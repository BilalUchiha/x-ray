// Dev utility: mirrors exactly what the app's scanner does for a folder, then
// reports graph statistics, layer grouping and the composed overview view.
// Used to diagnose "the graph is empty / wrong" against realistic projects.
//
//   npx esbuild scripts/scan-check.ts --bundle --platform=node --format=esm --external:node:* --outfile=/tmp/sc.mjs && node /tmp/sc.mjs /tmp/xray-fixtures/dotnet

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { FileMeta, ParsedFile } from '../src/core/types.ts';
import { parseFile } from '../src/core/parser/index.ts';
import { buildAnalysis } from '../src/core/graph/build.ts';
import { buildIndex } from '../src/core/analysis/analyze.ts';
import { composeGraphView, defaultExpandedGroups, PROJECT_ID, scopeNodeId } from '../src/graph/viewModel.ts';
import { GraphLayout } from '../src/graph/layout.ts';
import { isBinaryExtension, looksBinary, countLines, MAX_FILE_BYTES, shouldIgnoreDir } from '../src/core/scanner/ignore.ts';
import { extensionOf, isKnownText, isParseable, languageOf } from '../src/core/scanner/languages.ts';

const root = process.argv[2] ?? '/tmp/xray-fixtures/dotnet';

const files: FileMeta[] = [];
const contents = new Map<string, string>();
const parsed: ParsedFile[] = [];
const skippedByExt = new Map<string, { count: number; reason: string }>();
const ignoredDirs = new Set<string>();

function noteSkip(ext: string, reason: string): void {
  const entry = skippedByExt.get(ext) ?? { count: 0, reason };
  entry.count++;
  skippedByExt.set(ext, entry);
}

function walk(dir: string, prefix: string): void {
  let entries: ReturnType<typeof readdirSync>;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (shouldIgnoreDir(entry.name)) {
        ignoredDirs.add(prefix + entry.name);
        continue;
      }
      walk(join(dir, entry.name), `${prefix}${entry.name}/`);
      continue;
    }
    const id = prefix + entry.name;
    const full = join(dir, entry.name);
    const ext = extensionOf(id);

    if (isBinaryExtension(id)) { noteSkip(ext || '(none)', 'binary extension'); continue; }
    if (!isKnownText(id)) { noteSkip(ext || '(none)', 'extension not supported'); continue; }

    const text = readFileSync(full, 'utf8');
    if (looksBinary(text)) { noteSkip(ext, 'binary content'); continue; }
    const size = statSync(full).size;
    if (size > MAX_FILE_BYTES) { noteSkip(ext, 'too large'); continue; }

    const language = languageOf(id);
    files.push({
      id, path: id, name: entry.name, ext: ext,
      language, size, lines: countLines(text), parsed: isParseable(id),
    });
    contents.set(id, text);
    if (isParseable(id)) parsed.push(parseFile({ fileId: id, language, source: text }));
  }
}

walk(root, '');

console.log('=== SCAN ===');
console.log('files read:', files.length);
console.log('parsed (structural):', parsed.length);
console.log('ignored dirs hit:', Array.from(ignoredDirs).sort().join(', ') || '(none)');
console.log('skipped files by extension:');
for (const [ext, info] of Array.from(skippedByExt.entries()).sort((a, b) => b[1].count - a[1].count)) {
  console.log(`   ${ext.padEnd(12)} ${String(info.count).padStart(3)}  ${info.reason}`);
}

const { analysis } = buildAnalysis({
  analysisId: 'check', name: 'check', rootLabel: 'check',
  files, parsed, durationMs: 1, warnings: [],
});
const index = buildIndex(analysis);
const session = { analysis, index, fileById: new Map(files.map((f) => [f.id, f])), contents, parsed };

console.log('\n=== GRAPH ===');
console.log('stats:', {
  sourceFiles: analysis.stats.sourceFiles,
  classes: analysis.stats.classes,
  interfaces: analysis.stats.interfaces,
  methods: analysis.stats.methods,
  relationships: analysis.stats.relationships,
});

const typeNodes = analysis.graph.nodes.filter((n) => ['class', 'interface', 'record', 'struct', 'enum'].includes(n.kind));
console.log('type nodes:', typeNodes.length, '| file nodes:', analysis.graph.nodes.filter((n) => n.kind === 'file').length);

