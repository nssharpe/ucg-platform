import { describe, it, expect } from 'vitest';
import { clubHasActiveMembership, seasonForDate } from '../src/lib/capabilities-core';
import type { DB } from '../src/lib/types';

const db = {
  seasons: [
    { id: 's26', name: '2025–26', startsOn: '2025-07-01', endsOn: '2026-06-30', athleteFee: 35, coachFee: 20, clubFee: 109, active: true, current: true },
    { id: 's27', name: '2026–27', startsOn: '2026-07-01', endsOn: '2027-06-30', athleteFee: 40, coachFee: 20, clubFee: 109, active: true, current: false },
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

describe('seasonForDate', () => {
  it('maps a date into its season window', () => {
    expect(seasonForDate(db, '2026-07-31')).toBe('s27');
    expect(seasonForDate(db, '2025-09-01')).toBe('s26');
  });
  it('falls back to the current season when no window matches', () => {
    expect(seasonForDate(db, '2020-01-01')).toBe('s26');
  });
});
