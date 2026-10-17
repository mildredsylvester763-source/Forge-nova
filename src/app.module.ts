import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AuthModule } from './auth/auth.module';
import { AuthorizationModule } from './authorization/authorization.module';
import { WorkspaceModule } from './workspaces/workspace.module';
import { ProjectModule } from './projects/project.module';
import { ApplicationModule } from './applications/application.module';
import { ConversationModule } from './conversations/conversation.module';
import { FileModule } from './files/file.module';
import { WorkGraphModule } from './work-graphs/work-graph.module';
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
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 120 }]),
    PrismaModule,
    AuthModule,
    AuthorizationModule,
    WorkspaceModule,
    ProjectModule,
    ApplicationModule,
    ConversationModule,
    FileModule,
    WorkGraphModule,
    HealthModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
