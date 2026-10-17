import { SourceSyntaxValidatorService } from './source-syntax-validator.service';

describe('SourceSyntaxValidatorService', () => {
  const validator = new SourceSyntaxValidatorService();

  it('accepts valid TypeScript and JSON without executing them', () => {
    const result = validator.validate([
      { path: 'src/app.ts', language: 'typescript', content: 'export const ready: boolean = true;' },
      { path: 'package.json', language: 'json', content: '{"name":"sample","private":true}' },
    ]);
    expect(result.status).toBe('PASSED');
    expect(result.checkedFiles).toBe(2);
    expect(result.diagnostics).toHaveLength(0);
  });

  it('reports syntax errors with file locations', () => {
    const result = validator.validate([
      { path: 'src/broken.ts', content: 'const = ;' },
    ]);
    expect(result.status).toBe('FAILED');
    expect(result.diagnostics[0]?.path).toBe('src/broken.ts');
    expect(result.diagnostics[0]?.line).toBeGreaterThan(0);
  });

  it('marks unsupported file formats as partial rather than pretending they were checked', () => {
    const result = validator.validate([
      { path: 'styles.css', content: 'body { color: red; }' },
      { path: 'src/app.ts', content: 'export {};' },
    ]);
    expect(result.status).toBe('PARTIAL');
    expect(result.unsupportedFiles).toEqual(['styles.css']);
  });
});
