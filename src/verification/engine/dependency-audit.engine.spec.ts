import { auditDependencyManifests } from './dependency-audit.engine';

describe('auditDependencyManifests', () => {
  it('passes a valid manifest with clean dependency sections', () => {
    const report = auditDependencyManifests([
      {
        path: 'package.json',
        content: '{"name":"demo","version":"1.0.0","dependencies":{"zod":"^3.0.0"}}',
      },
    ]);
    expect(report.manifests).toBe(1);
    expect(report.findings).toEqual([]);
  });

  it('reports invalid JSON as an error', () => {
    const report = auditDependencyManifests([{ path: 'package.json', content: '{"name":' }]);
    expect(report.findings.length).toBe(1);
    expect(report.findings[0].code).toBe('manifest.invalid-json');
    expect(report.findings[0].severity).toBe('ERROR');
  });

  it('warns about missing name and version', () => {
    const report = auditDependencyManifests([{ path: 'package.json', content: '{"dependencies":{}}' }]);
    const codes = report.findings.map((finding) => finding.code);
    expect(codes).toContain('manifest.missing-name');
    expect(codes).toContain('manifest.missing-version');
  });

  it('errors when a dependency requirement is not a string', () => {
    const report = auditDependencyManifests([
      { path: 'package.json', content: '{"name":"demo","version":"1.0.0","dependencies":{"left-pad":123}}' },
    ]);
    expect(report.findings.length).toBe(1);
    expect(report.findings[0].code).toBe('manifest.dep-value-not-string');
    expect(report.findings[0].severity).toBe('ERROR');
  });

  it('warns when a dependency appears in both dependencies and devDependencies', () => {
    const report = auditDependencyManifests([
      {
        path: 'package.json',
        content: '{"name":"demo","version":"1.0.0","dependencies":{"zod":"^3.0.0"},"devDependencies":{"zod":"^3.0.0"}}',
      },
    ]);
    expect(report.findings.length).toBe(1);
    expect(report.findings[0].code).toBe('manifest.duplicate-dependency');
    expect(report.findings[0].severity).toBe('WARNING');
  });

  it('errors when a dependency section is not an object', () => {
    const report = auditDependencyManifests([
      { path: 'package.json', content: '{"name":"demo","version":"1.0.0","dependencies":["zod"]}' },
    ]);
    expect(report.findings.length).toBe(1);
    expect(report.findings[0].code).toBe('manifest.deps-not-object');
    expect(report.findings[0].severity).toBe('ERROR');
  });

  it('ignores files that are not package.json manifests', () => {
    const report = auditDependencyManifests([{ path: 'src/index.ts', content: 'export {};' }]);
    expect(report.manifests).toBe(0);
    expect(report.findings).toEqual([]);
  });
});
