// TypeScript / JavaScript structural parser.
//
// Token-based (real scanning, not regex) and focused on the structural facts
// that matter for X-Ray: imports, exported declarations, classes/interfaces
// with their extends/implements clauses, methods, and the type-level
// references each declaration contains.

import type {
  DeclaredMember,
  DeclaredType,
  ParsedFile,
  RawRelation,
} from '../../types';

type Tk = 'ident' | 'keyword' | 'punct' | 'string' | 'template' | 'number' | 'eof';

interface T {
  kind: Tk;
  value: string;
  line: number;
}

const KEYWORDS = new Set([
  'abstract', 'any', 'as', 'async', 'await', 'boolean', 'break', 'case',
  'catch', 'class', 'const', 'continue', 'declare', 'default', 'delete', 'do',
  'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'from',
  'function', 'get', 'if', 'implements', 'import', 'in', 'infer', 'instanceof',
  'interface', 'keyof', 'let', 'namespace', 'never', 'new', 'null', 'number',
  'object', 'of', 'private', 'protected', 'public', 'readonly', 'return',
  'set', 'static', 'string', 'super', 'switch', 'symbol', 'this', 'throw',
  'true', 'try', 'type', 'typeof', 'undefined', 'unknown', 'var', 'void',
  'while', 'with', 'yield', 'readonly',
]);

const RESERVED_AS_TYPE = new Set(['any', 'string', 'number', 'boolean', 'void', 'unknown', 'never', 'object', 'symbol', 'undefined', 'null', 'this', 'true', 'false']);

export function parseTypeScript(fileId: string, source: string): ParsedFile {
  const parser = new TsFileParser(fileId, source);
  return parser.parse();
}

class TsFileParser {
  private readonly tokens: T[];
  private pos = 0;
  private readonly types: DeclaredType[] = [];
  private readonly members: DeclaredMember[] = [];
  private readonly relations: RawRelation[] = [];
  private readonly imports: string[] = [];

  constructor(private readonly fileId: string, source: string) {
    this.tokens = tokenize(source);
  }

  parse(): ParsedFile {
    let guard = 0;
    while (!this.eof && guard++ < 200000) {
      const start = this.pos;
      if (!this.parseStatement()) this.advance();
      if (this.pos === start) this.advance();
    }
    return {
      fileId: this.fileId,
      types: this.types,
      members: this.members,
      relations: this.relations,
      imports: dedupe(this.imports),
      errors: [],
    };
  }

  private peek(offset = 0): T {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
  }

  private advance(): T {
    const t = this.tokens[this.pos];
    if (this.pos < this.tokens.length - 1) this.pos++;
    return t;
  }

  private at(value: string, offset = 0): boolean {
    const t = this.peek(offset);
    return t.kind === 'punct' && t.value === value;
  }

  private get eof(): boolean {
    return this.peek().kind === 'eof';
  }

  private parseStatement(): boolean {
    let exported = false;
    const decorators: string[] = [];
    let guard = 0;

    for (;;) {
      const t = this.peek();
      if (guard++ > 32) break;
      if (t.kind === 'punct' && t.value === '@') {
        this.advance();
        const name = this.advance();
        if (name.kind === 'ident') decorators.push(name.value);
        continue;
      }
      if (t.kind === 'keyword' && (t.value === 'export' || t.value === 'declare' || t.value === 'default' || t.value === 'abstract')) {
        if (t.value === 'export') exported = true;
        this.advance();
        continue;
      }
      break;
    }

    const t = this.peek();
    if (t.kind === 'punct' && t.value === ';') { this.advance(); return true; }

    if (t.kind === 'keyword' && t.value === 'import') return this.parseImport();

    if (t.kind === 'keyword' && t.value === 'class') { this.parseClass(exported, decorators); return true; }
    if (t.kind === 'keyword' && t.value === 'interface') { this.parseInterface(exported); return true; }
    if (t.kind === 'keyword' && t.value === 'enum') { this.parseEnum(exported); return true; }
    if (t.kind === 'keyword' && t.value === 'type' && this.peek(1).kind === 'ident' && this.peek(2).value === '=') {
      this.parseTypeAlias(exported);
      return true;
    }
    if (t.kind === 'keyword' && t.value === 'function') { this.parseFunction(exported); return true; }
    if (t.kind === 'keyword' && (t.value === 'const' || t.value === 'let' || t.value === 'var')) {
      return this.parseVariable(exported);
    }

    if (decorators.length) {
      for (const d of decorators) this.relations.push({ kind: 'usage', fromId: this.fileId, fromKind: 'file', toName: d, line: t.line });
    }
    return false;
  }

