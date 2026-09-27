// A real C# tokenizer.
//
// This is a hand-written scanner rather than a pile of regular expressions:
// it understands line/block/documentation comments, preprocessor directives,
// regular / verbatim / interpolated / raw string literals, character literals
// and numeric literals, and it tracks exact 1-based line numbers. The parser
// downstream consumes this token stream.

export type TokenKind =
  | 'ident'
  | 'keyword'
  | 'number'
  | 'string'
  | 'char'
  | 'punct'
  | 'directive'
  | 'eof';

export interface Token {
  kind: TokenKind;
  value: string;
  line: number;
  col: number;
  start: number;
  end: number;
  /** Names referenced inside interpolated strings, for usage extraction. */
  interpolationRefs?: string[];
}

export const CSHARP_KEYWORDS = new Set([
  'abstract', 'as', 'base', 'bool', 'break', 'byte', 'case', 'catch', 'char',
  'checked', 'class', 'const', 'continue', 'decimal', 'default', 'delegate',
  'do', 'double', 'else', 'enum', 'event', 'explicit', 'extern', 'false',
  'finally', 'fixed', 'float', 'for', 'foreach', 'goto', 'if', 'implicit',
  'in', 'int', 'interface', 'internal', 'is', 'lock', 'long', 'namespace',
  'new', 'null', 'object', 'operator', 'out', 'override', 'params', 'private',
  'protected', 'public', 'readonly', 'ref', 'return', 'sbyte', 'sealed',
  'short', 'sizeof', 'stackalloc', 'static', 'string', 'struct', 'switch',
  'this', 'throw', 'true', 'try', 'typeof', 'uint', 'ulong', 'unchecked',
  'unsafe', 'ushort', 'using', 'virtual', 'void', 'volatile', 'while',
]);

/** Contextual keywords — these may appear as ordinary identifiers too. */
export const CSHARP_CONTEXTUAL = new Set([
  'add', 'alias', 'and', 'as', 'ascending', 'async', 'await', 'by',
  'descending', 'dynamic', 'equals', 'file', 'from', 'get', 'global', 'group',
  'init', 'into', 'join', 'let', 'managed', 'nameof', 'nint', 'not', 'notnull',
  'nuint', 'on', 'or', 'orderby', 'partial', 'record', 'remove', 'required',
  'scoped', 'select', 'set', 'unmanaged', 'value', 'var', 'when', 'where',
  'with', 'yield',
]);

/** Modifiers that can precede a type or member declaration. */
export const MODIFIERS = new Set([
  'public', 'private', 'protected', 'internal', 'static', 'sealed', 'abstract',
  'partial', 'readonly', 'ref', 'file', 'unsafe', 'new', 'virtual', 'override',
  'async', 'extern', 'const', 'required', 'volatile', 'fixed', 'extern',
]);

const PUNCT_PAIRS = ['=>', '::', '?.', '??', '?[', '..'];

