import type {
  Analysis,
  AppInfo,
  ArchGroup,
  CodeEdge,
  CodeGraph,
  CodeNode,
  DeclaredMember,
  DeclaredType,
  EdgeKind,
  FileMeta,
  LanguageStat,
  NodeKind,
  ParsedFile,
  ProjectStats,
  RawRelation,
  ScopeInfo,
} from '../types';
import { languageLabel } from '../scanner/languages';
import { detectApps, planStructure } from './apps';
import { buildGroups } from './groups';

export const PROJECT_NODE_ID = 'project';

export interface BuildInput {
  analysisId: string;
  name: string;
  rootLabel: string;
  files: FileMeta[];
  parsed: ParsedFile[];
  durationMs: number;
  warnings: Analysis['warnings'];
}

export function folderId(path: string): string {
  return `d:${path}`;
}

/** Directory part of a file path, '' at the project root. */
export function dirOf(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}

export function buildAnalysis(input: BuildInput): { analysis: Analysis; declared: Map<string, DeclaredType> } {
  const builder = new GraphBuilder(input);
  return builder.build();
}

class GraphBuilder {
  private readonly nodes: CodeNode[] = [];
  private readonly edges: CodeEdge[] = [];
  private readonly edgeIndex = new Map<string, CodeEdge>();
  private readonly declared = new Map<string, DeclaredType>();
  private readonly memberOwner = new Map<string, string>();
  private readonly typeMembers = new Map<string, string[]>();
  private readonly nameIndex = new Map<string, string[]>();
  private readonly methodsByName = new Map<string, string[]>();
  private readonly nodeById = new Map<string, CodeNode>();
  private apps: AppInfo[] = [];
  private scopes: ScopeInfo[] = [];
  private scopeOfPath: (path: string) => string = () => '';

  constructor(private readonly input: BuildInput) {}

  build(): { analysis: Analysis; declared: Map<string, DeclaredType> } {
    this.apps = detectApps(this.input.files, this.input.name);
    const plan = planStructure({
      files: this.input.files,
      typeFilePaths: this.input.parsed.filter((file) => file.types.length > 0).map((file) => file.fileId),
      apps: this.apps,
      projectName: this.input.name,
    });
    this.scopes = plan.scopes;
    this.scopeOfPath = plan.scopeOfPath;

    this.addProjectNode();
    this.addFileAndFolderNodes();
    this.addTypeAndMemberNodes();
    this.indexSymbols();
    this.resolveRelations();
    this.deriveFileEdges();
    this.deriveFolderEdges();

    const typeNodes = this.nodes.filter((n) => isTypeKind(n.kind));
    const groups = buildGroups(typeNodes, this.declared, {
      scopes: this.scopes,
      scopeOfPath: this.scopeOfPath,
      projectName: this.input.name,
    }, this.input.name);
    const stats = this.computeStats(groups);
    const languages = this.computeLanguages();

    const graph: CodeGraph = { nodes: this.nodes, edges: this.edges };
    const analysis: Analysis = {
      id: this.input.analysisId,
      name: this.input.name,
      rootLabel: this.input.rootLabel,
      analyzedAt: Date.now(),
      durationMs: this.input.durationMs,
      stats,
      languages,
      graph,
      warnings: this.input.warnings,
      groups,
      apps: this.apps,
      scopes: this.scopes,
    };
    return { analysis, declared: this.declared };
  }

  // -- nodes ----------------------------------------------------------------

  private addNode(node: CodeNode): void {
    this.nodes.push(node);
    this.nodeById.set(node.id, node);
  }

  private addProjectNode(): void {
    this.addNode({
      id: PROJECT_NODE_ID,
      kind: 'project',
      name: this.input.name,
      lineCount: 0,
    });
  }