  // -- imports --------------------------------------------------------------

  private parseImport(): boolean {
    this.advance(); // import
    const line = this.peek().line;
    let specifier = '';
    let guard = 0;
    while (!this.eof && guard++ < 500) {
      const t = this.advance();
      if (t.kind === 'string') { specifier = stripQuotes(t.value); break; }
      if (t.kind === 'keyword' && t.value === 'function') break;
    }
    if (specifier) this.imports.push(specifier);

    // Named imports become genuine usages of the imported symbols.
    for (let k = this.pos; k < this.pos + 200 && k < this.tokens.length; k++) {
      const t = this.tokens[k];
      if (t.kind === 'string') break;
      if (t.kind === 'ident' && !RESERVED_AS_TYPE.has(t.value) && !KEYWORDS.has(t.value) && /^[A-Za-z_$][\w$]*$/.test(t.value)) {
        this.relations.push({ kind: 'usage', fromId: this.fileId, fromKind: 'file', toName: t.value, line: t.line });
      }
    }
    this.skipToSemicolon();
    void line;
    return true;
  }

  // -- declarations ---------------------------------------------------------

  private parseClass(exported: boolean, decorators: string[]): void {
    const classToken = this.advance();
    const nameToken = this.peek();
    const name = nameToken.kind === 'ident' ? this.advance().value : 'default';
    let genericParams: string[] | undefined;
    if (this.at('<')) genericParams = this.readGenericParams();

    const baseNames: string[] = [];
    if (this.peek().kind === 'keyword' && this.peek().value === 'extends') {
      this.advance();
      const base = this.readTypeName();
      if (base) baseNames.push(base);
    }
    if (this.peek().kind === 'keyword' && this.peek().value === 'implements') {
      this.advance();
      for (const item of this.readTypeList()) baseNames.push(item);
    }

    const typeId = this.makeTypeId(name, classToken.line);
    const type: DeclaredType = {
      id: typeId,
      kind: 'class',
      name,
      fileId: this.fileId,
      startLine: classToken.line,
      endLine: classToken.line,
      modifiers: exported ? ['export'] : [],
      baseNames,
      genericParams,
      memberIds: [],
      exported,
    };
    this.types.push(type);

    for (const d of decorators) this.relations.push({ kind: 'usage', fromId: typeId, fromKind: 'type', toName: d, line: classToken.line });
    for (const base of baseNames) this.relations.push({ kind: 'base', fromId: typeId, fromKind: 'type', toName: base, line: classToken.line });

    if (!this.at('{')) { this.skipToSemicolon(); return; }
    const span = this.parseClassBody(type);
    this.collectUsages(span.start, span.end, typeId, new Set([name, ...(genericParams ?? [])]));
  }

