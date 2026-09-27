// Context retrieval.
//
// X-Ray never sends the whole folder. A question is turned into search terms,
// matched against the graph, expanded to a small neighbourhood of related
// components, and only then are the *relevant line ranges* of the files that
// declare those components pulled out. Everything included is reported back to
// the UI so the developer can see exactly what the model received.

import type { AnalysisSession, CodeNode, LanguageId, NodeKind } from '../types';

export interface ContextFile {
  path: string;
  language: LanguageId;
  reason: string;
  excerpt: string;
  /** Line numbers the excerpt covers (1-based, inclusive). */
  startLine: number;
  endLine: number;
  truncated: boolean;
  tokens: number;
}

export interface ContextNode {
  id: string;
  name: string;
  kind: NodeKind;
  reason: string;
}

export interface AiContext {
  question: string;
  files: ContextFile[];
  nodes: ContextNode[];
  excludedFiles: number;
  totalFiles: number;
  estimatedTokens: number;
  notes: string[];
  selectedNodeId: string | null;
}

export interface BuildContextOptions {
  selectedNodeId?: string | null;
  maxFiles?: number;
  maxTokens?: number;
  linesPerSymbol?: number;
}

const CHARS_PER_TOKEN = 4;
const MAX_SEEDS = 10;
const NEIGHBOUR_LIMIT = 14;

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}

export function buildContext(session: AnalysisSession, question: string, options: BuildContextOptions = {}): AiContext {
  const maxFiles = options.maxFiles ?? 10;
  const maxTokens = options.maxTokens ?? 14000;
  const linesPerSymbol = options.linesPerSymbol ?? 70;
  const selectedNodeId = options.selectedNodeId ?? null;

  const { analysis, index, contents } = session;
  const terms = termsOf(question);
  const notes: string[] = [];

  // --- 1. Seed selection ---------------------------------------------------
  const seeds = new Map<string, string>(); // nodeId -> reason

  if (selectedNodeId) {
    const node = index.nodeById.get(selectedNodeId);
    if (node) seeds.set(node.id, 'selected component');
  }

  const scored: Array<{ node: CodeNode; score: number; reason: string }> = [];
  for (const node of analysis.graph.nodes) {
    if (!isMeaningful(node.kind)) continue;
    const { score, reason } = scoreNode(node, terms);
    if (score > 0) scored.push({ node, score, reason });
  }
  scored.sort((a, b) => b.score - a.score);

  for (const entry of scored.slice(0, MAX_SEEDS)) {
    if (!seeds.has(entry.node.id)) seeds.set(entry.node.id, entry.reason);
  }

  if (seeds.size === 0) {
    notes.push('No symbols matched the question directly — including the most connected components instead.');
    for (const node of topConnected(analysis.graph.nodes, index.childrenOf, 6)) {
      seeds.set(node.id, 'highly connected component');
    }
  }

  // --- 2. One-hop neighbourhood -------------------------------------------
  const included = new Map<string, string>(seeds);
  const adjacency = new Map<string, Array<{ id: string; kind: string }>>();
  for (const edge of analysis.graph.edges) {
    if (edge.derived) continue;
    if (edge.kind === 'contains' || edge.kind === 'imports') continue;
    push(adjacency, edge.source, { id: edge.target, kind: edge.kind });
    push(adjacency, edge.target, { id: edge.source, kind: edge.kind });
  }

  let neighbours = 0;
  for (const [seedId, reason] of Array.from(seeds)) {
    for (const neighbour of adjacency.get(seedId) ?? []) {
      if (included.has(neighbour.id)) continue;
      const node = index.nodeById.get(neighbour.id);
      if (!node || !isMeaningful(node.kind)) continue;
      if (neighbours >= NEIGHBOUR_LIMIT) break;
      included.set(neighbour.id, `${neighbour.kind} related to ${index.nodeById.get(seedId)?.name ?? 'selection'} (${reason})`);
      neighbours++;
    }
    if (neighbours >= NEIGHBOUR_LIMIT) break;
  }

  // --- 3. Files + excerpts ------------------------------------------------
  const byFile = new Map<string, { reasons: Set<string>; nodes: CodeNode[] }>();
  for (const [id, reason] of included) {
    const node = index.nodeById.get(id);
    if (!node?.fileId) continue;
    const entry = byFile.get(node.fileId) ?? { reasons: new Set<string>(), nodes: [] };
    entry.reasons.add(reason);
    entry.nodes.push(node);
    byFile.set(node.fileId, entry);
  }

  const rankedFiles = Array.from(byFile.entries()).sort((a, b) => {
    const aSeed = a[1].nodes.some((n) => seeds.has(n.id)) ? 1 : 0;
    const bSeed = b[1].nodes.some((n) => seeds.has(n.id)) ? 1 : 0;
    return bSeed - aSeed || b[1].nodes.length - a[1].nodes.length;
  });

  const files: ContextFile[] = [];
  let budget = maxTokens;

  for (const [fileId, entry] of rankedFiles) {
    if (files.length >= maxFiles) break;
    const text = contents.get(fileId);
    if (text === undefined) continue;

    const ranges = relevantRanges(entry.nodes, text, linesPerSymbol);
    const excerpt = buildExcerpt(text, ranges);
    const tokens = estimateTokens(excerpt.text);
    if (tokens > budget && files.length > 0) break;
    budget -= tokens;

    const reason = Array.from(entry.reasons).slice(0, 3).join('; ');
    files.push({
      path: fileId,
      language: index.nodeById.get(fileId)?.language ?? 'unknown',
      reason,
      excerpt: excerpt.text,
      startLine: excerpt.startLine,
      endLine: excerpt.endLine,
      truncated: excerpt.truncated,
      tokens,
    });
  }

  const nodes: ContextNode[] = Array.from(included.entries())
    .map(([id, reason]) => {
      const node = index.nodeById.get(id);
      return node ? { id, name: node.name, kind: node.kind, reason } : null;
    })
    .filter((entry): entry is ContextNode => entry !== null)
    .slice(0, 40);

  return {
    question,
    files,
    nodes,
    excludedFiles: Math.max(0, session.fileById.size - files.length),
    totalFiles: session.fileById.size,
    estimatedTokens: files.reduce((sum, file) => sum + file.tokens, 0),
    notes,
    selectedNodeId,
  };
}

