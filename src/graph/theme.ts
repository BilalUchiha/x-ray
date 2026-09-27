import type { EdgeKind, NodeKind } from '../core/types';

export const KIND_COLORS: Record<NodeKind, string> = {
  project: '#f0b429',
  workspace: '#94a3b8',
  app: '#7dd3fc',
  folder: '#475569',
  file: '#7d8b9c',
  class: '#4da3ff',
  interface: '#a78bfa',
  struct: '#34d399',
  enum: '#fbbf24',
  record: '#22d3ee',
  delegate: '#f472b6',
  'type-alias': '#f472b6',
  method: '#93c5fd',
  constructor: '#c4b5fd',
  function: '#93c5fd',
  property: '#8b98a5',
  field: '#8b98a5',
};

export const KIND_LABELS: Record<NodeKind, string> = {
  project: 'Project',
  workspace: 'Workspace',
  app: 'Project / app',
  folder: 'Folder',
  file: 'File',
  class: 'Class',
  interface: 'Interface',
  struct: 'Struct',
  enum: 'Enum',
  record: 'Record',
  delegate: 'Delegate',
  'type-alias': 'Type alias',
  method: 'Method',
  constructor: 'Constructor',
  function: 'Function',
  property: 'Property',
  field: 'Field',
};

export const EDGE_COLORS: Record<EdgeKind, string> = {
  contains: '#2b333f',
  inherits: '#f59e0b',
  implements: '#a78bfa',
  references: '#3b82f6',
  calls: '#22c55e',
  instantiates: '#14b8a6',
  imports: '#64748b',
  depends_on: '#6366f1',
};

export const EDGE_LABELS: Record<EdgeKind, string> = {
  contains: 'contains',
  inherits: 'inherits',
  implements: 'implements',
  references: 'references',
  calls: 'calls',
  instantiates: 'creates',
  imports: 'imports',
  depends_on: 'depends on',
};

export const THEME = {
  bg: '#0b0d10',
  panel: '#111419',
  panelAlt: '#151a21',
  border: '#1e242c',
  borderStrong: '#2a323d',
  text: '#e6edf3',
  muted: '#8b98a5',
  dim: '#5b6674',
  accent: '#4dd0c7',
  accentSoft: 'rgba(77, 208, 199, 0.14)',
  warn: '#f0b429',
  danger: '#f87171',
  ok: '#34d399',
};

export function kindColor(kind: NodeKind): string {
  return KIND_COLORS[kind] ?? '#7d8b9c';
}

export function edgeColor(kind: EdgeKind): string {
  return EDGE_COLORS[kind] ?? '#2b333f';
}

export function kindLabel(kind: NodeKind): string {
  return KIND_LABELS[kind] ?? kind;
}
