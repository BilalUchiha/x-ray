// A real Python tokenizer.
//
// Produces the INDENT / DEDENT / NEWLINE structure Python's grammar depends on,
// handles triple-quoted and f-strings (capturing interpolation references),
// implicit line joining inside brackets, and backslash continuations.
// The parser downstream consumes this stream.

export type PyTokenKind =
  | 'ident'
  | 'keyword'
  | 'number'
  | 'string'
  | 'punct'
  | 'newline'
  | 'indent'
  | 'dedent'
  | 'eof';

export interface PyToken {
  kind: PyTokenKind;
  value: string;
  line: number;
  /** Identifiers referenced inside an f-string interpolation. */
  refs?: string[];
}

export const PYTHON_KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break',
  'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally',
  'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal',
  'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
  'match', 'case', 'self', 'cls',
]);

const STRING_PREFIX = /^(?:[rRbBuUfF]{1,2})$/;

const PUNCT = [
  '**=', '//=', '>>=', '<<=', '...', '->', '**', '//', '>=', '<=', '==', '!=',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', ':=', '@=',
];

export function tokenizePython(source: string): PyToken[] {
  const tokens: PyToken[] = [];
  const n = source.length;
  let i = 0;
  let line = 1;
  let atLineStart = true;
  let bracketDepth = 0;
  let pendingNewline = false;
  const indentStack: number[] = [0];

  const push = (kind: PyTokenKind, value: string, atLine: number, refs?: string[]) => {
    const token: PyToken = { kind, value, line: atLine };
    if (refs && refs.length) token.refs = refs;
    tokens.push(token);
  };

  let guard = 0;
  const guardLimit = n * 8 + 4096;

  while (i < n && guard++ < guardLimit) {
    if (atLineStart && bracketDepth === 0) {
      let j = i;
      let indent = 0;
      while (j < n && (source[j] === ' ' || source[j] === '\t')) {
        indent += source[j] === '\t' ? 8 : 1;
        j++;
      }

      const rest = j >= n ? '' : source[j];
      const isBlankLine = rest === '' || rest === '\n' || rest === '\r';
      if (isBlankLine || rest === '#') {
        if (isBlankLine && rest === '') { i = n; continue; }
        if (rest === '#') while (j < n && source[j] !== '\n') j++;
        // Hand the newline back to the main loop so atLineStart/pendingNewline
        // bookkeeping happens exactly once.
        i = j;
        atLineStart = false;
        continue;
      }

      if (pendingNewline) {
        push('newline', '', line);
        pendingNewline = false;
      }

      const top = indentStack[indentStack.length - 1];
      if (indent > top) {
        indentStack.push(indent);
        push('indent', '', line);
      } else if (indent < top) {
        while (indentStack.length > 1 && indentStack[indentStack.length - 1] > indent) {
          indentStack.pop();
          push('dedent', '', line);
        }
      }
      i = j;
      atLineStart = false;
      continue;
    }

    const ch = source[i];

    if (ch === '\n') {
      line++;
      if (bracketDepth === 0) {
        if (!isBackslashContinuation(source, i)) pendingNewline = true;
        atLineStart = true;
      }
      i++;
      continue;
    }
    if (ch === '\r') { i++; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\f' || ch === '\v') { i++; continue; }

    if (ch === '\\' && source[i + 1] === '\n') {
      line++;
      i += 2;
      continue;
    }

    if (ch === '#') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }

    const tokenLine = line;

    // Strings, including prefixes and triple quotes.
    const stringStart = tryStringStart(source, i);
    if (stringStart) {
      const result = scanString(source, stringStart.quoteIndex, stringStart.prefix, line);
      if (result.refs.length) push('string', 'str', tokenLine, result.refs);
      else push('string', 'str', tokenLine);
      line = result.line;
      i = result.next;
      continue;
    }

    if (isIdentStart(ch)) {
      const start = i;
      while (i < n && isIdentPart(source[i])) i++;
      const value = source.slice(start, i);
      push(PYTHON_KEYWORDS.has(value) ? 'keyword' : 'ident', value, tokenLine);
      continue;
    }

    if (isDigit(ch) || (ch === '.' && isDigit(source[i + 1] ?? ''))) {
      const start = i;
      while (i < n && /[0-9a-fA-FxXoObB_.]/.test(source[i])) i++;
      if (source[i] === 'e' || source[i] === 'E') {
        i++;
        if (source[i] === '+' || source[i] === '-') i++;
        while (i < n && isDigit(source[i])) i++;
      }
      if (source[i] === 'j' || source[i] === 'J') i++;
      void start;
      push('number', '0', tokenLine);
      continue;
    }

    const punct = PUNCT.find((p) => source.startsWith(p, i));
    if (punct) {
      i += punct.length;
      push('punct', punct, tokenLine);
      continue;
    }

    if (ch === '(' || ch === '[' || ch === '{') bracketDepth++;
    else if (ch === ')' || ch === ']' || ch === '}') bracketDepth = Math.max(0, bracketDepth - 1);

    push('punct', ch, tokenLine);
    i++;
  }

  if (pendingNewline) push('newline', '', line);
  while (indentStack.length > 1) {
    indentStack.pop();
    push('dedent', '', line);
  }
  push('eof', '', line);
  return tokens;
}

