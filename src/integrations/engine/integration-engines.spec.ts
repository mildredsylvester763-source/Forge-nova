import { BACKOFF_SECONDS, backoffSeconds, canRetryNow, nextDeliveryStatus } from './delivery-backoff.engine';
import { CONNECTORS, buildTestRequest, describeCredentials, lookupConnector, validateCredentials } from './connector-catalog.engine';
import { KNOWN_EVENTS, matchesSubscriptions, validateEventName, validateSubscription } from './event-subscription.engine';
import { DEFAULT_SIGNATURE_TOLERANCE_SECONDS, signPayload, verifySignature } from './webhook-signature.engine';

/** Deterministic PRNG for the randomized sweeps (mulberry32, seed 42). */
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomString(rand: () => number, alphabet: string, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += alphabet[Math.floor(rand() * alphabet.length)];
  }
  return out;
}

describe('integration engines', () => {

  describe('webhook signature engine', () => {
    it('pins the signature scheme determinism', () => {
      const first = signPayload('whsec_test_secret', 1700000000, 'deployment recorded body');
      const second = signPayload('whsec_test_secret', 1700000000, 'deployment recorded body');
      expect(first).toBe(second);
      expect(first).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/);
      const otherTimestamp = signPayload('whsec_test_secret', 1700000001, 'deployment recorded body');
      const otherSecret = signPayload('whsec_other_secret', 1700000000, 'deployment recorded body');
      const otherBody = signPayload('whsec_test_secret', 1700000000, 'application created body');
      expect(new Set([first, otherTimestamp, otherSecret, otherBody]).size).toBe(4);
    });

    it('round-trips its own signature and names every refusal', () => {
      const secret = 'whsec_round_trip';
      const body = 'verification completed body';
      const now = 1700000123;
      const header = signPayload(secret, now, body);
      expect(verifySignature({ secret, headerValue: header, body, nowSeconds: now })).toEqual({ valid: true });

      expect(verifySignature({ secret, headerValue: '', body, nowSeconds: now })).toEqual({ valid: false, reason: 'signature-missing-header' });
      expect(verifySignature({ secret, headerValue: 'v1=abc', body, nowSeconds: now })).toEqual({ valid: false, reason: 'signature-malformed' });
      expect(verifySignature({ secret, headerValue: 't=abc,v1=' + 'a'.repeat(64), body, nowSeconds: now })).toEqual({ valid: false, reason: 'signature-malformed' });
      expect(verifySignature({ secret, headerValue: 't=' + now + ',v1=' + 'z'.repeat(64), body, nowSeconds: now })).toEqual({ valid: false, reason: 'signature-malformed' });
      expect(verifySignature({ secret, headerValue: 't=' + now + ',v1=' + 'a'.repeat(63), body, nowSeconds: now })).toEqual({ valid: false, reason: 'signature-malformed' });
      expect(verifySignature({ secret, headerValue: 't=' + now + ',v1=' + 'g'.repeat(64), body, nowSeconds: now })).toEqual({ valid: false, reason: 'signature-malformed' });

      const stale = signPayload(secret, now - DEFAULT_SIGNATURE_TOLERANCE_SECONDS - 1, body);
      expect(verifySignature({ secret, headerValue: stale, body, nowSeconds: now })).toEqual({ valid: false, reason: 'signature-stale-timestamp' });
      const future = signPayload(secret, now + DEFAULT_SIGNATURE_TOLERANCE_SECONDS + 1, body);
      expect(verifySignature({ secret, headerValue: future, body, nowSeconds: now })).toEqual({ valid: false, reason: 'signature-stale-timestamp' });
      const atEdge = signPayload(secret, now - DEFAULT_SIGNATURE_TOLERANCE_SECONDS, body);
      expect(verifySignature({ secret, headerValue: atEdge, body, nowSeconds: now })).toEqual({ valid: true });

      const wrongSecret = signPayload('whsec_wrong', now, body);
      expect(verifySignature({ secret, headerValue: wrongSecret, body, nowSeconds: now })).toEqual({ valid: false, reason: 'signature-mismatch' });
      const signed = signPayload(secret, now, body);
      expect(verifySignature({ secret, headerValue: signed, body: body + 'x', nowSeconds: now })).toEqual({ valid: false, reason: 'signature-mismatch' });
    });

    it('survives a 500-case randomized sign/verify/tamper sweep (seed 42)', () => {
      const rand = mulberry32(42);
      const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789 .,:{}[]_-';
      for (let i = 0; i < 500; i += 1) {
        const secret = randomString(rand, alphabet, 8 + Math.floor(rand() * 24));
        const body = randomString(rand, alphabet, 8 + Math.floor(rand() * 120));
        const now = Math.floor(rand() * 4000000000);
        const header = signPayload(secret, now, body);
        expect(verifySignature({ secret, headerValue: header, body, nowSeconds: now })).toEqual({ valid: true });
        expect(verifySignature({ secret, headerValue: header, body: body + 'x', nowSeconds: now }).valid).toBe(false);
        expect(verifySignature({ secret, headerValue: header, body, nowSeconds: now + DEFAULT_SIGNATURE_TOLERANCE_SECONDS + 1 }).valid).toBe(false);
      }
    });
  });

  describe('event subscription engine', () => {
    it('accepts exactly the known catalog and matches subscriptions honestly', () => {
      expect(KNOWN_EVENTS.length).toBe(8);
      for (const event of KNOWN_EVENTS) {
        expect(validateEventName(event)).toEqual({ ok: true });
      }
      expect(validateEventName('deployment.recorded')).toEqual({ ok: true });
      expect(validateEventName('Deployment.Recorded')).toEqual({ ok: false, reason: 'webhook-invalid-event-name' });
      expect(validateEventName('deployment')).toEqual({ ok: false, reason: 'webhook-invalid-event-name' });
      expect(validateEventName('deploy ment.rec orded')).toEqual({ ok: false, reason: 'webhook-invalid-event-name' });
      expect(validateEventName('deployment.nonexistent')).toEqual({ ok: false, reason: 'webhook-unknown-event' });

      expect(validateSubscription('all')).toEqual({ ok: true });
      expect(validateSubscription('deployment.*')).toEqual({ ok: true });
      expect(validateSubscription('application.*')).toEqual({ ok: true });
      expect(validateSubscription('bogus.*')).toEqual({ ok: false, reason: 'webhook-invalid-event-name' });
      expect(validateSubscription('application.nonexistent')).toEqual({ ok: false, reason: 'webhook-unknown-event' });

      expect(matchesSubscriptions(['all'], 'application.created')).toBe(true);
      expect(matchesSubscriptions(['deployment.*'], 'deployment.recorded')).toBe(true);
      expect(matchesSubscriptions(['deployment.*'], 'application.created')).toBe(false);
      expect(matchesSubscriptions(['deployment.recorded'], 'deployment.recorded')).toBe(true);
      expect(matchesSubscriptions(['deployment.recorded'], 'verification.completed')).toBe(false);
      expect(matchesSubscriptions([], 'deployment.recorded')).toBe(false);
    });

    it('survives a 500-case randomized matching sweep (seed 42)', () => {
      const rand = mulberry32(42);
      const events = [...KNOWN_EVENTS];
      const subscriptions = [...KNOWN_EVENTS, 'application.*', 'deployment.*', 'checkpoint.*', 'verification.*', 'reference.*', 'all'];
      for (let i = 0; i < 500; i += 1) {
        const event = events[Math.floor(rand() * events.length)];
        const list: string[] = [];
        const size = Math.floor(rand() * 4);
        for (let j = 0; j < size; j += 1) {
          list.push(subscriptions[Math.floor(rand() * subscriptions.length)]);
        }
        const expected = list.some((subscription) =>
          subscription === 'all' ||
          subscription === event ||
          (subscription.endsWith('.*') && event.startsWith(subscription.slice(0, -1))),
        );
        expect(matchesSubscriptions(list, event)).toBe(expected);
      }
    });
  });

  describe('delivery backoff engine', () => {
    it('pins the escalating schedule and honest exhaustion', () => {
      expect(BACKOFF_SECONDS).toEqual([60, 300, 1800, 7200, 28800]);
      expect(backoffSeconds(1)).toBe(60);
      expect(backoffSeconds(2)).toBe(300);
      expect(backoffSeconds(3)).toBe(1800);
      expect(backoffSeconds(4)).toBe(7200);
      expect(backoffSeconds(5)).toBe(28800);
      expect(backoffSeconds(9)).toBe(28800);
      expect(nextDeliveryStatus(true, 1)).toBe('DELIVERED');
      expect(nextDeliveryStatus(false, 1)).toBe('PENDING');
      expect(nextDeliveryStatus(false, 4)).toBe('PENDING');
      expect(nextDeliveryStatus(false, 5)).toBe('EXHAUSTED');
    });

    it('names every retry refusal', () => {
      const now = new Date('2026-10-31T12:00:00Z');
      const future = new Date('2026-10-31T13:00:00Z');
      const past = new Date('2026-10-31T11:00:00Z');
      expect(canRetryNow({ status: 'DELIVERED', attempts: 1, nextAttemptAt: past, now })).toEqual({ ok: false, reason: 'webhook-retries-exhausted' });
      expect(canRetryNow({ status: 'EXHAUSTED', attempts: 5, nextAttemptAt: past, now })).toEqual({ ok: false, reason: 'webhook-retries-exhausted' });
      expect(canRetryNow({ status: 'PENDING', attempts: 5, nextAttemptAt: past, now })).toEqual({ ok: false, reason: 'webhook-retries-exhausted' });
      expect(canRetryNow({ status: 'PENDING', attempts: 1, nextAttemptAt: future, now })).toEqual({ ok: false, reason: 'webhook-retry-too-early' });
      expect(canRetryNow({ status: 'PENDING', attempts: 1, nextAttemptAt: past, now })).toEqual({ ok: true });
      expect(canRetryNow({ status: 'PENDING', attempts: 0, nextAttemptAt: null, now })).toEqual({ ok: true });
    });

    it('survives a 500-case randomized backoff sweep (seed 42)', () => {
      const rand = mulberry32(42);
      for (let i = 0; i < 500; i += 1) {
        const attempt = Math.floor(rand() * 12) - 2;
        const expectedIndex = Math.min(Math.max(attempt, 1), BACKOFF_SECONDS.length) - 1;
        expect(backoffSeconds(attempt)).toBe(BACKOFF_SECONDS[expectedIndex]);
        const succeeded = rand() < 0.5;
        const attempts = Math.floor(rand() * 8);
        const expectedStatus = succeeded ? 'DELIVERED' : attempts >= 5 ? 'EXHAUSTED' : 'PENDING';
        expect(nextDeliveryStatus(succeeded, attempts)).toBe(expectedStatus);
      }
    });
  });

  describe('connector catalog engine', () => {
    it('offers named connectors with named credentials only', () => {
      expect(CONNECTORS.length).toBe(7);
      expect(new Set(CONNECTORS.map((c) => c.id)).size).toBe(7);
      for (const connector of CONNECTORS) {
        expect(connector.label.length).toBeGreaterThan(0);
        expect(connector.requiredCredentials.length).toBeGreaterThan(0);
        expect(lookupConnector(connector.id).ok).toBe(true);
      }
      expect(lookupConnector('shopify')).toEqual({ ok: false, reason: 'connector-unknown' });
    });

    it('validates credentials with named refusals', () => {
      const github = CONNECTORS.find((c) => c.id === 'github')!;
      expect(validateCredentials(github, { accessToken: 'ghp_test' })).toEqual({ ok: true });
      expect(validateCredentials(github, {})).toEqual({ ok: false, reason: 'connector-missing-credential', field: 'accessToken' });
      expect(validateCredentials(github, { accessToken: '   ' })).toEqual({ ok: false, reason: 'connector-empty-credential', field: 'accessToken' });
      expect(validateCredentials(github, { accessToken: 'ghp_test', webhookSecret: 'x' })).toEqual({ ok: false, reason: 'connector-unknown-credential', field: 'webhookSecret' });
      expect(validateCredentials(github, { accessToken: 'ghp_test', organization: 'acme' })).toEqual({ ok: true });

      const custom = CONNECTORS.find((c) => c.id === 'custom')!;
      expect(validateCredentials(custom, { baseUrl: 'http://127.0.0.1:9/x/' })).toEqual({ ok: true });
    });

    it('never echoes credential values back', () => {
      const custom = CONNECTORS.find((c) => c.id === 'custom')!;
      const described = describeCredentials(custom, { baseUrl: 'http://127.0.0.1:9/x/', bearerToken: 'tok_1234567890' });
      expect(described).toEqual({ baseUrl: 21, bearerToken: 14 });
      expect(JSON.stringify(described)).not.toContain('tok_1234567890');

      const request = buildTestRequest(custom, { baseUrl: 'http://127.0.0.1:9/x/', bearerToken: 'tok' })!;
      expect(request.url).toBe('http://127.0.0.1:9/x/connection-test');
      expect(request.headers['authorization']).toBe('Bearer tok');
      const noToken = buildTestRequest(custom, { baseUrl: 'http://127.0.0.1:9/' })!;
      expect(noToken.url).toBe('http://127.0.0.1:9/connection-test');
      expect(noToken.headers['authorization']).toBeUndefined();
    });

    it('survives a 500-case randomized credential sweep (seed 42)', () => {
      const rand = mulberry32(42);
      const noiseFields = ['extraneous', 'another', 'webhookSecret', 'secret2'];
      for (let i = 0; i < 500; i += 1) {
        const connector = CONNECTORS[Math.floor(rand() * CONNECTORS.length)];
        const provided: Record<string, string> = {};
        for (const field of connector.requiredCredentials.concat(connector.optionalCredentials)) {
          if (rand() < 0.75) {
            provided[field] = randomString(rand, 'abcdef0123456789', 12);
          }
        }
        if (rand() < 0.25) {
          provided[noiseFields[Math.floor(rand() * noiseFields.length)]] = 'noise';
        }
        const result = validateCredentials(connector, provided);
        const unknownNoise = Object.keys(provided).find((field) =>
          !connector.requiredCredentials.includes(field) && !connector.optionalCredentials.includes(field),
        );
        const missing = connector.requiredCredentials.find((field) => !(field in provided));
        if (result.ok) {
          expect(missing).toBeUndefined();
          expect(unknownNoise).toBeUndefined();
        } else {
          expect(result.ok).toBe(false);
          if (result.reason === 'connector-unknown-credential') {
            expect(unknownNoise).toBeDefined();
          }
        }
      }
    });
  });
});
