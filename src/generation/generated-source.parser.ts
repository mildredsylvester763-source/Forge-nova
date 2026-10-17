import { UnprocessableEntityException } from '@nestjs/common';
import { z } from 'zod';
import { normalizeApplicationPath } from '../common/source/path-safety';

const generatedFileSchema = z.object({
  path: z.string().min(1).max(512),
  language: z.string().max(80).optional(),
  content: z.string().max(1_000_000),
}).strict();

const generatedSourceSchema = z.object({
  summary: z.string().trim().min(1).max(3000),
  files: z.array(generatedFileSchema).min(1).max(30),
}).strict();

export type ParsedGeneratedSource = z.infer<typeof generatedSourceSchema>;

export function parseGeneratedSource(text: string): ParsedGeneratedSource {
  const jsonText = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let decoded: unknown;
  try {
    decoded = JSON.parse(jsonText);
  } catch {
    throw new UnprocessableEntityException('The source generator did not return valid JSON; no source files were changed.');
  }

  const parsed = generatedSourceSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new UnprocessableEntityException({
      message: 'The source generator output did not match the required file-batch schema.',
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }

  const normalizedPaths = parsed.data.files.map((file) => normalizeApplicationPath(file.path));
  if (new Set(normalizedPaths).size !== normalizedPaths.length) {
    throw new UnprocessableEntityException('The source generator returned duplicate file paths.');
  }
  const totalBytes = parsed.data.files.reduce(
    (total, file) => total + Buffer.byteLength(file.content, 'utf8'),
    0,
  );
  if (totalBytes > 4_000_000) {
    throw new UnprocessableEntityException('The generated source batch exceeds the 4 MB output limit.');
  }

  return {
    ...parsed.data,
    files: parsed.data.files.map((file, index) => ({ ...file, path: normalizedPaths[index] })),
  };
}
