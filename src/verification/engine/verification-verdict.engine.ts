import { FindingSeverity, VerificationFinding } from './static-analysis.engine';

export type VerificationVerdictStatus = 'PASSED' | 'FAILED' | 'SKIPPED';

export interface VerificationVerdict {
  status: VerificationVerdictStatus;
  summary: string;
  counts: Record<FindingSeverity, number>;
}

/**
 * Derives an honest verdict from findings. An empty analysis of zero files is
 * SKIPPED, never a fabricated PASS.
 */
export function verdictFromFindings(kind: string, findings: VerificationFinding[], analyzedCount: number): VerificationVerdict {
  const counts: Record<FindingSeverity, number> = { ERROR: 0, WARNING: 0, INFO: 0 };
  for (const finding of findings) {
    counts[finding.severity] += 1;
  }

  if (analyzedCount === 0) {
    return {
      status: 'SKIPPED',
      summary: `${kind}: skipped because no files were analyzable; nothing was executed or claimed.`,
      counts,
    };
  }

  if (counts.ERROR > 0) {
    return {
      status: 'FAILED',
      summary: `${kind}: failed with ${counts.ERROR} error(s), ${counts.WARNING} warning(s), and ${counts.INFO} informational note(s) across ${analyzedCount} analyzed file(s).`,
      counts,
    };
  }

  return {
    status: 'PASSED',
    summary: `${kind}: passed with 0 errors, ${counts.WARNING} warning(s), and ${counts.INFO} informational note(s) across ${analyzedCount} analyzed file(s).`,
    counts,
  };
}
