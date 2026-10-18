import {
  assessReadiness,
  detectEntrypoints,
  ReadinessFile,
  ReadinessVerificationSummary,
} from './readiness.engine';

const noSecrets = 0;
const noVerifications: ReadinessVerificationSummary[] = [];

const file = (path: string, content = 'placeholder'): ReadinessFile => ({ path, content });

describe('deployment readiness engine', () => {
  describe('entrypoint detection', () => {
    it('finds conventional entrypoint files at any supported depth', () => {
      const found = detectEntrypoints([
        file('index.html'),
        file('src/main.ts'),
        file('main.py'),
      ]);
      expect(found).toEqual(['index.html', 'main.py', 'src/main.ts']);
    });

    it('finds a package.json start script as an entrypoint', () => {
      const found = detectEntrypoints([
        file('package.json', '{"name":"app","scripts":{"start":"node dist/main.js"}}'),
      ]);
      expect(found).toEqual(['package.json#scripts.start']);
    });

    it('does not treat an empty start script as an entrypoint', () => {
      const found = detectEntrypoints([
        file('package.json', '{"name":"app","scripts":{"start":"   "}}'),
      ]);
      expect(found).toEqual([]);
    });

    it('ignores an unparseable manifest instead of throwing', () => {
      expect(detectEntrypoints([file('package.json', '{not json')])).toEqual([]);
    });
  });

  describe('verdicts', () => {
    it('blocks an application with no files', () => {
      const report = assessReadiness([], noVerifications, noSecrets);
      expect(report.verdict).toBe('BLOCKED');
      expect(report.checks).toContainEqual(
        expect.objectContaining({ code: 'readiness.empty-application', status: 'FAIL' }),
      );
      expect(report.checks).toContainEqual(
        expect.objectContaining({ code: 'readiness.entrypoint', status: 'FAIL' }),
      );
    });

    it('blocks when no entrypoint exists', () => {
      const report = assessReadiness([file('docs/readme.md')], noVerifications, noSecrets);
      expect(report.verdict).toBe('BLOCKED');
      expect(report.checks).toContainEqual(
        expect.objectContaining({ code: 'readiness.entrypoint', status: 'FAIL' }),
      );
    });

    it('warns, and needs review, when the manifest is invalid JSON', () => {
      const report = assessReadiness(
        [file('index.html'), file('package.json', '{oops')],
        noVerifications,
        noSecrets,
      );
      expect(report.verdict).toBe('NEEDS_REVIEW');
      expect(report.checks).toContainEqual(
        expect.objectContaining({ code: 'readiness.manifest', status: 'WARN' }),
      );
    });

    it('warns when no verification has ever been recorded', () => {
      const report = assessReadiness([file('index.html')], noVerifications, noSecrets);
      expect(report.verdict).toBe('NEEDS_REVIEW');
      expect(report.checks).toContainEqual(
        expect.objectContaining({ code: 'readiness.verification', status: 'WARN' }),
      );
    });

    it('blocks when the latest verification run failed', () => {
      const report = assessReadiness(
        [file('index.html')],
        [{ kind: 'DEPENDENCY_AUDIT', status: 'FAILED' }],
        noSecrets,
      );
      expect(report.verdict).toBe('BLOCKED');
      expect(report.checks).toContainEqual(
        expect.objectContaining({ code: 'readiness.verification', status: 'FAIL' }),
      );
    });

    it('treats an honestly skipped verification as not failed', () => {
      const report = assessReadiness(
        [file('index.html')],
        [{ kind: 'DEPENDENCY_AUDIT', status: 'SKIPPED' }],
        noSecrets,
      );
      expect(report.verdict).toBe('READY');
    });

    it('blocks when secret material is present in the source', () => {
      const report = assessReadiness([file('index.html')], noVerifications, 2);
      expect(report.verdict).toBe('BLOCKED');
      expect(report.checks).toContainEqual(
        expect.objectContaining({ code: 'readiness.secrets', status: 'FAIL' }),
      );
    });

    it('returns READY for a clean, entrypointed, verified application', () => {
      const report = assessReadiness(
        [
          file('index.html', '<!doctype html><html></html>'),
          file('package.json', '{"name":"app","scripts":{"start":"node dist/main.js"}}'),
        ],
        [{ kind: 'STATIC_ANALYSIS', status: 'PASSED' }],
        noSecrets,
      );
      expect(report.verdict).toBe('READY');
      expect(report.checks.every((check) => check.status === 'PASS')).toBe(true);
      expect(report.entrypoints).toEqual(['index.html', 'package.json#scripts.start']);
      expect(report.fileCount).toBe(2);
    });

    it('treats any FAIL as stronger than any WARN', () => {
      const report = assessReadiness(
        [file('index.html'), file('package.json', 'invalid')],
        [{ kind: 'DEPENDENCY_AUDIT', status: 'FAILED' }],
        noSecrets,
      );
      expect(report.verdict).toBe('BLOCKED');
    });
  });
});
