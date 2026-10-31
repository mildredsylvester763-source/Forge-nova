/**
 * Delivery backoff engine.
 *
 * Modeled on Slack Events API discipline (bounded retries with exponential
 * backoff, never infinite) and Stripe/GitHub escalating retry schedules:
 * after a failed attempt the next attempt waits [60, 300, 1800, 7200, 28800]
 * seconds; after the 5th failed attempt the delivery is EXHAUSTED for good.
 */

export const BACKOFF_SECONDS = [60, 300, 1800, 7200, 28800] as const;
export const MAX_DELIVERY_ATTEMPTS = 5;

export type DeliveryStatus = 'PENDING' | 'DELIVERED' | 'EXHAUSTED';

export type RetryRefusal =
  | 'webhook-retries-exhausted'
  | 'webhook-retry-too-early';

/** Seconds to wait after failed attempt number N (1-based). */
export function backoffSeconds(attempt: number): number {
  const index = Math.min(Math.max(attempt, 1), BACKOFF_SECONDS.length) - 1;
  return BACKOFF_SECONDS[index];
}

/** The status a delivery moves to after an attempt. */
export function nextDeliveryStatus(attemptSucceeded: boolean, attemptsSoFar: number): DeliveryStatus {
  if (attemptSucceeded) return 'DELIVERED';
  if (attemptsSoFar >= MAX_DELIVERY_ATTEMPTS) return 'EXHAUSTED';
  return 'PENDING';
}

/** Whether a delivery may be retried right now. Every refusal is named. */
export function canRetryNow(options: {
  status: string;
  attempts: number;
  nextAttemptAt: Date | null;
  now: Date;
}): { ok: true } | { ok: false; reason: RetryRefusal } {
  const { status, attempts, nextAttemptAt, now } = options;
  if (status === 'DELIVERED' || status === 'EXHAUSTED' || attempts >= MAX_DELIVERY_ATTEMPTS) {
    return { ok: false, reason: 'webhook-retries-exhausted' };
  }
  if (nextAttemptAt && nextAttemptAt.getTime() > now.getTime()) {
    return { ok: false, reason: 'webhook-retry-too-early' };
  }
  return { ok: true };
}
