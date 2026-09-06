import { describe, expect, it } from 'vitest';
import { upsertMembership } from '../src/lib/membership-upsert';
import type { Membership } from '../src/lib/types';

const m = (seasonId: string, status: Membership['status'], type?: Membership['type']): Membership =>
  ({ seasonId, status, waiverSignedAt: null, waiverSignedBy: null, ...(type ? { type } : {}) } as Membership);

describe('upsertMembership', () => {
  it('appends when no (season, type) row exists', () => {
    const list = [m('s1', 'active', 'athlete')];
    const out = upsertMembership(list, m('s2', 'pending-waiver', 'athlete'));
    expect(out).toHaveLength(2);
    expect(out[1].seasonId).toBe('s2');
    expect(list).toHaveLength(1); // never mutates the input
  });

  it('replaces the matching (season, type) row in place', () => {
    const list = [m('s1', 'active', 'athlete'), m('s1', 'active', 'coach')];
    const out = upsertMembership(list, m('s1', 'none', 'coach'));
    expect(out).toHaveLength(2);
    expect(out[0].status).toBe('active');
    expect(out[1]).toMatchObject({ seasonId: 's1', type: 'coach', status: 'none' });
  });

  it('treats a legacy row with no explicit type as athlete', () => {
    const list = [m('s1', 'active')];
    const out = upsertMembership(list, m('s1', 'pending-waiver', 'athlete'));
    expect(out).toHaveLength(1);
    expect(out[0].status).toBe('pending-waiver');
  });

  it('works from an empty list (a member with no memberships at all)', () => {
    expect(upsertMembership([], m('s1', 'pending-waiver', 'athlete'))).toHaveLength(1);
  });
});
