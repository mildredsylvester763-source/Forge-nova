import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, VerificationKind } from '@prisma/client';
import { AccessControlService } from '../authorization/access-control.service';
import { PrismaService } from '../database/prisma.service';
import { SecretScannerService } from '../security/secret-scanner.service';
import { VerifiableKind } from './dto/run-verification.dto';
import { auditDependencyManifests } from './engine/dependency-audit.engine';
import { analyzeSource, SourceFileInput, VerificationFinding } from './engine/static-analysis.engine';
import { verdictFromFindings } from './engine/verification-verdict.engine';

const MAX_STORED_FINDINGS = 200;
const DEFAULT_KINDS: VerifiableKind[] = ['STATIC_ANALYSIS', 'SECRET_SCAN', 'DEPENDENCY_AUDIT'];

interface KindExecution {
  findings: VerificationFinding[];
  analyzedCount: number;
  evidence: Record<string, unknown>;
}

@Injectable()
export class VerificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
    private readonly secretScanner: SecretScannerService,
  ) {}

  async runForApplication(
    userId: string,
    applicationId: string,
    kinds?: VerifiableKind[],
    jobId?: string,
  ) {
    const application = await this.prisma.application.findUnique({
      where: { id: applicationId },
      select: { id: true, projectId: true },
    });
    if (!application) {
      throw new NotFoundException('Application not found.');
    }
    await this.access.requireProjectRole(userId, application.projectId, this.access.writeRoles());

    const resolvedKinds = kinds && kinds.length > 0 ? kinds : DEFAULT_KINDS;
    const files = await this.prisma.applicationFile.findMany({
      where: { applicationId, isDeleted: false },
      select: { path: true, content: true },
      orderBy: { path: 'asc' },
    });

    const runs = [];
    for (const kind of resolvedKinds) {
      const execution = this.executeKind(kind, files);
      const run = await this.persistRun(applicationId, userId, jobId, kind, execution, files.length);
      runs.push(run);
    }
    return runs;
  }

  async listForApplication(userId: string, applicationId: string) {
    const application = await this.prisma.application.findUnique({
      where: { id: applicationId },
      select: { id: true, projectId: true },
    });
    if (!application) {
      throw new NotFoundException('Application not found.');
    }
    await this.access.requireProjectRole(userId, application.projectId, this.access.allRoles());

    return this.prisma.verificationRun.findMany({
      where: { applicationId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  async findOne(userId: string, applicationId: string, verificationId: string) {
    const application = await this.prisma.application.findUnique({
      where: { id: applicationId },
      select: { id: true, projectId: true },
    });
    if (!application) {
      throw new NotFoundException('Application not found.');
    }
    await this.access.requireProjectRole(userId, application.projectId, this.access.allRoles());

    const run = await this.prisma.verificationRun.findFirst({
      where: { id: verificationId, applicationId },
    });
    if (!run) {
      throw new NotFoundException('Verification run not found.');
    }
    return run;
  }

  private executeKind(kind: VerifiableKind, files: SourceFileInput[]): KindExecution {
    if (kind === 'STATIC_ANALYSIS') {
      const report = analyzeSource(files);
      return {
        findings: report.findings,
        analyzedCount: report.analyzedFiles,
        evidence: {
          engine: 'static-analysis@1',
          analyzedFiles: report.analyzedFiles,
          unsupportedFiles: report.unsupportedFiles,
          totalFiles: files.length,
        },
      };
    }

    if (kind === 'SECRET_SCAN') {
      const findings: VerificationFinding[] = [];
      for (const file of files) {
        for (const secret of this.secretScanner.scan(file.content)) {
          findings.push({
            path: file.path,
            line: secret.line,
            column: 1,
            severity: 'ERROR',
            code: `secret.${secret.category}`,
            message: `Possible ${secret.category} secret material detected. Store credentials in the authorized secret system, not source files.`,
          });
        }
      }
      findings.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
      return {
        findings,
        analyzedCount: files.length,
        evidence: {
          engine: 'secret-scan@1',
          scannedFiles: files.length,
        },
      };
    }

    const report = auditDependencyManifests(files);
    return {
      findings: report.findings,
      analyzedCount: report.manifests,
      evidence: {
        engine: 'dependency-audit@1',
        manifests: report.manifests,
        totalFiles: files.length,
      },
    };
  }

  private async persistRun(
    applicationId: string,
    userId: string,
    jobId: string | undefined,
    kind: VerifiableKind,
    execution: KindExecution,
    totalFiles: number,
  ) {
    const verdict = verdictFromFindings(kind, execution.findings, execution.analyzedCount);
    const storedFindings = execution.findings.slice(0, MAX_STORED_FINDINGS);
    const omittedCount = execution.findings.length - storedFindings.length;
    const evidence = { ...execution.evidence, totalFiles };
    if (omittedCount > 0) {
      evidence.storedFindings = storedFindings.length;
      evidence.omittedFindings = omittedCount;
    }

    const startedAt = new Date();
    const run = await this.prisma.verificationRun.create({
      data: {
        applicationId,
        jobId: jobId ?? null,
        kind: kind as VerificationKind,
        status: verdict.status,
        summary: verdict.summary,
        findings: { counts: verdict.counts, items: storedFindings } as unknown as Prisma.InputJsonValue,
        evidence: evidence as unknown as Prisma.InputJsonValue,
        triggeredBy: userId,
        startedAt,
        completedAt: new Date(),
      },
    });

    await this.prisma.auditEvent.create({
      data: {
        actorUserId: userId,
        action: 'application.verification.run',
        resourceType: 'verification',
        resourceId: run.id,
        outcome: 'SUCCESS',
        metadata: {
          applicationId,
          kind,
          status: verdict.status,
          errors: verdict.counts.ERROR,
          warnings: verdict.counts.WARNING,
        },
      },
    });

    return run;
  }
}