  private parseClassBody(type: DeclaredType): { start: number; end: number } {
    this.advance(); // '{'
    const start = this.pos;
    let depth = 1;
    let guard = 0;
    while (!this.eof && guard++ < 500000) {
      const t = this.peek();
      if (t.kind === 'punct' && t.value === '{') depth++;
      else if (t.kind === 'punct' && t.value === '}') {
        depth--;
        if (depth === 0) {
          const end = this.pos;
          type.endLine = t.line;
          this.advance();
          return { start, end };
        }
      }
      if (depth === 1) {
        // method / accessor detection: ident ( ... ) at class-body depth
        const isMethod = t.kind === 'ident' && this.peek(1).kind === 'punct' && this.peek(1).value === '(';
        if (isMethod) {
          const name = t.value;
          const line = t.line;
          const forward = this.pos;
          const close = this.matchingParen(forward + 1);
          const paramTypes: string[] = [];
          if (close > forward) this.paramTypesFromRange(forward + 2, close, paramTypes);
          const memberId = `m:${type.id}:${name}:${line}`;
          if (!type.memberIds.includes(memberId)) {
            this.members.push({
              id: memberId,
              kind: name === 'constructor' ? 'constructor' : 'method',
              name,
              ownerId: type.id,
              fileId: this.fileId,
              startLine: line,
              endLine: line,
              signature: `${name}(…)`,
              paramTypes,
              modifiers: [],
            });
            type.memberIds.push(memberId);
          }
          // Skip the parameter list, otherwise parameter names look like fields.
          if (close > forward) this.pos = close;
        } else if (
          t.kind === 'ident' &&
          (this.peek(1).value === ':' || this.peek(1).value === '=' || this.peek(1).value === ';' || this.peek(1).value === '?') &&
          // A declaration name never directly follows a type annotation or
          // member-access punctuation, which rules out `repo: UserRepository`
          // being read as a second declaration.
          ![':', '.', '<', ',', '|', '&', '?'].includes(this.tokens[this.pos - 1]?.value ?? '')
        ) {
          const name = t.value;
          const line = t.line;
          const memberId = `m:${type.id}:${name}:${line}`;
          if (!type.memberIds.includes(memberId)) {
            this.members.push({
              id: memberId,
              kind: 'property',
              name,
              ownerId: type.id,
              fileId: this.fileId,
              startLine: line,
              endLine: line,
              signature: name,
              paramTypes: [],
              modifiers: [],
            });
            type.memberIds.push(memberId);
          }
        }
      }
      this.advance();
    }
    type.endLine = this.peek().line;
    return { start, end: this.pos };
  }

  private parseInterface(exported: boolean): void {
    const token = this.advance();
    const nameToken = this.peek();
    const name = nameToken.kind === 'ident' ? this.advance().value : '';
    if (!name) return;
    let genericParams: string[] | undefined;
    if (this.at('<')) genericParams = this.readGenericParams();
    const baseNames: string[] = [];
    if (this.peek().kind === 'keyword' && this.peek().value === 'extends') {
      this.advance();
      for (const item of this.readTypeList()) baseNames.push(item);
    }
    const typeId = this.makeTypeId(name, token.line);
    const type: DeclaredType = {
      id: typeId,
      kind: 'interface',
      name,
      fileId: this.fileId,
      startLine: token.line,
      endLine: token.line,
      modifiers: exported ? ['export'] : [],
      baseNames,
      genericParams,
      memberIds: [],
      exported,
    };
    this.types.push(type);
    for (const base of baseNames) this.relations.push({ kind: 'base', fromId: typeId, fromKind: 'type', toName: base, line: token.line });

    if (!this.at('{')) return;
    const span = this.parseClassBody(type);
    this.collectUsages(span.start, span.end, typeId, new Set([name, ...(genericParams ?? [])]));
  }

  private parseEnum(exported: boolean): void {
    const token = this.advance();
    const name = this.peek().kind === 'ident' ? this.advance().value : '';
    if (!name) return;
    const typeId = this.makeTypeId(name, token.line);
    this.types.push({
      id: typeId,
      kind: 'enum',
      name,
      fileId: this.fileId,
      startLine: token.line,
      endLine: token.line,
      modifiers: exported ? ['export'] : [],
      baseNames: [],
      memberIds: [],
      exported,
    });
    if (this.at('{')) this.skipBalancedBraces(token.line);
  }