export function tokenizeCSharp(source: string): Token[] {
  const tokens: Token[] = [];
  const n = source.length;
  let i = 0;
  let line = 1;
  let lineStart = 0;

  const push = (kind: TokenKind, value: string, start: number, startLine: number, startCol: number, refs?: string[]) => {
    const token: Token = { kind, value, line: startLine, col: startCol, start, end: i };
    if (refs && refs.length) token.interpolationRefs = refs;
    tokens.push(token);
  };

  while (i < n) {
    const ch = source[i];

    // Whitespace
    if (ch === '\n') {
      line++; i++; lineStart = i; continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\f' || ch === '\v') {
      i++; continue;
    }

    // Line comments (including /// documentation)
    if (ch === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }

    // Block comments (including /** */ documentation)
    if (ch === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') { line++; lineStart = i + 1; }
        i++;
      }
      i = Math.min(n, i + 2);
      continue;
    }

    // Preprocessor directive: capture the whole logical line.
    if (ch === '#' && onlyWhitespaceBeforeOnLine(source, i, lineStart)) {
      const start = i;
      const startLine = line;
      const startCol = i - lineStart + 1;
      while (i < n && source[i] !== '\n') i++;
      push('directive', source.slice(start, i).trim(), start, startLine, startCol);
      continue;
    }

    const startLine = line;
    const startCol = i - lineStart + 1;
    const start = i;

    // Identifier / keyword (allow @-prefixed identifiers)
    if (isIdentStart(ch) || (ch === '@' && isIdentStart(source[i + 1] ?? ''))) {
      if (ch === '@') i++;
      while (i < n && isIdentPart(source[i])) i++;
      const raw = source.slice(start, i);
      const bare = raw.startsWith('@') ? raw.slice(1) : raw;
      push(CSHARP_KEYWORDS.has(bare) && !raw.startsWith('@') ? 'keyword' : 'ident', bare, start, startLine, startCol);
      continue;
    }

    // Numeric literal
    if (isDigit(ch) || (ch === '.' && isDigit(source[i + 1] ?? ''))) {
      i = scanNumber(source, i);
      push('number', source.slice(start, i), start, startLine, startCol);
      continue;
    }

    // Character literal
    if (ch === '\'') {
      i++;
      while (i < n && source[i] !== '\'') {
        if (source[i] === '\\') i++;
        i++;
      }
      i = Math.min(n, i + 1);
      push('char', source.slice(start, i), start, startLine, startCol);
      continue;
    }

    // Raw string literal: """
    if (ch === '"' && source[i + 1] === '"' && source[i + 2] === '"') {
      const quotes = countRun(source, i, '"');
      const fence = Math.min(quotes, 6);
      i += fence;
      let end = -1;
      while (i < n) {
        if (source[i] === '"' && countRun(source, i, '"') >= fence) {
          end = i;
          break;
        }
        if (source[i] === '\n') { line++; lineStart = i + 1; }
        i++;
      }
      if (end === -1) {
        i = n;
      } else {
        i = end + fence;
      }
      push('string', source.slice(start, i), start, startLine, startCol);
      continue;
    }

    // Interpolated / regular / verbatim string literal
    if (ch === '"' || ((ch === '$' || ch === '@') && startsString(source, i))) {
      const res = scanString(source, i, line, lineStart);
      i = res.next;
      line = res.line;
      lineStart = res.lineStart;
      push('string', source.slice(start, i), start, startLine, startCol, res.refs);
      continue;
    }

    // Punctuation (with a few multi-character operators)
    const pair = PUNCT_PAIRS.find((p) => source.startsWith(p, i));
    if (pair) {
      i += pair.length;
      push('punct', pair, start, startLine, startCol);
      continue;
    }

    i++;
    push('punct', ch, start, startLine, startCol);
  }

  push('eof', '', n, line, n - lineStart + 1);
  return tokens;
}

function onlyWhitespaceBeforeOnLine(source: string, index: number, lineStart: number): boolean {
  for (let k = lineStart; k < index; k++) {
    const c = source[k];
    if (c !== ' ' && c !== '\t') return false;
  }
  return true;
}

function countRun(source: string, index: number, ch: string): number {
  let count = 0;
  while (source[index + count] === ch) count++;
  return count;
}

function startsString(source: string, index: number): boolean {
  // @"...", @$"...", $"..." — but not "@identifier".
  let k = index;
  let sawAt = false;
  let sawDollar = false;
  while (source[k] === '@' || source[k] === '$') {
    if (source[k] === '@') sawAt = true;
    else sawDollar = true;
    k++;
  }
  if (!(sawAt || sawDollar)) return false;
  if (source[k] === '"') return true;
  // $""" raw interpolated string
  if (sawDollar && source[k] === '"' && source[k + 1] === '"') return true;
  return false;
}

interface ScanStringResult {
  next: number;
  line: number;
  lineStart: number;
  refs: string[];
}