// -- helpers ----------------------------------------------------------------

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'does', 'do', 'how', 'what',
  'where', 'who', 'why', 'when', 'which', 'and', 'or', 'of', 'to', 'in', 'on',
  'for', 'with', 'this', 'that', 'these', 'those', 'it', 'its', 'be', 'been',
  'being', 'have', 'has', 'had', 'can', 'could', 'should', 'would', 'will',
  'work', 'works', 'used', 'use', 'using', 'happen', 'happens', 'explain',
  'tell', 'me', 'about', 'my', 'our', 'your', 'code', 'codebase', 'class',
  'classes', 'file', 'files', 'method', 'methods', 'function', 'functions',
  'project', 'app', 'application', 'please', 'any', 'all', 'from', 'get',
]);

function termsOf(question: string): string[] {
  const words = question
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));
  return Array.from(new Set(words)).slice(0, 20);
}

function isMeaningful(kind: NodeKind): boolean {
  return kind === 'class' || kind === 'interface' || kind === 'struct'
    || kind === 'enum' || kind === 'record' || kind === 'method'
    || kind === 'function' || kind === 'constructor'
    || kind === 'property' || kind === 'field' || kind === 'file';
}

function scoreNode(node: CodeNode, terms: string[]): { score: number; reason: string } {
  if (terms.length === 0) return { score: 0, reason: '' };
  const name = node.name.toLowerCase();
  const qualified = (node.qualifiedName ?? '').toLowerCase();
  const path = (node.filePath ?? '').toLowerCase();
  let score = 0;
  let matched: string[] = [];

  for (const term of terms) {
    if (name === term) { score += 120; matched.push(term); continue; }
    if (name.startsWith(term)) { score += 60; matched.push(term); continue; }
    if (name.includes(term)) { score += 35; matched.push(term); continue; }
    // Word-stem overlap, so "authentication" finds AuthService / AuthController.
    if (sharesStem(name, term)) { score += 45; matched.push(term); continue; }
    if (qualified.includes(term)) { score += 18; matched.push(term); continue; }
    if (path.includes(term)) { score += 8; matched.push(term); }
  }
  if (score === 0) return { score: 0, reason: '' };

  // Prefer types over files/members when scores tie.
  if (node.kind === 'class' || node.kind === 'interface' || node.kind === 'record') score += 6;
  matched = Array.from(new Set(matched)).slice(0, 3);
  return { score, reason: `matches “${matched.join('”, “')}”` };
}

