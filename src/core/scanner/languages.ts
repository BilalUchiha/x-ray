import type { LanguageId } from '../types';

export interface LanguageDef {
  id: LanguageId;
  label: string;
  extensions: string[];
  /** Whether X-Ray has a real structural parser for this language. */
  parsed: boolean;
  /** True for files that belong to the source tree (as opposed to config/data). */
  source: boolean;
}

export const LANGUAGES: LanguageDef[] = [
  // --- languages with a structural parser --------------------------------
  { id: 'csharp', label: 'C#', extensions: ['.cs'], parsed: true, source: true },
  { id: 'python', label: 'Python', extensions: ['.py', '.pyi'], parsed: true, source: true },
  { id: 'typescript', label: 'TypeScript', extensions: ['.ts', '.tsx', '.mts', '.cts'], parsed: true, source: true },
  { id: 'javascript', label: 'JavaScript', extensions: ['.js', '.jsx', '.mjs', '.cjs'], parsed: true, source: true },

  // --- source languages shown structurally, without a deep parser --------
  { id: 'java', label: 'Java', extensions: ['.java'], parsed: false, source: true },
  { id: 'kotlin', label: 'Kotlin', extensions: ['.kt', '.kts'], parsed: false, source: true },
  { id: 'go', label: 'Go', extensions: ['.go'], parsed: false, source: true },
  { id: 'rust', label: 'Rust', extensions: ['.rs'], parsed: false, source: true },
  { id: 'ruby', label: 'Ruby', extensions: ['.rb', '.erb'], parsed: false, source: true },
  { id: 'php', label: 'PHP', extensions: ['.php'], parsed: false, source: true },
  { id: 'swift', label: 'Swift', extensions: ['.swift'], parsed: false, source: true },
  { id: 'cpp', label: 'C / C++', extensions: ['.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh', '.hxx'], parsed: false, source: true },
  { id: 'scala', label: 'Scala', extensions: ['.scala'], parsed: false, source: true },
  { id: 'dart', label: 'Dart', extensions: ['.dart'], parsed: false, source: true },
  { id: 'vue', label: 'Vue', extensions: ['.vue'], parsed: false, source: true },
  { id: 'svelte', label: 'Svelte', extensions: ['.svelte'], parsed: false, source: true },
  { id: 'razor', label: 'Razor', extensions: ['.cshtml', '.razor'], parsed: false, source: true },
  { id: 'vbnet', label: 'Visual Basic', extensions: ['.vb'], parsed: false, source: true },
  { id: 'fsharp', label: 'F#', extensions: ['.fs', '.fsx'], parsed: false, source: true },
  { id: 'r', label: 'R', extensions: ['.r', '.rmd'], parsed: false, source: true },
  { id: 'sql', label: 'SQL', extensions: ['.sql'], parsed: false, source: true },
  { id: 'shell', label: 'Shell', extensions: ['.sh', '.bash', '.zsh', '.ps1', '.psm1', '.bat', '.cmd'], parsed: false, source: true },
  { id: 'protobuf', label: 'Protobuf', extensions: ['.proto'], parsed: false, source: true },
  { id: 'graphql', label: 'GraphQL', extensions: ['.graphql', '.gql'], parsed: false, source: true },

  // --- markup / styles ----------------------------------------------------
  { id: 'html', label: 'HTML', extensions: ['.html', '.htm'], parsed: false, source: true },
  { id: 'css', label: 'CSS', extensions: ['.css', '.scss', '.sass', '.less', '.styl'], parsed: false, source: true },

  // --- project + config files --------------------------------------------
  { id: 'csproj', label: 'MSBuild', extensions: ['.csproj', '.vbproj', '.fsproj', '.props', '.targets', '.sln'], parsed: false, source: false },
  { id: 'gradle', label: 'Gradle', extensions: ['.gradle'], parsed: false, source: false },
  { id: 'json', label: 'JSON', extensions: ['.json', '.jsonc', '.json5'], parsed: false, source: false },
  { id: 'yaml', label: 'YAML', extensions: ['.yml', '.yaml'], parsed: false, source: false },
  { id: 'toml', label: 'TOML', extensions: ['.toml'], parsed: false, source: false },
  { id: 'xml', label: 'XML', extensions: ['.xml', '.xaml', '.config', '.resx', '.svg'], parsed: false, source: false },
  { id: 'markdown', label: 'Markdown', extensions: ['.md', '.mdx', '.rst', '.adoc'], parsed: false, source: false },
  { id: 'docker', label: 'Docker', extensions: ['.dockerfile'], parsed: false, source: false },
  { id: 'terraform', label: 'Terraform', extensions: ['.tf', '.hcl'], parsed: false, source: false },
];

/** Well-known file names with no useful extension. */
const BY_FILENAME = new Map<string, LanguageDef>([
  ['dockerfile', LANGUAGES.find((l) => l.id === 'docker')!],
  ['makefile', LANGUAGES.find((l) => l.id === 'shell')!],
  ['procfile', LANGUAGES.find((l) => l.id === 'yaml')!],
  ['pipfile', LANGUAGES.find((l) => l.id === 'toml')!],
  ['requirements.txt', LANGUAGES.find((l) => l.id === 'python')!],
  ['manage.py', LANGUAGES.find((l) => l.id === 'python')!],
]);

const BY_EXT = new Map<string, LanguageDef>();
for (const lang of LANGUAGES) {
  for (const ext of lang.extensions) BY_EXT.set(ext, lang);
}

export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return '';
  return name.slice(dot).toLowerCase();
}

function fileNameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).toLowerCase();
}

function definitionFor(path: string): LanguageDef | undefined {
  const byName = BY_FILENAME.get(fileNameOf(path));
  if (byName) return byName;
  return BY_EXT.get(extensionOf(path));
}

export function languageOf(path: string): LanguageId {
  return definitionFor(path)?.id ?? 'unknown';
}

export function languageLabel(id: LanguageId): string {
  return LANGUAGES.find((l) => l.id === id)?.label ?? 'Other';
}

export function isParseable(path: string): boolean {
  return definitionFor(path)?.parsed ?? false;
}

export function isSourceLanguage(path: string): boolean {
  return definitionFor(path)?.source ?? false;
}

/** Extensions X-Ray is willing to read as text at all. */
export function isKnownText(path: string): boolean {
  return definitionFor(path) !== undefined;
}

/** Languages X-Ray can read but cannot yet parse structurally. */
export function hasParser(id: LanguageId): boolean {
  return LANGUAGES.find((l) => l.id === id)?.parsed ?? false;
}
