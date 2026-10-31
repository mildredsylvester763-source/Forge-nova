import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Webhook signature engine.
 *
 * Scheme modeled on the market leaders:
 * - Stripe signs "timestamp.rawBody" with HMAC-SHA256 and puts the result in a
 *   "t=<unix>,v1=<hex>" header, rejecting timestamps outside a tolerance
 *   window (replay protection).
 * - GitHub signs the raw body with HMAC-SHA256 and demands constant-time
 *   comparison (X-Hub-Signature-256).
 *
 * GENESIS combines both: timestamp-bound payload, tolerance window, and
 * constant-time comparison. No secret ever leaves the platform.
 */

export const SIGNATURE_HEADER = 'x-genesis-signature';
export const DEFAULT_SIGNATURE_TOLERANCE_SECONDS = 300;

export type SignatureRefusal =
  | 'signature-missing-header'
  | 'signature-malformed'
  | 'signature-stale-timestamp'
  | 'signature-mismatch';

export interface SignatureVerification {
  valid: boolean;
  reason?: SignatureRefusal;
}

const HEX_64 = /^[0-9a-f]{64}$/;

/** Signs a raw body for a given unix timestamp. Deterministic for pinned vectors. */
export function signPayload(secret: string, timestampSeconds: number, body: string): string {
  const mac = createHmac('sha256', secret);
  mac.update(String(timestampSeconds) + '.' + body);
  return 't=' + timestampSeconds + ',v1=' + mac.digest('hex');
}

/** Extracts the timestamp and signature from a header value, or null if malformed. */
export function parseSignatureHeader(headerValue: string): { timestamp: number; signature: string } | null {
  const parts = headerValue.split(',');
  let timestamp: number | null = null;
  let signature: string | null = null;
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.startsWith('t=')) {
      const raw = trimmed.slice(2);
      if (!/^\d+$/.test(raw)) return null;
      timestamp = Number(raw);
    } else if (trimmed.startsWith('v1=')) {
      signature = trimmed.slice(3);
    }
  }
  if (timestamp === null || signature === null) return null;
  if (!HEX_64.test(signature)) return null;
  return { timestamp, signature };
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Verifies a signature header against a raw body. Stale timestamps are
 * rejected BEFORE the comparison (replay protection), and the comparison
 * itself is constant-time. Every refusal is named.
 */
export function verifySignature(options: {
  secret: string;
  headerValue: string;
  body: string;
  nowSeconds: number;
  toleranceSeconds?: number;
}): SignatureVerification {
  const { secret, headerValue, body, nowSeconds } = options;
  const tolerance = options.toleranceSeconds ?? DEFAULT_SIGNATURE_TOLERANCE_SECONDS;
  if (typeof headerValue !== 'string' || headerValue.length === 0) {
    return { valid: false, reason: 'signature-missing-header' };
  }
  const parsed = parseSignatureHeader(headerValue);
  if (!parsed) {
    return { valid: false, reason: 'signature-malformed' };
  }
  if (Math.abs(nowSeconds - parsed.timestamp) > tolerance) {
    return { valid: false, reason: 'signature-stale-timestamp' };
  }
  const expected = signPayload(secret, parsed.timestamp, body);
  const expectedSignature = expected.split('v1=')[1];
  if (!constantTimeEquals(expectedSignature, parsed.signature)) {
    return { valid: false, reason: 'signature-mismatch' };
  }
  return { valid: true };
}
