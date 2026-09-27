import type { AppInfo, FileMeta, ScopeInfo, StructurePlan } from '../types';
import { isLayerFolderName } from './groups';

// X-Ray infers the repository's real shape from the files that identify a
// buildable project: a .csproj, a package.json, a manage.py, and so on.
//
// Around those apps it materializes *scopes*: the folders that hold more than
// one unit of code. A plain `backend/` + `frontend/` repository therefore reads
// as two projects rather than one undifferentiated pile of layers, and a
// solution's `src/` folder reads as the group of projects it actually is.
//
// Detection is deliberately shallow and honest: it uses manifest filenames and
// directory paths, never file contents, and every app it reports can be traced
// back to a marker file shown in the UI.

interface MarkerRule {
  /** Matched against the file's basename. */
  match: RegExp;
  kind: AppInfo['kind'];
  /** Rank when a directory contains several markers; higher wins. */
  rank: number;
}

const MARKER_RULES: MarkerRule[] = [
  { match: /\.(csproj|fsproj|vbproj|vcxproj)$/i, kind: 'dotnet', rank: 100 },
  { match: /^package\.json$/i, kind: 'node', rank: 90 },
  { match: /^manage\.py$/i, kind: 'django', rank: 85 },
  { match: /^(pyproject\.toml|setup\.py|setup\.cfg|Pipfile|requirements\.txt)$/i, kind: 'python', rank: 60 },
  { match: /^go\.mod$/i, kind: 'go', rank: 80 },
  { match: /^Cargo\.toml$/i, kind: 'rust', rank: 80 },
  { match: /^(pom\.xml|build\.gradle|build\.gradle\.kts|settings\.gradle|settings\.gradle\.kts)$/i, kind: 'jvm', rank: 80 },
  { match: /^composer\.json$/i, kind: 'php', rank: 70 },
  { match: /^(Gemfile|Rakefile)$/i, kind: 'ruby', rank: 70 },
];

/** A solution file marks a container of projects, not a project itself. */
const SOLUTION_RULE = /\.(sln|slnx)$/i;

/**
 * A Django application package: a directory holding `models.py` alongside at
 * least one of the companion modules. Django projects are otherwise just
 * folders, and without this every Django app collapses into one bucket.
 */
const DJANGO_MODELS = /^models\.py$/i;
const DJANGO_COMPANION = /^(views|urls|serializers|admin|tasks|filters|signals|apps)\.py$/i;

