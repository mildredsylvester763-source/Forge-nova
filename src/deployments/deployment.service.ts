import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AccessControlService } from '../authorization/access-control.service';
import { PrismaService } from '../database/prisma.service';
import { SecretScannerService } from '../security/secret-scanner.service';
import { assessReadiness, ReadinessFile, ReadinessReport, ReadinessVerificationSummary } from './engine/readiness.engine';

const NO_ADAPTER_NOTE =
  'No deployment adapter is configured in this environment. GENESIS records the deployment intent and its readiness evidence; it does not claim execution.';

@Injectable()
export class DeploymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
    private readonly secretScanner: SecretScannerService,
  ) {}

  async getReadiness(userId: string, applicationId: string): Promise<ReadinessReport> {
    await this.access.requireApplicationRole(userId, applicationId, this.access.allRoles());
    const { report } = await this.buildReport(applicationId);
    return report;
  }

  async createDeployment(userId: string, applicationId: string, dto: { environment: string; target?: string; notes?: string }) {
    await this.access.requireApplicationRole(userId, applicationId, this.access.writeRoles());
    const { report, fileCount } = await this.buildReport(applicationId);

    if (report.verdict === 'BLOCKED') {
      throw new BadRequestException({
        statusCode: 400,
        message: 'Deployment blocked by readiness checks. Fix the failing checks before recording a deployment.',
        readiness: report,
      });
    }

    const deployment = await this.prisma.deployment.create({
      data: {
        applicationId,
        environment: dto.environment,
        provider: dto.target ?? null,
        status: report.verdict === 'READY' ? 'READY' : 'PENDING',
        metadata: {
          readiness: report,
          fileCount,
          adapter: 'none-configured',
          executionNote: NO_ADAPTER_NOTE,
          notes: dto.notes ?? null,
        } as unknown as Prisma.InputJsonValue,
      },
    });

    await this.prisma.auditEvent.create({
      data: {
        actorUserId: userId,
        action: 'application.deployment.record',
        resourceType: 'deployment',
        resourceId: deployment.id,
        outcome: 'SUCCESS',
        metadata: {
          applicationId,
          environment: dto.environment,
          verdict: report.verdict,
          adapter: 'none-configured',
        },
      },
    });

    return deployment;
  }

  async listForApplication(userId: string, applicationId: string) {
    await this.access.requireApplicationRole(userId, applicationId, this.access.allRoles());
    return this.prisma.deployment.findMany({
      where: { applicationId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  async findOne(userId: string, applicationId: string, deploymentId: string) {
    await this.access.requireApplicationRole(userId, applicationId, this.access.allRoles());
    const deployment = await this.prisma.deployment.findFirst({
      where: { id: deploymentId, applicationId },
    });
    if (!deployment) {
      throw new NotFoundException('Deployment not found.');
    }
    return deployment;
  }

  private async buildReport(
    applicationId: string,
  ): Promise<{ report: ReadinessReport; fileCount: number }> {
    const files = await this.prisma.applicationFile.findMany({
      where: { applicationId, isDeleted: false },
      select: { path: true, content: true },
      orderBy: { path: 'asc' },
    });

    const runs = await this.prisma.verificationRun.findMany({
      where: { applicationId },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: { kind: true, status: true },
    });
    const latestByKind = new Map<string, ReadinessVerificationSummary>();
    for (const run of runs) {
      if (!latestByKind.has(run.kind)) {
        latestByKind.set(run.kind, { kind: run.kind, status: run.status });
      }
    }

    let secretFindingCount = 0;
    for (const file of files) {
      const scanFile: ReadinessFile = { path: file.path, content: file.content };
      const findings = this.secretScanner.scan(scanFile.content);
      secretFindingCount += findings.length;
    }

    const report = assessReadiness(files, [...latestByKind.values()], secretFindingCount);
    return { report, fileCount: files.length };
  }
}
