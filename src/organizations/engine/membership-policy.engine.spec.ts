import { canChangeMemberRole, canRemoveMember } from './membership-policy.engine';

describe('membership policy engine', () => {
  describe('role changes', () => {
    it('refuses assigning the OWNER role through a plain role change', () => {
      expect(canChangeMemberRole('DEVELOPER', 'OWNER', 1)).toEqual({
        allowed: false,
        refusal: 'membership.owner-assignment-requires-transfer',
      });
    });

    it('refuses demoting the only owner', () => {
      expect(canChangeMemberRole('OWNER', 'ADMIN', 1)).toEqual({
        allowed: false,
        refusal: 'membership.last-owner-protected',
      });
    });

    it('allows demoting an owner when another owner exists', () => {
      expect(canChangeMemberRole('OWNER', 'ADMIN', 2)).toEqual({ allowed: true });
    });

    it('allows ordinary non-owner role changes', () => {
      expect(canChangeMemberRole('DEVELOPER', 'ADMIN', 1)).toEqual({ allowed: true });
      expect(canChangeMemberRole('VIEWER', 'BILLING', 0)).toEqual({ allowed: true });
    });
  });

  describe('member removal', () => {
    it('refuses removing an owner directly', () => {
      expect(canRemoveMember('OWNER')).toEqual({
        allowed: false,
        refusal: 'membership.owner-removal-requires-transfer',
      });
    });

    it('allows removing any non-owner member', () => {
      expect(canRemoveMember('ADMIN')).toEqual({ allowed: true });
      expect(canRemoveMember('DEVELOPER')).toEqual({ allowed: true });
      expect(canRemoveMember('BILLING')).toEqual({ allowed: true });
      expect(canRemoveMember('VIEWER')).toEqual({ allowed: true });
    });
  });
});
