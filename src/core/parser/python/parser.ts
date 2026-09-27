// Python structural parser (Django / Flask / FastAPI shaped code).
//
// Indentation-aware: it consumes the INDENT/DEDENT/NEWLINE tokens from the
// lexer and builds classes, module-level functions, methods, class attributes
// and the type references / call sites each contains. Module-level functions
// are attached to their file node, which is exactly how Django views and
// management commands are shaped.

import type {
  AnalysisWarning,
  DeclaredMember,
  DeclaredType,
  ParsedFile,
  RawRelation,
} from '../../types';
import { PYTHON_KEYWORDS, tokenizePython, type PyToken } from './lexer';

interface Scope {
  kind: 'module' | 'class' | 'function' | 'block';
  typeId?: string;
  memberId?: string;
  name?: string;
}

export function parsePython(fileId: string, source: string): ParsedFile {
  return new PythonParser(fileId, source).parse();
}

class PythonParser {
  private readonly tokens: PyToken[];
  private pos = 0;
  private readonly types: DeclaredType[] = [];
  private readonly members: DeclaredMember[] = [];
  private readonly relations: RawRelation[] = [];
  private readonly imports: string[] = [];
  private readonly errors: AnalysisWarning[] = [];
  private readonly scopes: Scope[] = [{ kind: 'module' }];
  private pendingScope: Scope | null = null;

  constructor(private readonly fileId: string, source: string) {
    this.tokens = tokenizePython(source);
  }

  parse(): ParsedFile {
    let guard = 0;
    const limit = this.tokens.length * 2 + 64;

    while (!this.eof && guard++ < limit) {
      const token = this.peek();

      if (token.kind === 'newline') { this.advance(); continue; }
      if (token.kind === 'dedent') { this.advance(); this.popScope(); continue; }
      if (token.kind === 'indent') {
        this.advance();
        this.scopes.push(this.pendingScope ?? { kind: 'block' });
        this.pendingScope = null;
        continue;
      }

      const start = this.pos;
      this.parseStatement();
      if (this.pos === start) this.advance();
    }

    return {
      fileId: this.fileId,
      types: this.types,
      members: this.members,
      relations: this.relations,
      imports: dedupe(this.imports),
      errors: this.errors,
    };
  }

  // -- token helpers --------------------------------------------------------

  private peek(offset = 0): PyToken {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
  }

  private advance(): PyToken {
    const token = this.tokens[this.pos];
    if (this.pos < this.tokens.length - 1) this.pos++;
    return token;
  }

  private get eof(): boolean {
    return this.peek().kind === 'eof';
  }

  private at(value: string, offset = 0): boolean {
    const token = this.peek(offset);
    return token.kind === 'punct' && token.value === value;
  }

  private isWord(value: string, offset = 0): boolean {
    const token = this.peek(offset);
    return (token.kind === 'ident' || token.kind === 'keyword') && token.value === value;
  }

