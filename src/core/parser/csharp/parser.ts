// C# structural parser.
//
// Consumes the tokenizer output and builds a structural model: namespaces,
// type declarations (class/interface/struct/enum/record), their base lists,
// and members (methods, constructors, properties, fields) with the type
// references and call sites each contains.
//
// It is deliberately conservative: only relationships actually present in the
// syntax are recorded. Nothing is fabricated to make the graph look denser.

import type {
  AnalysisWarning,
  DeclaredMember,
  DeclaredType,
  DeclaredTypeKind,
  ParsedFile,
  RawRelation,
} from '../../types';
import { CSHARP_CONTEXTUAL, CSHARP_KEYWORDS, MODIFIERS, tokenizeCSharp, type Token } from './lexer';

const TYPE_BASE = new Set(['class', 'interface', 'struct', 'enum', 'record']);
const CALL_SKIP = new Set([
  'if', 'while', 'for', 'foreach', 'switch', 'catch', 'using', 'lock',
  'return', 'new', 'typeof', 'sizeof', 'nameof', 'default', 'checked',
  'unchecked', 'await', 'is', 'as', 'in', 'out', 'ref', 'throw', 'get', 'set',
]);

export function parseCSharp(fileId: string, source: string): ParsedFile {
  return new CSharpFileParser(fileId, source).parse();
}

class CSharpFileParser {
  private readonly tokens: Token[];
  private pos = 0;
  private namespace = '';
  private readonly typeStack: string[] = [];
  private readonly types: DeclaredType[] = [];
  private readonly members: DeclaredMember[] = [];
  private readonly relations: RawRelation[] = [];
  private readonly imports: string[] = [];
  private readonly errors: AnalysisWarning[] = [];
  /** owner type id -> field/property name -> declared type text. */
  private readonly fieldTypes = new Map<string, Map<string, string>>();

  constructor(private readonly fileId: string, source: string) {
    this.tokens = tokenizeCSharp(source);
  }

  parse(): ParsedFile {
    this.parseContainer(false);
    return {
      fileId: this.fileId,
      namespace: this.namespace || undefined,
      types: this.types,
      members: this.members,
      relations: this.relations,
      imports: dedupe(this.imports),
      errors: this.errors,
    };
  }