export function detectApps(files: FileMeta[], projectName: string): AppInfo[] {
  const byDir = new Map<string, Set<string>>();
  for (const file of files) {
    const dir = dirOf(file.path);
    const set = byDir.get(dir) ?? new Set<string>();
    set.add(file.name);
    byDir.set(dir, set);
  }

  const apps = new Map<string, AppInfo>();
  const ranks = new Map<string, number>();
  const keep = (dir: string, kind: AppInfo['kind'], marker: string, rank: number): void => {
    // A directory with several markers keeps the strongest one: a csproj beats
    // a stray requirements.txt sitting next to it.
    if ((ranks.get(dir) ?? -1) >= rank) return;
    ranks.set(dir, rank);
    apps.set(dir, { path: dir, name: dir ? lastSegment(dir) : projectName, kind, marker });
  };

  for (const file of files) {
    if (SOLUTION_RULE.test(file.name)) continue; // container only
    const rule = MARKER_RULES.find((entry) => entry.match.test(file.name));
    if (rule) keep(dirOf(file.path), rule.kind, file.path, rule.rank);
  }

  for (const [dir, names] of byDir) {
    if (apps.has(dir)) continue;
    let hasModels = false;
    let hasCompanion = false;
    for (const name of names) {
      if (DJANGO_MODELS.test(name)) hasModels = true;
      else if (DJANGO_COMPANION.test(name)) hasCompanion = true;
    }
    if (hasModels && hasCompanion) keep(dir, 'django', `${dir}/models.py`, 50);
  }

  return Array.from(apps.values()).sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Turns detected apps plus the files that actually declare types into the
 * structural skeleton the map draws.
 *
 * The rules, in full:
 *  - a file under a detected app belongs to the innermost (longest) app path;
 *  - when a repository holds several units of code, a file no app claims
 *    belongs to its top-level folder, so `backend/` never merges with the rest;
 *  - a folder becomes a visible node when it holds types of its own, or when it
 *    groups two or more other nodes. A folder wrapping a single project is
 *    skipped, so the map never shows redundant levels.
 */
export function planStructure(options: {
  files: FileMeta[];
  /** File ids that declare at least one type. */
  typeFilePaths: string[];
  apps: AppInfo[];
  projectName: string;
}): StructurePlan {
  const { apps, typeFilePaths, projectName } = options;
  const appByPath = new Map(apps.map((app) => [app.path, app]));

  const topLevelWithTypes = new Set<string>();
  for (const path of typeFilePaths) {
    const first = firstSegment(path);
    if (first) topLevelWithTypes.add(first);
  }
  // A top-level folder only ever becomes a scope of its own when its name
  // describes a unit of code rather than a layer inside one.
  const unitFolders = new Set(
    Array.from(topLevelWithTypes).filter((dir) => !isLayerFolderName(lastSegment(dir))),
  );
  const multiUnit = apps.some((app) => app.path !== '') || unitFolders.size >= 2;

  const scopeOfPath = (path: string): string => {
    const appId = appOfPath(apps, path);
    if (appId) return appId;
    if (!multiUnit) return '';
    // Unclaimed code follows its top-level folder, which is what keeps a
    // marker-less `backend/` separate from `frontend/`.
    const first = firstSegment(path);
    return first && unitFolders.has(first) ? first : '';
  };

  const ownTypes = new Map<string, number>();
  for (const path of typeFilePaths) {
    const scope = scopeOfPath(path);
    if (!scope) continue;
    ownTypes.set(scope, (ownTypes.get(scope) ?? 0) + 1);
  }

  const materialized = new Set<string>(ownTypes.keys());
  const descendants = new Map<string, number>();
  for (const path of ownTypes.keys()) {
    for (const ancestor of ancestorsOf(path)) {
      descendants.set(ancestor, (descendants.get(ancestor) ?? 0) + 1);
    }
  }
  for (const [ancestor, count] of descendants) {
    if (count >= 2) materialized.add(ancestor);
  }

  const ordered = Array.from(materialized).sort((a, b) => depthOf(a) - depthOf(b) || a.localeCompare(b));
  const parentOf = (path: string): string => {
    let best = '';
    for (const other of ordered) {
      if (other === path) continue;
      if (path.startsWith(`${other}/`) && other.length > best.length) best = other;
    }
    return best;
  };

  const childCounts = new Map<string, number>();
  for (const path of ordered) {
    const parent = parentOf(path);
    if (parent) childCounts.set(parent, (childCounts.get(parent) ?? 0) + 1);
  }

  const scopes: ScopeInfo[] = ordered.map((path) => {
    const app = appByPath.get(path);
    // A detected project stays an app only while nothing nests inside it.
    const hasChildren = (childCounts.get(path) ?? 0) > 0;
    return {
      path,
      name: app?.name ?? lastSegment(path),
      nodeKind: app && !hasChildren ? 'app' : 'workspace',
      marker: app?.marker,
      appKind: app?.kind,
      ownTypes: ownTypes.get(path) ?? 0,
      parentPath: parentOf(path),
      depth: depthOf(path),
    };
  });

  return { scopes, scopeOfPath, projectName };
}

/**
 * The app a file belongs to: the longest app path that contains it, falling
 * back to the project root (''). Longest-prefix is what makes nested projects
 * — a solution's projects inside `src/` — bind to the innermost app.
 */
export function appOfPath(apps: AppInfo[], path: string): string {
  let best = '';
  for (const app of apps) {
    if (!app.path) continue;
    if (path === app.path || path.startsWith(`${app.path}/`)) {
      if (app.path.length > best.length) best = app.path;
    }
  }
  return best;
}

export const APP_KIND_LABELS: Record<AppInfo['kind'], string> = {
  dotnet: '.NET project',
  node: 'Node package',
  django: 'Django app',
  python: 'Python project',
  go: 'Go module',
  rust: 'Rust crate',
  jvm: 'JVM module',
  php: 'PHP package',
  ruby: 'Ruby project',
  generic: 'Folder',
};

function ancestorsOf(path: string): string[] {
  const out: string[] = [];
  let current = dirOf(path);
  while (current) {
    out.push(current);
    current = dirOf(current);
  }
  return out;
}

function firstSegment(path: string): string {
  const idx = path.indexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

function lastSegment(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function depthOf(path: string): number {
  let count = 1;
  for (let i = 0; i < path.length; i++) if (path[i] === '/') count++;
  return count;
}

function dirOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}