  private parseTypeAlias(exported: boolean): void {
    const token = this.advance();
    const name = this.peek().kind === 'ident' ? this.advance().value : '';
    if (!name) return;
    const typeId = this.makeTypeId(name, token.line);
    this.types.push({
      id: typeId,
      kind: 'class',
      name,
      fileId: this.fileId,
      startLine: token.line,
      endLine: token.line,
      modifiers: [...(exported ? ['export'] : []), 'type-alias'],
      baseNames: [],
      memberIds: [],
      exported,
    });
    // Collect referenced names in the alias body.
    const body = this.spanToSemicolon();
    this.collectUsages(token.line ? body.start : body.start, body.end, typeId, new Set([name]));
    void token;
  }

  private parseFunction(exported: boolean): boolean {
    this.advance(); // function
    if (this.at('*')) this.advance();
    const nameToken = this.peek();
    let name = nameToken.kind === 'ident' ? this.advance().value : '';
    if (!name) {
      // anonymous default export
      name = 'default';
    }
    let genericParams: string[] | undefined;
    if (this.at('<')) genericParams = this.readGenericParams();

    let paramTypes: string[] = [];
    if (this.at('(')) {
      const open = this.pos;
      this.advance();
      const close = this.matchingParen(open);
      this.paramTypesFromRange(open + 1, close, paramTypes);
    }
    // Return type annotation
    let returnType: string | undefined;
    if (this.at(':')) {
      this.advance();
      returnType = this.readTypeName() ?? undefined;
    }

    const startLine = nameToken.line;
    const typeId = this.makeTypeId(name, startLine);
    const signature = `${exported ? 'export ' : ''}function ${name}(…)`;
    const type: DeclaredType = {
      id: typeId,
      kind: 'class',
      name,
      fileId: this.fileId,
      startLine,
      endLine: startLine,
      modifiers: [...(exported ? ['export'] : []), 'function'],
      baseNames: [],
      genericParams,
      memberIds: [],
      exported,
    };
    this.types.push(type);
    const memberId = `m:${typeId}:function:${name}:${startLine}`;
    this.members.push({
      id: memberId,
      kind: 'function',
      name,
      ownerId: typeId,
      fileId: this.fileId,
      startLine,
      endLine: startLine,
      signature,
      returnType,
      paramTypes: dedupe(paramTypes).filter((p) => !RESERVED_AS_TYPE.has(p)),
      modifiers: type.modifiers,
    });
    type.memberIds.push(memberId);

    let spanStart = this.pos;
    let spanEnd = this.pos;
    if (this.at('{')) {
      const span = this.skipBalancedBraces(startLine);
      spanStart = span.start;
      spanEnd = span.end;
      type.endLine = span.endLine;
    } else if (this.at('=>')) {
      const span = this.spanToSemicolon();
      spanEnd = span.end;
    } else {
      this.skipToSemicolon();
      spanEnd = this.pos;
    }
    const exclude = new Set([name, ...(genericParams ?? [])]);
    this.collectUsages(spanStart, spanEnd, memberId, exclude);
    this.collectCalls(spanStart, spanEnd, memberId);
    return true;
  }

