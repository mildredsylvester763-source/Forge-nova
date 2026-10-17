import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { AuthorizationModule } from './authorization/authorization.module';
import { WorkspaceModule } from './workspaces/workspace.module';
import { ProjectModule } from './projects/project.module';
import { ApplicationModule } from './applications/application.module';
import { ConversationModule } from './conversations/conversation.module';\nimport { FileModule } from './files/file.module';
import { PrismaModule } from './database/prisma.module';
import { HealthModule } from './health/health.module';
import { validateEnvironment } from './common/config/env.validation';

@Module({
  imports: [
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: (configuration) => validateEnvironment(configuration),
    }),
    PrismaModule,
    AuthModule,
    AuthorizationModule,
    WorkspaceModule,
    ProjectModule,
    ApplicationModule,
    ConversationModule,
    HealthModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