  private addFileAndFolderNodes(): void {
    const folders = new Set<string>();
    for (const file of this.input.files) {
      const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
      collectParents(dir, folders);
    }

    // Create folders shallowest-first so parents always exist.
    const ordered = Array.from(folders).sort((a, b) => depth(a) - depth(b));
    for (const path of ordered) {
      const parentDir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      const node: CodeNode = {
        id: folderId(path),
        kind: 'folder',
        name: path.slice(path.lastIndexOf('/') + 1),
        parentId: parentDir ? folderId(parentDir) : PROJECT_NODE_ID,
        filePath: path,
      };
      this.addNode(node);
      this.addEdge(node.parentId!, node.id, 'contains');
    }

    for (const file of this.input.files) {
      const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
      const node: CodeNode = {
        id: file.id,
        kind: 'file',
        name: file.name,
        fileId: file.id,
        filePath: file.path,
        parentId: dir ? folderId(dir) : PROJECT_NODE_ID,
        language: file.language,
        sizeBytes: file.size,
        lineCount: file.lines,
      };
      this.addNode(node);
      this.addEdge(node.parentId!, node.id, 'contains');
    }
  }

  private addTypeAndMemberNodes(): void {
    for (const parsed of this.input.parsed) {
      const fileNode = this.nodeById.get(parsed.fileId);
      for (const type of parsed.types) {
        this.declared.set(type.id, type);
        const kind: NodeKind = type.kind;
        const node: CodeNode = {
          id: type.id,
          kind,
          name: type.name,
          qualifiedName: type.namespace ? `${type.namespace}.${type.name}` : type.name,
          namespace: type.namespace,
          fileId: type.fileId,
          filePath: fileNode?.filePath,
          parentId: type.fileId,
          language: fileNode?.language,
          modifiers: type.modifiers,
          startLine: type.startLine,
          endLine: type.endLine,
          lineCount: Math.max(1, type.endLine - type.startLine + 1),
        };
        this.addNode(node);
        this.addEdge(type.fileId, type.id, 'contains');
      }
    }

    for (const parsed of this.input.parsed) {
      for (const member of parsed.members) {
        // A member's owner is normally a declared type. Languages that have
        // module-level functions (Python, TypeScript) attach those to the file
        // node instead of inventing a container type.
        const owner = this.declared.get(member.ownerId);
        const parentId = owner ? member.ownerId : member.fileId;
        if (!this.nodeById.has(parentId)) continue;
        // Defensive: never let a repeated declaration id create two nodes.
        if (this.nodeById.has(member.id)) continue;
        const kind: NodeKind = member.kind === 'function' ? 'function' : member.kind;
        const node: CodeNode = {
          id: member.id,
          kind,
          name: member.name,
          qualifiedName: owner
            ? `${owner.namespace ? `${owner.namespace}.` : ''}${owner.name}.${member.name}`
            : member.name,
          namespace: owner?.namespace,
          fileId: member.fileId,
          filePath: this.nodeById.get(member.fileId)?.filePath,
          parentId,
          language: this.nodeById.get(member.fileId)?.language,
          modifiers: member.modifiers,
          signature: member.signature,
          returnType: member.returnType,
          paramTypes: member.paramTypes,
          startLine: member.startLine,
          endLine: member.endLine,
        };
        this.addNode(node);
        this.memberOwner.set(member.id, parentId);
        const list = this.typeMembers.get(parentId) ?? [];
        list.push(member.id);
        this.typeMembers.set(parentId, list);
        this.addEdge(parentId, member.id, 'contains');
      }
    }

    for (const [typeId, members] of this.typeMembers) {
      const node = this.nodeById.get(typeId);
      if (node && isTypeKind(node.kind)) node.memberCount = members.length;
    }
  }

  private indexSymbols(): void {
    for (const node of this.nodes) {
      if (!isTypeKind(node.kind)) continue;
      const list = this.nameIndex.get(node.name) ?? [];
      list.push(node.id);
      this.nameIndex.set(node.name, list);
    }
    for (const node of this.nodes) {
      if (node.kind !== 'method' && node.kind !== 'constructor' && node.kind !== 'function') continue;
      const list = this.methodsByName.get(node.name) ?? [];
      list.push(node.id);
      this.methodsByName.set(node.name, list);
    }
  }

  // -- resolution -----------------------------------------------------------

  /**
   * The structural scope of a file: its app, or the top-level folder that holds
   * unclaimed code. Used to keep name resolution inside one unit of the repo.
   */
  private scopeOf(fileId: string): string {
    return this.scopes.length > 0 ? this.scopeOfPath(fileId) : '';
  }

