-- CreateEnum
CREATE TYPE "ReferenceKind" AS ENUM ('SPEC', 'TRANSCRIPT', 'NOTES', 'OTHER');

-- CreateEnum
CREATE TYPE "ReferenceStatus" AS ENUM ('STORED', 'EXTRACTED', 'EXTRACTION_FAILED');

-- CreateTable
CREATE TABLE "ReferenceDocument" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" "ReferenceKind" NOT NULL,
    "content" TEXT NOT NULL,
    "status" "ReferenceStatus" NOT NULL DEFAULT 'STORED',
    "extraction" JSONB,
    "extractionError" TEXT,
    "extractedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReferenceDocument_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReferenceDocument_applicationId_createdAt_idx" ON "ReferenceDocument"("applicationId", "createdAt");
CREATE INDEX "ReferenceDocument_applicationId_status_updatedAt_idx" ON "ReferenceDocument"("applicationId", "status", "updatedAt");

-- AddForeignKey
ALTER TABLE "ReferenceDocument" ADD CONSTRAINT "ReferenceDocument_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
