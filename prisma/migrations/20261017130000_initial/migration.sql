CREATE TYPE "MembershipRole" AS ENUM ('OWNER', 'ADMIN', 'DEVELOPER', 'BILLING', 'VIEWER');
CREATE TYPE "ProjectStatus" AS ENUM ('ACTIVE', 'ARCHIVED', 'DELETED');
CREATE TYPE "ApplicationStatus" AS ENUM ('PLANNING', 'BUILDING', 'READY', 'DEPLOYED', 'DEGRADED', 'ARCHIVED');
CREATE TYPE "ConversationRole" AS ENUM ('SYSTEM', 'USER', 'ASSISTANT', 'TOOL');
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RESERVED', 'RUNNING', 'WAITING_FOR_APPROVAL', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'PAUSED');
CREATE TYPE "JobType" AS ENUM ('REQUIREMENTS_ANALYSIS', 'CODE_GENERATION', 'CODE_MODIFICATION', 'BUILD', 'TEST', 'SECURITY_SCAN', 'DEPLOYMENT', 'RESEARCH', 'DATA_PROCESSING', 'MANAGED_OPERATION', 'API_TASK');
CREATE TYPE "AuditOutcome" AS ENUM ('SUCCESS', 'DENIED', 'FAILURE');

CREATE TABLE "User" (
  "id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "emailVerifiedAt" TIMESTAMP(3),
  "displayName" TEXT,
  "passwordHash" TEXT,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AuthSession" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "refreshTokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "lastUsedAt" TIMESTAMP(3),
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Organization" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Membership" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "role" "MembershipRole" NOT NULL DEFAULT 'VIEWER',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Workspace" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Project" (
  "id" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "status" "ProjectStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Application" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "status" "ApplicationStatus" NOT NULL DEFAULT 'PLANNING',
  "framework" TEXT,
  "runtime" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Application_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Conversation" (
  "id" TEXT NOT NULL,
  "applicationId" TEXT NOT NULL,
  "title" TEXT,
  "archivedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Message" (
  "id" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "role" "ConversationRole" NOT NULL,
  "content" TEXT NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Checkpoint" (
  "id" TEXT NOT NULL,
  "applicationId" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "sourceRef" TEXT,
  "manifest" JSONB NOT NULL,
  "createdBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Checkpoint_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WorkJob" (
  "id" TEXT NOT NULL,
  "applicationId" TEXT NOT NULL,
  "type" "JobType" NOT NULL,
  "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
  "idempotencyKey" TEXT,
  "input" JSONB NOT NULL,
  "result" JSONB,
  "errorCode" TEXT,
  "errorMessage" TEXT,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "reservedAt" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkJob_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Deployment" (
  "id" TEXT NOT NULL,
  "applicationId" TEXT NOT NULL,
  "environment" TEXT NOT NULL,
  "provider" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "sourceRef" TEXT,
  "externalId" TEXT,
  "url" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Deployment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AuditEvent" (
  "id" TEXT NOT NULL,
  "actorUserId" TEXT,
  "organizationId" TEXT,
  "action" TEXT NOT NULL,
  "resourceType" TEXT NOT NULL,
  "resourceId" TEXT,
  "outcome" "AuditOutcome" NOT NULL,
  "requestId" TEXT,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE INDEX "User_status_createdAt_idx" ON "User"("status", "createdAt");
CREATE UNIQUE INDEX "AuthSession_refreshTokenHash_key" ON "AuthSession"("refreshTokenHash");
CREATE INDEX "AuthSession_userId_expiresAt_idx" ON "AuthSession"("userId", "expiresAt");
CREATE INDEX "AuthSession_expiresAt_revokedAt_idx" ON "AuthSession"("expiresAt", "revokedAt");
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");
CREATE INDEX "Organization_name_idx" ON "Organization"("name");
CREATE UNIQUE INDEX "Membership_userId_organizationId_key" ON "Membership"("userId", "organizationId");
CREATE INDEX "Membership_organizationId_role_idx" ON "Membership"("organizationId", "role");
CREATE UNIQUE INDEX "Workspace_organizationId_slug_key" ON "Workspace"("organizationId", "slug");
CREATE INDEX "Workspace_organizationId_createdAt_idx" ON "Workspace"("organizationId", "createdAt");
CREATE INDEX "Project_workspaceId_status_updatedAt_idx" ON "Project"("workspaceId", "status", "updatedAt");
CREATE INDEX "Project_ownerId_createdAt_idx" ON "Project"("ownerId", "createdAt");
CREATE INDEX "Application_projectId_status_updatedAt_idx" ON "Application"("projectId", "status", "updatedAt");
CREATE INDEX "Conversation_applicationId_archivedAt_updatedAt_idx" ON "Conversation"("applicationId", "archivedAt", "updatedAt");
CREATE INDEX "Message_conversationId_createdAt_idx" ON "Message"("conversationId", "createdAt");
CREATE INDEX "Checkpoint_applicationId_createdAt_idx" ON "Checkpoint"("applicationId", "createdAt");
CREATE UNIQUE INDEX "WorkJob_applicationId_idempotencyKey_key" ON "WorkJob"("applicationId", "idempotencyKey");
CREATE INDEX "WorkJob_status_createdAt_idx" ON "WorkJob"("status", "createdAt");
CREATE INDEX "WorkJob_applicationId_createdAt_idx" ON "WorkJob"("applicationId", "createdAt");
CREATE INDEX "Deployment_applicationId_environment_createdAt_idx" ON "Deployment"("applicationId", "environment", "createdAt");
CREATE INDEX "Deployment_status_createdAt_idx" ON "Deployment"("status", "createdAt");
CREATE INDEX "AuditEvent_actorUserId_createdAt_idx" ON "AuditEvent"("actorUserId", "createdAt");
CREATE INDEX "AuditEvent_organizationId_createdAt_idx" ON "AuditEvent"("organizationId", "createdAt");
CREATE INDEX "AuditEvent_resourceType_resourceId_createdAt_idx" ON "AuditEvent"("resourceType", "resourceId", "createdAt");
CREATE INDEX "AuditEvent_action_createdAt_idx" ON "AuditEvent"("action", "createdAt");

ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Project" ADD CONSTRAINT "Project_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Project" ADD CONSTRAINT "Project_ownerId_fkey"
  FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Application" ADD CONSTRAINT "Application_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_applicationId_fkey"
  FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Checkpoint" ADD CONSTRAINT "Checkpoint_applicationId_fkey"
  FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkJob" ADD CONSTRAINT "WorkJob_applicationId_fkey"
  FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Deployment" ADD CONSTRAINT "Deployment_applicationId_fkey"
  FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_actorUserId_fkey"
  FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ApplicationFile" (
  "id" TEXT NOT NULL,
  "applicationId" TEXT NOT NULL,
  "path" TEXT NOT NULL,
  "language" TEXT,
  "content" TEXT NOT NULL,
  "contentHash" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "isDeleted" BOOLEAN NOT NULL DEFAULT false,
  "createdBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ApplicationFile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FileRevision" (
  "id" TEXT NOT NULL,
  "fileId" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "content" TEXT NOT NULL,
  "contentHash" TEXT NOT NULL,
  "isDeleted" BOOLEAN NOT NULL DEFAULT false,
  "createdBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FileRevision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ApplicationFile_applicationId_path_key" ON "ApplicationFile"("applicationId", "path");
CREATE INDEX "ApplicationFile_applicationId_isDeleted_updatedAt_idx" ON "ApplicationFile"("applicationId", "isDeleted", "updatedAt");
CREATE UNIQUE INDEX "FileRevision_fileId_revision_key" ON "FileRevision"("fileId", "revision");
CREATE INDEX "FileRevision_fileId_createdAt_idx" ON "FileRevision"("fileId", "createdAt");

ALTER TABLE "ApplicationFile" ADD CONSTRAINT "ApplicationFile_applicationId_fkey"
  FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FileRevision" ADD CONSTRAINT "FileRevision_fileId_fkey"
  FOREIGN KEY ("fileId") REFERENCES "ApplicationFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TYPE "WorkGraphStatus" AS ENUM ('DRAFT', 'PLANNING', 'READY', 'EXECUTING', 'COMPLETED', 'FAILED', 'CANCELLED');
CREATE TYPE "WorkNodeStatus" AS ENUM ('RECORDED', 'PENDING', 'READY', 'RUNNING', 'WAITING_FOR_APPROVAL', 'SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED');
CREATE TYPE "WorkNodeType" AS ENUM ('REQUIREMENT', 'ANALYSIS', 'GENERATE', 'MODIFY', 'BUILD', 'TEST', 'SECURITY_SCAN', 'DEPLOY', 'VERIFY', 'EXTERNAL_TOOL');
CREATE TYPE "WorkRiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

CREATE TABLE "WorkGraph" (
  "id" TEXT NOT NULL,
  "applicationId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "sourcePrompt" TEXT NOT NULL,
  "status" "WorkGraphStatus" NOT NULL DEFAULT 'DRAFT',
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkGraph_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WorkNode" (
  "id" TEXT NOT NULL,
  "graphId" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "type" "WorkNodeType" NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "status" "WorkNodeStatus" NOT NULL DEFAULT 'PENDING',
  "riskLevel" "WorkRiskLevel" NOT NULL DEFAULT 'LOW',
  "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
  "input" JSONB NOT NULL,
  "output" JSONB,
  "estimatedResources" JSONB,
  "actualResources" JSONB,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkNode_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "WorkDependency" (
  "id" TEXT NOT NULL,
  "fromNodeId" TEXT NOT NULL,
  "toNodeId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkDependency_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "WorkDependency_no_self_edge_check" CHECK ("fromNodeId" <> "toNodeId")
);

CREATE INDEX "WorkGraph_applicationId_status_updatedAt_idx" ON "WorkGraph"("applicationId", "status", "updatedAt");
CREATE UNIQUE INDEX "WorkNode_graphId_key_key" ON "WorkNode"("graphId", "key");
CREATE INDEX "WorkNode_graphId_status_createdAt_idx" ON "WorkNode"("graphId", "status", "createdAt");
CREATE INDEX "WorkNode_status_riskLevel_createdAt_idx" ON "WorkNode"("status", "riskLevel", "createdAt");
CREATE UNIQUE INDEX "WorkDependency_fromNodeId_toNodeId_key" ON "WorkDependency"("fromNodeId", "toNodeId");
CREATE INDEX "WorkDependency_toNodeId_idx" ON "WorkDependency"("toNodeId");

ALTER TABLE "WorkGraph" ADD CONSTRAINT "WorkGraph_applicationId_fkey"
  FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkNode" ADD CONSTRAINT "WorkNode_graphId_fkey"
  FOREIGN KEY ("graphId") REFERENCES "WorkGraph"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkDependency" ADD CONSTRAINT "WorkDependency_fromNodeId_fkey"
  FOREIGN KEY ("fromNodeId") REFERENCES "WorkNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkDependency" ADD CONSTRAINT "WorkDependency_toNodeId_fkey"
  FOREIGN KEY ("toNodeId") REFERENCES "WorkNode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "WorkJob"
  ADD COLUMN "lockedBy" TEXT,
  ADD COLUMN "leaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN "heartbeatAt" TIMESTAMP(3),
  ADD COLUMN "cancelRequestedAt" TIMESTAMP(3),
  ADD COLUMN "maxAttempts" INTEGER NOT NULL DEFAULT 3;

CREATE TABLE "ResourceUsageEvent" (
  "id" TEXT NOT NULL,
  "applicationId" TEXT NOT NULL,
  "jobId" TEXT,
  "eventType" TEXT NOT NULL,
  "provider" TEXT,
  "model" TEXT,
  "unit" TEXT NOT NULL,
  "quantity" DECIMAL(24,8) NOT NULL,
  "dimensions" JSONB,
  "idempotencyKey" TEXT,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ResourceUsageEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ResourceUsageEvent_applicationId_idempotencyKey_key" ON "ResourceUsageEvent"("applicationId", "idempotencyKey");
CREATE INDEX "ResourceUsageEvent_applicationId_occurredAt_idx" ON "ResourceUsageEvent"("applicationId", "occurredAt");
CREATE INDEX "ResourceUsageEvent_jobId_occurredAt_idx" ON "ResourceUsageEvent"("jobId", "occurredAt");
CREATE INDEX "ResourceUsageEvent_eventType_occurredAt_idx" ON "ResourceUsageEvent"("eventType", "occurredAt");

ALTER TABLE "ResourceUsageEvent" ADD CONSTRAINT "ResourceUsageEvent_applicationId_fkey"
  FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResourceUsageEvent" ADD CONSTRAINT "ResourceUsageEvent_jobId_fkey"
  FOREIGN KEY ("jobId") REFERENCES "WorkJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "WorkGraph"
  ADD COLUMN "planningToken" TEXT,
  ADD COLUMN "planningLeaseExpiresAt" TIMESTAMP(3);