console.log('\n=== STRUCTURE (scopes) ===');
if ((analysis.scopes ?? []).length === 0) console.log('   (nothing to nest — the project holds every layer directly)');
for (const scope of analysis.scopes ?? []) {
  const indent = '  '.repeat(scope.depth);
  const label = scope.nodeKind === 'app' ? `app(${scope.appKind})` : 'workspace';
  console.log(`   ${indent}${scope.path.padEnd(28)} ${label.padEnd(20)} own=${scope.ownTypes} ${scope.marker ?? ''}`);
}
console.log('   detected build units:', analysis.apps.length === 0 ? '(none)' : analysis.apps.map((a) => a.path || '(root)').join(', '));

console.log('\n=== LAYER GROUPS ===');
if (analysis.groups.length === 0) {
  console.log('!! NO GROUPS — the overview map will be empty');
}
for (const group of analysis.groups) {
  console.log(`   ${(group.appLabel || '(root)').padEnd(26)} ${group.label.padEnd(20)} ${String(group.memberIds.length).padStart(4)}`);
}

console.log('\n=== DEFAULT VIEW (what the user sees first) ===');
const overview = composeGraphView(session, { expandedGroups: defaultExpandedGroups(analysis), expandedTypes: new Set() });
console.log('view nodes:', overview.nodes.length, '| view edges:', overview.edges.length, '| hidden beyond cap:', overview.hiddenNodes);
const kindCounts = new Map<string, number>();
for (const node of overview.nodes) kindCounts.set(node.kind, (kindCounts.get(node.kind) ?? 0) + 1);
console.log('node kinds:', Array.from(kindCounts.entries()).map(([k, n]) => `${k}=${n}`).join(', '));
if (overview.nodes.length <= 3) console.log('!! DEGENERATE: the initial map has almost nothing to show');
if (!overview.nodes.some((n) => ['class', 'interface', 'struct', 'enum', 'record'].includes(n.kind))) {
  console.log('!! NO TYPES visible in the default view');
}
if (overview.edges.filter((e) => e.kind !== 'contains').length === 0) {
  console.log('!! NO relationship edges visible in the default view');
}

console.log('\n=== COLLAPSED (layer-level architecture) ===');
const collapsed = composeGraphView(session, { expandedGroups: new Set(), expandedTypes: new Set() });
console.log('view nodes:', collapsed.nodes.length, '| view edges:', collapsed.edges.length);
console.log('node kinds:', collapsed.kinds.join(', '));

console.log('\n=== TOP TYPES BY CONNECTIONS ===');
const degree = new Map<string, number>();
for (const edge of analysis.graph.edges) {
  if (edge.derived || edge.kind === 'contains') continue;
  degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
  degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
}
for (const node of typeNodes.sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0)).slice(0, 12)) {
  console.log(`   ${node.kind.padEnd(10)} ${node.name.padEnd(28)} degree=${degree.get(node.id) ?? 0} group=${node.groupId ?? '-'} file=${node.filePath}`);
}