  // -- token helpers --------------------------------------------------------

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
  }

  private at(value: string, offset = 0): boolean {
    const t = this.peek(offset);
    return (t.kind === 'punct') && t.value === value;
  }

  private advance(): Token {
    const t = this.tokens[this.pos];
    if (this.pos < this.tokens.length - 1) this.pos++;
    return t;
  }

  private get eof(): boolean {
    return this.peek().kind === 'eof';
  }

  private isWord(index: number, word: string): boolean {
    const t = this.tokens[index];
    return !!t && (t.kind === 'ident' || t.kind === 'keyword') && t.value === word;
  }

  // -- container ------------------------------------------------------------

  private parseContainer(expectClose: boolean): void {
    let guard = 0;
    const limit = this.tokens.length * 2 + 64;
    while (!this.eof && guard++ < limit) {
      const startPos = this.pos;
      this.parseOneDeclaration();
      if (this.pos === startPos) this.advance();
      if (expectClose && this.isClosingBrace()) {
        this.advance();
        return;
      }
    }
  }

  private isClosingBrace(): boolean {
    const t = this.peek();
    return t.kind === 'punct' && t.value === '}';
  }

  private parseOneDeclaration(): void {
    const t = this.peek();

    if (t.kind === 'directive') { this.advance(); return; }
    if (t.kind === 'punct' && t.value === '[') { this.collectAttributes(); return; }
    if (t.kind === 'punct' && t.value === ';') { this.advance(); return; }
    if (t.kind === 'punct' && t.value === '}') { this.advance(); return; }

    // using directive (including `global using`)
    if (this.isWord(this.pos, 'using') || (this.isWord(this.pos, 'global') && this.isWord(this.pos + 1, 'using'))) {
      this.parseUsingDirective();
      return;
    }

    if (this.isWord(this.pos, 'namespace')) {
      this.parseNamespace();
      return;
    }

    this.readModifiersTokens();

    const cur = this.peek();
    if (cur.kind === 'keyword' && TYPE_BASE.has(cur.value)) {
      this.parseTypeDeclaration();
      return;
    }
    if (cur.kind === 'keyword' && cur.value === 'delegate') {
      this.advance();
      this.skipToSemicolon();
      return;
    }
    // Unknown construct at container level — let the caller advance.
  }

  private parseUsingDirective(): void {
    if (this.isWord(this.pos, 'global')) this.advance();
    this.advance(); // using
    let isStatic = false;
    if (this.isWord(this.pos, 'static')) { isStatic = true; this.advance(); }

    const first = this.peek();
    if (first.kind === 'ident' && this.at('=', 1)) {
      this.advance(); // alias
      this.advance(); // '='
      const target = this.readDottedName();
      if (target) {
        this.relations.push({ kind: 'usage', fromId: this.fileId, fromKind: 'file', toName: lastSegment(target), line: first.line });
      }
    } else {
      const name = this.readDottedName();
      const alias = this.at('=') ? null : name;
      if (alias) this.imports.push(isStatic ? `${alias}.*` : alias);
      if (this.at('=')) { this.advance(); this.readDottedName(); }
    }
    this.skipToSemicolon();
  }

  private parseNamespace(): void {
    this.advance(); // namespace
    const name = this.readDottedName();
    if (this.at(';')) {
      this.advance();
      this.namespace = name; // file-scoped namespace
      return;
    }
    if (this.at('{')) {
      this.advance();
      const previous = this.namespace;
      this.namespace = name;
      this.parseContainer(true);
      this.namespace = previous;
    }
  }

  private readDottedName(): string {
    let name = '';
    let guard = 0;
    while (guard++ < 64) {
      const t = this.peek();
      if (t.kind === 'ident' || (t.kind === 'keyword' && t.value === 'global')) {
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

  // -- type declarations ----------------------------------------------------

  private parseTypeDeclaration(): void {
    const kindToken = this.advance();
    const kind = (kindToken.value === 'record' && (this.peek().value === 'class' || this.peek().value === 'struct')
      ? (this.advance(), 'record')
      : kindToken.value) as DeclaredTypeKind;

    const nameToken = this.peek();
    if (nameToken.kind !== 'ident') {
      this.skipToSemicolonOrBrace();
      return;
    }
    const name = this.advance().value;

    let genericParams: string[] | undefined;
    if (this.at('<')) genericParams = this.readGenericParams();

    const startLine = kindToken.line;
    const qualifiedName = [...this.typeStack, name].join('.');
    const typeId = makeTypeId(this.fileId, this.namespace, qualifiedName, startLine);
    const declared: DeclaredType = {
      id: typeId,
      kind,
      name,
      namespace: this.namespace || undefined,
      fileId: this.fileId,
      startLine,
      endLine: startLine,
      modifiers: this.pendingModifiers,
      baseNames: [],
      genericParams,
      memberIds: [],
    };

    // Record positional parameters: record Foo(int A, string B)
    if (kind === 'record' && this.at('(')) {
      const close = this.matchingParen(this.pos);
      if (close > this.pos) {
        const paramTypes: string[] = [];
        this.paramTypesFromRange(this.pos + 1, close, paramTypes);
        for (const p of paramTypes) {
          this.relations.push({ kind: 'usage', fromId: typeId, fromKind: 'type', toName: p, line: startLine });
        }
      }
      this.advance(); // '('
      this.skipToMatchingParen();
    }

    if (this.at(':')) {
      this.advance();
      const bases = this.readBaseList(typeId);
      declared.baseNames = bases;
      for (const base of bases) {
        this.relations.push({ kind: 'base', fromId: typeId, fromKind: 'type', toName: base, line: startLine });
      }
    }

    this.skipWhereClauses();
    this.types.push(declared);

    if (this.at('{')) {
      if (kind === 'enum') {
        const span = this.skipBalancedBraces();
        declared.endLine = span.endLine;
        this.collectUsages(span.start, span.end, typeId, 'type', new Set([name, ...(genericParams ?? [])]));
      } else {
        this.typeStack.push(name);
        this.parseTypeBody(declared, genericParams);
        this.typeStack.pop();
      }
    } else {
      this.skipToSemicolon();
    }
  }

  private parseTypeBody(type: DeclaredType, genericParams?: string[]): void {
    this.advance(); // '{'
    let guard = 0;
    const limit = this.tokens.length * 2 + 64;
    while (!this.eof && guard++ < limit) {
      const t = this.peek();
      if (t.kind === 'punct' && t.value === '}') {
        type.endLine = this.advance().line;
        return;
      }
      if (t.kind === 'directive' || (t.kind === 'punct' && (t.value === ';' || t.value === ','))) {
        this.advance();
        continue;
      }
      if (t.kind === 'punct' && t.value === '[') { this.collectAttributes(); continue; }
      if (t.kind === 'punct' && t.value === '~') {
        this.advance();
        this.skipToSemicolonOrBrace();
        continue;
      }
      const startPos = this.pos;
      this.parseMember(type, genericParams);
      if (this.pos === startPos) this.advance();
    }
    type.endLine = this.peek().line;
  }

  private parseMember(type: DeclaredType, genericParams?: string[]): void {
    const memberStart = this.pos;
    const startLine = this.peek().line;
    const modifiers = this.readModifiersTokens();

    const cur = this.peek();
    if (cur.kind === 'keyword' && TYPE_BASE.has(cur.value)) { this.parseTypeDeclaration(); return; }
    if (cur.kind === 'keyword' && cur.value === 'delegate') { this.advance(); this.skipToSemicolon(); return; }
    if (cur.kind === 'punct' && cur.value === '}') return;

    const stop = this.scanDeclarationHead(memberStart);
    const stopToken = this.tokens[stop];
    if (!stopToken || stopToken.kind === 'eof') {
      this.pos = stop;
      return;
    }

    const sawEquals = this.headHasEquals(memberStart, stop);
    const parenIndex = this.findFirstParen(memberStart, stop);
    const nameInfo = parenIndex >= 0 && !this.headHasEquals(memberStart, parenIndex)
      ? this.methodNameAt(parenIndex)
      : null;
    const indexer = this.findIndexer(memberStart, stop);

    let name: string;
    let nameIndex: number;
    if (indexer >= 0) {
      name = 'this[]';
      nameIndex = indexer;
    } else if (nameInfo) {
      name = nameInfo.name;
      nameIndex = nameInfo.index;
    } else {
      name = this.lastIdentifierBefore(stop, memberStart);
      nameIndex = this.lastIdentifierIndexBefore(stop, memberStart);
    }
    if (!name) {
      // Unrecognised member: consume it and move on rather than guessing.
      this.consumeMemberBody(stop, stopToken, sawEquals);
      return;
    }

    let kind: DeclaredMember['kind'];
    let returnType: string | undefined;

    if (nameInfo) {
      kind = name === type.name ? 'constructor' : 'method';
      returnType = name === type.name ? undefined : this.typeExpressionBefore(nameIndex);
    } else if (sawEquals) {
      kind = 'field';
      returnType = this.typeExpressionBefore(nameIndex);
    } else if (stopToken.kind === 'punct' && (stopToken.value === '=>' || stopToken.value === '{')) {
      kind = 'property';
      returnType = this.typeExpressionBefore(nameIndex);
    } else {
      kind = 'field';
      returnType = this.typeExpressionBefore(nameIndex);
    }

    const paramTypes: string[] = [];
    let closeParen = -1;
    if (nameInfo && parenIndex >= 0) {
      closeParen = this.matchingParen(parenIndex);
      if (closeParen > parenIndex) this.paramTypesFromRange(parenIndex + 1, closeParen, paramTypes);
    }

    const bodyEnd = this.consumeMemberBody(stop, stopToken, sawEquals);
    const endLine = this.tokens[Math.max(memberStart, bodyEnd - 1)]?.line ?? startLine;

    const exclude = new Set<string>([name, type.name, ...(genericParams ?? [])]);
    const memberId = makeMemberId(type.id, kind, name, startLine);
    this.members.push({
      id: memberId,
      kind,
      name,
      ownerId: type.id,
      fileId: this.fileId,
      startLine,
      endLine,
      signature: this.buildSignature(modifiers, returnType, name, kind, parenIndex, nameInfo),
      returnType,
      paramTypes: dedupe(paramTypes),
      modifiers,
    });
    type.memberIds.push(memberId);

    if ((kind === 'field' || kind === 'property') && returnType) {
      const fields = this.fieldTypes.get(type.id) ?? new Map<string, string>();
      fields.set(name, returnType);
      this.fieldTypes.set(type.id, fields);
    }

    this.collectUsages(memberStart, bodyEnd, memberId, 'method', exclude);
    this.collectInstantiations(memberStart, bodyEnd, memberId);
    if (kind === 'method' || kind === 'constructor') {
      // Call sites only exist after the signature — otherwise the declaration's
      // own name ("GetUser(") would be recorded as a call to itself.
      const callStart = closeParen > 0 ? closeParen + 1 : stop;
      this.collectCalls(callStart, bodyEnd, memberId, type.id);
    }
  }

  private pendingModifiers: string[] = [];

  private readModifiersTokens(): string[] {
    const mods: string[] = [];
    for (;;) {
      const t = this.peek();
      if (!((t.kind === 'keyword' || t.kind === 'ident') && MODIFIERS.has(t.value))) break;
      mods.push(this.advance().value);
      if (mods.length > 24) break;
    }
    this.pendingModifiers = mods;
    return mods;
  }

  // -- head analysis --------------------------------------------------------

  private scanDeclarationHead(from: number): number {
    let paren = 0;
    let bracket = 0;
    for (let k = from; k < this.tokens.length; k++) {
      const t = this.tokens[k];
      if (t.kind === 'eof') return k;
      if (t.kind !== 'punct') continue;
      if (t.value === '(') { paren++; continue; }
      if (t.value === ')') { paren--; continue; }
      if (t.value === '[') { bracket++; continue; }
      if (t.value === ']') { bracket--; continue; }
      if (paren > 0 || bracket > 0) continue;
      if (t.value === '{' || t.value === ';' || t.value === '=>' || t.value === '}') return k;
    }
    return this.tokens.length - 1;
  }

  private headHasEquals(from: number, to: number): boolean {
    let paren = 0;
    for (let k = from; k < to; k++) {
      const t = this.tokens[k];
      if (t.kind !== 'punct') continue;
      if (t.value === '(') paren++;
      else if (t.value === ')') paren--;
      else if (paren === 0 && t.value === '=') return true;
    }
    return false;
  }

  private findFirstParen(from: number, to: number): number {
    for (let k = from; k < to; k++) {
      const t = this.tokens[k];
      if (t.kind === 'punct' && t.value === '(') return k;
    }
    return -1;
  }

  private findIndexer(from: number, to: number): number {
    for (let k = from; k < to - 1; k++) {
      if (this.isWord(k, 'this') && this.tokens[k + 1]?.value === '[') return k;
    }
    return -1;
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

  private methodNameAt(parenIndex: number): { name: string; index: number } | null {
    const before = this.tokens[parenIndex - 1];
    if (!before) return null;
    if (before.kind === 'ident') return { name: before.value, index: parenIndex - 1 };
    if (before.kind === 'punct' && before.value === '>') {
      let depth = 0;
      for (let k = parenIndex - 1; k >= 0; k--) {
        const t = this.tokens[k];
        if (t.kind !== 'punct') continue;
        if (t.value === '>') depth++;
        else if (t.value === '<') {
          depth--;
          if (depth === 0) {
            const candidate = this.tokens[k - 1];
            if (candidate && candidate.kind === 'ident') return { name: candidate.value, index: k - 1 };
            return null;
          }
        }
      }
      return null;
    }
    if (before.kind === 'punct' && before.value === ']') {
      return { name: 'this[]', index: parenIndex - 1 };
    }
    if (this.isWord(parenIndex - 1, 'operator') || this.isWord(parenIndex - 2, 'operator')) {
      return { name: 'operator', index: parenIndex - 1 };
    }
    return null;
  }

  private lastIdentifierBefore(stop: number, from: number): string {
    const idx = this.lastIdentifierIndexBefore(stop, from);
    return idx >= 0 ? this.tokens[idx].value : '';
  }

  private lastIdentifierIndexBefore(stop: number, from: number): number {
    for (let k = Math.min(stop - 1, this.tokens.length - 1); k >= from; k--) {
      if (this.tokens[k].kind === 'ident') return k;
    }
    return -1;
  }

  /** Reconstructs the declared type expression immediately before `nameIndex`. */
  private typeExpressionBefore(nameIndex: number): string | undefined {
    const parts: string[] = [];
    let k = nameIndex - 1;
    let angle = 0;
    let guard = 0;
    while (k >= 0 && guard++ < 128) {
      const t = this.tokens[k];
      if (t.kind === 'ident' || t.kind === 'keyword') {
        if (MODIFIERS.has(t.value)) break;
        parts.push(t.value);
        k--;
        continue;
      }
      if (t.kind === 'punct') {
        const v = t.value;
        if (v === '>') { angle++; parts.push(v); k--; continue; }
        if (v === '<') { angle--; parts.push(v); k--; continue; }
        if (angle > 0) { parts.push(v); k--; continue; }
        if (v === '.' || v === '?' || v === '*' || v === '[' || v === ']' || v === ',') {
          parts.push(v);
          k--;
          continue;
        }
      }
      break;
    }
    const text = parts.reverse().join('').trim();
    return text || undefined;
  }

  private paramTypesFromRange(from: number, to: number, out: string[]): void {
    for (const seg of splitTopLevel(this.tokens, from, to, ',')) {
      let nameIdx = -1;
      for (let k = seg.end - 1; k >= seg.start; k--) {
        if (this.tokens[k].kind === 'ident') { nameIdx = k; break; }
      }
      if (nameIdx <= seg.start) continue;
      const text = this.typeExpressionBefore(nameIdx);
      if (text) for (const n of splitTypeNames(text)) out.push(n);
    }
  }

  // -- body consumption -----------------------------------------------------

  private consumeMemberBody(stop: number, stopToken: Token, sawEquals: boolean): number {
    // Head scanning never moves the cursor, so jump it to the first stop token
    // before consuming the body. Without this the loop would re-parse the rest
    // of the declaration as more members.
    this.pos = Math.max(this.pos, stop);

    if (stopToken.kind === 'eof') {
      return stop;
    }

    if (sawEquals && (stopToken.value === '{' || stopToken.value === '=>')) {
      if (stopToken.value === '{') this.skipBalancedBraces();
      this.skipToSemicolonOrBrace();
      return this.pos;
    }

    if (stopToken.value === '{') {
      this.skipBalancedBraces();
      this.skipTrailingInitializer();
      return this.pos;
    }

    if (stopToken.value === '=>') {
      let paren = 0;
      let guard = 0;
      while (!this.eof && guard++ < 200000) {
        const t = this.peek();
        if (t.kind === 'punct') {
          if (t.value === '(') paren++;
          else if (t.value === ')') { if (paren > 0) paren--; }
          else if (t.value === '{') { this.skipBalancedBraces(); continue; }
          else if (t.value === ';' && paren === 0) { this.advance(); break; }
          else if (t.value === '}' && paren === 0) break;
        }
        this.advance();
      }
      return this.pos;
    }

    if (stopToken.value === ';') {
      this.advance();
      return this.pos;
    }

    // stopToken.value === '}' — unterminated declaration; leave the brace.
    this.pos = stop;
    return stop;
  }

  private skipTrailingInitializer(): void {
    if (this.at('=')) this.skipToSemicolon();
  }

  private buildSignature(
    modifiers: string[],
    returnType: string | undefined,
    name: string,
    kind: DeclaredMember['kind'],
    parenIndex: number,
    nameInfo: { name: string; index: number } | null,
  ): string {
    const mods = modifiers.join(' ');
    if (nameInfo && parenIndex >= 0) {
      const close = this.matchingParen(parenIndex);
      const params = close > parenIndex
        ? this.tokens.slice(parenIndex + 1, close).map((t) => t.value).join(' ')
        : '';
      const prefix = kind === 'constructor' ? '' : `${returnType ?? ''} `;
      return `${mods} ${prefix}${name}(${compact(params)})`.trim();
    }
    return returnType ? `${mods} ${returnType} ${name}`.trim() : `${mods} ${name}`.trim();
  }

  // -- relations ------------------------------------------------------------

  private collectUsages(from: number, to: number, fromId: string, fromKind: RawRelation['fromKind'], exclude: Set<string>): void {
    for (let k = from; k < to && k < this.tokens.length; k++) {
      const t = this.tokens[k];
      if (t.kind === 'string') {
        for (const ref of t.interpolationRefs ?? []) {
          if (!exclude.has(ref) && isTypeLikeName(ref) && !CSHARP_CONTEXTUAL.has(ref) && !CSHARP_KEYWORDS.has(ref)) {
            this.relations.push({ kind: 'usage', fromId, fromKind, toName: ref, line: t.line });
          }
        }
        continue;
      }
      if (t.kind !== 'ident') continue;
      if (CSHARP_CONTEXTUAL.has(t.value)) continue;
      if (!isTypeLikeName(t.value)) continue;
      if (exclude.has(t.value)) continue;
      const prev = this.tokens[k - 1];
      if (prev && prev.kind === 'punct' && (prev.value === '.' || prev.value === '->' || prev.value === '::')) continue;
      this.relations.push({ kind: 'usage', fromId, fromKind, toName: t.value, line: t.line });
    }
  }

  private collectInstantiations(from: number, to: number, fromId: string): void {
    for (let k = from; k < to; k++) {
      const t = this.tokens[k];
      if (t.kind !== 'keyword' || t.value !== 'new') continue;
      const next = this.tokens[k + 1];
      if (!next || next.kind !== 'ident') continue;
      if (CSHARP_CONTEXTUAL.has(next.value)) continue;
      this.relations.push({ kind: 'instantiate', fromId, fromKind: 'method', toName: next.value, line: next.line });
    }
  }

  private collectCalls(from: number, to: number, fromId: string, ownerTypeId: string): void {
    const ownerFields = this.fieldTypes.get(ownerTypeId);
    for (let k = from; k < to; k++) {
      const t = this.tokens[k];
      if (t.kind !== 'ident') continue;
      const next = this.tokens[k + 1];
      if (!next || next.kind !== 'punct' || next.value !== '(') continue;
      if (CALL_SKIP.has(t.value)) continue;
      const prev = this.tokens[k - 1];
      if (prev && (prev.kind === 'keyword' && CALL_SKIP.has(prev.value))) continue;
      if (prev && prev.kind === 'ident' && MODIFIERS.has(prev.value)) continue;

      let targetName = '';
      let memberAccess = false;
      let viaTypes: string[] | undefined;

      if (prev && prev.kind === 'punct' && prev.value === '.') {
        memberAccess = true;
        const before = this.tokens[k - 2];
        if (before && before.kind === 'ident') {
          if (isTypeLikeName(before.value)) {
            // Static call through a type name: `UserRepository.Create()`. Only
            // a real type reference counts, so keep it as a usage-style call.
            targetName = before.value;
          } else if (ownerFields?.has(before.value)) {
            // Instance call through a field/property: resolve via its declared type.
            viaTypes = splitTypeNames(ownerFields.get(before.value)!);
          }
        }
      }

      this.relations.push({
        kind: 'call',
        fromId,
        fromKind: 'method',
        toName: targetName,
        methodName: t.value,
        line: t.line,
        memberAccess,
        viaTypes,
      });
    }
  }

  private collectAttributes(): void {
    const start = this.advance(); // '['
    let depth = 1;
    const names: string[] = [];
    let guard = 0;
    while (!this.eof && depth > 0 && guard++ < 10000) {
      const t = this.peek();
      if (t.kind === 'punct' && t.value === '[') depth++;
      if (t.kind === 'punct' && t.value === ']') {
        depth--;
        if (depth === 0) { this.advance(); break; }
      }
      if (t.kind === 'ident' && !CSHARP_CONTEXTUAL.has(t.value) && isTypeLikeName(t.value)) names.push(t.value);
      this.advance();
    }
    const owner = this.types.length ? this.types[this.types.length - 1].id : this.fileId;
    const ownerKind: RawRelation['fromKind'] = this.typeStack.length ? 'type' : 'file';
    for (const name of names) {
      this.relations.push({ kind: 'usage', fromId: owner, fromKind: ownerKind, toName: name, line: start.line });
    }
  }

  private readGenericParams(): string[] {
    const params: string[] = [];
    if (!this.at('<')) return params;
    this.advance();
    let depth = 1;
    let expectName = true;
    let guard = 0;
    while (!this.eof && depth > 0 && guard++ < 5000) {
      const t = this.advance();
      if (t.kind === 'punct') {
        if (t.value === '<') depth++;
        else if (t.value === '>') depth--;
        else if (t.value === ',' && depth === 1) expectName = true;
        continue;
      }
      if (t.kind === 'ident' && expectName) {
        params.push(t.value);
        expectName = false;
      }
    }
    return params;
  }

  private readBaseList(typeId: string): string[] {
    const out: string[] = [];
    let depthAngle = 0;
    let depthParen = 0;
    let pendingName = '';
    let guard = 0;
    const flush = () => {
      if (pendingName) { out.push(pendingName); pendingName = ''; }
    };
    while (!this.eof && guard++ < 2000) {
      const t = this.peek();
      if (t.kind === 'ident' && t.value === 'where') break;
      if (t.kind === 'punct') {
        if (t.value === '<') depthAngle++;
        else if (t.value === '>') depthAngle = Math.max(0, depthAngle - 1);
        else if (t.value === '(') depthParen++;
        else if (t.value === ')') depthParen--;
        else if (t.value === ',' && depthAngle === 0 && depthParen === 0) {
          flush();
          this.advance();
          continue;
        } else if ((t.value === '{' || t.value === ';') && depthAngle === 0 && depthParen === 0) {
          break;
        }
      }
      if (t.kind === 'ident') {
        if (!pendingName && depthAngle === 0 && depthParen === 0) pendingName = t.value;
        else if (depthAngle > 0) {
          this.relations.push({ kind: 'usage', fromId: typeId, fromKind: 'type', toName: t.value, line: t.line });
        }
      }
      this.advance();
    }
    flush();
    return out;
  }

  private skipWhereClauses(): void {
    let guard = 0;
    while (this.peek().value === 'where' && guard++ < 64) {
      let inner = 0;
      while (!this.eof && inner++ < 2000) {
        const t = this.peek();
        if (t.kind === 'punct' && (t.value === '{' || t.value === ';')) return;
        this.advance();
        if (t.kind === 'punct' && t.value === ',') break;
      }
    }
  }

  // -- skipping -------------------------------------------------------------

  private skipToSemicolon(): void {
    let guard = 0;
    while (!this.eof && guard++ < 200000) {
      const t = this.peek();
      if (t.kind === 'punct' && t.value === ';') { this.advance(); return; }
      if (t.kind === 'punct' && t.value === '{') { this.skipBalancedBraces(); continue; }
      if (t.kind === 'punct' && t.value === '}') return;
      this.advance();
    }
  }

  private skipToSemicolonOrBrace(): void {
    let guard = 0;
    while (!this.eof && guard++ < 200000) {
      const t = this.peek();
      if (t.kind === 'punct' && t.value === ';') { this.advance(); return; }
      if (t.kind === 'punct' && t.value === '{') { this.skipBalancedBraces(); return; }
      if (t.kind === 'punct' && t.value === '}') return;
      this.advance();
    }
  }

  private skipToMatchingParen(): void {
    let depth = 0;
    let guard = 0;
    while (!this.eof && guard++ < 200000) {
      const t = this.advance();
      if (t.kind === 'punct' && t.value === '(') depth++;
      else if (t.kind === 'punct' && t.value === ')') {
        depth--;
        if (depth <= 0) return;
      }
    }
  }

  private skipBalancedBraces(): { start: number; end: number; endLine: number } {
    const start = this.pos;
    let depth = 0;
    let endLine = this.peek().line;
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

// -- helpers ----------------------------------------------------------------

export function makeTypeId(fileId: string, namespace: string, qualifiedName: string, line: number): string {
  return `t:${fileId}:${namespace ? `${namespace}.` : ''}${qualifiedName}:${line}`;
}

export function makeMemberId(ownerId: string, kind: string, name: string, line: number): string {
  return `m:${ownerId}:${kind}:${name}:${line}`;
}

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
    const name = match[0];
    if (CSHARP_KEYWORDS.has(name)) continue;
    if (!isTypeLikeName(name)) continue;
    names.push(name);
  }
  return dedupe(names);
}

function splitTopLevel(tokens: Token[], from: number, to: number, sep: string): Array<{ start: number; end: number }> {
  const segments: Array<{ start: number; end: number }> = [];
  let paren = 0;
  let angle = 0;
  let bracket = 0;
  let start = from;
  for (let k = from; k < to; k++) {
    const t = tokens[k];
    if (t.kind !== 'punct') continue;
    if (t.value === '(') paren++;
    else if (t.value === ')') paren--;
    else if (t.value === '[') bracket++;
    else if (t.value === ']') bracket--;
    else if (t.value === '<') angle++;
    else if (t.value === '>') angle = Math.max(0, angle - 1);
    else if (t.value === sep && paren === 0 && angle === 0 && bracket === 0) {
      segments.push({ start, end: k });
      start = k + 1;
    }
  }
  if (to > start) segments.push({ start, end: to });
  return segments;
}

function lastSegment(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx === -1 ? name : name.slice(idx + 1);
}

function compact(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function dedupe<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}