  private parseVariable(exported: boolean): boolean {
    this.advance(); // const/let/var
    const nameToken = this.peek();
    if (nameToken.kind !== 'ident') { this.skipToSemicolon(); return true; }
    const name = this.advance().value;
    let returnType: string | undefined;
    if (this.at(':')) {
      this.advance();
      returnType = this.readTypeName() ?? undefined;
    }
    const isArrow = returnType !== undefined || this.at('=');

    if (!isArrow) { this.skipToSemicolon(); return true; }

    // Arrow function assigned to a const → treat as a function.
    let isFn = false;
    if (this.at('=')) {
      const ahead = this.peek(1);
      const ahead2 = this.peek(2);
      if (ahead.kind === 'ident' && ahead2 && ahead2.kind === 'punct' && ahead2.value === '=>') isFn = true;
      if (ahead.kind === 'keyword' && ahead.value === 'async') isFn = true;
      if (ahead.kind === 'punct' && ahead.value === '(') isFn = true;
    }
    const startLine = nameToken.line;

    if (!isFn) {
      const span = this.spanToSemicolon();
      this.collectUsages(span.start, span.end, this.fileId, new Set([name]));
      return true;
    }

    const typeId = this.makeTypeId(name, startLine);
    this.types.push({
      id: typeId,
      kind: 'class',
      name,
      fileId: this.fileId,
      startLine,
      endLine: startLine,
      modifiers: [...(exported ? ['export'] : []), 'function'],
      baseNames: [],
      memberIds: [],
      exported,
    });
    const memberId = `m:${typeId}:function:${name}:${startLine}`;
    this.members.push({
      id: memberId,
      kind: 'function',
      name,
      ownerId: typeId,
      fileId: this.fileId,
      startLine,
      endLine: startLine,
      signature: `${exported ? 'export ' : ''}const ${name} = (…)`,
      returnType,
      paramTypes: [],
      modifiers: [],
    });
    type0MemberIds(this.types, typeId, memberId);

    let spanEnd = this.pos;
    let spanStart = this.pos;
    if (this.peek().kind === 'keyword' && this.peek().value === 'async') { this.advance(); }
    if (this.at('(')) {
      const open = this.pos;
      this.advance();
      this.skipToMatchingParen(open);
    }
    if (this.at('=>') || this.at('=')) {
      this.advance();
      if (this.at('{')) {
        const span = this.skipBalancedBraces(startLine);
        spanEnd = span.end;
      } else {
        const span = this.spanToSemicolon();
        spanEnd = span.end;
      }
    } else {
      const span = this.spanToSemicolon();
      spanStart = span.start;
      spanEnd = span.end;
    }
    this.collectUsages(spanStart, spanEnd, memberId, new Set([name]));
    this.collectCalls(spanStart, spanEnd, memberId);
    return true;
  }

  // -- helpers --------------------------------------------------------------

  private makeTypeId(name: string, line: number): string {
    return `t:${this.fileId}:${name}:${line}`;
  }

  private readGenericParams(): string[] {
    const params: string[] = [];
    if (!this.at('<')) return params;
    this.advance();
    let depth = 1;
    let guard = 0;
    while (!this.eof && depth > 0 && guard++ < 5000) {
      const t = this.advance();
      if (t.kind === 'punct') {
        if (t.value === '<') depth++;
        else if (t.value === '>') depth--;
        else if (t.value === '>=') depth--;
        continue;
      }
      if (t.kind === 'ident' && depth === 1) params.push(t.value);
    }
    return dedupe(params);
  }

  /** Reads a type name like `Foo`, `Foo<Bar>`, `Foo.Bar`. */
  private readTypeName(): string | null {
    let name = '';
    let guard = 0;
    while (guard++ < 64) {
      const t = this.peek();
      if (t.kind === 'ident' || (t.kind === 'keyword' && !RESERVED_AS_TYPE.has(t.value))) {
        name += (name && !name.endsWith('<') && !name.endsWith('.') ? ' ' : '') + t.value;
        this.advance();
      } else if (t.kind === 'punct' && (t.value === '<' || t.value === '>')) {
        name += t.value;
        this.advance();
      } else if (t.kind === 'punct' && t.value === '.' && this.peek(1).kind === 'ident') {
        name += '.';
        this.advance();
      } else if (t.kind === 'punct' && t.value === '[' && this.peek(1).value === ']') {
        name += '[]';
        this.advance();
        this.advance();
      } else {
        break;
      }
    }
    return name.trim() || null;
  }

