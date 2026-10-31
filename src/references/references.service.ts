import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, ReferenceStatus } from '@prisma/client';
import { AiRouterService } from '../ai/ai-router.service';
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
    const validated = validateReferenceInput(dto);
    this.secrets.assertNoSecrets(validated.content);
    await this.access.requireApplicationRole(userId, applicationId, this.access.writeRoles());

    const application = await this.prisma.application.findUnique({
      where: { id: applicationId },
      select: { id: true },
    });
    if (!application) {
      throw new NotFoundException('Application not found.');
    }

    const reference = await this.prisma.referenceDocument.create({
      data: {
        applicationId,
        title: validated.title,
        kind: validated.kind,
        content: validated.content,
        createdBy: userId,
      },
      select: REFERENCE_SELECT,
    });

    await this.prisma.auditEvent.create({
      data: {
        actorUserId: userId,
        action: 'application.reference.create',
        resourceType: 'reference',
        resourceId: reference.id,
        outcome: 'SUCCESS',
        metadata: { applicationId, kind: validated.kind },
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

  async list(userId: string, applicationId: string) {
    await this.access.requireApplicationRole(userId, applicationId, this.access.allRoles());
    return this.prisma.referenceDocument.findMany({
      where: { applicationId },
      select: { ...REFERENCE_SELECT, content: true },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async findOne(userId: string, applicationId: string, referenceId: string) {
    await this.access.requireApplicationRole(userId, applicationId, this.access.allRoles());
    const reference = await this.prisma.referenceDocument.findFirst({
      where: { id: referenceId, applicationId },
      select: { ...REFERENCE_SELECT, content: true },
    });
    if (!reference) {
      throw new NotFoundException('Reference not found.');
    }
    return reference;
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
