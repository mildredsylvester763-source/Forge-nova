import { IsIn } from 'class-validator';

/**
 * OWNER is deliberately absent: ownership moves only through the dedicated
 * ownership-transfer workflow, never through a role change.
 */
export const ASSIGNABLE_MEMBER_ROLES = ['ADMIN', 'DEVELOPER', 'BILLING', 'VIEWER'] as const;

export class ChangeMemberRoleDto {
  @IsIn(ASSIGNABLE_MEMBER_ROLES)
  role: (typeof ASSIGNABLE_MEMBER_ROLES)[number];
}
