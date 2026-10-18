import { IsArray, IsIn, IsOptional } from 'class-validator';

/**
 * The verification kinds that have honest, real implementations today.
 * BUILD and TEST execution does not exist yet, so it cannot be requested;
 * requesting it would imply an execution that never happens.
 */
export const VERIFIABLE_KINDS = ['STATIC_ANALYSIS', 'SECRET_SCAN', 'DEPENDENCY_AUDIT'] as const;
export type VerifiableKind = (typeof VERIFIABLE_KINDS)[number];

export class RunVerificationDto {
  @IsOptional()
  @IsArray()
  @IsIn(VERIFIABLE_KINDS as unknown as string[], { each: true })
  kinds?: VerifiableKind[];
}
