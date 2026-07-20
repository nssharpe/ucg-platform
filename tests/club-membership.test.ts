import { describe, it, expect, vi } from 'vitest';
import { clubHasActiveMembership, clubHasActiveMembershipForEvent, clubMembershipGateApplies, seasonForDate } from '../src/lib/capabilities-core';
import type { DB } from '../src/lib/types';

const db = {
  seasons: [
    { id: 's26', name: '2025–26', startsOn: '2025-07-01', endsOn: '2026-06-30', athleteFee: 35, coachFee: 20, clubFee: 109, active: true },
    { id: 's27', name: '2026–27', startsOn: '2026-07-01', endsOn: '2027-06-30', athleteFee: 40, coachFee: 20, clubFee: 109, active: true },
  ],
  clubMemberships: [
    { id: 'cm1', clubId: 'c1', seasonId: 's26', status: 'active', grantedByAdmin: true, createdAt: '2025-07-01' },
  ],
} as unknown as DB;

describe('club membership gate', () => {
  it('is active for a granted club + season', () => {
    expect(clubHasActiveMembership(db, 'c1', 's26')).toBe(true);
  });
  it('is inactive for a season the club has not purchased', () => {
    expect(clubHasActiveMembership(db, 'c1', 's27')).toBe(false);
  });
  it('is inactive for a different club', () => {
    expect(clubHasActiveMembership(db, 'c2', 's26')).toBe(false);
  });
  it('is inactive for null inputs', () => {
    expect(clubHasActiveMembership(db, null, 's26')).toBe(false);
    expect(clubHasActiveMembership(db, 'c1', null)).toBe(false);
  });
  it('stays inactive while only a club-membership cart line exists (not yet paid)', () => {
    // A club-membership purchase adds a cart line (kind:'membership', refType:'club')
    // but creates NO clubMemberships row until the cart is paid — so the gate must
    // remain false for that season.
    const pending = {
      seasons: db.seasons,
      clubMemberships: [], // nothing granted/paid yet
      carts: { c1: [{ id: 'ci1', label: 'club membership', amount: 109, kind: 'membership', refSeasonId: 's26', refType: 'club' }] },
    } as unknown as DB;
    expect(clubHasActiveMembership(pending, 'c1', 's26')).toBe(false);
  });
});

describe('club membership gate — camp carve-out (emv2 P2 T5, spec §G)', () => {
  it('gate applies to competitions (default/undefined eventType)', () => {
    expect(clubMembershipGateApplies(undefined)).toBe(true);
    expect(clubMembershipGateApplies('competition')).toBe(true);
  });
  it('gate is waived for camps', () => {
    expect(clubMembershipGateApplies('camp')).toBe(false);
  });
  it('clubHasActiveMembershipForEvent still gates a competition without an active club membership', () => {
    expect(clubHasActiveMembershipForEvent(db, 'c2', 's26', 'competition')).toBe(false);
    expect(clubHasActiveMembershipForEvent(db, 'c2', 's26', undefined)).toBe(false);
  });
  it('clubHasActiveMembershipForEvent passes a competition with an active club membership', () => {
    expect(clubHasActiveMembershipForEvent(db, 'c1', 's26', 'competition')).toBe(true);
  });
  it('clubHasActiveMembershipForEvent bypasses the club gate for a camp, even with no club membership at all', () => {
    expect(clubHasActiveMembershipForEvent(db, 'c2', 's26', 'camp')).toBe(true);
    expect(clubHasActiveMembershipForEvent(db, null, null, 'camp')).toBe(true);
  });
  it('the underlying clubHasActiveMembership (non-event-aware) is unaffected — still used for the club membership status card', () => {
    expect(clubHasActiveMembership(db, 'c2', 's26')).toBe(false);
  });
});

describe('seasonForDate', () => {
  it('maps a date into its season window', () => {
    expect(seasonForDate(db, '2026-07-31')).toBe('s27');
    expect(seasonForDate(db, '2025-09-01')).toBe('s26');
  });
  it('falls back to the current (P3: date-derived) season when no window matches', () => {
    // No stored `current` flag anymore — seasonForDate's fallback is
    // `currentSeasonId`, which derives from the real clock. Pin "today"
    // inside s26's window so the fallback is deterministic.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-09-01T00:00:00Z'));
    try {
      expect(seasonForDate(db, '2020-01-01')).toBe('s26');
    } finally {
      vi.useRealTimers();
    }
  });
});
