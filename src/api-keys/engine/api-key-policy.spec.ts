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
  actorAttribution,
  actorAuditMetadata,
  actorAuditOrganization,
  hasGrantedScope,
  keyActorFromApiKey,
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

  it('accepts the write scopes and dedupes them like any other scope', () => {
    const result = normalizeScopes(['WRITE_APPLICATIONS', 'WRITE_APPLICATIONS', 'READ_APPLICATIONS']);
    expect(result).toEqual({ scopes: ['WRITE_APPLICATIONS', 'READ_APPLICATIONS'] });
    expect(normalizeScopes(['WRITE_APPLICATIONS'])).toEqual({ scopes: ['WRITE_APPLICATIONS'] });
    expect(normalizeScopes(['WRITE_ORGANIZATION', 'WRITE_ORGANIZATION']))
      .toEqual({ scopes: ['WRITE_ORGANIZATION'] });
    expect(normalizeScopes(['WRITE_PROJECTS'])).toEqual({ scopes: ['WRITE_PROJECTS'] });
  });

  it('pins the complete honest scope set', () => {
    expect(ALL_API_KEY_SCOPES).toEqual([
      'READ_ORGANIZATION',
      'READ_PROJECTS',
      'READ_APPLICATIONS',
      'WRITE_APPLICATIONS',
      'WRITE_ORGANIZATION',
      'WRITE_PROJECTS',
    ]);
  });

  it('derives the key actor with honest attribution', () => {
    const actor = keyActorFromApiKey({ id: 'key_1', name: 'ci', organizationId: 'org_1', createdBy: 'user_1' });
    expect(actor).toEqual({
      kind: 'apiKey',
      apiKeyId: 'key_1',
      apiKeyName: 'ci',
      organizationId: 'org_1',
      attributedUserId: 'user_1',
    });
    const orphan = keyActorFromApiKey({ id: 'key_2', name: 'orphan', organizationId: 'org_1', createdBy: null });
    expect(orphan.attributedUserId).toBeNull();
  });

  it('attributes user actors to themselves and key actors to the creator', () => {
    expect(actorAttribution({ kind: 'user', userId: 'user_9' })).toBe('user_9');
    const attributed = keyActorFromApiKey({ id: 'k', name: 'n', organizationId: 'o', createdBy: 'user_3' });
    expect(actorAttribution(attributed)).toBe('user_3');
    const orphan = keyActorFromApiKey({ id: 'k', name: 'n', organizationId: 'o', createdBy: null });
    expect(actorAttribution(orphan)).toBeNull();
  });

  it('stamps key actions in audit metadata and leaves user actions untouched', () => {
    const base = { applicationId: 'app_1' };
    expect(actorAuditMetadata({ kind: 'user', userId: 'u1' }, base)).toBe(base);
    const stamped = actorAuditMetadata(
      keyActorFromApiKey({ id: 'key_1', name: 'ci', organizationId: 'org_1', createdBy: 'u1' }),
      base,
    );
    expect(stamped).toEqual({ applicationId: 'app_1', via: 'genapi', apiKeyId: 'key_1', apiKeyName: 'ci' });
  });

  it('scopes audit organization to key actors only', () => {
    expect(actorAuditOrganization({ kind: 'user', userId: 'u1' })).toBeNull();
    const actor = keyActorFromApiKey({ id: 'k', name: 'n', organizationId: 'org_7', createdBy: null });
    expect(actorAuditOrganization(actor)).toBe('org_7');
  });

  it('checks granted scopes against a single source of truth', () => {
    expect(hasGrantedScope(['READ_PROJECTS'], 'READ_PROJECTS')).toBe(true);
    expect(hasGrantedScope(['READ_PROJECTS'], 'WRITE_APPLICATIONS')).toBe(false);
    expect(hasGrantedScope([], 'WRITE_APPLICATIONS')).toBe(false);
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

  it('sweep: 500 randomized actors and scope sets resolve honestly', () => {
    const rng = mulberry32(42);
    const scopeList = ALL_API_KEY_SCOPES as readonly string[];
    for (let i = 0; i < 500; i += 1) {
      const requested: string[] = [];
      const count = 1 + Math.floor(rng() * 3);
      for (let j = 0; j < count; j += 1) {
        requested.push(scopeList[Math.floor(rng() * scopeList.length)]);
      }
      const normalized = normalizeScopes(requested);
      if (typeof normalized === 'string') {
        throw new Error('sweep normalization refused a known scope set');
      }
      const scopes = normalized.scopes;
      expect(new Set(scopes).size).toBe(scopes.length);
      for (const scope of scopes) {
        expect(scopeList.includes(scope)).toBe(true);
        expect(hasGrantedScope(scopes, scope)).toBe(true);
      }
      expect(hasGrantedScope(scopes, 'WRITE_APPLICATIONS'))
        .toBe(scopes.includes('WRITE_APPLICATIONS'));

      const actor = rng() < 0.5
        ? { kind: 'user' as const, userId: 'user_' + i }
        : keyActorFromApiKey({
            id: 'key_' + i,
            name: 'k' + i,
            organizationId: 'org_' + (i % 7),
            createdBy: rng() < 0.5 ? 'user_' + i : null,
          });
      expect(actorAttribution(actor)).toBe(
        actor.kind === 'user' ? 'user_' + i : actor.attributedUserId,
      );
      const metadata = actorAuditMetadata(actor, { step: i });
      if (actor.kind === 'user') {
        expect(metadata).toEqual({ step: i });
        expect(actorAuditOrganization(actor)).toBeNull();
      } else {
        expect(metadata).toEqual({
          step: i,
          via: 'genapi',
          apiKeyId: 'key_' + i,
          apiKeyName: 'k' + i,
        });
        expect(actorAuditOrganization(actor)).toBe('org_' + (i % 7));
      }
    }
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
