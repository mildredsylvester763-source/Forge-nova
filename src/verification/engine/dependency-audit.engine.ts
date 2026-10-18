import { SourceFileInput, VerificationFinding } from './static-analysis.engine';

export interface DependencyAuditReport {
  manifests: number;
  findings: VerificationFinding[];
}

const DEPENDENCY_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;

/**
 * Audits package.json manifests for structural problems. This is a real
 * inspection of manifest shape and values; no installation or resolution is
 * performed, and none is claimed.
 */
export function auditDependencyManifests(files: SourceFileInput[]): DependencyAuditReport {
  const findings: VerificationFinding[] = [];
  let manifests = 0;

  for (const file of files) {
    const basename = file.path.split('/').pop() ?? file.path;
    if (basename !== 'package.json') continue;

    manifests += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(file.content);
    } catch (error) {
      findings.push(manifestFinding(file.path, 'ERROR', 'manifest.invalid-json', error));
      continue;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      findings.push(
        manifestFinding(file.path, 'ERROR', 'manifest.not-an-object', new Error('package.json must contain a JSON object.')),
      );
      continue;
    }

    const manifest = parsed as Record<string, unknown>;

    if (typeof manifest.name !== 'string' || manifest.name.trim().length === 0) {
      findings.push(
        manifestFinding(file.path, 'WARNING', 'manifest.missing-name', new Error('package.json has no non-empty "name" field.')),
      );
    }
    if (typeof manifest.version !== 'string' || manifest.version.trim().length === 0) {
      findings.push(
        manifestFinding(file.path, 'WARNING', 'manifest.missing-version', new Error('package.json has no non-empty "version" field.')),
      );
    }

    const declared = new Map<string, string>();
    for (const section of DEPENDENCY_SECTIONS) {
      const sectionValue = manifest[section];
      if (sectionValue === undefined) continue;

      if (!sectionValue || typeof sectionValue !== 'object' || Array.isArray(sectionValue)) {
        findings.push(
          manifestFinding(
            file.path,
            'ERROR',
            'manifest.deps-not-object',
            new Error(`"${section}" must be an object of dependency names to version strings.`),
          ),
        );
        continue;
      }

      for (const [dependencyName, requirement] of Object.entries(sectionValue as Record<string, unknown>)) {
        if (typeof requirement !== 'string') {
          findings.push(
            manifestFinding(
              file.path,
              'ERROR',
              'manifest.dep-value-not-string',
              new Error(`"${section}.${dependencyName}" must be a version string.`),
            ),
          );
          continue;
        }
        const previous = declared.get(dependencyName);
        if (previous === undefined) {
          declared.set(dependencyName, section);
        } else if (previous !== section && (previous === 'dependencies' || section === 'dependencies')) {
          findings.push(
            manifestFinding(
              file.path,
              'WARNING',
              'manifest.duplicate-dependency',
              new Error(`"${dependencyName}" is declared in both "${previous}" and "${section}".`),
            ),
          );
        }
      }
    }
  }

  return { manifests, findings };
}

function manifestFinding(path: string, severity: 'ERROR' | 'WARNING', code: string, error: Error): VerificationFinding {
  return { path, line: 1, column: 1, severity, code, message: error.message.slice(0, 500) };
}
