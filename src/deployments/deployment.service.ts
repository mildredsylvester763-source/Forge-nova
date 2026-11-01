import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuthenticatedApiKey } from '../api-keys/api-key.guard';
import {
  WriteActor,
  actorAttribution,
  actorAuditMetadata,
  actorAuditOrganization,
  keyActorFromApiKey,
} from '../api-keys/engine/api-key-policy';
import { AccessControlService } from '../authorization/access-control.service';
import { PrismaService } from '../database/prisma.service';
import { WebhookService } from '../integrations/webhook.service';
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
    private readonly events: WebhookService,
  ) {}

  async getReadiness(userId: string, applicationId: string): Promise<ReadinessReport> {
    await this.access.requireApplicationRole(userId, applicationId, this.access.allRoles());
    const { report } = await this.buildReport(applicationId);
    return report;
  }

  /**
   * Key-authenticated readiness report. Grounded in the GitHub
   * deployments read surface: reading deployments and their statuses
   * needs only read access, so the report never writes an audit row
   * and stays available on archived applications.
   */
  async getReadinessForKey(key: AuthenticatedApiKey, applicationId: string): Promise<ReadinessReport> {
    await this.access.requireReadableApplicationInOrganization(key.organizationId, applicationId);
    const { report } = await this.buildReport(applicationId);
    return report;
  }

  async createDeployment(userId: string, applicationId: string, dto: { environment: string; target?: string; notes?: string }) {
    await this.access.requireApplicationRole(userId, applicationId, this.access.writeRoles());
    return this.createForActor({ kind: 'user', userId }, applicationId, dto);
  }

  /**
   * Key-authenticated deployment create. Grounded in the GitHub
   * create-a-deployment REST surface, where a fine-grained token
   * needs the Deployments repository permission set to write,
   * never read: the writable tenant bound refuses foreign, missing,
   * and archived applications with one uniform 404, the readiness
   * gate answers BLOCKED with the same honest 400 report as the JWT
   * route, and the landed intent lands in the audit trail exactly
   * once, stamped via genapi with the acting key.
   */
  async createDeploymentForKey(
    key: AuthenticatedApiKey,
    applicationId: string,
    dto: { environment: string; target?: string; notes?: string },
  ) {
    await this.access.requireApplicationInOrganization(key.organizationId, applicationId);
    return this.createForActor(keyActorFromApiKey(key), applicationId, dto);
  }

  /**
   * The one create core shared by the JWT route and the genapi key
   * route, so the two surfaces can never drift apart: the same
   * readiness gate with the same honest BLOCKED refusal, the same
   * none-configured adapter disclaimer, the same audit row law, and
   * the same deployment.recorded event. A keyed create attributes
   * to the key creator and stamps the acting key into the trail;
   * a user create keeps its existing row shape exactly.
   */
  private async createForActor(
    actor: WriteActor,
    applicationId: string,
    dto: { environment: string; target?: string; notes?: string },
  ) {
    const attributedUserId = actorAttribution(actor);
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
        actorUserId: attributedUserId,
        organizationId: actorAuditOrganization(actor),
        action: 'application.deployment.record',
        resourceType: 'deployment',
        resourceId: deployment.id,
        outcome: 'SUCCESS',
        metadata: actorAuditMetadata(actor, {
          applicationId,
          environment: dto.environment,
          verdict: report.verdict,
          adapter: 'none-configured',
        }),
      },
    });

    await this.events.emitForApplication(applicationId, 'deployment.recorded', {
      applicationId,
      deploymentId: deployment.id,
      environment: dto.environment,
      verdict: report.verdict,
    });

    return deployment;
  }

  async listForApplication(userId: string, applicationId: string) {
    await this.access.requireApplicationRole(userId, applicationId, this.access.allRoles());
    return this.listDeploymentsForApplication(applicationId);
  }

  /**
   * The one deployment-listing core shared by the JWT route and the
   * genapi key route: newest first, capped at 50, never padded.
   */
  private listDeploymentsForApplication(applicationId: string) {
    return this.prisma.deployment.findMany({
      where: { applicationId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  /**
   * Key-authenticated deployment listing with parity against the JWT
   * route. Reading needs only read access, like the GitHub deployment
   * listing, and there is no audit row for reads.
   */
  async listForKey(key: AuthenticatedApiKey, applicationId: string) {
    await this.access.requireReadableApplicationInOrganization(key.organizationId, applicationId);
    return this.listDeploymentsForApplication(applicationId);
  }

  async findOne(userId: string, applicationId: string, deploymentId: string) {
    await this.access.requireApplicationRole(userId, applicationId, this.access.allRoles());
    return this.findDeploymentInApplication(applicationId, deploymentId);
  }

  /**
   * The one deployment-inspect core shared by both surfaces: the
   * deployment must belong to the named application, and foreign,
   * cross-application, and unknown ids all answer one uniform 404.
   */
  private async findDeploymentInApplication(applicationId: string, deploymentId: string) {
    const deployment = await this.prisma.deployment.findFirst({
      where: { id: deploymentId, applicationId },
    });
    if (!deployment) {
      throw new NotFoundException('Deployment not found.');
    }
    return deployment;
  }

  /**
   * Key-authenticated deployment inspect with the same uniform 404 as
   * the JWT route, so the two surfaces can never drift apart.
   */
  async getForKey(key: AuthenticatedApiKey, applicationId: string, deploymentId: string) {
    await this.access.requireReadableApplicationInOrganization(key.organizationId, applicationId);
    return this.findDeploymentInApplication(applicationId, deploymentId);
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
