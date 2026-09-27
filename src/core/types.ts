// X-Ray core domain types.
// Shared by the analysis engine, the graph, search, AI context and the UI.
// The visualization consumes these structures; it never parses source itself.

export type NodeKind =
  | 'project'
  | 'workspace'
  | 'app'
  | 'folder'
  | 'file'
  | 'class'
  | 'interface'
  | 'struct'
  | 'enum'
  | 'record'
  | 'delegate'
  | 'method'
  | 'constructor'
  | 'property'
  | 'field'
  | 'function'
  | 'type-alias';

export type EdgeKind =
  | 'contains'
  | 'inherits'
  | 'implements'
  | 'references'
  | 'calls'
  | 'instantiates'
  | 'imports'
  /** Aggregated dependency, derived from the concrete edge kinds above. */
  | 'depends_on';

export const EDGE_KINDS: EdgeKind[] = [
  'contains',
  'inherits',
  'implements',
  'references',
  'calls',
  'instantiates',
  'imports',
  'depends_on',
];

export interface CodeNode {
  id: string;
  kind: NodeKind;
  name: string;
  /** Fully qualified name where the parser could determine one. */
  qualifiedName?: string;
  namespace?: string;
  fileId?: string;
  filePath?: string;
  parentId?: string;
  language?: LanguageId;
  modifiers?: string[];
  /** Human readable signature for members. */
  signature?: string;
  returnType?: string;
  paramTypes?: string[];
  startLine?: number;
  endLine?: number;
  sizeBytes?: number;
  lineCount?: number;
  /** Number of declared members inside a type. */
  memberCount?: number;
  /** Filled in by the graph builder: architectural group id, if any. */
  groupId?: string;
  /** True for members that X-Ray inferred but could not fully type-check. */
  inferred?: boolean;
}

export interface CodeEdge {
  id: string;
  source: string;
  target: string;
  kind: EdgeKind;
  /** How many raw occurrences produced this edge (deduplicated). */
  weight: number;
  /** True when the edge aggregates finer-grained evidence. */
  derived?: boolean;
}

export interface CodeGraph {
  nodes: CodeNode[];
  edges: CodeEdge[];
}

export type LanguageId =
  | 'csharp'
  | 'python'
  | 'typescript'
  | 'javascript'
  | 'java'
  | 'kotlin'
  | 'go'
  | 'rust'
  | 'ruby'
  | 'php'
  | 'swift'
  | 'cpp'
  | 'scala'
  | 'dart'
  | 'vue'
  | 'svelte'
  | 'razor'
  | 'vbnet'
  | 'fsharp'
  | 'r'
  | 'sql'
  | 'shell'
  | 'protobuf'
  | 'graphql'
  | 'html'
  | 'css'
  | 'csproj'
  | 'gradle'
  | 'json'
  | 'yaml'
  | 'toml'
  | 'xml'
  | 'markdown'
  | 'docker'
  | 'terraform'
  | 'unknown';

export interface LanguageStat {
  language: LanguageId;
  label: string;
  files: number;
  lines: number;
  bytes: number;
  percent: number;
}

export interface FileMeta {
  id: string;
  path: string;
  name: string;
  ext: string;
  language: LanguageId;
  size: number;
  lines: number;
  /** True when X-Ray has a structural parser for this language. */
  parsed: boolean;
}

export type WarningKind =
  | 'unreadable'
  | 'too-large'
  | 'binary'
  | 'parse-error'
  | 'unsupported';

export interface AnalysisWarning {
  kind: WarningKind;
  path: string;
  message: string;
  line?: number;
}

export interface ProjectStats {
  totalFiles: number;
  sourceFiles: number;
  folders: number;
  classes: number;
  interfaces: number;
  structs: number;
  enums: number;
  records: number;
  methods: number;
  properties: number;
  fields: number;
  totalLines: number;
  totalBytes: number;
  relationships: number;
  /** Files X-Ray could not fully parse. */
  warnings: number;
}

export interface Analysis {
  id: string;
  name: string;
  rootLabel: string;
  analyzedAt: number;
  durationMs: number;
  stats: ProjectStats;
  languages: LanguageStat[];
  graph: CodeGraph;
  warnings: AnalysisWarning[];
  /** Architectural groups used as the entry level of the map. */
  groups: ArchGroup[];
  /** Buildable projects detected from manifest files. */
  apps: AppInfo[];
  /** The structural skeleton: projects and the folders that group them. */
  scopes: ScopeInfo[];
}