const STEM_MIN = 4;

/** True when a word in `name` and `term` share a leading stem of >= 4 characters. */
function sharesStem(name: string, term: string): boolean {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  for (const word of words) {
    if (word.length < STEM_MIN || term.length < STEM_MIN) continue;
    const limit = Math.min(word.length, term.length);
    let common = 0;
    while (common < limit && word[common] === term[common]) common++;
    if (common >= STEM_MIN) return true;
  }
  return false;
}

function topConnected(
  nodes: CodeNode[],
  childrenOf: Map<string, string[]>,
  limit: number,
): CodeNode[] {
  const degree = new Map<string, number>();
  for (const node of nodes) {
    const members = childrenOf.get(node.id)?.length ?? 0;
    degree.set(node.id, members);
  }
  return nodes
    .filter((node) => node.kind === 'class' || node.kind === 'interface' || node.kind === 'record')
    .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))
    .slice(0, limit);
}

interface Range {
  start: number;
  end: number;
}

function relevantRanges(nodes: CodeNode[], text: string, linesPerSymbol: number): Range[] {
  const totalLines = countLines(text);
  const ranges: Range[] = [];
  for (const node of nodes) {
    if (node.startLine && node.endLine) {
      ranges.push({ start: node.startLine, end: node.endLine });
    }
  }
  if (ranges.length === 0) return [{ start: 1, end: Math.min(totalLines, linesPerSymbol) }];

  ranges.sort((a, b) => a.start - b.start);
  const merged: Range[] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + 2) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }

  // Cap the amount taken from any single file.
  const capped: Range[] = [];
  let used = 0;
  for (const range of merged) {
    if (used >= linesPerSymbol * 2) break;
    const length = range.end - range.start + 1;
    if (used + length <= linesPerSymbol * 2) {
      capped.push(range);
      used += length;
    } else {
      const remaining = linesPerSymbol * 2 - used;
      if (remaining > 8) capped.push({ start: range.start, end: range.start + remaining - 1 });
      used += remaining;
      break;
    }
  }
  return capped.length ? capped : [{ start: 1, end: Math.min(totalLines, linesPerSymbol) }];
}

function buildExcerpt(text: string, ranges: Range[]): { text: string; startLine: number; endLine: number; truncated: boolean } {
  const lines = text.split(/\r\n|\r|\n/);
  const parts: string[] = [];
  const first = ranges[0].start;
  const last = ranges[ranges.length - 1].end;
  let previousEnd = 0;

  for (const range of ranges) {
    const start = Math.max(1, range.start);
    const end = Math.min(lines.length, range.end);
    if (start > end) continue;
    if (previousEnd && start > previousEnd + 1) {
      parts.push(`// … ${start - previousEnd - 1} line(s) omitted …`);
    }
    for (let i = start; i <= end; i++) parts.push(lines[i - 1]);
    previousEnd = end;
  }

  const truncated = first > 1 || last < lines.length;
  return { text: parts.join('\n'), startLine: first, endLine: last, truncated };
}

function countLines(text: string): number {
  let count = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) count++;
  return count;
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key) ?? [];
  list.push(value);
  map.set(key, list);
}

/** Finds components mentioned in an AI answer so they can be highlighted. */
export function detectReferencedNodes(session: AnalysisSession, answer: string): Array<{ id: string; name: string; kind: NodeKind }> {
  if (!answer) return [];
  const identifiers = new Set<string>();
  const re = /[A-Z][A-Za-z0-9_]{2,}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(answer))) identifiers.add(match[0]);
  const codeSpans = answer.match(/`([^`]+)`/g) ?? [];
  for (const span of codeSpans) {
    const inner = span.slice(1, -1);
    for (const part of inner.split(/[^A-Za-z0-9_]+/)) {
      if (/^[A-Z][A-Za-z0-9_]{2,}$/.test(part)) identifiers.add(part);
    }
  }

  const found: Array<{ id: string; name: string; kind: NodeKind }> = [];
  const seen = new Set<string>();
  for (const identifier of identifiers) {
    const ids = session.index.nameIndex.get(identifier.toLowerCase());
    if (!ids) continue;
    for (const id of ids) {
      const node = session.index.nodeById.get(id);
      if (!node) continue;
      if (!isMeaningful(node.kind)) continue;
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      found.push({ id: node.id, name: node.name, kind: node.kind });
      break;
    }
  }
  return found.slice(0, 30);
}
