// Directories and file globs that are never useful for structural analysis.
// NOTE: .git is listed here only because it is irrelevant to reading source
// code. X-Ray implements no Git functionality whatsoever — it never reads
// refs, objects, history, branches or remotes.

export const IGNORED_DIRS = new Set([
  'node_modules',
  'bin',
  'obj',
  'dist',
  'build',
  'out',
  'coverage',
  'vendor',
  'packages',
  '.git',
  '.vs',
  '.vscode',
  '.idea',
  '.fleet',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '__pycache__',
  '.venv',
  'venv',
  'env',
  'target',
  'Debug',
  'Release',
  'TestResults',
  'publish',
  'artifacts',
  '.terraform',
  '.npm',
  '.pnpm-store',
  'bower_components',
  'jspm_packages',
  '.angular',
  '.gradle',
  '.mypy_cache',
  '.pytest_cache',
  '.DS_Store',
  'Temp',
  'temp',
  'logs',
]);

/** Directory names that get ignored only when they match exactly, case-sensitively. */
export const MAX_DEPTH = 24;
export const MAX_FILE_BYTES = 4 * 1024 * 1024; // 4 MB — larger files are skipped with a warning.
export const MAX_SCAN_FILES = 60_000;

export function shouldIgnoreDir(name: string): boolean {
  if (IGNORED_DIRS.has(name)) return true;
  // Minified / generated bundles that sometimes live at the root.
  if (/^(dist|build|out)-/i.test(name)) return true;
  return false;
}

const BINARY_EXT = new Set([
  '.dll', '.exe', '.pdb', '.so', '.dylib', '.a', '.lib', '.obj', '.o',
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.avif', '.svgz',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.zip', '.gz', '.tar', '.7z', '.rar', '.bz2', '.xz',
  '.mp3', '.mp4', '.mov', '.avi', '.wav', '.flac', '.webm',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.db', '.sqlite', '.sqlite3', '.mdf', '.ldf',
  '.nupkg', '.snupkg', '.wasm', '.class', '.jar', '.pyc', '.bin', '.dat',
  '.map', '.lock', '.min.js', '.min.css',
]);

export function isBinaryExtension(path: string): boolean {
  const lower = path.toLowerCase();
  for (const ext of BINARY_EXT) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

/** Cheap binary sniff: NUL byte in the first chunk means "not text". */
export function looksBinary(text: string): boolean {
  const probe = text.slice(0, 2000);
  return probe.includes('\u0000');
}

export function detectLineEndingSplit(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

export function countLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lines++;
  }
  return lines;
}