console.log('\n=== HIERARCHY LAYOUT (org chart) ===');
{
  const layout = new GraphLayout(overview.nodes, overview.edges.map((e) => ({ source: e.source, target: e.target, kind: e.kind as string, weight: e.weight })), {
    centerX: 0,
    centerY: 0,
  });
  for (let i = 0; i < 40; i++) layout.step();
  const rows = new Map<number, number>();
  for (const node of layout.nodes) rows.set(node.rank, (rows.get(node.rank) ?? 0) + 1);
  console.log('rows:', Array.from(rows.entries()).sort((a, b) => a[0] - b[0]).map(([rank, n]) => `r${rank}=${n}`).join(', '));
  const bounds = layout.bounds();
  console.log(`extent: ${Math.round(bounds.maxX - bounds.minX)} x ${Math.round(bounds.maxY - bounds.minY)}`);

  // 1. No two boxes may overlap anywhere in the chart.
  let overlaps = 0;
  for (let i = 0; i < layout.nodes.length; i++) {
    for (let j = i + 1; j < layout.nodes.length; j++) {
      const a = layout.nodes[i];
      const b = layout.nodes[j];
      const dx = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const dy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      if (dx > 0 && dy > 0) overlaps++;
    }
  }
  console.log(overlaps === 0 ? 'no overlapping boxes anywhere' : `!! ${overlaps} overlapping box pair(s)`);

  // 2. Every child must sit below its parent, and the parent must be centred
  // over its children the way an org chart puts a manager over their team.
  const byId = new Map(layout.nodes.map((n) => [n.id, n]));
  const parentOf = new Map<string, string>();
  const childrenOf = new Map<string, string[]>();
  for (const edge of overview.edges) {
    if (edge.kind !== 'contains') continue;
    parentOf.set(edge.target, edge.source);
    const list = childrenOf.get(edge.source) ?? [];
    list.push(edge.target);
    childrenOf.set(edge.source, list);
  }
  let above = 0;
  for (const node of layout.nodes) {
    const parentId = parentOf.get(node.id);
    const parent = parentId ? byId.get(parentId) : undefined;
    if (!parent) continue;
    if (node.y < parent.y + parent.height - 1) above++;
  }
  let offCentre = 0;
  for (const node of layout.nodes) {
    const kids = childrenOf.get(node.id);
    if (!kids || kids.length === 0) continue;
    const boxes = kids.map((id) => byId.get(id)).filter((box): box is NonNullable<typeof box> => Boolean(box));
    if (boxes.length === 0) continue;
    const left = Math.min(...boxes.map((box) => box.x));
    const right = Math.max(...boxes.map((box) => box.x + box.width));
    const centre = node.x + node.width / 2;
    // Children reserve columns wider than their own box (a child's subtree can
    // be broader still), so a parent only has to be centred over the team's
    // span; being one box outside means the wrap is genuinely off-centre.
    if (centre < left - node.width || centre > right + node.width) offCentre++;
  }
  // 3. Clicking the middle of a box must select that box.
  let missHit = 0;
  for (const node of layout.nodes) {
    const hit = layout.nodeAt(node.x + node.width / 2, node.y + node.height / 2);
    if (!hit || hit.id !== node.id) missHit++;
  }
  console.log(missHit === 0 ? 'clicking the centre of any box selects exactly that box' : `!! ${missHit} box(es) are not hit-testable at their centre`);

  console.log(above === 0 ? 'every child sits below its parent' : `!! ${above} child(ren) are not below their parent`);
  console.log(offCentre === 0 ? 'every parent sits centred over its team' : `!! ${offCentre} parent(s) are not centred over their team`);
  if (layout.nodes.some((n) => !Number.isFinite(n.x) || !Number.isFinite(n.y))) console.log('!! non-finite layout positions');
}

