import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';

@Injectable()
export class HealthService {
  constructor(private readonly prisma: PrismaService) {}

  live() {
    return {
      status: 'ok',
      service: 'genesis-api',
      timestamp: new Date().toISOString(),
    };
  }

  async ready() {
    const databaseReady = await this.prisma.isDatabaseReady();
    return {
      status: databaseReady ? 'ok' : 'degraded',
      checks: { database: databaseReady ? 'ok' : 'unavailable' },
      timestamp: new Date().toISOString(),
    };
  }
}
