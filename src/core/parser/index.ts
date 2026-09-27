import type { AnalysisWarning, LanguageId, ParsedFile } from '../types';
import { parseCSharp } from './csharp/parser';
import { parseTypeScript } from './tsjs/parser';
import { parsePython } from './python/parser';

export interface ParseInput {
  fileId: string;
  language: LanguageId;
  source: string;
}

/**
 * Parses a single file. Adding a language is a matter of adding a branch here
 * plus a language entry in scanner/languages.ts — nothing else changes.
 */
export function parseFile({ fileId, language, source }: ParseInput): ParsedFile {
  try {
    switch (language) {
      case 'csharp':
        return parseCSharp(fileId, source);
      case 'python':
        return parsePython(fileId, source);
      case 'typescript':
      case 'javascript':
        return parseTypeScript(fileId, source);
      default:
        return emptyParse(fileId);
    }
  } catch (err) {
    const warning: AnalysisWarning = {
      kind: 'parse-error',
      path: fileId,
      message: err instanceof Error ? err.message : 'Unknown parse failure',
    };
    return { ...emptyParse(fileId), errors: [warning] };
  }
}

function emptyParse(fileId: string): ParsedFile {
  return { fileId, types: [], members: [], relations: [], imports: [], errors: [] };
}

export { parseCSharp, parseTypeScript, parsePython };
