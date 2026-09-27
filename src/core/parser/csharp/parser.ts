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
