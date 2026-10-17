import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { AuthorizationModule } from './authorization/authorization.module';
import { WorkspaceModule } from './workspaces/workspace.module';
import { ProjectModule } from './projects/project.module';
import { ApplicationModule } from './applications/application.module';
import { ConversationModule } from './conversations/conversation.module';
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
    AuthModule,
    AuthorizationModule,
    WorkspaceModule,
    ProjectModule,
    ApplicationModule,
    ConversationModule,
    HealthModule,
  ],
})
export class AppModule {}
