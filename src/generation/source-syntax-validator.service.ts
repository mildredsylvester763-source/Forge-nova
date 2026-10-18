import { Injectable } from '@nestjs/common';
import ts from 'typescript';
import { GeneratedSourceFile } from '../files/application-source.service';

export interface SyntaxDiagnostic {
  path: string;
  line: number;
  column: number;
  message: string;
}

export interface SyntaxValidationResult {
  status: 'PASSED' | 'FAILED' | 'PARTIAL' | 'NOT_APPLICABLE';
  checkedFiles: number;
  unsupportedFiles: string[];
  diagnostics: SyntaxDiagnostic[];
}

@Injectable()
export class SourceSyntaxValidatorService {
  validate(files: GeneratedSourceFile[]): SyntaxValidationResult {
    const diagnostics: SyntaxDiagnostic[] = [];
    const unsupportedFiles: string[] = [];
    let checkedFiles = 0;

    for (const file of files) {
      const extension = file.path.toLowerCase().split('.').pop() ?? '';
      if (extension === 'json') {
        checkedFiles += 1;
        try {
          JSON.parse(file.content);
        } catch (error) {
          diagnostics.push({
            path: file.path,
            line: 1,
            column: 1,
            message: error instanceof Error ? error.message.slice(0, 500) : 'Invalid JSON.',
          });
        }
        continue;
      }

      const scriptKind = this.scriptKind(extension);
      if (scriptKind === undefined) {
        unsupportedFiles.push(file.path);
        continue;
      }

      checkedFiles += 1;
      const source = ts.createSourceFile(
        file.path,
        file.content,
        ts.ScriptTarget.Latest,
        true,
        scriptKind,
      );
      const parseDiagnostics =
        (source as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
      for (const diagnostic of parseDiagnostics) {
        const position = diagnostic.file && diagnostic.start !== undefined
          ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
          : { line: 0, character: 0 };
        diagnostics.push({
          path: file.path,
          line: position.line + 1,
          column: position.character + 1,
          message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ').slice(0, 500),
        });
      }
    }

    const status = diagnostics.length > 0
      ? 'FAILED'
      : checkedFiles === 0
        ? 'NOT_APPLICABLE'
        : unsupportedFiles.length > 0
          ? 'PARTIAL'
          : 'PASSED';

    return { status, checkedFiles, unsupportedFiles, diagnostics };
  }

  private scriptKind(extension: string): ts.ScriptKind | undefined {
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
}
