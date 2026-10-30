import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiKeyScopeName, keyLooksLikeApiKey } from './engine/api-key-policy';
import { ApiKeyService } from './api-key.service';

export const API_KEY_SCOPES_KEY = 'genapi:required-scopes';

/** Declares the scopes a key-authenticated endpoint requires. */
export const RequireScopes = (...scopes: ApiKeyScopeName[]) =>
  SetMetadata(API_KEY_SCOPES_KEY, scopes);

export interface AuthenticatedApiKey {
  id: string;
  organizationId: string;
  name: string;
  scopes: ApiKeyScopeName[];
}

const RATE_WINDOW_MS = 60_000;

/**
 * Authenticates requests with a GENESIS API key (Authorization: Bearer
 * gn_live_...), enforces the endpoint's required scopes, and applies a
 * fixed-window per-key rate limit. The counter is per application
 * instance and resets on restart - it protects the read surface honestly
 * without claiming a distributed limiter that does not exist.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly buckets = new Map<string, { windowStart: number; count: number }>();
  private readonly limit: number;

  constructor(
    private readonly reflector: Reflector,
    private readonly apiKeys: ApiKeyService,
  ) {
    const raw = Number(process.env.GENESIS_API_KEY_RATE_LIMIT ?? '120');
    this.limit = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 120;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<ApiKeyScopeName[] | undefined>(
      API_KEY_SCOPES_KEY,
      [context.getHandler(), context.getClass()],
    );

    const request = context.switchToHttp().getRequest();
    const header: unknown = request.headers.authorization;
    const rawKey =
      typeof header === 'string' && header.startsWith('Bearer ')
        ? header.slice('Bearer '.length).trim()
        : undefined;
    if (!rawKey || !keyLooksLikeApiKey(rawKey)) {
      throw new UnauthorizedException('A valid GENESIS API key is required.');
    }

    const key = await this.apiKeys.authenticate(rawKey);
    if (!key) {
      throw new UnauthorizedException('API key is invalid, expired, or revoked.');
    }

    if (!this.allowRequest(key.id)) {
      throw new HttpException('API key rate limit exceeded.', HttpStatus.TOO_MANY_REQUESTS);
    }

    if (required && required.length > 0) {
      const granted = new Set<string>(key.scopes);
      for (const scope of required) {
        if (!granted.has(scope)) {
          throw new ForbiddenException('The API key does not grant the required scope.');
        }
      }
    }

    request.apiKey = key;
    return true;
  }

  private allowRequest(keyId: string): boolean {
    const now = Date.now();
    const bucket = this.buckets.get(keyId);
    if (!bucket || now - bucket.windowStart >= RATE_WINDOW_MS) {
      this.buckets.set(keyId, { windowStart: now, count: 1 });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= this.limit;
  }
}