/**
 * A buildable unit of the analysed folder, found by its manifest file
 * (`.csproj`, `package.json`, `manage.py`, Django app package, …).
 */
export interface AppInfo {
  /** Directory relative to the project root; '' for the root itself. */
  path: string;
  /** Display name — the last path segment, or the project name for the root. */
  name: string;
  kind:
    | 'dotnet'
    | 'node'
    | 'django'
    | 'python'
    | 'go'
    | 'rust'
    | 'jvm'
    | 'php'
    | 'ruby'
    | 'generic';
  /** The file that proved this app exists, e.g. `src/Api/Api.csproj`. */
  marker: string;
}

/**
 * A node of the repository's structural skeleton: a detected project, or a
 * folder that holds several units of code (e.g. `backend`, `src`).
 */
export interface ScopeInfo {
  /** Directory path relative to the project root. Never ''. */
  path: string;
  name: string;
  /** 'app' for a detected project, 'workspace' for a grouping folder. */
  nodeKind: 'app' | 'workspace';
  /** The manifest that proved a detected project exists. */
  marker?: string;
  appKind?: AppInfo['kind'];
  /** Declared types that live directly in this scope. */
  ownTypes: number;
  /** Parent scope path, or '' when the scope hangs off the project node. */
  parentPath: string;
  depth: number;
}

/** Result of planning the structural skeleton for an analysed folder. */
export interface StructurePlan {
  scopes: ScopeInfo[];
  scopeOfPath: (path: string) => string;
  projectName: string;
}

export interface ArchGroup {
  id: string;
  label: string;
  /** 'layer' for heuristic architectural buckets, 'folder' for directory buckets. */
  source: 'layer' | 'folder';
  memberIds: string[];
  description: string;
  /** App this layer belongs to, so layers never span two apps. */
  appId: string;
  /** Display name of that app. */
  appLabel: string;
}

/** Indexes kept alongside the graph for fast lookup and AI retrieval. */
export interface AnalysisIndex {
  nodeById: Map<string, CodeNode>;
  childrenOf: Map<string, string[]>;
  /** node id -> files that declare it */
  nameIndex: Map<string, string[]>;
}
export interface AnalysisSession {
  analysis: Analysis;
  index: AnalysisIndex;
  fileById: Map<string, FileMeta>;
  /** File contents are held in memory only, never persisted. */
  contents: Map<string, string>;
  /** Raw parser output, kept for AI context and re-grouping. */
  parsed: ParsedFile[];
}

// --- Parser output ---------------------------------------------------------

export type DeclaredTypeKind =
  | 'class'
  | 'interface'
  | 'struct'
  | 'enum'
  | 'record'
  | 'delegate';

export interface DeclaredType {
  id: string;
  kind: DeclaredTypeKind;
  name: string;
  namespace?: string;
  fileId: string;
  startLine: number;
  endLine: number;
  modifiers: string[];
  /** Raw names from the base list / extends clause, unresolved. */
  baseNames: string[];
  genericParams?: string[];
  memberIds: string[];
  exported?: boolean;
}

export interface DeclaredMember {
  id: string;
  kind: 'method' | 'constructor' | 'property' | 'field' | 'function';
  name: string;
  ownerId: string;
  fileId: string;
  startLine: number;
  endLine: number;
  signature: string;
  returnType?: string;
  paramTypes: string[];
  modifiers: string[];
}

export type RawRelationKind =
  | 'base'
  | 'usage'
  | 'call'
  | 'instantiate'
  | 'import';

export interface RawRelation {
  kind: RawRelationKind;
  fromId: string;
  fromKind: 'type' | 'file' | 'method';
  /** Unresolved target name, e.g. "IUserRepository" or "MyApp.Services.Foo". */
  toName: string;
  /** For calls: the invoked member name. */
  methodName?: string;
  /** True when the call went through a receiver expression (`x.Foo()`). */
  memberAccess?: boolean;
  /** Declared type names of the receiver, when the parser could determine them. */
  viaTypes?: string[];
  line?: number;
}

export interface ParsedFile {
  fileId: string;
  namespace?: string;
  types: DeclaredType[];
  members: DeclaredMember[];
  relations: RawRelation[];
  imports: string[];
  errors: AnalysisWarning[];
  /** Non-fatal note, e.g. "file truncated after N lines". */
  note?: string;
}