console.log('\n=== FOLD (per-box disclosure) ===');
{
  const open = { expandedGroups: defaultExpandedGroups(analysis), expandedTypes: new Set<string>() };
  const full = composeGraphView(session, { ...open, collapsedSubtree: new Set<string>() });
  const fullIds = new Set(full.nodes.map((n) => n.id));
  const kidsOf = new Map<string, string[]>();
  for (const edge of full.edges) {
    if (edge.kind !== 'contains') continue;
    kidsOf.set(edge.source, [...(kidsOf.get(edge.source) ?? []), edge.target]);
  }
  const descendants = (id: string): Set<string> => {
    const out = new Set<string>();
    const queue = [...(kidsOf.get(id) ?? [])];
    for (let i = 0; i < queue.length; i++) {
      if (out.has(queue[i])) continue;
      out.add(queue[i]);
      queue.push(...(kidsOf.get(queue[i]) ?? []));
    }
    return out;
  };

  // 1. Every box that owns children must offer a way to hide them.
  const noControl = full.nodes.filter((node) => (kidsOf.get(node.id)?.length ?? 0) > 0 && !(node.childCount && node.childCount > 0));
  console.log(noControl.length === 0
    ? 'every box with children carries a disclosure control'
    : `!! ${noControl.length} container(s) cannot be folded`);

  // The control must read the same as the picture: "−" exactly when the
  // children are on screen, "+" exactly when they are hidden.
  const lying = full.nodes.filter((node) => {
    if (!node.childCount) return false;
    const drawnChildren = (kidsOf.get(node.id)?.length ?? 0) > 0;
    return Boolean(node.collapsed) === drawnChildren;
  });
  console.log(lying.length === 0
    ? 'every control matches whether its children are drawn'
    : `!! ${lying.length} control(s) disagree with the picture (e.g. ${lying.slice(0, 3).map((n) => n.id).join(', ')})`);

  // 2. Folding the project leaves the project alone, and it still reports size.
  const folded = composeGraphView(session, { ...open, collapsedSubtree: new Set([PROJECT_ID]) });
  const onlyProject = folded.nodes.length === 1 && folded.nodes[0].id === PROJECT_ID && folded.edges.length === 0;
  console.log(onlyProject ? 'folding the project leaves only the project box' : `!! folding the project left ${folded.nodes.length} nodes / ${folded.edges.length} edges`);
  const root = folded.nodes[0];
  console.log(root?.collapsed ? 'the folded box is marked collapsed' : '!! the folded box is not marked collapsed');
  console.log(root?.childCount ? `the folded box still advertises ${root.childCount} children` : '!! the folded box lost its child count');

  // 3. Folding a scope hides exactly its descendants — no unrelated box, no
  //    dangling relationship edge pointing into the hidden subtree.
  let checked = 0;
  for (const scope of (analysis.scopes ?? [])) {
    const id = scopeNodeId(scope.path);
    if (!fullIds.has(id)) continue;
    const hidden = descendants(id);
    if (hidden.size === 0) continue;
    checked++;
    const cut = composeGraphView(session, { ...open, collapsedSubtree: new Set([id]) });
    const cutIds = new Set(cut.nodes.map((n) => n.id));
    const expected = new Set([...fullIds].filter((nodeId) => !hidden.has(nodeId)));
    const lost = [...expected].filter((nodeId) => !cutIds.has(nodeId));
    const extra = [...cutIds].filter((nodeId) => !expected.has(nodeId));
    const dangling = cut.edges.filter((edge) => hidden.has(edge.source) || hidden.has(edge.target)).length;
    const ok = lost.length === 0 && extra.length === 0 && dangling === 0 && cutIds.has(id);
    console.log(ok
      ? `folding ${scope.path} hides exactly its ${hidden.size} descendant(s)`
      : `!! folding ${scope.path}: ${lost.length} unrelated box(es) lost, ${extra.length} extra, ${dangling} dangling edge(s)`);
  }
  if (checked === 0) console.log('   (no nested scope has descendants in the default view)');

  // 4. The folder tree follows the same rule, and starts folded except for
  //    its top level.
  const treeOpen = composeGraphView(session, { mode: 'structure', expandedGroups: new Set<string>(), expandedTypes: new Set<string>() });
  const treeFolded = composeGraphView(session, { mode: 'structure', expandedGroups: new Set<string>(), expandedTypes: new Set<string>(), collapsedSubtree: new Set([PROJECT_ID]) });
  console.log(treeFolded.nodes.length === 1
    ? `the folder tree folds to the project too (default tree: ${treeOpen.nodes.length} boxes)`
    : `!! folding the project in structure mode left ${treeFolded.nodes.length} nodes`);

  // 5. Unfolding must bring the map back byte for byte.
  const restored = composeGraphView(session, { ...open, collapsedSubtree: new Set<string>() });
  const key = (view: typeof full) => `${view.nodes.map((n) => n.id).sort().join(',')}|${view.edges.map((e) => `${e.source}>${e.target}:${e.kind}`).sort().join(',')}`;
  console.log(key(restored) === key(full) ? 'unfolding restores the map exactly' : '!! unfolding did not restore the map');
}

console.log('\n=== RELATIONSHIP EDGES ===');
const label = (id: string): string => {
  const node = index.nodeById.get(id);
  return node ? `${node.name}${node.kind === 'file' ? '' : ''}` : id;
};
let shown = 0;
for (const edge of analysis.graph.edges) {
  if (edge.derived || edge.kind === 'contains') continue;
  if (shown++ >= 40) { console.log('   …'); break; }
  console.log(`   ${edge.kind.padEnd(12)} ${label(edge.source)} -> ${label(edge.target)}`);
}
if (shown === 0) console.log('   (none detected)');
