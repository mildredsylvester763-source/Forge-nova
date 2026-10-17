import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    const poolTimeout = Number(process.env.DATABASE_POOL_TIMEOUT_SECONDS ?? 10);
    super({
      log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
      transactionOptions: {
        maxWait: Math.max(1, poolTimeout) * 1000,
        timeout: 15_000,
      },
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  async isDatabaseReady(): Promise<boolean> {
    try {
      await this.$queryRawUnsafe<[{ ready: number }]>('SELECT 1 AS ready');
      return true;
    } catch {
      return false;
    }
  }

  async inTransaction<T>(
    operation: (transaction: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return this.$transaction(operation);
  }
}