  /**
   * Resolves an unqualified type name to a declared type.
   *
   * The first filter is the app boundary. In a repository with a backend and a
   * frontend, `User` usually exists on both sides; binding the backend's
   * reference to the frontend's `User` would be a fabricated dependency, which
   * is exactly the kind of error this tool must not make.
   */
  private resolveType(name: string, fromNamespace?: string, fromFileId?: string): string | null {
    if (!name) return null;
    const candidates = this.nameIndex.get(name);
    if (!candidates || candidates.length === 0) return null;

    if (candidates.length === 1) return candidates[0];

    const fromApp = fromFileId ? this.scopeOf(fromFileId) : null;
    let pool = candidates;
    if (fromApp !== null && this.scopes.length > 0) {
      const sameApp = candidates.filter((id) => this.scopeOf(this.nodeById.get(id)?.fileId ?? '') === fromApp);
      if (sameApp.length > 0) pool = sameApp;
      if (pool.length === 1) return pool[0];
    }

    if (fromNamespace) {
      const sameNs = pool.filter((id) => this.nodeById.get(id)?.namespace === fromNamespace);
      if (sameNs.length === 1) return sameNs[0];
    }
    if (fromFileId) {
      const sameFile = pool.filter((id) => this.nodeById.get(id)?.fileId === fromFileId);
      if (sameFile.length === 1) return sameFile[0];
    }

    // Nearest declaration by directory, then by namespace overlap. A tie means
    // the name is genuinely ambiguous, and X-Ray says so by drawing no edge.
    const scored = pool
      .map((id) => {
        const node = this.nodeById.get(id);
        const pathScore = fromFileId ? commonDirDepth(dirOf(fromFileId), dirOf(node?.filePath ?? '')) : 0;
        const nsScore = fromNamespace ? commonPrefixLength(node?.namespace ?? '', fromNamespace) : 0;
        return { id, pathScore, nsScore };
      })
      .sort((a, b) => b.pathScore - a.pathScore || b.nsScore - a.nsScore);
    const best = scored[0];
    const runnerUp = scored[1];
    if (runnerUp && runnerUp.pathScore === best.pathScore && runnerUp.nsScore === best.nsScore) return null;
    return best.nsScore > 0 || best.pathScore > 0 ? best.id : null;
  }

  private resolveRelations(): void {
    for (const parsed of this.input.parsed) {
      const fileNode = this.nodeById.get(parsed.fileId);
      const fileNamespace = parsed.namespace ?? this.declared.get(parsed.types[0]?.id ?? '')?.namespace;

      for (const relation of parsed.relations) {
        if (relation.kind === 'base') {
          const target = this.resolveType(relation.toName, fileNamespace, parsed.fileId);
          if (!target) continue;
          const targetNode = this.nodeById.get(target);
          const kind: EdgeKind = targetNode?.kind === 'interface' ? 'implements' : 'inherits';
          this.addEdge(relation.fromId, target, kind);
          continue;
        }

        if (relation.kind === 'call') {
          this.resolveCall(relation, fileNamespace, parsed.fileId);
          continue;
        }

        if (relation.kind === 'usage' || relation.kind === 'instantiate') {
          const target = this.resolveType(relation.toName, fileNamespace, parsed.fileId);
          if (!target) continue;
          const sourceType = relation.fromKind === 'type'
            ? relation.fromId
            : relation.fromKind === 'method'
              ? this.memberOwner.get(relation.fromId) ?? null
              : null;

          if (relation.fromKind === 'file') {
            // Imports / aliased usings: record a file -> file import edge.
            const targetFile = this.nodeById.get(target)?.fileId;
            if (targetFile && targetFile !== parsed.fileId) {
              this.addEdge(parsed.fileId, targetFile, 'imports');
            }
            continue;
          }
          if (!sourceType || sourceType === target) continue;
          this.addEdge(sourceType, target, relation.kind === 'instantiate' ? 'instantiates' : 'references');
        }
      }

      // Relative imports in TS/JS resolve directly to files.
      if (fileNode) {
        for (const specifier of parsed.imports) {
          if (!specifier.startsWith('.')) continue;
          const targetFile = resolveRelativeImport(parsed.fileId, specifier, this.input.files);
          if (targetFile && targetFile !== parsed.fileId) this.addEdge(parsed.fileId, targetFile, 'imports');
        }
      }
    }
  }

