import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ReferenceStatus } from '@prisma/client';
import { AiRouterService } from '../ai/ai-router.service';
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
import { CreateReferenceDto } from './dto/create-reference.dto';
import {
  buildExtractionSystemPrompt,
  buildExtractionUserPrompt,
  parseExtractionResult,
} from './engine/requirement-extraction.engine';
import { validateReferenceInput } from './engine/reference-input.engine';

const REFERENCE_SELECT = {
  id: true,
  applicationId: true,
  title: true,
  kind: true,
  status: true,
  extraction: true,
  extractionError: true,
  extractedAt: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
} as const;

@Injectable()
export class ReferencesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
    private readonly ai: AiRouterService,
    private readonly secrets: SecretScannerService,
    private readonly events: WebhookService,
  ) {}

  async create(userId: string, applicationId: string, dto: CreateReferenceDto) {
    const validated = this.validateReferenceInput(dto);
    this.secrets.assertNoSecrets(validated.content);
    await this.access.requireApplicationRole(userId, applicationId, this.access.writeRoles());
    return this.persistReference({ kind: 'user', userId }, applicationId, validated);
  }

  /**
   * Key-authenticated reference create. Grounded in the market leaders:
   * a GitHub fine-grained token with Contents write creates a file
   * inside the parent repository, and the OpenAI file create uploads
   * a document straight from a Bearer API key with an explicit
   * purpose. The key IS the authorization: the writable tenant bound
   * refuses foreign, missing, and archived applications with one
   * uniform 404, and the create lands in the audit trail exactly
   * once, attributed to the acting key.
   */
  async createForKey(key: AuthenticatedApiKey, applicationId: string, dto: CreateReferenceDto) {
    await this.access.requireApplicationInOrganization(key.organizationId, applicationId);
    const validated = this.validateReferenceInput(dto);
    this.secrets.assertNoSecrets(validated.content);
    return this.persistReference(keyActorFromApiKey(key), applicationId, validated);
  }

  /**
   * The input engine refuses by name; a refusal is a named 400, never
   * a raw engine error surfacing as a 500 on either surface.
   */
  private validateReferenceInput(dto: CreateReferenceDto) {
    try {
      return validateReferenceInput(dto);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Invalid reference input.');
    }
  }

  /**
   * The one create core shared by the JWT route and the genapi key
   * route, so the two surfaces can never drift apart: the same
   * validation, the same secret scan, the same honest audit row, and
   * the same reference.created event. A keyed create attributes to
   * the key creator and stamps the acting key into the audit trail;
   * a user create keeps its existing shape exactly.
   */
  private async persistReference(
    actor: WriteActor,
    applicationId: string,
    validated: ReturnType<typeof validateReferenceInput>,
  ) {
    const attributedUserId = actorAttribution(actor);

    const application = await this.prisma.application.findUnique({
      where: { id: applicationId },
      select: { id: true },
    });
    if (!application) {
      throw new NotFoundException('Application not found.');
    }

    // The application can be deleted after the guard ran: the honest
    // answer is the same uniform 404, never a raw foreign-key 500.
    const reference = await this.prisma.referenceDocument
      .create({
        data: {
          applicationId,
          title: validated.title,
          kind: validated.kind,
          content: validated.content,
          createdBy: attributedUserId,
        },
        select: REFERENCE_SELECT,
      })
      .catch((error: unknown) => {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') {
          throw new NotFoundException('Application not found.');
        }
        throw error;
      });

    await this.prisma.auditEvent.create({
      data: {
        actorUserId: attributedUserId,
        organizationId: actorAuditOrganization(actor),
        action: 'application.reference.create',
        resourceType: 'reference',
        resourceId: reference.id,
        outcome: 'SUCCESS',
        metadata: actorAuditMetadata(actor, { applicationId, kind: validated.kind }),
      },
    });

    await this.events.emitForApplication(applicationId, 'reference.created', {
      applicationId,
      referenceId: reference.id,
      kind: validated.kind,
      title: validated.title,
    });

    return reference;
  }

  /**
   * The one reference-listing core shared by the JWT route and the genapi
   * key route: newest first, capped at the honest window of 100, full
   * documents included because a read key may read what members read.
   */
  private listReferencesForApplication(applicationId: string) {
    return this.prisma.referenceDocument.findMany({
      where: { applicationId },
      select: { ...REFERENCE_SELECT, content: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  private async findReferenceInApplication(applicationId: string, referenceId: string) {
    const reference = await this.prisma.referenceDocument.findFirst({
      where: { id: referenceId, applicationId },
      select: { ...REFERENCE_SELECT, content: true },
    });
    if (!reference) {
      throw new NotFoundException('Reference not found.');
    }
    return reference;
  }

  async list(userId: string, applicationId: string) {
    await this.access.requireApplicationRole(userId, applicationId, this.access.allRoles());
    return this.listReferencesForApplication(applicationId);
  }

  /**
   * Key-authenticated reference listing. Foreign and missing applications
   * answer the same uniform 404; reads stay possible on archived
   * applications and never write audit rows.
   */
  async listForKey(key: AuthenticatedApiKey, applicationId: string) {
    await this.access.requireReadableApplicationInOrganization(key.organizationId, applicationId);
    return this.listReferencesForApplication(applicationId);
  }

  async findOne(userId: string, applicationId: string, referenceId: string) {
    await this.access.requireApplicationRole(userId, applicationId, this.access.allRoles());
    return this.findReferenceInApplication(applicationId, referenceId);
  }

  /**
   * Key-authenticated reference inspect. Foreign, cross-application, and
   * missing references all answer the same uniform 404 as the JWT route.
   */
  async getForKey(key: AuthenticatedApiKey, applicationId: string, referenceId: string) {
    await this.access.requireReadableApplicationInOrganization(key.organizationId, applicationId);
    return this.findReferenceInApplication(applicationId, referenceId);
  }

  async remove(userId: string, applicationId: string, referenceId: string) {
    await this.access.requireApplicationRole(userId, applicationId, this.access.writeRoles());
    const reference = await this.prisma.referenceDocument.findFirst({
      where: { id: referenceId, applicationId },
      select: { id: true, title: true, status: true },
    });
    if (!reference) {
      throw new NotFoundException('Reference not found.');
    }

    // Guarded delete: two members pressing delete at the same time must get
    // exactly one success and one clean 404 - never a raw Prisma P2025 as a 500.
    const deleted = await this.prisma.referenceDocument.deleteMany({
      where: { id: referenceId },
    });
    if (deleted.count !== 1) {
      throw new NotFoundException('Reference not found.');
    }
    await this.prisma.auditEvent.create({
      data: {
        actorUserId: userId,
        action: 'application.reference.delete',
        resourceType: 'reference',
        resourceId: referenceId,
        outcome: 'SUCCESS',
        metadata: { applicationId, title: reference.title, previousStatus: reference.status },
      },
    });
    return { deleted: true, id: referenceId };
  }

  /**
   * Runs AI requirement extraction over a stored reference. On any failure the
   * reference is marked EXTRACTION_FAILED with the recorded error; a later
   * extract call can retry. No requirement is ever invented or padded.
   */
  async extract(userId: string, applicationId: string, referenceId: string, jobId?: string) {
    await this.access.requireApplicationRole(userId, applicationId, this.access.writeRoles());
    const reference = await this.prisma.referenceDocument.findFirst({
      where: { id: referenceId, applicationId },
      select: { id: true, title: true, kind: true, content: true },
    });
    if (!reference) {
      throw new NotFoundException('Reference not found.');
    }

    try {
      const result = await this.ai.complete({
        applicationId,
        jobId,
        operationId: `reference-extraction:${reference.id}:${Date.now()}`,
        systemPrompt: buildExtractionSystemPrompt(),
        userPrompt: buildExtractionUserPrompt(reference.title, reference.kind, reference.content),
        maxOutputTokens: 4000,
        allowFallback: true,
      });

      const extracted = parseExtractionResult(result.text);
      this.secrets.assertNoSecrets(JSON.stringify(extracted));

      const updated = await this.prisma.referenceDocument.update({
        where: { id: reference.id },
        data: {
          status: ReferenceStatus.EXTRACTED,
          extraction: {
            summary: extracted.summary,
            requirements: extracted.requirements,
            openQuestions: extracted.openQuestions,
            provider: result.provider,
            model: result.model,
          } as unknown as Prisma.InputJsonValue,
          extractionError: null,
          extractedAt: new Date(),
        },
        select: REFERENCE_SELECT,
      })
        .catch((error: unknown) => {
          // The reference may have been deleted while extraction was running;
          // that is an honest 404, never a raw Prisma P2025 as a 500.
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
            throw new NotFoundException('Reference not found.');
          }
          throw error;
        });

      await this.prisma.auditEvent.create({
        data: {
          actorUserId: userId,
          action: 'application.reference.extract',
          resourceType: 'reference',
          resourceId: reference.id,
          outcome: 'SUCCESS',
          metadata: {
            applicationId,
            requirementCount: extracted.requirements.length,
            openQuestionCount: extracted.openQuestions.length,
          },
        },
      });

      return updated;
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 500) : 'Unknown extraction failure.';
      const marked = await this.prisma.referenceDocument.updateMany({
        where: { id: reference.id },
        data: {
          status: ReferenceStatus.EXTRACTION_FAILED,
          extractionError: reason,
        },
      });
      if (marked.count === 0) {
        // The reference vanished (e.g. deleted mid-extraction): an honest 404.
        throw new NotFoundException('Reference not found.');
      }
      throw error instanceof Error ? error : new BadRequestException(reason);
    }
  }
}
