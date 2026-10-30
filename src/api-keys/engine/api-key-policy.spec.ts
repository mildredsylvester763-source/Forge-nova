import { createHash } from 'node:crypto';
import {
  ALL_API_KEY_SCOPES,
  API_KEY_PREFIX,
  buildKeyMaterial,
  hashApiKey,
  isKeyUsable,
  keyLooksLikeApiKey,
  normalizeScopes,
  planExpiry,
} from './api-key-policy';

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

describe('api key policy engine', () => {
  const secret = 'Ab3D_eFgH9xYzK2LmN4oP5qRsTuVwXyZ0123456789';
  const now = new Date('2026-10-30T12:00:00.000Z');

  it('derives a prefixed raw key, its hash, and a masked hint from a secret', () => {
    const material = buildKeyMaterial(secret);
    expect(material.rawKey).toBe(API_KEY_PREFIX + secret);
    expect(material.hashedKey).toBe(hashApiKey(material.rawKey));
    expect(material.displayHint).toBe('gn_live_Ab3D…6789');
  });

  it('hashes deterministically and matches an independent sha-256 derivation', () => {
    const raw = 'gn_live_fixed-vector-0123456789abcdef';
    expect(hashApiKey(raw)).toBe(
      createHash('sha256').update(raw, 'utf8').digest('hex'),
    );
    expect(hashApiKey(raw)).toBe(hashApiKey(raw));
  });

  it('never exposes the middle of the secret through the hint', () => {
    const material = buildKeyMaterial(secret);
    expect(material.displayHint).toContain('…');
    expect(material.displayHint).not.toContain(secret.slice(4, -4));
    expect(material.displayHint.length).toBeLessThan(material.rawKey.length);
  });

  it('accepts only values with the exact lowercase prefix and enough entropy', () => {
    expect(keyLooksLikeApiKey('gn_live_' + secret)).toBe(true);
    expect(keyLooksLikeApiKey('GN_LIVE_' + secret)).toBe(false);
    expect(keyLooksLikeApiKey('sk_live_' + secret)).toBe(false);
    expect(keyLooksLikeApiKey('gn_live_short')).toBe(false);
    expect(keyLooksLikeApiKey(API_KEY_PREFIX)).toBe(false);
  });

  it('normalizes and dedupes valid scopes', () => {
    const result = normalizeScopes(['READ_PROJECTS', 'READ_PROJECTS', 'READ_APPLICATIONS']);
    expect(result).toEqual({ scopes: ['READ_PROJECTS', 'READ_APPLICATIONS'] });
  });

  it('refuses empty and unknown scopes by name', () => {
    expect(normalizeScopes([])).toBe('api-key.scopes-missing');
    expect(normalizeScopes(['WRITE_EVERYTHING'])).toBe('api-key.scope-unknown');
    expect(normalizeScopes(['read_projects'])).toBe('api-key.scope-unknown');
  });

  it('pins the complete honest scope set', () => {
    expect(ALL_API_KEY_SCOPES).toEqual([
      'READ_ORGANIZATION',
      'READ_PROJECTS',
      'READ_APPLICATIONS',
    ]);
  });

  it('refuses expiries in the past and accepts future or absent expiry', () => {
    expect(planExpiry(new Date('2026-10-30T11:59:59.000Z'), now)).toBe(
      'api-key.expiry-in-the-past',
    );
    expect(planExpiry(now, now)).toBe('api-key.expiry-in-the-past');
    const future = new Date('2027-01-01T00:00:00.000Z');
    expect(planExpiry(future, now)).toEqual({ expiresAt: future });
    expect(planExpiry(undefined, now)).toEqual({ expiresAt: null });
  });

  it('classifies revoked and expired keys with named refusals', () => {
    expect(isKeyUsable({ revokedAt: now, expiresAt: null }, now)).toBe(
      'api-key.revoked',
    );
    expect(
      isKeyUsable({ revokedAt: null, expiresAt: new Date('2026-10-29T00:00:00.000Z') }, now),
    ).toBe('api-key.expired');
    expect(
      isKeyUsable({ revokedAt: null, expiresAt: new Date('2027-01-01T00:00:00.000Z') }, now),
    ).toEqual({ usable: true });
    expect(isKeyUsable({ revokedAt: null, expiresAt: null }, now)).toEqual({ usable: true });
  });

  it('sweep: 500 deterministic secrets produce 500 unique keys and hashes', () => {
    const rng = mulberry32(42);
    const raws = new Set<string>();
    const hashes = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      let secret = '';
      for (let j = 0; j < 43; j += 1) {
        secret += ALPHABET[Math.floor(rng() * ALPHABET.length)];
      }
      const material = buildKeyMaterial(secret);
      raws.add(material.rawKey);
      hashes.add(material.hashedKey);
      expect(keyLooksLikeApiKey(material.rawKey)).toBe(true);
    }
    expect(raws.size).toBe(500);
    expect(hashes.size).toBe(500);
  });
});
