-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('PENDING', 'RUNNING', 'PASSED', 'FAILED', 'SKIPPED', 'ERROR');

-- CreateEnum
CREATE TYPE "VerificationKind" AS ENUM ('STATIC_ANALYSIS', 'SECRET_SCAN', 'DEPENDENCY_AUDIT', 'BUILD', 'TEST');

-- CreateTable
CREATE TABLE "VerificationRun" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "jobId" TEXT,
    "kind" "VerificationKind" NOT NULL,
    "status" "VerificationStatus" NOT NULL DEFAULT 'PENDING',
    "summary" TEXT,
    "findings" JSONB,
    "evidence" JSONB,
    "triggeredBy" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VerificationRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "VerificationRun_applicationId_kind_createdAt_idx" ON "VerificationRun"("applicationId", "kind", "createdAt");
CREATE INDEX "VerificationRun_status_createdAt_idx" ON "VerificationRun"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "VerificationRun" ADD CONSTRAINT "VerificationRun_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VerificationRun" ADD CONSTRAINT "VerificationRun_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "WorkJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;