  /**
   * Resolves a call site. Resolution is intentionally strict: when the receiver
   * cannot be typed from the syntax, the call is left out rather than guessed.
   * A wrong "calls" edge is worse than a missing one in a tool people use to
   * reason about their architecture.
   */
  private resolveCall(relation: RawRelation, fromNamespace?: string, fromFileId?: string): void {
    const methodName = relation.methodName;
    if (!methodName) return;
    const fromMemberId = relation.fromId;
    const owner = this.memberOwner.get(fromMemberId);
    if (!owner) return;

    // Candidates: a static call through a type name, or an instance call whose
    // receiver is a field/property with a declared type.
    const candidates: string[] = [];
    if (relation.toName) candidates.push(relation.toName);
    for (const via of relation.viaTypes ?? []) candidates.push(via);

    for (const candidateName of candidates) {
      const targetType = this.resolveType(candidateName, fromNamespace, fromFileId);
      if (!targetType) continue;
      const method = this.findMethodIn(targetType, methodName);
      if (method) {
        this.addEdge(fromMemberId, method, 'calls');
        return;
      }
    }

    if (relation.memberAccess) {
      // The receiver exists but its type is unknown — do not guess.
      return;
    }

    // Bare call: a method on the same type is a sound resolution.
    const self = this.findMethodIn(owner, methodName);
    if (self && self !== fromMemberId) {
      this.addEdge(fromMemberId, self, 'calls');
      return;
    }

    // Or a name that is unique across the whole analysed folder.
    const global = this.methodsByName.get(methodName);
    if (global && global.length === 1 && global[0] !== fromMemberId) {
      this.addEdge(fromMemberId, global[0], 'calls');
    }
  }

  private findMethodIn(typeId: string, methodName: string): string | null {
    const members = this.typeMembers.get(typeId);
    if (!members) return null;
    for (const id of members) {
      const node = this.nodeById.get(id);
      if (node && node.name === methodName && (node.kind === 'method' || node.kind === 'constructor' || node.kind === 'function')) {
        return id;
      }
    }
    return null;
  }

  // -- derived aggregation --------------------------------------------------

  private deriveFileEdges(): void {
    this.aggregateEdges('file', (id) => this.nodeById.get(id)?.fileId ?? null);
  }

  private deriveFolderEdges(): void {
    this.aggregateEdges('folder', (id) => folderOf(this.nodeById.get(id)?.filePath ?? ''));
  }

  private aggregateEdges(_scope: string, ownerOf: (nodeId: string) => string | null): void {
    const seen = new Set<string>();
    const list = [...this.edges];
    for (const edge of list) {
      if (edge.derived) continue;
      if (edge.kind === 'contains' || edge.kind === 'imports') continue;
      const sourceOwner = ownerOf(edge.source);
      const targetOwner = ownerOf(edge.target);
      if (!sourceOwner || !targetOwner || sourceOwner === targetOwner) continue;
      const key = `${sourceOwner}|${targetOwner}|${edge.kind}`;
      if (seen.has(key)) continue;
      seen.add(key);
      this.addEdge(sourceOwner, targetOwner, edge.kind, true);
    }
  }

  // -- edges ----------------------------------------------------------------

  private addEdge(source: string, target: string, kind: EdgeKind, derived = false): void {
    if (!source || !target || source === target) return;
    const key = `${source}|${target}|${kind}`;
    const existing = this.edgeIndex.get(key);
    if (existing) {
      existing.weight = Math.min(existing.weight + 1, 99);
      return;
    }
    const edge: CodeEdge = {
      id: `e:${this.edges.length}:${kind}`,
      source,
      target,
      kind,
      weight: 1,
    };
    if (derived) edge.derived = true;
    this.edges.push(edge);
    this.edgeIndex.set(key, edge);
  }

  // -- stats ----------------------------------------------------------------

