import { analyzeSource, VerificationFinding } from './static-analysis.engine';
import { verdictFromFindings } from './verification-verdict.engine';

function finding(severity: VerificationFinding['severity']): VerificationFinding {
  return { path: 'src/index.ts', line: 1, column: 1, severity, code: 'test', message: 'test finding' };
}

describe('verdictFromFindings', () => {
  it('passes when there are no errors', () => {
    const verdict = verdictFromFindings('STATIC_ANALYSIS', [], 3);
    expect(verdict.status).toBe('PASSED');
    expect(verdict.counts).toEqual({ ERROR: 0, WARNING: 0, INFO: 0 });
    expect(verdict.summary).toContain('STATIC_ANALYSIS');
  });

  it('fails when at least one error exists', () => {
    const verdict = verdictFromFindings('STATIC_ANALYSIS', [finding('ERROR'), finding('WARNING')], 3);
    expect(verdict.status).toBe('FAILED');
    expect(verdict.counts).toEqual({ ERROR: 1, WARNING: 1, INFO: 0 });
  });

  it('is skipped, never passed, when zero files were analyzable', () => {
    const verdict = verdictFromFindings('SECRET_SCAN', [], 0);
    expect(verdict.status).toBe('SKIPPED');
    expect(verdict.summary).toContain('nothing was executed');
  });

  it('counts severities honestly', () => {
    const verdict = verdictFromFindings('DEPENDENCY_AUDIT', [
      finding('ERROR'),
      finding('ERROR'),
      finding('WARNING'),
      finding('INFO'),
    ], 2);
    expect(verdict.counts).toEqual({ ERROR: 2, WARNING: 1, INFO: 1 });
    expect(verdict.status).toBe('FAILED');
  });

  it('treats real parser errors as failures end to end', () => {
    const report = analyzeSource([{ path: 'src/broken.ts', content: 'const value = {\n' }]);
    const verdict = verdictFromFindings('STATIC_ANALYSIS', report.findings, report.analyzedFiles);
    expect(verdict.status).toBe('FAILED');
  });
});
