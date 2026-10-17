import { BadRequestException, Injectable } from '@nestjs/common';
import { JobType, Prisma, WorkJob } from '@prisma/client';
import { AiRouterService } from '../ai/ai-router.service';
import { AccessControlService } from '../authorization/access-control.service';
import { PrismaService } from '../database/prisma.service';
import { ApplicationSourceService } from '../files/application-source.service';
import { SecretScannerService } from '../security/secret-scanner.service';
import { ExecutionJobHandler } from '../workers/execution-job-handler.interface';
import { parseGeneratedSource } from './generated-source.parser';

const MAX_CONTEXT_FILES = 30;
const MAX_CONTEXT_BYTES = 60_000;

@Injectable()
export class CodeGenerationJobHandler implements ExecutionJobHandler {
  readonly type = JobType.CODE_GENERATION;

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessControlService,
    private readonly ai: AiRouterService,
    private readonly source: ApplicationSourceService,
    private readonly secrets: SecretScannerService,
  ) {}

  async execute(job: WorkJob, signal: AbortSignal): Promise<Prisma.InputJsonValue> {
    const value = job.input;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new BadRequestException('Code-generation job payload must be an object.');
    }
    const input = value as Record<string, unknown>;
    if (
      input.task !== 'GENERATE_SOURCE_FILES' ||
      typeof input.prompt !== 'string' ||
      typeof input.requestedBy !== 'string'
    ) {
      throw new BadRequestException('Code-generation job payload is invalid.');
    }

    const userId = input.requestedBy;
    const prompt = input.prompt;
    this.secrets.assertNoSecrets(prompt);
    await this.access.requireApplicationRole(userId, job.applicationId, this.access.writeRoles());

    const application = await this.prisma.application.findUnique({
      where: { id: job.applicationId },
      select: {
        id: true,
        name: true,
        description: true,
        framework: true,
        runtime: true,
        status: true,
        project: { select: { name: true, description: true } },
      },
    });
    if (!application) throw new BadRequestException('The target application no longer exists.');

    const existingFiles = await this.prisma.applicationFile.findMany({
      where: { applicationId: job.applicationId, isDeleted: false },
      select: { path: true, language: true, content: true, revision: true },
      orderBy: { path: 'asc' },
      take: MAX_CONTEXT_FILES + 1,
    });
    if (existingFiles.length > MAX_CONTEXT_FILES) {
      throw new BadRequestException(
        'This source-generation pass supports up to 30 existing files. Use a narrower change or implement repository-aware context retrieval first.',
      );
    }
    const contextBytes = existingFiles.reduce(
      (total, file) => total + Buffer.byteLength(file.content, 'utf8'),
      0,
    );
    if (contextBytes > MAX_CONTEXT_BYTES) {
      throw new BadRequestException(
        'Existing source context exceeds the safe initial context limit. A targeted context-selection pass is required.',
      );
    }

    const context = {
      application: {
        name: application.name,
        description: application.description,
        framework: application.framework,
        runtime: application.runtime,
        status: application.status,
      },
      project: application.project,
      existingFiles: existingFiles.map(({ path, language, content }) => ({ path, language, content })),
    };
    const systemPrompt = [
      'You are GENESIS Source Generation Engine, part of a full-stack software factory.',
      'Return only one JSON object with this exact shape: {"summary":"what changed","files":[{"path":"relative/path","language":"optional language","content":"complete file contents"}]}.',
      'Do not use markdown fences, commentary, or additional top-level fields.',
      'Return 1–40 complete files. Every file must be a complete replacement, not a diff or ellipsis.',
      'Preserve unrelated existing files: only include files that must be created or changed for the request.',
      'Use the application context and current files as the source of truth. Do not silently remove existing capabilities.',
      'Do not write .env, private keys, API credentials, real tokens, node_modules, or .git content. Use environment-variable references and safe example placeholders instead.',
      'Do not claim that code was built, tested, security-scanned, or deployed. This job only writes validated source files.',
      'Prefer maintainable, typed code, clear module boundaries, input validation, least privilege, and explicit error handling.',
      'If the request is ambiguous, make conservative assumptions and document them in the summary rather than inventing external access or credentials.',
    ].join('\n');

    const result = await this.ai.complete({
      applicationId: job.applicationId,
      jobId: job.id,
      operationId: `source-generation:${job.id}:attempt-${job.attemptCount}`,
      systemPrompt: systemPrompt,
      userPrompt: [
        'User request:',
        prompt,
        '',
        'Application and current source context (JSON):',
        JSON.stringify(context),
      ].join('\n'),
      maxOutputTokens: 12000,
      allowFallback: true,
      signal,
    });

    if (signal.aborted) {
      throw new BadRequestException('Source generation was cancelled before persistence.');
    }

    const generated = parseGeneratedSource(result.text);
    this.secrets.assertNoSecrets(JSON.stringify(generated));
    if (signal.aborted) throw new BadRequestException('Source generation was cancelled before file persistence.');
    const expectedRevisions = Object.fromEntries(
      existingFiles.map((file) => [file.path, file.revision]),
    );
    const applied = await this.source.applyGeneratedBatch(
      userId,
      job.applicationId,
      generated.files,
      expectedRevisions,
    );

    return {
      applicationId: job.applicationId,
      summary: generated.summary,
      filesApplied: applied.filesApplied,
      files: applied.files,
      sourcePersisted: true,
      buildVerification: 'NOT_RUN',
      deploymentStatus: 'NOT_DEPLOYED',
    } as Prisma.InputJsonValue;
  }
}
