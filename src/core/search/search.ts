import type { AnalysisIndex, AnalysisSession, NodeKind } from '../types';

export interface SearchResult {
  nodeId: string;
  kind: NodeKind;
  name: string;
  qualifiedName?: string;
  filePath?: string;
  namespace?: string;
  score: number;
  match: 'name' | 'qualified' | 'path' | 'content';
  snippet?: string;
}

const SEARCHABLE: ReadonlySet<NodeKind> = new Set<NodeKind>([
  'file', 'class', 'interface', 'struct', 'enum', 'record', 'delegate',
  'method', 'function', 'constructor',
]);

const KIND_WEIGHT: Partial<Record<NodeKind, number>> = {
  class: 12,
  interface: 11,
  record: 12,
  struct: 10,
  enum: 9,
  method: 6,
  function: 6,
  constructor: 4,
  file: 3,
};

/**
 * Searches the in-memory analysis. Pure and synchronous: names first (cheap),
 * then file paths, then a bounded content scan for the remaining budget.
 */
export function searchCodebase(
  session: AnalysisSession,
  query: string,
  options: { limit?: number; includeContent?: boolean } = {},
): SearchResult[] {
  const limit = options.limit ?? 40;
  const includeContent = options.includeContent ?? true;
  const term = query.trim().toLowerCase();
  if (term.length < 2) return [];

  const results = new Map<string, SearchResult>();

  const consider = (result: SearchResult) => {
    const existing = results.get(result.nodeId);
    if (!existing || result.score > existing.score) results.set(result.nodeId, result);
  };

  for (const node of session.analysis.graph.nodes) {
    if (!SEARCHABLE.has(node.kind)) continue;
    const name = node.name.toLowerCase();
    const qualified = (node.qualifiedName ?? '').toLowerCase();
    const path = (node.filePath ?? '').toLowerCase();
    const kindBonus = KIND_WEIGHT[node.kind] ?? 0;

    if (name === term) {
      consider({ ...toResult(node), score: 1000 + kindBonus, match: 'name' });
      continue;
    }
    if (name.startsWith(term)) {
      consider({ ...toResult(node), score: 800 + kindBonus, match: 'name' });
      continue;
    }
    if (name.includes(term)) {
      consider({ ...toResult(node), score: 600 + kindBonus, match: 'name' });
      continue;
    }
    // camelCase / PascalCase word boundary match: "UserService" for "service"
    if (wordStartsWith(name, term)) {
      consider({ ...toResult(node), score: 500 + kindBonus, match: 'name' });
      continue;
    }
    if (qualified.includes(term)) {
      consider({ ...toResult(node), score: 380 + kindBonus, match: 'qualified' });
      continue;
    }
    if (path.includes(term)) {
      consider({ ...toResult(node), score: 300 + kindBonus, match: 'path' });
    }
  }

  if (includeContent && results.size < limit) {
    scanContents(session, term, consider, limit);
  }

  return Array.from(results.values())
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit);
}

function scanContents(
  session: AnalysisSession,
  term: string,
  consider: (result: SearchResult) => void,
  limit: number,
): void {
  let found = 0;
  for (const [fileId, text] of session.contents) {
    if (found > limit * 3) break;
    const haystack = text.toLowerCase();
    const at = haystack.indexOf(term);
    if (at === -1) continue;
    found++;
    const node = session.index.nodeById.get(fileId);
    if (!node) continue;
    consider({
      ...toResult(node),
      score: 200,
      match: 'content',
      snippet: makeSnippet(text, at, term.length),
    });
  }
}

function makeSnippet(text: string, at: number, length: number): string {
  const start = Math.max(0, at - 40);
  const end = Math.min(text.length, at + length + 60);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return `${prefix}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${suffix}`;
}

function wordStartsWith(name: string, term: string): boolean {
  // "userService" -> ["user","Service"]
  const parts = name.split(/[^a-z0-9]+|(?=[0-9])/).filter(Boolean);
  return parts.some((part) => part.startsWith(term));
}

function toResult(node: AnalysisSession['analysis']['graph']['nodes'][number]): SearchResult {
  return {
    nodeId: node.id,
    kind: node.kind,
    name: node.name,
    qualifiedName: node.qualifiedName,
    filePath: node.filePath,
    namespace: node.namespace,
    score: 0,
    match: 'name',
  };
}

export function findNodeByName(index: AnalysisIndex, name: string): string | null {
  const key = name.toLowerCase();
  const direct = index.nameIndex.get(key);
  if (direct && direct.length > 0) return direct[0];
  return null;
}
