import {
  countLines,
  isBinaryExtension,
  looksBinary,
  MAX_DEPTH,
  MAX_FILE_BYTES,
  MAX_SCAN_FILES,
  shouldIgnoreDir,
} from '../scanner/ignore';
import { isKnownText, isParseable, languageOf } from '../scanner/languages';
import type { SourceDir, SourceEntry, SourceFile, FolderSource } from '../fs/source';
import { parseFile } from '../parser';
import { buildAnalysis, PROJECT_NODE_ID } from '../graph/build';
import type {
  Analysis,
  AnalysisIndex,
  AnalysisSession,
  AnalysisWarning,
  CodeNode,
  FileMeta,
  ParsedFile,
} from '../types';

export interface AnalysisCounters {
  files?: number;
  sourceFiles?: number;
  folders?: number;
  types?: number;
  members?: number;
  relations?: number;
  nodes?: number;
  relationships?: number;
}

export interface AnalysisProgress {
  phase: 'scanning' | 'languages' | 'parsing' | 'symbols' | 'dependencies' | 'graph';
  /** Short label shown next to the phase in the UI. */
  label: string;
  completed: number;
  total: number;
  filesFound: number;
  detail?: string;
  /** Real counters surfaced as the pipeline passes each stage. */
  counters?: AnalysisCounters;
}

export interface AnalyzeResult {
  session: AnalysisSession;
}

interface PendingFile {
  meta: FileMeta;
  file: SourceFile;
}

const READ_CONCURRENCY = 24;

