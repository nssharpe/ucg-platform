import { describe, it, expect } from 'vitest';
import {
  membershipFee,
  priceForAdding,
  offeredMembershipTypes,
  couponValid,
  applyCoupon,
} from '../src/lib/pricing';
import type { Coupon, Membership, Season } from '../src/lib/types';

const season: Season = {
  id: 's26', name: '2025–26', startsOn: '2025-07-01', endsOn: '2026-06-30',
  athleteFee: 35, coachFee: 20, clubFee: 109, active: true, current: true,
};

const mk = (type: 'athlete' | 'coach', status: Membership['status'] = 'active'): Membership => ({
  seasonId: 's26', type, status, waiverSignedAt: null, waiverSignedBy: null, paidVia: 'card',
});

describe('membership pricing', () => {
  it('charges base fees with no existing memberships', () => {
    expect(priceForAdding(season, 'athlete', [])).toBe(35);
    expect(priceForAdding(season, 'coach', [])).toBe(20);
  });

  it('adds coach to an existing athlete for $0', () => {
    expect(priceForAdding(season, 'coach', [mk('athlete')])).toBe(0);
  });

  it('adds athlete to an existing coach for the difference', () => {
    expect(priceForAdding(season, 'athlete', [mk('coach')])).toBe(15); // 35 - 20
  });

  it('floors the difference at 0 when coach fee exceeds athlete fee', () => {
    const s2 = { ...season, athleteFee: 15, coachFee: 20 };
    expect(priceForAdding(s2, 'athlete', [mk('coach')])).toBe(0);
  });

  it('does not re-charge for an already-active same-type membership', () => {
    expect(priceForAdding(season, 'athlete', [mk('athlete')])).toBe(0);
  });

  it('ignores memberships from other seasons', () => {
    const other: Membership = { ...mk('athlete'), seasonId: 's25' };
    expect(priceForAdding(season, 'coach', [other])).toBe(20);
  });

  it('membershipFee returns the right base', () => {
    expect(membershipFee(season, 'athlete')).toBe(35);
    expect(membershipFee(season, 'coach')).toBe(20);
  });
});

describe('offeredMembershipTypes', () => {
  it('reflects profile roles', () => {
    expect(offeredMembershipTypes({ athlete: true, coach: false })).toEqual(['athlete']);
    expect(offeredMembershipTypes({ athlete: false, coach: true })).toEqual(['coach']);
    expect(offeredMembershipTypes({ athlete: true, coach: true })).toEqual(['athlete', 'coach']);
    expect(offeredMembershipTypes({ athlete: false, coach: false })).toEqual([]);
  });
});

describe('coupon validity', () => {
  const base: Coupon = { code: 'X', amountOff: 5, appliesTo: 'any' };
  const now = '2026-06-18T12:00:00Z';

  it('valid with no constraints', () => {
    expect(couponValid(base, now)).toBe(true);
  });
  it('rejects before start', () => {
    expect(couponValid({ ...base, startsAt: '2026-07-01T00:00:00Z' }, now)).toBe(false);
  });
  it('rejects after end', () => {
    expect(couponValid({ ...base, endsAt: '2026-06-01T00:00:00Z' }, now)).toBe(false);
  });
  it('accepts inside the window', () => {
    expect(couponValid({ ...base, startsAt: '2026-06-01T00:00:00Z', endsAt: '2026-07-01T00:00:00Z' }, now)).toBe(true);
  });
  it('rejects when usage cap is reached', () => {
    expect(couponValid({ ...base, maxUses: 2, usedCount: 2 }, now)).toBe(false);
    expect(couponValid({ ...base, maxUses: 2, usedCount: 1 }, now)).toBe(true);
  });
  it('treats null maxUses as unlimited', () => {
    expect(couponValid({ ...base, maxUses: null, usedCount: 999 }, now)).toBe(true);
  });
});

describe('applyCoupon', () => {
  it('amount off, floored at 0', () => {
    expect(applyCoupon(35, { code: 'A', amountOff: 10, appliesTo: 'any' })).toBe(25);
    expect(applyCoupon(5, { code: 'A', amountOff: 10, appliesTo: 'any' })).toBe(0);
  });
  it('percent off', () => {
    expect(applyCoupon(40, { code: 'P', pctOff: 25, appliesTo: 'any' })).toBe(30);
  });
  it('no discount fields → unchanged', () => {
    expect(applyCoupon(40, { code: 'N', appliesTo: 'any' })).toBe(40);
  });
});