  private currentScope(): Scope {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const scope = this.scopes[i];
      if (scope.kind === 'function') return scope;
    }
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const scope = this.scopes[i];
      if (scope.kind === 'class') return scope;
    }
    return this.scopes[0];
  }

  private currentClass(): Scope | null {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (this.scopes[i].kind === 'class') return this.scopes[i];
    }
    return null;
  }

  private ownerTarget(): { id: string; kind: 'file' | 'type' | 'method' } {
    const scope = this.currentScope();
    if (scope.kind === 'function' && scope.memberId) return { id: scope.memberId, kind: 'method' };
    if (scope.kind === 'class' && scope.typeId) return { id: scope.typeId, kind: 'type' };
    return { id: this.fileId, kind: 'file' };
  }

  private popScope(): void {
    if (this.scopes.length > 1) this.scopes.pop();
  }

  private qualifiedName(name: string): string {
    const enclosing: string[] = [];
    for (const scope of this.scopes) {
      if (scope.kind === 'class' && scope.name) enclosing.push(scope.name);
    }
    return [...enclosing, name].join('.');
  }

  // -- statements -----------------------------------------------------------

  private parseStatement(): void {
    const token = this.peek();

    if (token.kind === 'punct' && token.value === '@') { this.parseDecorator(); return; }
    if (this.isWord('import')) { this.parseImport(); return; }
    if (this.isWord('from')) { this.parseFromImport(); return; }
    if (this.isWord('async') && this.isWord('def', 1)) { this.advance(); this.parseFunction(); return; }
    if (this.isWord('def')) { this.parseFunction(); return; }
    if (this.isWord('class')) { this.parseClass(); return; }
    if (token.kind === 'keyword' && ['if', 'elif', 'else', 'for', 'while', 'try', 'except', 'finally', 'with', 'match', 'case'].includes(token.value)) {
      this.consumeLine();
      return;
    }

    // Class-level attribute: `name = ...` or `name: Type = ...`
    const classScope = this.currentScope();
    if (classScope.kind === 'class' && token.kind === 'ident' && (this.at('=', 1) || this.at(':', 1))) {
      this.parseClassAttribute();
      return;
    }

    this.consumeLine();
  }

  private parseDecorator(): void {
    this.advance(); // '@'
    const target = this.ownerTarget();
    const line = this.peek().line;
    const name = this.readDottedName();
    if (name) {
      this.relations.push({ kind: 'usage', fromId: target.id, fromKind: target.kind, toName: lastSegment(name), line });
    }
    if (this.at('(')) this.skipBalanced('(', ')');
    this.consumeLine();
  }

  private parseImport(): void {
    this.advance(); // import
    let guard = 0;
    while (!this.eof && guard++ < 200) {
      const line = this.peek().line;
      const name = this.readDottedName();
      if (name) this.imports.push(name);
      if (this.isWord('as')) {
        this.advance();
        if (this.peek().kind === 'ident') this.advance();
      }
      if (this.at(',')) { this.advance(); continue; }
      void line;
      break;
    }
    this.consumeLine();
  }

  private parseFromImport(): void {
    this.advance(); // from
    const line = this.peek().line;
    let module = '';
    let guard = 0;
    while (guard++ < 40) {
      if (this.at('.', 0)) {
        // relative import: ./../
        while (this.at('.')) { module += '.'; this.advance(); }
        if (this.peek().kind === 'ident') module += this.advance().value;
        if (this.at('.')) { this.advance(); module += '.' + this.readDottedName(); }
        break;
      }
      const part = this.readDottedName();
      if (!part) break;
      module = part;
      if (this.at('.')) { this.advance(); continue; }
      break;
    }
    if (module) this.imports.push(module);

    if (this.isWord('import')) {
      this.advance();
      const target = this.ownerTarget();
      let inner = 0;
      while (!this.eof && inner++ < 200) {
        if (this.at('*')) { this.advance(); break; }
        if (this.peek().kind !== 'ident') break;
        const importLine = this.peek().line;
        const symbol = this.advance().value;
        // `from .models import User` makes User a real reference in this file.
        this.relations.push({ kind: 'usage', fromId: target.id, fromKind: target.kind, toName: symbol, line: importLine });
        if (this.isWord('as')) { this.advance(); if (this.peek().kind === 'ident') this.advance(); }
        if (this.at(',')) { this.advance(); continue; }
        break;
      }
    }
    this.consumeLine();
    void line;
  }

  private parseClass(): void {
    const classToken = this.advance(); // class
    const nameToken = this.peek();
    if (nameToken.kind !== 'ident') { this.consumeLine(); return; }
    const name = this.advance().value;

    // Base classes: `class UserSerializer(serializers.ModelSerializer)`. Module
    // prefixes (serializers, django.db.models) are dropped so the name that can
    // actually be resolved in the graph is kept.
    const baseNames: string[] = [];
    if (this.at('(')) {
      this.advance();
      let guard = 0;
      let depth = 1;
      let expectName = true;
      let segment = '';
      const flush = () => {
        if (segment && expectName === false) {
          baseNames.push(segment);
          segment = '';
        }
        expectName = true;
      };
      while (!this.eof && guard++ < 500 && depth > 0) {
        const token = this.advance();
        if (token.kind === 'punct') {
          if (token.value === '(' || token.value === '[' || token.value === '{') depth++;
          else if (token.value === ')' || token.value === ']' || token.value === '}') {
            depth--;
            if (depth === 0) { flush(); break; }
          } else if (token.value === ',') flush();
          // `class A(B, metaclass=Meta)` — keyword arguments are not bases.
          else if (token.value === '=') { segment = ''; expectName = true; }
          continue;
        }
        if (token.kind === 'ident') {
          segment = token.value; // last segment of a dotted base wins
          expectName = false;
        }
        if (token.kind === 'keyword' && token.value === 'metaclass') {
          flush();
        }
      }
      flush();
    }

    const startLine = classToken.line;
    const qualified = this.qualifiedName(name);
    const typeId = makeTypeId(this.fileId, qualified, startLine);
    const declared: DeclaredType = {
      id: typeId,
      kind: 'class',
      name,
      fileId: this.fileId,
      startLine,
      endLine: startLine,
      modifiers: [],
      baseNames,
      memberIds: [],
    };
    this.types.push(declared);
    for (const base of baseNames) {
      this.relations.push({ kind: 'base', fromId: typeId, fromKind: 'type', toName: base, line: startLine });
    }

    this.finishHeader({
      kind: 'class',
      typeId,
      name: qualified,
      startLine,
      setEnd: (line) => { declared.endLine = line; },
    });
  }

  private parseFunction(): void {
    const defToken = this.advance(); // def
    const nameToken = this.peek();
    if (nameToken.kind !== 'ident') { this.consumeLine(); return; }
    const name = this.advance().value;

    const sentinel = this.ownerTarget();
    const paramTypes: string[] = [];
    if (this.at('(')) {
      const open = this.pos;
      this.advance();
      const close = this.findMatching(open, '(', ')');
      if (close > open) this.parameterAnnotations(open + 1, close, paramTypes);
      this.pos = Math.max(this.pos, Math.min(close + 1, this.tokens.length - 1));
    }

    let returnType: string | undefined;
    if (this.at('-') && this.at('>', 1)) {
      this.advance();
      this.advance();
      returnType = this.readTypeExpression();
    }

    const enclosingClass = this.currentClass();
    const startLine = defToken.line;
    const kind: DeclaredMember['kind'] = enclosingClass ? 'method' : 'function';
    const ownerId = enclosingClass?.typeId ?? this.fileId;
    const memberId = makeMemberId(kind, `${ownerId}:${name}`, startLine);

    const member: DeclaredMember = {
      id: memberId,
      kind,
      name,
      ownerId,
      fileId: this.fileId,
      startLine,
      endLine: startLine,
      signature: buildSignature(name, paramTypes, returnType),
      returnType,
      paramTypes: dedupe(paramTypes),
      modifiers: [],
    };
    this.members.push(member);

    if (enclosingClass?.typeId) {
      const owner = this.types.find((type) => type.id === enclosingClass.typeId);
      owner?.memberIds.push(memberId);
    }

    if (returnType) {
      for (const referenced of splitTypeNames(returnType)) {
        this.relations.push({ kind: 'usage', fromId: memberId, fromKind: 'method', toName: referenced, line: startLine });
      }
    }

    this.finishHeader({
      kind: 'function',
      memberId,
      name,
      startLine,
      setEnd: (line) => { member.endLine = line; },
    });
    void sentinel;
  }

  private parseClassAttribute(): void {
    const nameToken = this.peek();
    const name = nameToken.value;
    const classScope = this.currentScope();
    const typeId = classScope.typeId;
    if (!typeId) { this.consumeLine(); return; }

    const start = this.pos;
    let declaredType: string | undefined;
    if (this.at(':', 1)) {
      this.advance(); // name
      this.advance(); // ':'
      declaredType = this.readTypeExpression();
    }
    const end = this.skipLine();

    const memberId = makeMemberId('property', `${typeId}:${name}`, nameToken.line);
    const member: DeclaredMember = {
      id: memberId,
      kind: 'property',
      name,
      ownerId: typeId,
      fileId: this.fileId,
      startLine: nameToken.line,
      endLine: this.tokens[Math.max(start, end - 1)]?.line ?? nameToken.line,
      signature: declaredType ? `${declaredType} ${name}` : name,
      returnType: declaredType,
      paramTypes: [],
      modifiers: [],
    };
    this.members.push(member);
    const owner = this.types.find((type) => type.id === typeId);
    owner?.memberIds.push(memberId);
    this.collectReferences(start, end, memberId, 'method', new Set([name]));
  }

  /** Consumes `:` and either opens a block or consumes a one-line body. */
  private finishHeader(options: {
    kind: 'class' | 'function';
    typeId?: string;
    memberId?: string;
    name: string;
    startLine: number;
    setEnd: (line: number) => void;
  }): void {
    if (this.at(':')) this.advance();

    // The block's INDENT arrives after the header's NEWLINE, so look past the
    // line break before deciding whether a block follows.
    let sawNewline = false;
    while (this.peek().kind === 'newline') {
      sawNewline = true;
      this.advance();
    }

    if (this.peek().kind === 'indent') {
      this.pendingScope = options.kind === 'class'
        ? { kind: 'class', typeId: options.typeId, name: options.name }
        : { kind: 'function', memberId: options.memberId, name: options.name };
      return;
    }

    if (sawNewline) {
      // Empty body — nothing to collect.
      this.pendingScope = null;
      return;
    }

    // One-line body: `def f(): return 1`
    const start = this.pos;
    const end = this.skipLine();
    options.setEnd(this.tokens[Math.max(start, end - 1)]?.line ?? options.startLine);
    const target = options.kind === 'class'
      ? { id: options.typeId!, kind: 'type' as const }
      : { id: options.memberId!, kind: 'method' as const };
    this.collectReferences(start, end, target.id, target.kind, new Set([options.name]));
    this.pendingScope = null;
  }

  // -- reference extraction -------------------------------------------------

  private consumeLine(): void {
    const start = this.pos;
    const end = this.skipLine();
    const target = this.ownerTarget();
    this.collectReferences(start, end, target.id, target.kind, new Set());
  }

  /** Moves to just before the terminating newline and returns the end index. */
  private skipLine(): number {
    while (!this.eof && this.peek().kind !== 'newline' && this.peek().kind !== 'dedent') this.advance();
    return this.pos;
  }

  private collectReferences(from: number, to: number, fromId: string, fromKind: RawRelation['fromKind'], exclude: Set<string>): void {
    for (let k = from; k < to && k < this.tokens.length; k++) {
      const token = this.tokens[k];

      if (token.kind === 'string') {
        for (const ref of token.refs ?? []) {
          if (exclude.has(ref) || !isTypeLikeName(ref)) continue;
          this.relations.push({ kind: 'usage', fromId, fromKind, toName: ref, line: token.line });
        }
        continue;
      }

      if (token.kind !== 'ident') continue;
      if (PYTHON_KEYWORDS.has(token.value)) continue;

      const next = this.tokens[k + 1];
      const prev = this.tokens[k - 1];

      // Call site
      if (next && next.kind === 'punct' && next.value === '(') {
        if (prev && prev.kind === 'punct' && prev.value === '.') {
          const receiver = this.tokens[k - 2];
          const receiverName = receiver && receiver.kind === 'ident' ? receiver.value : '';
          this.relations.push({
            kind: 'call',
            fromId,
            fromKind: 'method',
            toName: isTypeLikeName(receiverName) ? receiverName : '',
            methodName: token.value,
            memberAccess: true,
            line: token.line,
          });
        } else if (isTypeLikeName(token.value)) {
          // `User(...)` — constructing a model / serializer, not calling a function.
          this.relations.push({ kind: 'instantiate', fromId, fromKind: 'method', toName: token.value, line: token.line });
        } else {
          this.relations.push({ kind: 'call', fromId, fromKind: 'method', toName: '', methodName: token.value, line: token.line });
        }
        continue;
      }

      if (!isTypeLikeName(token.value)) continue;
      if (exclude.has(token.value)) continue;
      if (prev && prev.kind === 'punct' && (prev.value === '.' || prev.value === '->')) continue;
      this.relations.push({ kind: 'usage', fromId, fromKind, toName: token.value, line: token.line });
    }
  }

  private parameterAnnotations(from: number, to: number, out: string[]): void {
    let k = from;
    while (k < to) {
      if (this.tokens[k].kind === 'punct' && this.tokens[k].value === ':') {
        const start = k + 1;
        let end = start;
        let depth = 0;
        while (end < to) {
          const token = this.tokens[end];
          if (token.kind === 'punct') {
            if (token.value === '[' || token.value === '(') depth++;
            else if (token.value === ']' || token.value === ')') depth--;
            else if (depth === 0 && (token.value === ',' || token.value === '=')) break;
          }
          end++;
        }
        for (const name of splitTypeNames(this.tokens.slice(start, end).map((t) => t.value).join(''))) out.push(name);
        k = end;
        continue;
      }
      k++;
    }
  }

  private readDottedName(): string {
    let name = '';
    let guard = 0;
    while (guard++ < 64) {
      const token = this.peek();
      if (token.kind === 'ident') {
        name += (name ? '.' : '') + this.advance().value;
      } else {
        break;
      }
      if (this.at('.') && this.peek(1).kind === 'ident') {
        this.advance();
        continue;
      }
      break;
    }
    return name;
  }

  /** Reads a type expression, stopping at logical boundaries. */
  private readTypeExpression(): string | undefined {
    const parts: string[] = [];
    let guard = 0;
    let depth = 0;
    while (guard++ < 64) {
      const token = this.peek();
      if (token.kind === 'eof' || token.kind === 'newline' || token.kind === 'dedent') break;
      if (token.kind === 'punct') {
        if (token.value === '[' || token.value === '(') depth++;
        else if (token.value === ']' || token.value === ')') { if (depth === 0) break; depth--; }
        else if (depth === 0 && (token.value === ':' || token.value === '=' || token.value === ',')) break;
        if (token.value === ',') { parts.push(' '); this.advance(); continue; }
        parts.push(token.value);
        this.advance();
        continue;
      }
      parts.push(token.value);
      this.advance();
    }
    const text = parts.join('').trim();
    return text || undefined;
  }

  private findMatching(openIndex: number, open: string, close: string): number {
    let depth = 0;
    for (let k = openIndex; k < this.tokens.length; k++) {
      const token = this.tokens[k];
      if (token.kind !== 'punct') continue;
      if (token.value === open) depth++;
      else if (token.value === close) {
        depth--;
        if (depth === 0) return k;
      }
    }
    return -1;
  }

  private skipBalanced(open: string, close: string): void {
    const from = this.pos;
    const end = this.findMatching(from, open, close);
    if (end >= 0) this.pos = Math.min(end + 1, this.tokens.length - 1);
    else this.pos = this.tokens.length - 1;
  }
}

// -- helpers ----------------------------------------------------------------

export function makeTypeId(fileId: string, qualifiedName: string, line: number): string {
  return `t:${fileId}:${qualifiedName}:${line}`;
}

export function makeMemberId(kind: string, key: string, line: number): string {
  return `m:${key}:${kind}:${line}`;
}

/** Python type references are conventionally PascalCase. */
export function isTypeLikeName(name: string): boolean {
  if (name.length < 2) return false;
  const first = name[0];
  return first >= 'A' && first <= 'Z';
}

export function splitTypeNames(text: string): string[] {
  const names: string[] = [];
  const re = /[A-Za-z_][A-Za-z0-9_]*/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    if (!isTypeLikeName(match[0])) continue;
    names.push(match[0]);
  }
  return dedupe(names);
}

function buildSignature(name: string, paramTypes: string[], returnType?: string): string {
  const params = paramTypes.length ? paramTypes.join(', ') : '';
  return `def ${name}(${params})${returnType ? ` -> ${returnType}` : ''}`;
}

function lastSegment(name: string): string {
  const index = name.lastIndexOf('.');
  return index === -1 ? name : name.slice(index + 1);
}

function dedupe<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}