  private readTypeList(): string[] {
    const out: string[] = [];
    let guard = 0;
    while (!this.eof && guard++ < 200) {
      const t = this.peek();
      if (t.kind === 'punct' && (t.value === '{' || t.value === ';' || t.value === '=')) break;
      const name = this.readTypeName();
      if (!name) { this.advance(); continue; }
      const first = name.split(/[.<\s]/)[0];
      if (first && !RESERVED_AS_TYPE.has(first)) out.push(first);
      if (this.at(',')) { this.advance(); continue; }
      break;
    }
    return dedupe(out);
  }

  private paramTypesFromRange(from: number, to: number, out: string[]): void {
    for (let k = from; k < to; k++) {
      const t = this.tokens[k];
      if (t.kind !== 'ident') continue;
      if (RESERVED_AS_TYPE.has(t.value)) continue;
      if (!/^[A-Za-z_$][\w$]*$/.test(t.value)) continue;
      const prev = this.tokens[k - 1];
      // Type positions: after ':' , or a PascalCase ident
      const prevIsColon = prev && prev.kind === 'punct' && prev.value === ':';
      if (prevIsColon || /^[A-Z]/.test(t.value)) out.push(t.value);
    }
  }

  /**
   * The scope a collected reference belongs to. The id prefix is authoritative:
   * `t:` is a declared type, `m:` a member, anything else is the file itself.
   * Labelling a type-scope reference as a member one silently dropped every
   * class-level type reference when the graph was built.
   */
  private scopeOfId(id: string): 'type' | 'method' | 'file' {
    if (id.startsWith('t:')) return 'type';
    if (id.startsWith('m:')) return 'method';
    return 'file';
  }

  private collectUsages(from: number, to: number, fromId: string, exclude: Set<string>): void {
    const fromKind = this.scopeOfId(fromId);
    for (let k = from; k < to && k < this.tokens.length; k++) {
      const t = this.tokens[k];
      if (t.kind !== 'ident') continue;
      if (exclude.has(t.value)) continue;
      if (RESERVED_AS_TYPE.has(t.value)) continue;
      if (!/^[A-Z]/.test(t.value)) continue;
      const prev = this.tokens[k - 1];
      if (prev && prev.kind === 'punct' && prev.value === '.') continue;
      this.relations.push({ kind: 'usage', fromId, fromKind, toName: t.value, line: t.line });
    }
  }

  private collectCalls(from: number, to: number, fromId: string): void {
    for (let k = from; k < to; k++) {
      const t = this.tokens[k];
      if (t.kind !== 'ident') continue;
      const next = this.tokens[k + 1];
      if (!next || next.kind !== 'punct' || next.value !== '(') continue;
      if (KEYWORDS.has(t.value)) continue;
      const prev = this.tokens[k - 1];
      let targetName = '';
      if (prev && prev.kind === 'punct' && prev.value === '.') {
        const before = this.tokens[k - 2];
        if (before && before.kind === 'ident' && /^[A-Z]/.test(before.value)) targetName = before.value;
      }
      this.relations.push({ kind: 'call', fromId, fromKind: this.scopeOfId(fromId), toName: targetName, methodName: t.value, line: t.line });
    }
  }

  private spanToSemicolon(): { start: number; end: number } {
    const start = this.pos;
    let paren = 0;
    let brace = 0;
    let guard = 0;
    while (!this.eof && guard++ < 200000) {
      const t = this.peek();
      if (t.kind === 'punct') {
        if (t.value === '(') paren++;
        else if (t.value === ')') paren--;
        else if (t.value === '{') brace++;
        else if (t.value === '}') {
          if (brace === 0) break;
          brace--;
        } else if (t.value === ';' && paren === 0 && brace === 0) break;
      }
      this.advance();
    }
    return { start, end: this.pos };
  }

  private skipToSemicolon(): void {
    this.spanToSemicolon();
    if (this.at(';')) this.advance();
  }

  private matchingParen(openIndex: number): number {
    let depth = 0;
    for (let k = openIndex; k < this.tokens.length; k++) {
      const t = this.tokens[k];
      if (t.kind !== 'punct') continue;
      if (t.value === '(') depth++;
      else if (t.value === ')') {
        depth--;
        if (depth === 0) return k;
      }
    }
    return -1;
  }

