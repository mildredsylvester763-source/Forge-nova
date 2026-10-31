import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';

export const API_KEY_PREFIX = 'gn_live_';
export const API_KEY_SECRET_MIN_CHARS = 20;

/**
 * Granular, per-resource key permissions. The set is deliberately honest:
 * a scope may only exist when a key-authenticated endpoint can actually
 * honor it. New scopes require new real endpoints first.
 */
export const ALL_API_KEY_SCOPES = [
  'READ_ORGANIZATION',
  'READ_PROJECTS',
  'READ_APPLICATIONS',
  'WRITE_APPLICATIONS',
] as const;

export type ApiKeyScopeName = (typeof ALL_API_KEY_SCOPES)[number];

export type ApiKeyRefusal =
  | 'api-key.name-empty'
  | 'api-key.name-too-long'
  | 'api-key.scopes-missing'
  | 'api-key.scope-unknown'
  | 'api-key.expiry-in-the-past';

export const REFUSAL_MESSAGES: Record<ApiKeyRefusal, string> = {
  'api-key.name-empty': 'A key name is required.',
  'api-key.name-too-long': 'A key name must be at most 100 characters.',
  'api-key.scopes-missing': 'At least one scope is required.',
  'api-key.scope-unknown': 'One of the requested scopes does not exist.',
  'api-key.expiry-in-the-past': 'An expiry date cannot be in the past.',
};

export interface KeyMaterial {
  rawKey: string;
  hashedKey: string;
  displayHint: string;
}

export interface UsableKeyState {
  revokedAt: Date | null;
  expiresAt: Date | null;
}

export type UsabilityRefusal = 'api-key.revoked' | 'api-key.expired';

/**
 * Keys are stored ONLY as SHA-256 hashes; the plaintext is returned to the
 * caller exactly once, at creation time, and never again.
 */
export function hashApiKey(rawKey: string): string {
  return createHash('sha256').update(rawKey, 'utf8').digest('hex');
}

export function buildKeyMaterial(secret: string): KeyMaterial {
  const rawKey = API_KEY_PREFIX + secret;
  return {
    rawKey,
    hashedKey: hashApiKey(rawKey),
    displayHint: API_KEY_PREFIX + secret.slice(0, 4) + '…' + secret.slice(-4),
  };
}

export function keyLooksLikeApiKey(raw: string): boolean {
  if (!raw.startsWith(API_KEY_PREFIX)) return false;
  return raw.slice(API_KEY_PREFIX.length).length >= API_KEY_SECRET_MIN_CHARS;
}

export function normalizeScopes(
  requested: readonly string[],
): { scopes: ApiKeyScopeName[] } | ApiKeyRefusal {
  if (requested.length === 0) return 'api-key.scopes-missing';
  const known = new Set<string>(ALL_API_KEY_SCOPES);
  const scopes: ApiKeyScopeName[] = [];
  for (const scope of requested) {
    if (!known.has(scope)) return 'api-key.scope-unknown';
    const name = scope as ApiKeyScopeName;
    if (!scopes.includes(name)) scopes.push(name);
  }
  return { scopes };
}

export function planExpiry(
  expiresAt: Date | undefined,
  now: Date,
): { expiresAt: Date | null } | ApiKeyRefusal {
  if (expiresAt === undefined) return { expiresAt: null };
  if (expiresAt.getTime() <= now.getTime()) return 'api-key.expiry-in-the-past';
  return { expiresAt };
}

export function isKeyUsable(
  key: UsableKeyState,
  now: Date,
): { usable: true } | UsabilityRefusal {
  if (key.revokedAt !== null) return 'api-key.revoked';
  if (key.expiresAt !== null && key.expiresAt.getTime() <= now.getTime()) {
    return 'api-key.expired';
  }
  return { usable: true };
}

/**
 * The principal behind a write. JWT-authenticated requests act as the
 * user; key-authenticated genapi requests act as the key itself,
 * tenant-bounded to the key organization and attributed to the key
 * creator when that user still exists.
 */
export interface KeyActorContext {
  kind: 'apiKey';
  apiKeyId: string;
  apiKeyName: string;
  organizationId: string;
  attributedUserId: string | null;
}

export type WriteActor =
  | { kind: 'user'; userId: string }
  | KeyActorContext;

export function keyActorFromApiKey(key: {
  id: string;
  name: string;
  organizationId: string;
  createdBy: string | null;
}): KeyActorContext {
  return {
    kind: 'apiKey',
    apiKeyId: key.id,
    apiKeyName: key.name,
    organizationId: key.organizationId,
    attributedUserId: key.createdBy,
  };
}

/**
 * The user id written into createdBy/triggeredBy columns. A key whose
 * creator has been deleted attributes honestly to null.
 */
export function actorAttribution(actor: WriteActor): string | null {
  return actor.kind === 'user' ? actor.userId : actor.attributedUserId;
}

/**
 * Key-authenticated actions are stamped into audit metadata so the
 * trail always shows which key performed the action. User actions
 * keep their existing metadata shape unchanged.
 */
export function actorAuditMetadata(
  actor: WriteActor,
  base: Record<string, unknown>,
): Prisma.InputJsonValue {
  if (actor.kind === 'user') return base as Prisma.InputJsonValue;
  return {
    ...base,
    via: 'genapi',
    apiKeyId: actor.apiKeyId,
    apiKeyName: actor.apiKeyName,
  } as Prisma.InputJsonValue;
}

/**
 * Key-authenticated audit rows are organization-scoped so they appear
 * in the organization audit trail; user rows keep the existing shape.
 */
export function actorAuditOrganization(actor: WriteActor): string | null {
  return actor.kind === 'user' ? null : actor.organizationId;
}

/** Single source of truth for scope checks across the genapi surface. */
export function hasGrantedScope(scopes: readonly string[], required: string): boolean {
  return scopes.includes(required);
}