function scanString(source: string, index: number, startLine: number, startLineStart: number): ScanStringResult {
  const n = source.length;
  let i = index;
  let line = startLine;
  let lineStart = startLineStart;
  let verbatim = false;
  let interpolated = false;
  while (source[i] === '@' || source[i] === '$') {
    if (source[i] === '@') verbatim = true;
    else interpolated = true;
    i++;
  }

  // Raw strings: """ ... """
  if (source[i] === '"' && source[i + 1] === '"') {
    const fence = Math.min(countRun(source, i, '"'), 6);
    i += fence;
    while (i < n) {
      if (source[i] === '"' && countRun(source, i, '"') >= fence) {
        i += fence;
        break;
      }
      if (source[i] === '\n') { line++; lineStart = i + 1; }
      i++;
    }
    return { next: i, line, lineStart, refs: [] };
  }

  // Opening quote
  i++;
  const refs: string[] = [];
  if (!interpolated) {
    while (i < n) {
      const c = source[i];
      if (!verbatim && c === '\\') { i += 2; continue; }
      if (verbatim && c === '"' && source[i + 1] === '"') { i += 2; continue; }
      if (c === '"') { i++; break; }
      if (c === '\n') { line++; lineStart = i + 1; }
      i++;
    }
    return { next: i, line, lineStart, refs };
  }

  // Interpolated string: track { } holes ({{ and }} are escaped braces).
  let braceDepth = 0;
  while (i < n) {
    const c = source[i];
    if (braceDepth > 0) {
      if (c === '{' ) { braceDepth++; i++; continue; }
      if (c === '}') {
        braceDepth--;
        i++;
        if (braceDepth === 0 && verbatim) {
          // resume string scanning
        }
        continue;
      }
      // Inside a hole, nested strings must be skipped.
      if (c === '"' || ((c === '$' || c === '@') && startsString(source, i))) {
        const inner = scanString(source, i, line, lineStart);
        i = inner.next; line = inner.line; lineStart = inner.lineStart;
        continue;
      }
      if (c === '\'') {
        i++;
        while (i < n && source[i] !== '\'') { if (source[i] === '\\') i++; i++; }
        i = Math.min(n, i + 1);
        continue;
      }
      if (isIdentStart(c)) {
        const s = i;
        while (i < n && isIdentPart(source[i])) i++;
        const name = source.slice(s, i);
        if (!CSHARP_KEYWORDS.has(name) && !CSHARP_CONTEXTUAL.has(name)) refs.push(name);
        continue;
      }
      if (c === '\n') { line++; lineStart = i + 1; }
      i++;
      continue;
    }
    if (!verbatim && c === '\\') { i += 2; continue; }
    if (c === '{' && source[i + 1] === '{') { i += 2; continue; }
    if (c === '}' && source[i + 1] === '}') { i += 2; continue; }
    if (c === '{') { braceDepth = 1; i++; continue; }
    if (verbatim && c === '"' && source[i + 1] === '"') { i += 2; continue; }
    if (c === '"') { i++; break; }
    if (c === '\n') { line++; lineStart = i + 1; }
    i++;
  }
  return { next: i, line, lineStart, refs };
}

function scanNumber(source: string, index: number): number {
  const n = source.length;
  let i = index;
  if (source[i] === '0' && (source[i + 1] === 'x' || source[i + 1] === 'X' || source[i + 1] === 'b' || source[i + 1] === 'B')) {
    i += 2;
    while (i < n && /[0-9a-fA-F_]/.test(source[i])) i++;
  } else {
    while (i < n && /[0-9_]/.test(source[i])) i++;
    if (source[i] === '.') {
      i++;
      while (i < n && /[0-9_]/.test(source[i])) i++;
    }
    if (source[i] === 'e' || source[i] === 'E') {
      i++;
      if (source[i] === '+' || source[i] === '-') i++;
      while (i < n && /[0-9]/.test(source[i])) i++;
    }
  }
  // Numeric suffixes
  while (i < n && /[uUlLfFdDmM]/.test(source[i])) i++;
  return i;
}

function isIdentStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || (ch >= '0' && ch <= '9');
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}
