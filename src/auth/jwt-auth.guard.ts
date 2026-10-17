import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { AuthenticatedUser } from './auth.types';

type AuthenticatedRequest = Request & { user?: AuthenticatedUser };

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;

    if (!header || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException('A valid bearer access token is required.');
    }

    const token = header.slice('Bearer '.length).trim();
    if (!token) {
      throw new UnauthorizedException('A valid bearer access token is required.');
    }

    try {
      const payload = await this.jwt.verifyAsync<AuthenticatedUser>(token);
      if (!payload.sub || !payload.email) {
        throw new UnauthorizedException('Access token payload is invalid.');
      }
      request.user = { sub: payload.sub, email: payload.email };
      return true;
    } catch {
      throw new UnauthorizedException('Access token is invalid or expired.');
    }
  }
}
