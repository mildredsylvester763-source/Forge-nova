import ts from 'typescript';

export interface SourceFileInput {
  path: string;
  content: string;
}

export type FindingSeverity = 'ERROR' | 'WARNING' | 'INFO';

export interface VerificationFinding {
  path: string;
  line: number;
  column: number;
  severity: FindingSeverity;
  code: string;
  message: string;
}

export interface StaticAnalysisReport {
  analyzedFiles: number;
  unsupportedFiles: string[];
  findings: VerificationFinding[];
}

/**
 * Non-executing static analysis: real TypeScript parser diagnostics and real
 * JSON validation. Nothing is executed, and no execution is ever claimed.
 */
export function analyzeSource(files: SourceFileInput[]): StaticAnalysisReport {
  const findings: VerificationFinding[] = [];
  const unsupportedFiles: string[] = [];
  let analyzedFiles = 0;

  for (const file of files) {
    const extension = file.path.toLowerCase().split('.').pop() ?? '';

    if (extension === 'json') {
      analyzedFiles += 1;
      try {
        JSON.parse(file.content);
      } catch (error) {
        findings.push({
          path: file.path,
          line: 1,
          column: 1,
          severity: 'ERROR',
          code: 'json.parse',
          message: error instanceof Error ? error.message.slice(0, 500) : 'Invalid JSON.',
        });
      }
      continue;
    }

    const scriptKind = scriptKindForExtension(extension);
    if (scriptKind === undefined) {
      unsupportedFiles.push(file.path);
      continue;
    }

    analyzedFiles += 1;
    const source = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true, scriptKind);
    const parseDiagnostics =
      (source as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];

    for (const diagnostic of parseDiagnostics) {
      const position =
        diagnostic.file && diagnostic.start !== undefined
          ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
          : { line: 0, character: 0 };
      findings.push({
        path: file.path,
        line: position.line + 1,
        column: position.character + 1,
        severity: diagnostic.category === ts.DiagnosticCategory.Error ? 'ERROR' : 'WARNING',
        code: 'ts.parse',
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ').slice(0, 500),
      });
    }
  }

  findings.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column);
  return { analyzedFiles, unsupportedFiles, findings };
}

function scriptKindForExtension(extension: string): ts.ScriptKind | undefined {
  switch (extension) {
    case 'ts':
    case 'mts':
    case 'cts':
      return ts.ScriptKind.TS;
    case 'tsx':
      return ts.ScriptKind.TSX;
    case 'js':
    case 'mjs':
    case 'cjs':
      return ts.ScriptKind.JS;
    case 'jsx':
      return ts.ScriptKind.JSX;
    default:
      return undefined;
  }
}
