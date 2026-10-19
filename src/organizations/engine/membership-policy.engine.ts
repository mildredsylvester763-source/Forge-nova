export type MembershipRoleName = 'OWNER' | 'ADMIN' | 'DEVELOPER' | 'BILLING' | 'VIEWER';

export type MembershipPolicyRefusal =
  | 'membership.owner-assignment-requires-transfer'
  | 'membership.last-owner-protected'
  | 'membership.owner-removal-requires-transfer';

export type MembershipPolicyDecision =
  | { allowed: true }
  | { allowed: false; refusal: MembershipPolicyRefusal };

/**
 * Owner assignment is never a plain role change: it must go through the
 * dedicated ownership-transfer workflow so the organization can never end up
 * with zero owners.
 */
export function canChangeMemberRole(
  currentRole: MembershipRoleName,
  targetRole: MembershipRoleName,
  ownerCount: number,
): MembershipPolicyDecision {
  if (targetRole === 'OWNER') {
    return { allowed: false, refusal: 'membership.owner-assignment-requires-transfer' };
  }
  if (currentRole === 'OWNER' && ownerCount <= 1) {
    return { allowed: false, refusal: 'membership.last-owner-protected' };
  }
  return { allowed: true };
}

/**
 * An owner can never be removed as a member directly. Ownership must be
 * transferred away first; then the (now non-owner) membership can be removed.
 */
export function canRemoveMember(role: MembershipRoleName): MembershipPolicyDecision {
  if (role === 'OWNER') {
    return { allowed: false, refusal: 'membership.owner-removal-requires-transfer' };
  }
  return { allowed: true };
}
