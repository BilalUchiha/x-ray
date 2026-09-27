// Dev utility: runs scan -> parse -> graph -> context -> impact over the
// bundled sample project, so the analysis engine can be checked without a UI.
//
//   npx esbuild scripts/engine-check.ts --bundle --platform=node --format=esm --outfile=/tmp/engine.mjs && node /tmp/engine.mjs

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { FileMeta, ParsedFile } from '../src/core/types.ts';
import { parseFile } from '../src/core/parser/index.ts';
import { buildAnalysis } from '../src/core/graph/build.ts';
import { buildIndex } from '../src/core/analysis/analyze.ts';
import { buildContext, detectReferencedNodes } from '../src/core/ai/context.ts';
import { computeImpact } from '../src/core/analysis/impact.ts';
import { languageOf, isParseable } from '../src/core/scanner/languages.ts';
import { countLines } from '../src/core/scanner/ignore.ts';

const ROOT = 'public/sample-project';

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files: FileMeta[] = [];
const contents = new Map<string, string>();
const parsed: ParsedFile[] = [];

for (const full of walk(ROOT)) {
  const id = relative(ROOT, full).split(sep).join('/');
  const text = readFileSync(full, 'utf8');
  files.push({
    id,
    path: id,
    name: id.slice(id.lastIndexOf('/') + 1),
    ext: id.slice(id.lastIndexOf('.')),
    language: languageOf(id),
    size: statSync(full).size,
    lines: countLines(text),
    parsed: isParseable(id),
  });
  contents.set(id, text);
  if (isParseable(id)) parsed.push(parseFile({ fileId: id, language: languageOf(id), source: text }));
}

const { analysis } = buildAnalysis({
  analysisId: 'sample',
  name: 'Sample.Api',
  rootLabel: 'sample',
  files,
  parsed,
  durationMs: 1,
  warnings: [],
});

const index = buildIndex(analysis);
const session = { analysis, index, fileById: new Map(files.map((f) => [f.id, f])), contents, parsed };

console.log('nodes:', analysis.graph.nodes.length);
console.log('edges (total):', analysis.graph.edges.length);
console.log('edges (primary):', analysis.graph.edges.filter((e) => !e.derived).length);
console.log('stats:', analysis.stats);
console.log('groups:', analysis.groups.map((g) => `${g.label}=${g.memberIds.length}`).join(', '));

const byKind = new Map<string, number>();
for (const edge of analysis.graph.edges) byKind.set(edge.kind, (byKind.get(edge.kind) ?? 0) + 1);
console.log('edge kinds:', Array.from(byKind.entries()).map(([k, v]) => `${k}:${v}`).join(', '));

console.log('\n--- all calls edges ---');
const callEdges = analysis.graph.edges.filter((e) => e.kind === 'calls' && !e.derived);
for (const edge of callEdges) {
  const s = index.nodeById.get(edge.source);
  const t = index.nodeById.get(edge.target);
  const owner = s?.parentId ? index.nodeById.get(s.parentId)?.name : '';
  console.log(`  ${owner}.${s?.name} -> ${index.nodeById.get(t?.parentId ?? '')?.name ?? ''}.${t?.name}`);
}

console.log('\n--- context for "How does authentication work?" ---');
const context = buildContext(session, 'How does authentication work?');
console.log('files:', context.files.map((f) => `${f.path} (L${f.startLine}-${f.endLine}, ${f.tokens}tok)`));
console.log('excluded:', context.excludedFiles, 'of', context.totalFiles);
console.log('estimated tokens:', context.estimatedTokens);
console.log('nodes:', context.nodes.map((n) => n.name).join(', '));

console.log('\n--- context for "Where is the database connection configured?" ---');
const context2 = buildContext(session, 'Where is the database connection configured?');
console.log('files:', context2.files.map((f) => f.path));

console.log('\n--- context for "Explain UserService" ---');
const context3 = buildContext(session, 'Explain UserService');
console.log('files:', context3.files.map((f) => f.path));

console.log('\n--- referenced components in a sample answer ---');
const answer = [
  'Authentication starts in `AuthController`, which calls `IAuthService` implemented by AuthService.',
  'AuthService depends on IUserRepository for lookups and uses IPasswordHasher to verify the',
  'password, then delegates to JwtService via IJwtService.CreateToken to mint the token.',
  'The DI wiring lives in ServiceCollectionExtensions. Nothing outside this folder depends on it.',
].join('\n');
const referenced = detectReferencedNodes(session, answer);
console.log(referenced.map((n) => `${n.name} (${n.kind})`).join(', '));

console.log('\n--- impact of AuthService ---');
const authService = analysis.graph.nodes.find((n) => n.name === 'AuthService');
if (authService) {
  const impact = computeImpact(session, authService.id, { depth: 3 });
  console.log('dependencies:', impact.dependencies.map((d) => d.name));
  console.log('direct dependents:', impact.dependents.map((d) => d.name));
  console.log('indirect:', impact.indirect.map((d) => `${d.name}(+${d.distance})`));
} else {
  console.log('AuthService not found!');
}
