import {
  BadRequestException,
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';
import { compare, hash } from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import { Request } from 'express';
import { PrismaService } from '../database/prisma.service';
import { AuthTokens } from './auth.types';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';

@Injectable()
export class AuthService {
  private readonly accessTokenTtl: number;
  private readonly refreshTokenTtlDays: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {
    this.accessTokenTtl = this.config.get<number>('ACCESS_TOKEN_TTL_SECONDS', 900);
    this.refreshTokenTtlDays = this.config.get<number>('REFRESH_TOKEN_TTL_DAYS', 30);
  }

  async register(dto: RegisterDto, request: Request) {
    const email = dto.email.trim().toLowerCase();
    this.assertBcryptCompatiblePassword(dto.password);
    const passwordHash = await hash(dto.password, 12);
    const displayName = dto.displayName?.trim() || email.split('@')[0];
    const localPart = email.split('@')[0] ?? 'user';
    const baseSlug = localPart
      .normalize('NFKD')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase()
      .slice(0, 32) || 'user';
    const organizationSlug = `${baseSlug}-${randomBytes(4).toString('hex')}`;

    let user: { id: string; email: string; displayName: string | null };
    try {
      user = await this.prisma.$transaction(async (tx) => {
        const createdUser = await tx.user.create({
          data: { email, passwordHash, displayName },
          select: { id: true, email: true, displayName: true },
        });

        const organization = await tx.organization.create({
          data: {
            name: `${displayName}'s Organization`,
            slug: organizationSlug,
            memberships: {
              create: { role: 'OWNER', user: { connect: { id: createdUser.id } } },
            },
            workspaces: {
              create: { name: 'Personal Workspace', slug: 'personal' },
            },
          },
        });

        await tx.auditEvent.create({
          data: {
            actorUserId: createdUser.id,
            organizationId: organization.id,
            action: 'auth.register',
            resourceType: 'user',
            resourceId: createdUser.id,
            outcome: 'SUCCESS',
            requestId: this.requestId(request),
            ipAddress: this.clientIp(request),
            userAgent: this.userAgent(request),
          },
        });

        return createdUser;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('An account with this email already exists.');
      }
      throw error;
    }

    const tokens = await this.createSession(user.id, user.email, request);
    return { user, ...tokens };
  }

  async login(dto: LoginDto, request: Request) {
    const email = dto.email.trim().toLowerCase();
    if (Buffer.byteLength(dto.password, 'utf8') > 72) {
      throw new UnauthorizedException('Email or password is incorrect.');
    }
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, displayName: true, passwordHash: true, status: true },
    });

    // Keep the outward error identical for unknown emails and wrong passwords.
    if (!user?.passwordHash || !(await compare(dto.password, user.passwordHash))) {
      throw new UnauthorizedException('Email or password is incorrect.');
    }
    if (user.status !== 'ACTIVE') {
      throw new UnauthorizedException('This account is not active.');
    }

    await this.prisma.auditEvent.create({
      data: {
        actorUserId: user.id,
        action: 'auth.login',
        resourceType: 'user',
        resourceId: user.id,
        outcome: 'SUCCESS',
        requestId: this.requestId(request),
        ipAddress: this.clientIp(request),
        userAgent: this.userAgent(request),
      },
    });

    const tokens = await this.createSession(user.id, user.email, request);
    return {
      user: { id: user.id, email: user.email, displayName: user.displayName },
      ...tokens,
    };
  }

  async refresh(refreshToken: string, request: Request) {
    const tokenHash = this.hashToken(refreshToken);
    const now = new Date();
    const session = await this.prisma.authSession.findUnique({
      where: { refreshTokenHash: tokenHash },
      include: { user: { select: { id: true, email: true, displayName: true, status: true } } },
    });

    if (
      !session ||
      session.revokedAt ||
      session.expiresAt <= now ||
      session.user.status !== 'ACTIVE'
    ) {
      throw new UnauthorizedException('Refresh token is invalid, expired, or revoked.');
    }

    const rotated = await this.prisma.$transaction(async (tx) => {
      const update = await tx.authSession.updateMany({
        where: {
          id: session.id,
          revokedAt: null,
          expiresAt: { gt: now },
        },
        data: { revokedAt: now, lastUsedAt: now },
      });
      if (update.count !== 1) {
        return false;
      }

      const nextToken = randomBytes(48).toString('base64url');
      await tx.authSession.create({
        data: {
          userId: session.user.id,
          refreshTokenHash: this.hashToken(nextToken),
          expiresAt: this.refreshExpiry(),
          ipAddress: this.clientIp(request),
          userAgent: this.userAgent(request),
        },
      });

      await tx.auditEvent.create({
        data: {
          actorUserId: session.user.id,
          action: 'auth.refresh',
          resourceType: 'auth_session',
          resourceId: session.id,
          outcome: 'SUCCESS',
          requestId: this.requestId(request),
          ipAddress: this.clientIp(request),
          userAgent: this.userAgent(request),
        },
      });

      return nextToken;
    });

    if (!rotated) {
      throw new UnauthorizedException('Refresh token has already been used.');
    }

    return {
      user: {
        id: session.user.id,
        email: session.user.email,
        displayName: session.user.displayName,
      },
      ...(await this.issueAccessToken(session.user.id, session.user.email)),
      refreshToken: rotated,
      tokenType: 'Bearer' as const,
      expiresIn: this.accessTokenTtl,
    };
  }

  async logout(refreshToken: string, request: Request): Promise<{ success: true }> {
    const tokenHash = this.hashToken(refreshToken);
    const session = await this.prisma.authSession.findUnique({
      where: { refreshTokenHash: tokenHash },
      select: { id: true, userId: true, revokedAt: true },
    });

    if (session && !session.revokedAt) {
      await this.prisma.$transaction([
        this.prisma.authSession.updateMany({
          where: { id: session.id, revokedAt: null },
          data: { revokedAt: new Date() },
        }),
        this.prisma.auditEvent.create({
          data: {
            actorUserId: session.userId,
            action: 'auth.logout',
            resourceType: 'auth_session',
            resourceId: session.id,
            outcome: 'SUCCESS',
            requestId: this.requestId(request),
            ipAddress: this.clientIp(request),
            userAgent: this.userAgent(request),
          },
        }),
      ]);
    }

    // Logout is idempotent and does not disclose whether a token existed.
    return { success: true };
  }

  async getCurrentUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        displayName: true,
        emailVerifiedAt: true,
        status: true,
        createdAt: true,
      },
    });

    if (!user || user.status !== 'ACTIVE') {
      throw new UnauthorizedException('Account is unavailable.');
    }
    return user;
  }

  private async createSession(userId: string, email: string, request: Request): Promise<AuthTokens> {
    const refreshToken = randomBytes(48).toString('base64url');
    await this.prisma.authSession.create({
      data: {
        userId,
        refreshTokenHash: this.hashToken(refreshToken),
        expiresAt: this.refreshExpiry(),
        ipAddress: this.clientIp(request),
        userAgent: this.userAgent(request),
      },
    });

    const access = await this.issueAccessToken(userId, email);
    return {
      ...access,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: this.accessTokenTtl,
    };
  }

  private async issueAccessToken(userId: string, email: string) {
    const accessToken = await this.jwt.signAsync(
      { sub: userId, email },
      { expiresIn: this.accessTokenTtl },
    );
    return { accessToken };
  }

  private refreshExpiry(): Date {
    return new Date(Date.now() + this.refreshTokenTtlDays * 24 * 60 * 60 * 1000);
  }

  private assertBcryptCompatiblePassword(password: string): void {
    // bcrypt only considers the first 72 UTF-8 bytes; reject longer input rather than silently truncating it.
    if (Buffer.byteLength(password, 'utf8') > 72) {
      throw new BadRequestException('Password must be at most 72 bytes when encoded as UTF-8.');
    }
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private requestId(request: Request): string | undefined {
    const value = request.headers['x-request-id'];
    return typeof value === 'string' && value.length <= 128 ? value : undefined;
  }

  private clientIp(request: Request): string | undefined {
    return request.ip?.slice(0, 64);
  }

  private userAgent(request: Request): string | undefined {
    const value = request.headers['user-agent'];
    return typeof value === 'string' ? value.slice(0, 512) : undefined;
  }
}