  private computeStats(groups: ArchGroup[]): ProjectStats {
    const counts = new Map<NodeKind, number>();
    for (const node of this.nodes) counts.set(node.kind, (counts.get(node.kind) ?? 0) + 1);
    const primaryEdges = this.edges.filter((e) => !e.derived && e.kind !== 'contains');

    return {
      totalFiles: this.input.files.length,
      sourceFiles: this.input.files.filter((f) => this.input.parsed.some((p) => p.fileId === f.id)).length,
      folders: this.nodes.filter((n) => n.kind === 'folder').length,
      classes: (counts.get('class') ?? 0) + (counts.get('record') ?? 0),
      interfaces: counts.get('interface') ?? 0,
      structs: counts.get('struct') ?? 0,
      enums: counts.get('enum') ?? 0,
      records: counts.get('record') ?? 0,
      methods: counts.get('method') ?? 0,
      properties: counts.get('property') ?? 0,
      fields: counts.get('field') ?? 0,
      totalLines: this.input.files.reduce((sum, f) => sum + f.lines, 0),
      totalBytes: this.input.files.reduce((sum, f) => sum + f.size, 0),
      relationships: primaryEdges.length,
      warnings: this.input.warnings.length,
    };
    void groups;
  }

  private computeLanguages(): LanguageStat[] {
    const byLang = new Map<string, { files: number; lines: number; bytes: number }>();
    for (const file of this.input.files) {
      const entry = byLang.get(file.language) ?? { files: 0, lines: 0, bytes: 0 };
      entry.files += 1;
      entry.lines += file.lines;
      entry.bytes += file.size;
      byLang.set(file.language, entry);
    }
    const totalLines = Array.from(byLang.values()).reduce((sum, e) => sum + e.lines, 0) || 1;
    return Array.from(byLang.entries())
      .map(([language, entry]) => ({
        language: language as LanguageStat['language'],
        label: languageLabel(language as LanguageStat['language']),
        files: entry.files,
        lines: entry.lines,
        bytes: entry.bytes,
        percent: Math.round((entry.lines / totalLines) * 1000) / 10,
      }))
      .sort((a, b) => b.lines - a.lines);
  }
}

// -- helpers ----------------------------------------------------------------

export function isTypeKind(kind: NodeKind): boolean {
  return kind === 'class' || kind === 'interface' || kind === 'struct' || kind === 'enum'
    || kind === 'record' || kind === 'delegate' || kind === 'type-alias';
}

function collectParents(dir: string, out: Set<string>): void {
  let current = dir;
  while (current) {
    if (out.has(current)) break;
    out.add(current);
    current = current.includes('/') ? current.slice(0, current.lastIndexOf('/')) : '';
  }
}

function depth(path: string): number {
  let count = 1;
  for (let i = 0; i < path.length; i++) if (path[i] === '/') count++;
  return count;
}

function folderOf(path: string): string | null {
  if (!path) return null;
  const idx = path.lastIndexOf('/');
  if (idx === -1) return null;
  return folderId(path.slice(0, idx));
}

/** Number of leading path segments two directories share. */
function commonDirDepth(a: string, b: string): number {
  if (!a && !b) return 0;
  const partsA = a ? a.split('/') : [];
  const partsB = b ? b.split('/') : [];
  let count = 0;
  for (let i = 0; i < Math.min(partsA.length, partsB.length); i++) {
    if (partsA[i] === partsB[i]) count++;
    else break;
  }
  return count;
}

function commonPrefixLength(a: string, b: string): number {
  const partsA = a.split('.');
  const partsB = b.split('.');
  let count = 0;
  for (let i = 0; i < Math.min(partsA.length, partsB.length); i++) {
    if (partsA[i] === partsB[i]) count++;
    else break;
  }
  return count;
}

function resolveRelativeImport(fromFileId: string, specifier: string, files: FileMeta[]): string | null {
  const baseDir = fromFileId.includes('/') ? fromFileId.slice(0, fromFileId.lastIndexOf('/')) : '';
  const resolved = normalizePath(baseDir ? `${baseDir}/${specifier}` : specifier);
  const candidates = [
    resolved,
    `${resolved}.ts`, `${resolved}.tsx`, `${resolved}.js`, `${resolved}.jsx`,
    `${resolved}/index.ts`, `${resolved}/index.tsx`, `${resolved}/index.js`, `${resolved}/index.jsx`,
    `${resolved}.cs`,
  ];
  const byId = new Set(files.map((f) => f.id));
  for (const candidate of candidates) {
    if (byId.has(candidate)) return candidate;
  }
  return null;
}

function normalizePath(path: string): string {
  const segments = path.split('/');
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === '.' || segment === '') continue;
    if (segment === '..') out.pop();
    else out.push(segment);
  }
  return out.join('/');
}

export type { DeclaredMember };