export async function analyzeFolder(
  source: FolderSource,
  onProgress: (progress: AnalysisProgress) => void,
  signal?: AbortSignal,
): Promise<AnalysisSession> {
  const started = Date.now();
  const warnings: AnalysisWarning[] = [];

  // --- 1. Scan ------------------------------------------------------------
  const pending: PendingFile[] = [];
  let scanned = 0;
  const queue: Array<{ dir: SourceDir; depth: number }> = [{ dir: source.root, depth: 0 }];
  let truncated = false;

  onProgress({ phase: 'scanning', label: 'Scanning files', completed: 0, total: 0, filesFound: 0 });

  while (queue.length > 0) {
    throwIfAborted(signal);
    const { dir, depth } = queue.shift()!;
    if (depth > MAX_DEPTH) {
      warnings.push({ kind: 'unsupported', path: dir.path, message: `Directory nesting deeper than ${MAX_DEPTH} levels was skipped.` });
      continue;
    }

    let entries: SourceEntry[];
    try {
      entries = await dir.list();
    } catch (err) {
      warnings.push({ kind: 'unreadable', path: dir.path || '.', message: describe(err) });
      continue;
    }

    for (const entry of entries) {
      if (entry.kind === 'dir') {
        if (shouldIgnoreDir(entry.dir.name)) continue;
        queue.push({ dir: entry.dir, depth: depth + 1 });
        continue;
      }

      scanned++;
      if (scanned > MAX_SCAN_FILES) {
        truncated = true;
        queue.length = 0;
        break;
      }

      const path = entry.file.path;
      if (isBinaryExtension(path)) continue;
      if (!isKnownText(path)) continue;

      const language = languageOf(path);
      pending.push({
        meta: {
          id: path,
          path,
          name: entry.file.name,
          ext: path.slice(path.lastIndexOf('.')),
          language,
          size: 0,
          lines: 0,
          parsed: isParseable(path),
        },
        file: entry.file,
      });

      if (pending.length % 40 === 0) {
        onProgress({
          phase: 'scanning',
          label: 'Scanning files',
          completed: pending.length,
          total: 0,
          filesFound: pending.length,
          detail: path,
        });
        await yieldToUi();
      }
    }
  }

  if (truncated) {
    warnings.push({ kind: 'unsupported', path: '.', message: `Scan stopped after ${MAX_SCAN_FILES.toLocaleString()} files.` });
  }

  onProgress({
    phase: 'scanning',
    label: 'Scanning files',
    completed: pending.length,
    total: pending.length,
    filesFound: pending.length,
    counters: { files: pending.length },
  });

  // --- 2. Read ------------------------------------------------------------
  const files: FileMeta[] = [];
  const contents = new Map<string, string>();
  const readable: PendingFile[] = [];

  for (let i = 0; i < pending.length; i += READ_CONCURRENCY) {
    throwIfAborted(signal);
    const batch = pending.slice(i, i + READ_CONCURRENCY);
    await Promise.all(
      batch.map(async (item) => {
        try {
          const text = await item.file.readText();
          if (looksBinary(text)) {
            warnings.push({ kind: 'binary', path: item.meta.path, message: 'File contains binary data and was skipped.' });
            return;
          }
          const bytes = estimateBytes(text);
          if (bytes > MAX_FILE_BYTES) {
            warnings.push({ kind: 'too-large', path: item.meta.path, message: `File is ${formatBytes(bytes)} — larger than the ${formatBytes(MAX_FILE_BYTES)} analysis limit.` });
            return;
          }
          item.meta.size = bytes;
          item.meta.lines = countLines(text);
          files.push(item.meta);
          contents.set(item.meta.id, text);
          readable.push(item);
        } catch (err) {
          warnings.push({ kind: 'unreadable', path: item.meta.path, message: describe(err) });
        }
      }),
    );
    onProgress({
      phase: 'scanning',
      label: 'Reading files',
      completed: Math.min(i + batch.length, pending.length),
      total: pending.length,
      filesFound: files.length,
    });
  }

  files.sort((a, b) => a.path.localeCompare(b.path));

  // --- 3. Languages -------------------------------------------------------
  const parseTargets = files.filter((f) => f.parsed);
  onProgress({
    phase: 'languages',
    label: 'Detecting languages',
    completed: files.length,
    total: files.length,
    filesFound: files.length,
    detail: `${files.length.toLocaleString()} files · ${parseTargets.length.toLocaleString()} with a parser`,
    counters: { files: files.length, sourceFiles: parseTargets.length },
  });

  // --- 4. Parse -----------------------------------------------------------
  const parsed: ParsedFile[] = [];
  onProgress({
    phase: 'parsing',
    label: 'Parsing source code',
    completed: 0,
    total: parseTargets.length,
    filesFound: files.length,
    counters: { files: files.length, sourceFiles: parseTargets.length },
  });

  for (let i = 0; i < parseTargets.length; i++) {
    throwIfAborted(signal);
    const meta = parseTargets[i];
    const text = contents.get(meta.id) ?? '';
    const result = parseFile({ fileId: meta.id, language: meta.language, source: text });
    if (result.errors.length) {
      for (const error of result.errors) warnings.push({ ...error, path: meta.path });
    }
    parsed.push(result);

    if (i % 25 === 0 || i === parseTargets.length - 1) {
      onProgress({
        phase: 'parsing',
        label: 'Parsing source code',
        completed: i + 1,
        total: parseTargets.length,
        filesFound: files.length,
        detail: meta.path,
      });
      await yieldToUi();
    }
  }

  // --- 5. Symbols ---------------------------------------------------------
  const typeCount = parsed.reduce((sum, p) => sum + p.types.length, 0);
  const memberCount = parsed.reduce((sum, p) => sum + p.members.length, 0);
  onProgress({
    phase: 'symbols',
    label: 'Finding symbols',
    completed: typeCount,
    total: typeCount,
    filesFound: files.length,
    detail: `${typeCount.toLocaleString()} types · ${memberCount.toLocaleString()} members`,
    counters: { files: files.length, sourceFiles: parseTargets.length, types: typeCount, members: memberCount },
  });
  await yieldToUi();

  // --- 6. Dependencies + graph -------------------------------------------
  const relationCount = parsed.reduce((sum, p) => sum + p.relations.length, 0);
  onProgress({
    phase: 'dependencies',
    label: 'Finding dependencies',
    completed: relationCount,
    total: relationCount,
    filesFound: files.length,
    detail: `${relationCount.toLocaleString()} raw references observed`,
    counters: { files: files.length, sourceFiles: parseTargets.length, types: typeCount, members: memberCount, relations: relationCount },
  });
  await yieldToUi();

  const analysisId = makeAnalysisId(source.name, source.origin);
  const { analysis, declared } = buildAnalysis({
    analysisId,
    name: source.name,
    rootLabel: source.origin,
    files,
    parsed,
    durationMs: Date.now() - started,
    warnings,
  });

  onProgress({
    phase: 'graph',
    label: 'Building code graph',
    completed: analysis.graph.nodes.length,
    total: analysis.graph.nodes.length,
    filesFound: files.length,
    detail: `${analysis.graph.nodes.length.toLocaleString()} nodes · ${analysis.stats.relationships.toLocaleString()} relationships`,
    counters: {
      files: files.length,
      sourceFiles: parseTargets.length,
      folders: analysis.stats.folders,
      types: typeCount,
      members: memberCount,
      relations: relationCount,
      nodes: analysis.graph.nodes.length,
      relationships: analysis.stats.relationships,
    },
  });
  await yieldToUi();

  const fileById = new Map(files.map((f) => [f.id, f]));
  const index = buildIndex(analysis);
  void declared;

  return { analysis, index, fileById, contents, parsed };
}

export function buildIndex(analysis: Analysis): AnalysisIndex {
  const nodeById = new Map<string, CodeNode>();
  const childrenOf = new Map<string, string[]>();
  const nameIndex = new Map<string, string[]>();

  for (const node of analysis.graph.nodes) {
    nodeById.set(node.id, node);
    if (node.parentId) {
      const list = childrenOf.get(node.parentId) ?? [];
      list.push(node.id);
      childrenOf.set(node.parentId, list);
    }
    const key = node.name.toLowerCase();
    const names = nameIndex.get(key) ?? [];
    names.push(node.id);
    nameIndex.set(key, names);
  }

  return { nodeById, childrenOf, nameIndex };
}

/**
 * A stable id per analysed folder, so rescanning updates the stored workspace
 * instead of piling up duplicates.
 *
 * Browsers do not expose absolute paths for a picked folder, so the id is keyed
 * by folder name and how it was opened. Two different folders that happen to
 * share a name will therefore share a workspace slot.
 */
export function makeAnalysisId(name: string, origin: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
  return `${slug}--${origin}`;
}

export function estimateBytes(text: string): number {
  if (text.length > 1_000_000) return text.length;
  return new TextEncoder().encode(text).length;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Analysis cancelled', 'AbortError');
}

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function describe(err: unknown): string {
  if (err instanceof DOMException && err.name === 'NotAllowedError') {
    return 'Permission to read this path was denied.';
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

export { PROJECT_NODE_ID };
