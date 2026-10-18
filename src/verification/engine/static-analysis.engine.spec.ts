import { analyzeSource } from './static-analysis.engine';

describe('analyzeSource', () => {
  it('reports zero findings for clean TypeScript and JSON files', () => {
    const report = analyzeSource([
      { path: 'src/index.ts', content: 'export function add(a: number, b: number): number {\n  return a + b;\n}\n' },
      { path: 'package.json', content: '{"name":"demo","version":"1.0.0"}' },
    ]);
    expect(report.analyzedFiles).toBe(2);
    expect(report.unsupportedFiles).toEqual([]);
    expect(report.findings).toEqual([]);
  });

  it('reports a real parse error for broken TypeScript', () => {
    const report = analyzeSource([{ path: 'src/broken.ts', content: 'const value = {\n' }]);
    expect(report.analyzedFiles).toBe(1);
    expect(report.findings.length).toBeGreaterThan(0);
    const error = report.findings[0];
    expect(error.path).toBe('src/broken.ts');
    expect(error.severity).toBe('ERROR');
    expect(error.code).toBe('ts.parse');
    expect(error.line).toBeGreaterThan(0);
  });

  it('reports invalid JSON as an error without executing anything', () => {
    const report = analyzeSource([{ path: 'data/bad.json', content: '{"broken":' }]);
    expect(report.findings.length).toBe(1);
    expect(report.findings[0].code).toBe('json.parse');
    expect(report.findings[0].severity).toBe('ERROR');
    expect(report.findings[0].path).toBe('data/bad.json');
  });

  it('honestly reports unsupported extensions instead of pretending to analyze them', () => {
    const report = analyzeSource([{ path: 'docs/readme.md', content: '# hello' }]);
    expect(report.analyzedFiles).toBe(0);
    expect(report.unsupportedFiles).toEqual(['docs/readme.md']);
    expect(report.findings).toEqual([]);
  });

  it('handles an empty file set without inventing results', () => {
    const report = analyzeSource([]);
    expect(report.analyzedFiles).toBe(0);
    expect(report.findings).toEqual([]);
  });
});