interface StringStart {
  prefix: string;
  quoteIndex: number;
}

function tryStringStart(source: string, index: number): StringStart | null {
  const ch = source[index];
  if (ch === '"' || ch === '\'') return { prefix: '', quoteIndex: index };

  // Prefixed string: r, b, u, f and combinations.
  let k = index;
  let prefix = '';
  while (k < source.length && prefix.length < 2 && /[rRbBuUfF]/.test(source[k])) {
    prefix += source[k];
    k++;
  }
  if (!prefix) return null;
  if (!STRING_PREFIX.test(prefix)) return null;
  if (source[k] === '"' || source[k] === '\'') return { prefix, quoteIndex: k };
  return null;
}

interface ScanResult {
  next: number;
  line: number;
  refs: string[];
}

function scanString(source: string, quoteIndex: number, prefix: string, startLine: number): ScanResult {
  const isRaw = prefix.includes('r') || prefix.includes('R');
  const isF = prefix.includes('f') || prefix.includes('F');
  const quote = source[quoteIndex];
  const triple = source[quoteIndex + 1] === quote && source[quoteIndex + 2] === quote;
  const n = source.length;
  let i = quoteIndex + (triple ? 3 : 1);
  let line = startLine;
  const refs: string[] = [];

  while (i < n) {
    const c = source[i];
    if (c === '\\' && !isRaw) {
      if (source[i + 1] === '\n') line++;
      i += 2;
      continue;
    }
    if (c === '\n') {
      line++;
      if (!triple) return { next: i, line, refs };
      i++;
      continue;
    }
    if (triple) {
      if (c === quote && source[i + 1] === quote && source[i + 2] === quote) {
        return { next: i + 3, line, refs };
      }
      if (isF && c === '{') {
        const hole = scanInterpolation(source, i, line);
        for (const ref of hole.refs) refs.push(ref);
        line = hole.line;
        i = hole.next;
        continue;
      }
      i++;
      continue;
    }
    if (c === quote) return { next: i + 1, line, refs };
    if (isF && c === '{' && source[i + 1] === '{') { i += 2; continue; }
    if (isF && c === '{') {
      const hole = scanInterpolation(source, i, line);
      for (const ref of hole.refs) refs.push(ref);
      line = hole.line;
      i = hole.next;
      continue;
    }
    i++;
  }
  return { next: i, line, refs };
}

function scanInterpolation(source: string, braceIndex: number, startLine: number): ScanResult {
  const n = source.length;
  let i = braceIndex + 1;
  let depth = 1;
  let line = startLine;
  const refs: string[] = [];

  while (i < n && depth > 0) {
    const c = source[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === '{') { depth++; i++; continue; }
    if (c === '}') { depth--; i++; continue; }
    if (c === '"' || c === '\'' || /[rRbBuUfF]/.test(c)) {
      const nested = tryStringStart(source, i);
      if (nested) {
        const inner = scanString(source, nested.quoteIndex, nested.prefix, line);
        line = inner.line;
        i = inner.next;
        continue;
      }
    }
    if (isIdentStart(c)) {
      const start = i;
      while (i < n && isIdentPart(source[i])) i++;
      const name = source.slice(start, i);
      const prev = source[start - 1];
      if (prev !== '.' && !PYTHON_KEYWORDS.has(name)) refs.push(name);
      continue;
    }
    i++;
  }
  return { next: i, line, refs };
}

function isBackslashContinuation(source: string, newlineIndex: number): boolean {
  let k = newlineIndex - 1;
  while (k >= 0 && (source[k] === ' ' || source[k] === '\t' || source[k] === '\r')) k--;
  return k >= 0 && source[k] === '\\';
}

function isIdentStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || isDigit(ch);
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}
