export interface ReadinessFile {
  path: string;
  content: string;
}

export interface ReadinessVerificationSummary {
  kind: string;
  status: string;
}

export type ReadinessCheckCode =
  | 'readiness.empty-application'
  | 'readiness.entrypoint'
  | 'readiness.manifest'
  | 'readiness.verification'
  | 'readiness.secrets';

export type ReadinessCheckStatus = 'PASS' | 'WARN' | 'FAIL';

export interface ReadinessCheck {
  code: ReadinessCheckCode;
  status: ReadinessCheckStatus;
  message: string;
}

export type ReadinessVerdict = 'READY' | 'NEEDS_REVIEW' | 'BLOCKED';

export interface ReadinessReport {
  verdict: ReadinessVerdict;
  checks: ReadinessCheck[];
  entrypoints: string[];
  fileCount: number;
}

const ENTRYPOINT_PATHS = [
  'index.html',
  'index.js',
  'src/index.js',
  'src/index.ts',
  'src/main.ts',
  'src/main.py',
  'main.py',
  'app.py',
  'manage.py',
];

const MANIFEST_PATH = 'package.json';

export function detectEntrypoints(files: ReadinessFile[]): string[] {
  const paths = new Set(files.map((file) => file.path));
  const entrypoints = new Set<string>();
  for (const candidate of ENTRYPOINT_PATHS) {
    if (paths.has(candidate)) {
      entrypoints.add(candidate);
    }
  }
  const manifest = files.find((file) => file.path === MANIFEST_PATH);
  if (manifest) {
    try {
      const parsed = JSON.parse(manifest.content) as { scripts?: { start?: unknown } };
      if (parsed && typeof parsed.scripts?.start === 'string' && parsed.scripts.start.trim().length > 0) {
        entrypoints.add('package.json#scripts.start');
      }
    } catch {
      // An unparseable manifest is reported by the manifest check, not here.
    }
  }
  return [...entrypoints].sort();
}

function manifestCheck(files: ReadinessFile[]): ReadinessCheck {
  const manifest = files.find((file) => file.path === MANIFEST_PATH);
  if (!manifest) {
    return {
      code: 'readiness.manifest',
      status: 'PASS',
      message: 'No package.json manifest present; nothing to validate.',
    };
  }
  try {
    JSON.parse(manifest.content);
    return {
      code: 'readiness.manifest',
      status: 'PASS',
      message: 'package.json parses as valid JSON.',
    };
  } catch {
    return {
      code: 'readiness.manifest',
      status: 'WARN',
      message: 'package.json is not valid JSON. Some deployment targets require a valid manifest.',
    };
  }
}

function verificationCheck(verifications: ReadinessVerificationSummary[]): ReadinessCheck {
  if (verifications.length === 0) {
    return {
      code: 'readiness.verification',
      status: 'WARN',
      message: 'No verification runs recorded for this application yet.',
    };
  }
  const failed = verifications.filter((run) => run.status === 'FAILED');
  if (failed.length > 0) {
    return {
      code: 'readiness.verification',
      status: 'FAIL',
      message: 'The latest recorded verification run failed (' + failed.map((run) => run.kind).join(', ') + '). Fix the findings before deploying.',
    };
  }
  return {
    code: 'readiness.verification',
    status: 'PASS',
    message: 'All recorded verification runs passed or were honestly skipped.',
  };
}

export function assessReadiness(
  files: ReadinessFile[],
  verifications: ReadinessVerificationSummary[],
  secretFindingCount: number,
): ReadinessReport {
  const checks: ReadinessCheck[] = [];

  if (files.length === 0) {
    checks.push({
      code: 'readiness.empty-application',
      status: 'FAIL',
      message: 'The application has no source files. There is nothing to deploy.',
    });
  } else {
    checks.push({
      code: 'readiness.empty-application',
      status: 'PASS',
      message: 'The application contains ' + files.length + ' source file(s).',
    });
  }

  const entrypoints = detectEntrypoints(files);
  if (entrypoints.length === 0) {
    checks.push({
      code: 'readiness.entrypoint',
      status: 'FAIL',
      message: 'No runnable entrypoint was found (for example index.html, src/index.ts, main.py, or a package.json start script).',
    });
  } else {
    checks.push({
      code: 'readiness.entrypoint',
      status: 'PASS',
      message: 'Entrypoint(s) detected: ' + entrypoints.join(', '),
    });
  }

  checks.push(manifestCheck(files));
  checks.push(verificationCheck(verifications));

  if (secretFindingCount > 0) {
    checks.push({
      code: 'readiness.secrets',
      status: 'FAIL',
      message: secretFindingCount + ' piece(s) of possible secret material were found in the source files. Credentials belong in the secret system, never in deployable source.',
    });
  } else {
    checks.push({
      code: 'readiness.secrets',
      status: 'PASS',
      message: 'No secret material detected in the current source files.',
    });
  }

  const verdict: ReadinessVerdict = checks.some((check) => check.status === 'FAIL')
    ? 'BLOCKED'
    : checks.some((check) => check.status === 'WARN')
      ? 'NEEDS_REVIEW'
      : 'READY';

  return { verdict, checks, entrypoints, fileCount: files.length };
}
