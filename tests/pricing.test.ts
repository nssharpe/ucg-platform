import { describe, it, expect } from 'vitest';
import {
  membershipFee,
  priceForAdding,
  priceForTypes,
  offeredMembershipTypes,
  couponValid,
  applyCoupon,
  newRegistrationEntryTotal,
  reassignPartners,
  syncSynchroPartnerLevel,
} from '../src/lib/pricing';
import type { PartnerReg, RegFeeEvent, SynchroReg } from '../src/lib/pricing';
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

describe('priceForTypes (combined selection)', () => {
  it('charges the single fee for one type', () => {
    expect(priceForTypes(season, ['athlete'], [])).toBe(35);
    expect(priceForTypes(season, ['coach'], [])).toBe(20);
  });

  it('charges the HIGHER fee for both together, not the sum', () => {
    expect(priceForTypes(season, ['athlete', 'coach'], [])).toBe(35); // not 55
  });

  it('credits an existing athlete so adding coach is $0', () => {
    expect(priceForTypes(season, ['athlete', 'coach'], [mk('athlete')])).toBe(0);
  });

  it('credits an existing coach so adding athlete costs the difference', () => {
    expect(priceForTypes(season, ['athlete', 'coach'], [mk('coach')])).toBe(15); // 35 - 20
  });

  it('returns 0 when everything selected is already active', () => {
    expect(priceForTypes(season, ['athlete', 'coach'], [mk('athlete'), mk('coach')])).toBe(0);
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

  describe('hard expiration when scoped to a specific event', () => {
    const eventScoped: Coupon = { ...base, appliesTo: 'meet-entry', appliesToEventId: 'evt-1' };

    it('stays valid through the end of the event day, even with a far-future endsAt', () => {
      expect(couponValid(
        { ...eventScoped, endsAt: '2027-01-01T00:00:00Z' },
        '2026-06-20T23:00:00Z',
        '2026-06-20',
      )).toBe(true);
    });
    it('hard-expires the day after the event ends, regardless of endsAt', () => {
      expect(couponValid(
        { ...eventScoped, endsAt: '2027-01-01T00:00:00Z' },
        '2026-06-22T00:00:00Z',
        '2026-06-20',
      )).toBe(false);
    });
    it('ignores the event date when the coupon is not scoped to that event', () => {
      // appliesTo === 'any', so appliesToEventId (if any) is irrelevant.
      expect(couponValid({ ...base }, '2026-06-22T00:00:00Z', '2026-06-20')).toBe(true);
    });
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

describe('newRegistrationEntryTotal (3f/3g host-club $0)', () => {
  const event: RegFeeEvent = { hostClubId: 'host', entryFee: 60, secondDisciplineFee: 25 };

  it('host club pays $0 for any number of disciplines', () => {
    expect(newRegistrationEntryTotal(event, { competingClubId: 'host', priorDisciplineCount: 0, newDisciplineCount: 1 })).toBe(0);
    expect(newRegistrationEntryTotal(event, { competingClubId: 'host', priorDisciplineCount: 0, newDisciplineCount: 3 })).toBe(0);
    expect(newRegistrationEntryTotal(event, { competingClubId: 'host', priorDisciplineCount: 2, newDisciplineCount: 1 })).toBe(0);
  });

  it('non-host: first discipline = entry fee, additional = second-discipline fee', () => {
    expect(newRegistrationEntryTotal(event, { competingClubId: 'other', priorDisciplineCount: 0, newDisciplineCount: 1 })).toBe(60);
    expect(newRegistrationEntryTotal(event, { competingClubId: 'other', priorDisciplineCount: 0, newDisciplineCount: 2 })).toBe(85);
    expect(newRegistrationEntryTotal(event, { competingClubId: 'other', priorDisciplineCount: 0, newDisciplineCount: 3 })).toBe(110);
  });

  it('non-host: a discipline added when others already exist is a second discipline', () => {
    expect(newRegistrationEntryTotal(event, { competingClubId: 'other', priorDisciplineCount: 1, newDisciplineCount: 1 })).toBe(25);
    expect(newRegistrationEntryTotal(event, { competingClubId: 'other', priorDisciplineCount: 2, newDisciplineCount: 2 })).toBe(50);
  });

  it('zero new disciplines = $0', () => {
    expect(newRegistrationEntryTotal(event, { competingClubId: 'other', priorDisciplineCount: 0, newDisciplineCount: 0 })).toBe(0);
  });
});

describe('reassignPartners (synchro swap, 3e)', () => {
  const reg = (id: string, athleteId: string, partner?: string | null): PartnerReg =>
    ({ id, athleteId, partnerAthleteId: partner ?? null });

  it('repoints a partner that named the swapped-out athlete', () => {
    const regs = [
      reg('r1', 'a1'),               // swapped-out athlete's own reg
      reg('r3', 'a3', 'a1'),          // a3 named a1 as partner → must become a2
      reg('r4', 'a4', 'a9'),          // unrelated partner → untouched
      reg('r5', 'a5'),                // no partner → untouched
    ];
    const out = reassignPartners(regs, 'a1', 'a2');
    expect(out).toEqual([{ id: 'r3', athleteId: 'a3', partnerAthleteId: 'a2' }]);
  });

  it('does not touch the swapped athletes own rows', () => {
    // a1's reg points at itself somehow / a2 already present — never returned.
    const regs = [reg('r1', 'a1', 'a1'), reg('r2', 'a2', 'a1')];
    expect(reassignPartners(regs, 'a1', 'a2')).toEqual([]);
  });

  it('is a no-op when from === to', () => {
    expect(reassignPartners([reg('r3', 'a3', 'a1')], 'a1', 'a1')).toEqual([]);
  });

  it('returns shallow copies, leaving the input untouched', () => {
    const r = reg('r3', 'a3', 'a1');
    const out = reassignPartners([r], 'a1', 'a2');
    expect(r.partnerAthleteId).toBe('a1'); // original unchanged
    expect(out[0].partnerAthleteId).toBe('a2');
    expect(out[0]).not.toBe(r);
  });
});

describe('syncSynchroPartnerLevel (B4.4 — first-to-select sets the level for both)', () => {
  const syReg = (athleteId: string, level: string | undefined, partner: string | null = null): SynchroReg => ({
    athleteId,
    apparatus: ['SY'],
    ...(level ? { apparatusLevels: { SY: level } } : {}),
    partnerAthleteId: partner,
  });

  it('A selects B (High Flyer) — B (previously Novice Flyer) syncs to High Flyer', () => {
    const existing = [syReg('b', 'novice-flyer')];
    const saved = syReg('a', 'high-flyer', 'b');
    const out = syncSynchroPartnerLevel(existing, saved);
    expect(out?.apparatusLevels?.SY).toBe('high-flyer');
    expect(out?.athleteId).toBe('b');
  });

  it('does nothing if the partner has no existing SY registration yet', () => {
    const out = syncSynchroPartnerLevel([], syReg('a', 'high-flyer', 'b'));
    expect(out).toBeNull();
  });

  it('does nothing if the levels already match', () => {
    const existing = [syReg('b', 'high-flyer')];
    const out = syncSynchroPartnerLevel(existing, syReg('a', 'high-flyer', 'b'));
    expect(out).toBeNull();
  });

  it('does nothing if the saved reg has no partner named', () => {
    const existing = [syReg('b', 'novice-flyer')];
    const out = syncSynchroPartnerLevel(existing, syReg('a', 'high-flyer', null));
    expect(out).toBeNull();
  });

  it('does nothing if the saved reg does not include SY', () => {
    const existing = [syReg('b', 'novice-flyer')];
    const saved: SynchroReg = { athleteId: 'a', apparatus: ['TR'], apparatusLevels: { TR: 'high-flyer' }, partnerAthleteId: 'b' };
    expect(syncSynchroPartnerLevel(existing, saved)).toBeNull();
  });

  it("preserves the partner's OTHER apparatus levels, only touching SY", () => {
    const existing = [{ athleteId: 'b', apparatus: ['SY', 'TR'], apparatusLevels: { SY: 'novice-flyer', TR: 'intermediate-flyer' }, partnerAthleteId: null }];
    const out = syncSynchroPartnerLevel(existing, syReg('a', 'high-flyer', 'b'));
    expect(out?.apparatusLevels).toEqual({ SY: 'high-flyer', TR: 'intermediate-flyer' });
  });
});
