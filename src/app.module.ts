import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './database/prisma.module';
import { HealthModule } from './health/health.module';
import { validateEnvironment } from './common/config/env.validation';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: (configuration) => validateEnvironment(configuration),
    }),
    PrismaModule,
    HealthModule,
  ],
})
export class AppModule {}