  private skipToMatchingParen(openIndex: number): void {
    const close = this.matchingParen(openIndex);
    if (close >= 0) this.pos = Math.min(close + 1, this.tokens.length - 1);
    else this.pos = this.tokens.length - 1;
  }

  private skipBalancedBraces(startLine: number): { start: number; end: number; endLine: number } {
    this.advance(); // '{'
    const start = this.pos;
    let depth = 1;
    let endLine = startLine;
    let guard = 0;
    while (!this.eof && guard++ < 500000) {
      const t = this.advance();
      if (t.kind === 'punct' && t.value === '{') depth++;
      else if (t.kind === 'punct' && t.value === '}') {
        depth--;
        if (depth === 0) { endLine = t.line; break; }
      }
    }
    return { start, end: this.pos, endLine };
  }
}

function type0MemberIds(types: DeclaredType[], typeId: string, memberId: string): void {
  const type = types.find((t) => t.id === typeId);
  if (type && !type.memberIds.includes(memberId)) type.memberIds.push(memberId);
}

// -- tokenizer --------------------------------------------------------------

function tokenize(source: string): T[] {
  const out: T[] = [];
  let i = 0;
  let line = 1;
  const n = source.length;

  while (i < n) {
    const ch = source[i];
    if (ch === '\n') { line++; i++; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\f') { i++; continue; }

    if (ch === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') line++;
        i++;
      }
      i = Math.min(n, i + 2);
      continue;
    }

    if (ch === '"' || ch === '\'') {
      const quote = ch;
      const start = i;
      i++;
      while (i < n && source[i] !== quote) {
        if (source[i] === '\\') i++;
        if (source[i] === '\n') line++;
        i++;
      }
      i = Math.min(n, i + 1);
      out.push({ kind: 'string', value: source.slice(start, i), line });
      continue;
    }
    if (ch === '`') {
      // Template literal: interpolations are scanned as code for usage detection.
      i++;
      while (i < n && source[i] !== '`') {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === '$' && source[i + 1] === '{') {
          let depth = 1;
          i += 2;
          while (i < n && depth > 0) {
            if (source[i] === '{') depth++;
            else if (source[i] === '}') depth--;
            if (source[i] === '\n') line++;
            i++;
          }
          continue;
        }
        if (source[i] === '\n') line++;
        i++;
      }
      i = Math.min(n, i + 1);
      out.push({ kind: 'template', value: '``', line });
      continue;
    }

    if (/[A-Za-z_$]/.test(ch)) {
      const start = i;
      while (i < n && /[A-Za-z0-9_$]/.test(source[i])) i++;
      const value = source.slice(start, i);
      out.push({ kind: KEYWORDS.has(value) ? 'keyword' : 'ident', value, line });
      continue;
    }

    if (/[0-9]/.test(ch)) {
      const start = i;
      while (i < n && /[0-9a-fA-FxX._,eE+\-n]/.test(source[i])) {
        if (source[i] === '+' || source[i] === '-') {
          const prev = source[i - 1];
          if (prev !== 'e' && prev !== 'E') break;
        }
        i++;
      }
      out.push({ kind: 'number', value: source.slice(start, i), line });
      continue;
    }

    const pair = source.startsWith('=>', i) ? '=>' : source.startsWith('?.', i) ? '?.' : source.startsWith('??', i) ? '??' : null;
    if (pair) { out.push({ kind: 'punct', value: pair, line }); i += pair.length; continue; }

    out.push({ kind: 'punct', value: ch, line });
    i++;
  }

  out.push({ kind: 'eof', value: '', line });
  return out;
}

function stripQuotes(text: string): string {
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith('\'') && text.endsWith('\'')) || (text.startsWith('`') && text.endsWith('`'))) {
    return text.slice(1, -1);
  }
  return text;
}

function dedupe<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}
