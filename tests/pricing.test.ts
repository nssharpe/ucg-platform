import { describe, it, expect } from 'vitest';
import {
  membershipFee,
  priceForAdding,
  priceForTypes,
  offeredMembershipTypes,
  couponValid,
  applyCoupon,
  couponEligibleLine,
  newRegistrationEntryTotal,
  reassignPartners,
  syncSynchroPartnerLevel,
  addonConfig,
  addonPrice,
  addonPurchaseOpen,
  initialAddonDraft,
  addonDraftValid,
  buildAddonCartItems,
  anyAddonWindowOpen,
  initialClubAddonDraft,
  buildClubAddonCartItems,
  campSurveyQuestionsOf,
  campSurveyAnswersValid,
  campSurveyToStored,
  campSurveySummary,
  campSurveyAnswerLabel,
  refundAmountCents,
  capRefundCents,
  allocateRegistrationRefund,
  decideAfterConflict,
  shrinkOrDropCartLines,
  diffCartLinePrices,
} from '../src/lib/pricing';
import type { AddonPricingEvent, AddonDraftEvent, ClubAddonDraftEvent, PartnerReg, RegFeeEvent, SynchroReg } from '../src/lib/pricing';
import type { CampSurveyQuestion, CartItem, Coupon, Membership, Season } from '../src/lib/types';

const season: Season = {
  id: 's26', name: '2025–26', startsOn: '2025-07-01', endsOn: '2026-06-30',
  athleteFee: 35, coachFee: 20, clubFee: 109, active: true,
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

describe('couponEligibleLine (UAT M-11-01)', () => {
  const entryLine = { scope: 'meet-entry' as const, eventId: 'evt-1' };
  const changeFeeLine = { scope: 'change-fee' as const, eventId: 'evt-1' };
  const addonLine = { scope: 'addon' as const, eventId: 'evt-1' };
  const membershipLine = { scope: 'athlete-membership' as const };

  it('a meet-entry coupon is eligible for a true entry line', () => {
    expect(couponEligibleLine(entryLine, { appliesTo: 'meet-entry' })).toBe(true);
  });
  it('a meet-entry coupon is NOT eligible for a change-fee line', () => {
    expect(couponEligibleLine(changeFeeLine, { appliesTo: 'meet-entry' })).toBe(false);
  });
  it('a meet-entry coupon is NOT eligible for an addon line', () => {
    expect(couponEligibleLine(addonLine, { appliesTo: 'meet-entry' })).toBe(false);
  });
  it('a meet-entry coupon is NOT eligible for a membership line', () => {
    expect(couponEligibleLine(membershipLine, { appliesTo: 'meet-entry' })).toBe(false);
  });
  it('an "any" coupon is eligible for every line, regardless of scope', () => {
    for (const line of [entryLine, changeFeeLine, addonLine, membershipLine]) {
      expect(couponEligibleLine(line, { appliesTo: 'any' })).toBe(true);
    }
  });
  it('a "membership" coupon matches all three membership scopes, never entry/change-fee/addon', () => {
    expect(couponEligibleLine({ scope: 'athlete-membership' }, { appliesTo: 'membership' })).toBe(true);
    expect(couponEligibleLine({ scope: 'club-membership' }, { appliesTo: 'membership' })).toBe(true);
    expect(couponEligibleLine({ scope: 'coach-membership' }, { appliesTo: 'membership' })).toBe(true);
    expect(couponEligibleLine(entryLine, { appliesTo: 'membership' })).toBe(false);
    expect(couponEligibleLine(changeFeeLine, { appliesTo: 'membership' })).toBe(false);
    expect(couponEligibleLine(addonLine, { appliesTo: 'membership' })).toBe(false);
  });
  it('a meet-entry coupon scoped to one event does not match an entry line for a different event', () => {
    expect(couponEligibleLine(entryLine, { appliesTo: 'meet-entry', appliesToEventId: 'evt-2' })).toBe(false);
    expect(couponEligibleLine(entryLine, { appliesTo: 'meet-entry', appliesToEventId: 'evt-1' })).toBe(true);
    expect(couponEligibleLine(entryLine, { appliesTo: 'meet-entry', appliesToEventId: null })).toBe(true);
  });
  it('a fine-grained membership coupon matches only its own exact scope', () => {
    expect(couponEligibleLine({ scope: 'club-membership' }, { appliesTo: 'club-membership' })).toBe(true);
    expect(couponEligibleLine({ scope: 'athlete-membership' }, { appliesTo: 'club-membership' })).toBe(false);
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

  // PM feedback 2026-07-22: UCG-hosted events can have hostClubId === '' (no
  // host club resolved). An unaffiliated athlete's competingClubId also
  // defaults to '' (e.g. camp registration, which waives the club-membership
  // gate) — that must NOT coincidentally match and waive the fee.
  it('an empty competingClubId never matches an empty (unresolved) hostClubId', () => {
    const hostless: RegFeeEvent = { hostClubId: '', entryFee: 60, secondDisciplineFee: 25 };
    expect(newRegistrationEntryTotal(hostless, { competingClubId: '', priorDisciplineCount: 0, newDisciplineCount: 1 })).toBe(60);
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

describe('per-unit add-on pricing (emv2 P2)', () => {
  const event: AddonPricingEvent = {
    tshirtAddon: { price: 20 },
    bannerAddon: { price: 15, lastPurchaseAt: '2026-08-01T00:00:00Z' },
    banquet: { price: 40 },
    campConfig: { leoAddon: { price: 60 } },
  };
  const regCloses = '2026-07-01T00:00:00Z';

  describe('addonPrice / addonConfig', () => {
    it('prices each configured type', () => {
      expect(addonPrice(event, 'tshirt')).toBe(20);
      expect(addonPrice(event, 'banner')).toBe(15);
      expect(addonPrice(event, 'banquet')).toBe(40);
      expect(addonPrice(event, 'leo')).toBe(60);
    });

    it('returns null (never 0) for an unconfigured type', () => {
      const bare: AddonPricingEvent = {};
      expect(addonPrice(bare, 'tshirt')).toBeNull();
      expect(addonPrice(bare, 'banquet')).toBeNull();
      expect(addonPrice(bare, 'leo')).toBeNull();
    });

    it('returns null for an unknown line type', () => {
      expect(addonPrice(event, 'not-a-real-type')).toBeNull();
      expect(addonPrice(event, null)).toBeNull();
    });

    it('leo is only priced when nested under campConfig', () => {
      const noCamp: AddonPricingEvent = { tshirtAddon: { price: 20 } };
      expect(addonPrice(noCamp, 'leo')).toBeNull();
    });

    it('addonConfig returns the full config object', () => {
      expect(addonConfig(event, 'banner')).toEqual({ price: 15, lastPurchaseAt: '2026-08-01T00:00:00Z' });
      expect(addonConfig(event, 'tshirt')).toEqual({ price: 20 });
    });
  });

  describe('addonPurchaseOpen', () => {
    it('is open before regCloses when no lastPurchaseAt is set', () => {
      expect(addonPurchaseOpen(event.tshirtAddon, regCloses, new Date('2026-06-01T00:00:00Z'))).toBe(true);
    });

    it('is closed after regCloses when no lastPurchaseAt is set', () => {
      expect(addonPurchaseOpen(event.tshirtAddon, regCloses, new Date('2026-07-02T00:00:00Z'))).toBe(false);
    });

    it('is open exactly AT regCloses (boundary, no lastPurchaseAt)', () => {
      expect(addonPurchaseOpen(event.tshirtAddon, regCloses, new Date(regCloses))).toBe(true);
    });

    it('stays open past regCloses when lastPurchaseAt is set later', () => {
      // banner's lastPurchaseAt (2026-08-01) is AFTER regCloses (2026-07-01).
      expect(addonPurchaseOpen(event.bannerAddon, regCloses, new Date('2026-07-15T00:00:00Z'))).toBe(true);
    });

    it('closes at its own lastPurchaseAt even though that is after regCloses', () => {
      expect(addonPurchaseOpen(event.bannerAddon, regCloses, new Date('2026-08-02T00:00:00Z'))).toBe(false);
    });

    it('is open exactly AT its own lastPurchaseAt (boundary)', () => {
      expect(addonPurchaseOpen(event.bannerAddon, regCloses, new Date(event.bannerAddon!.lastPurchaseAt!))).toBe(true);
    });

    it('an EARLIER lastPurchaseAt than regCloses still governs (deadline can tighten, not just extend)', () => {
      const tight = { price: 10, lastPurchaseAt: '2026-06-01T00:00:00Z' };
      expect(addonPurchaseOpen(tight, regCloses, new Date('2026-06-15T00:00:00Z'))).toBe(false);
      expect(addonPurchaseOpen(tight, regCloses, new Date('2026-05-15T00:00:00Z'))).toBe(true);
    });

    it('treats an unconfigured add-on (undefined config) as governed by regCloses alone', () => {
      expect(addonPurchaseOpen(undefined, regCloses, new Date('2026-06-01T00:00:00Z'))).toBe(true);
      expect(addonPurchaseOpen(undefined, regCloses, new Date('2026-07-02T00:00:00Z'))).toBe(false);
    });
  });
});

describe('per-unit add-on draft (individual purchase UI, emv2 P2 T3)', () => {
  const athlete = { id: 'ath-1', firstName: 'Jamie', lastName: 'Lee' };
  const regCloses = '2026-07-01T00:00:00Z';
  const competition: AddonDraftEvent = {
    id: 'ev-1', name: 'Springfield Open', regCloses, eventType: 'competition',
    tshirtAddon: { price: 20, sizes: ['S', 'M', 'L'] },
    bannerAddon: { price: 15 },
    banquet: { price: 40, name: 'Awards Banquet' },
  };
  const camp: AddonDraftEvent = {
    id: 'ev-2', name: 'Summer Camp', regCloses, eventType: 'camp',
    tshirtAddon: { price: 0, sizes: ['S', 'M', 'L'] },
    campConfig: { leoAddon: { price: 30, sizes: ['CS', 'CM'] } },
  };

  describe('initialAddonDraft', () => {
    it('starts empty for a competition registration', () => {
      expect(initialAddonDraft(competition, 'registration')).toEqual({
        shirtUnits: [], leoUnits: [], banquetUnits: [], bannerText: '',
      });
    });

    it('seeds a single unfilled unit for camp shirt/leo in registration mode (forces an explicit choice)', () => {
      expect(initialAddonDraft(camp, 'registration')).toEqual({
        shirtUnits: [''], leoUnits: [''], banquetUnits: [], bannerText: '',
      });
    });

    it('never forces a choice in standalone mode, even for a camp', () => {
      expect(initialAddonDraft(camp, 'standalone')).toEqual({
        shirtUnits: [], leoUnits: [], banquetUnits: [], bannerText: '',
      });
    });
  });

  describe('addonDraftValid', () => {
    const now = new Date('2026-06-01T00:00:00Z');
    it('is always valid for a non-camp event', () => {
      expect(addonDraftValid(competition, { shirtUnits: [''], leoUnits: [], banquetUnits: [], bannerText: '' }, now)).toBe(true);
    });

    it('rejects an unmade camp shirt/leo choice while the window is open', () => {
      expect(addonDraftValid(camp, { shirtUnits: [''], leoUnits: ['CS'], banquetUnits: [], bannerText: '' }, now)).toBe(false);
      expect(addonDraftValid(camp, { shirtUnits: ['none'], leoUnits: [''], banquetUnits: [], bannerText: '' }, now)).toBe(false);
    });

    it('accepts an explicit "none" opt-out for camp shirt/leo', () => {
      expect(addonDraftValid(camp, { shirtUnits: ['none'], leoUnits: ['none'], banquetUnits: [], bannerText: '' }, now)).toBe(true);
    });

    it('accepts a real size choice for camp shirt/leo', () => {
      expect(addonDraftValid(camp, { shirtUnits: ['M'], leoUnits: ['CM'], banquetUnits: [], bannerText: '' }, now)).toBe(true);
    });

    it('does not require a choice for a camp add-on whose window has already closed', () => {
      const closedCamp: AddonDraftEvent = { ...camp, tshirtAddon: { price: 0, sizes: ['S'], lastPurchaseAt: '2026-01-01T00:00:00Z' } };
      expect(addonDraftValid(closedCamp, { shirtUnits: [''], leoUnits: ['CM'], banquetUnits: [], bannerText: '' }, now)).toBe(true);
    });
  });

  describe('buildAddonCartItems', () => {
    it('creates one line per non-empty shirt unit, skipping blank/none', () => {
      const items = buildAddonCartItems(competition, athlete, { shirtUnits: ['M', '', 'L'], leoUnits: [], banquetUnits: [], bannerText: '' }, 1000);
      expect(items).toHaveLength(2);
      expect(items[0]).toMatchObject({ kind: 'addon', refLineType: 'tshirt', addonSize: 'M', amount: 20, refEventId: 'ev-1', refUserId: 'ath-1' });
      expect(items[1]).toMatchObject({ refLineType: 'tshirt', addonSize: 'L' });
      expect(items[0].id).not.toBe(items[1].id);
    });

    it('skips a camp shirt/leo unit explicitly set to "none"', () => {
      const items = buildAddonCartItems(camp, athlete, { shirtUnits: ['none'], leoUnits: ['CS'], banquetUnits: [], bannerText: '' }, 1000);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ refLineType: 'leo', addonSize: 'CS', amount: 30 });
    });

    it('labels a banquet ticket assigned to the athlete vs an extra ticket', () => {
      const items = buildAddonCartItems(
        competition, athlete,
        { shirtUnits: [], leoUnits: [], banquetUnits: ['ath-1', 'extra'], bannerText: '' },
        2000,
      );
      expect(items).toHaveLength(2);
      expect(items[0]).toMatchObject({ refLineType: 'banquet', addonAssigneeId: 'ath-1' });
      expect(items[0].label).toContain('For Jamie Lee');
      expect(items[1]).toMatchObject({ refLineType: 'banquet', addonAssigneeId: 'extra' });
      expect(items[1].label).toContain('Extra ticket');
    });

    it('adds a banner line only when text is present and non-blank', () => {
      const withText = buildAddonCartItems(competition, athlete, { shirtUnits: [], leoUnits: [], banquetUnits: [], bannerText: '  Springfield  ' }, 3000);
      expect(withText).toHaveLength(1);
      expect(withText[0]).toMatchObject({ refLineType: 'banner' });
      expect(withText[0].label).toContain('Springfield');

      const blank = buildAddonCartItems(competition, athlete, { shirtUnits: [], leoUnits: [], banquetUnits: [], bannerText: '   ' }, 3000);
      expect(blank).toHaveLength(0);
    });

    it('produces no lines from an all-empty draft', () => {
      expect(buildAddonCartItems(competition, athlete, { shirtUnits: [], leoUnits: [], banquetUnits: [], bannerText: '' }, 4000)).toHaveLength(0);
    });
  });

  describe('anyAddonWindowOpen', () => {
    const now = new Date('2026-06-01T00:00:00Z');
    it('true when at least one configured type is open', () => {
      expect(anyAddonWindowOpen(competition, now)).toBe(true);
    });

    it('false once every configured type has closed', () => {
      const closed: AddonDraftEvent = { id: 'ev-3', name: 'x', regCloses: '2026-01-01T00:00:00Z' };
      expect(anyAddonWindowOpen(closed, now)).toBe(false);
    });

    it('excludes the banner when includeBanner is false (standalone-purchase gate)', () => {
      const bannerOnly: AddonDraftEvent = { id: 'ev-4', name: 'x', regCloses, bannerAddon: { price: 15 } };
      expect(anyAddonWindowOpen(bannerOnly, now)).toBe(true);
      expect(anyAddonWindowOpen(bannerOnly, now, { includeBanner: false })).toBe(false);
    });
  });
});

describe('club-manager per-unit add-on draft (emv2 P2 T4)', () => {
  const clubEvent: ClubAddonDraftEvent = {
    id: 'ev-1', name: 'Springfield Open',
    tshirtAddon: { price: 20, sizes: ['S', 'M', 'L'] },
    bannerAddon: { price: 15 },
    banquet: { price: 40, name: 'Awards Banquet' },
  };
  const names: Record<string, string> = { 'p-1': 'Jamie Lee', 'p-2': 'Alex Kim' };
  const nameOf = (id: string) => names[id] ?? id;

  it('initialClubAddonDraft starts fully empty', () => {
    expect(initialClubAddonDraft()).toEqual({ shirtUnits: [], banquetUnits: [], bannerText: '' });
  });

  it('one line per shirt unit, skipping blank entries', () => {
    const items = buildClubAddonCartItems(clubEvent, { shirtUnits: ['M', '', 'L'], banquetUnits: [], bannerText: '' }, nameOf, 1000);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: 'addon', refLineType: 'tshirt', addonSize: 'M', amount: 20, refEventId: 'ev-1' });
    expect(items[1]).toMatchObject({ addonSize: 'L' });
  });

  it('banquet tickets: assigned lines name the roster person, extra lines say "Extra ticket", refUserId set only when assigned', () => {
    const items = buildClubAddonCartItems(
      clubEvent, { shirtUnits: [], banquetUnits: ['p-1', 'extra', 'p-2'], bannerText: '' }, nameOf, 2000,
    );
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ refLineType: 'banquet', addonAssigneeId: 'p-1', refUserId: 'p-1', label: expect.stringContaining('Jamie Lee') });
    expect(items[1]).toMatchObject({ addonAssigneeId: 'extra', refUserId: undefined, label: expect.stringContaining('Extra ticket') });
    expect(items[2]).toMatchObject({ addonAssigneeId: 'p-2', refUserId: 'p-2', label: expect.stringContaining('Alex Kim') });
  });

  it('banner: one line with the trimmed club text, skipped when blank', () => {
    const withText = buildClubAddonCartItems(clubEvent, { shirtUnits: [], banquetUnits: [], bannerText: '  Springfield  ' }, nameOf, 3000);
    expect(withText).toHaveLength(1);
    expect(withText[0]).toMatchObject({ refLineType: 'banner', label: expect.stringContaining('Springfield') });

    const blank = buildClubAddonCartItems(clubEvent, { shirtUnits: [], banquetUnits: [], bannerText: '   ' }, nameOf, 3000);
    expect(blank).toHaveLength(0);
  });

  it('produces no lines from an all-empty draft', () => {
    expect(buildClubAddonCartItems(clubEvent, { shirtUnits: [], banquetUnits: [], bannerText: '' }, nameOf, 4000)).toHaveLength(0);
  });
});

describe('camp registrant survey (emv2 P2 T5, spec §G; editable questions 2026-07-23)', () => {
  const customQuestions: CampSurveyQuestion[] = [
    { id: 'q-1', label: 'Favorite color?', type: 'text', required: true },
    { id: 'q-2', label: 'T-shirt style', type: 'single', options: ['Crew', 'V-neck'], required: true },
    { id: 'q-3', label: 'Activities interested in', type: 'multi', options: ['Archery', 'Swimming'], required: false },
  ];

  describe('campSurveyQuestionsOf (legacy resolver)', () => {
    it('derives the legacy 4-question survey, disabled, when there is no campConfig at all', () => {
      const { enabled, questions } = campSurveyQuestionsOf(undefined);
      expect(enabled).toBe(false);
      expect(questions.map((q) => q.id)).toEqual(['bedtime', 'noiseLevel', 'cabinGenderPref', 'roommateRequest']);
      expect(questions.map((q) => q.required)).toEqual([true, true, true, false]);
    });

    it('reads the legacy overnightSurvey on/off flag', () => {
      expect(campSurveyQuestionsOf({ overnightSurvey: true }).enabled).toBe(true);
      expect(campSurveyQuestionsOf({ overnightSurvey: false }).enabled).toBe(false);
    });

    it('honors legacy surveyMandatory per-question overrides', () => {
      const allMandatory = { bedtime: true, noiseLevel: true, cabinGenderPref: true, roommateRequest: true };
      const { questions } = campSurveyQuestionsOf({ overnightSurvey: true, surveyMandatory: allMandatory });
      expect(questions.every((q) => q.required)).toBe(true);
    });

    it('falls back to the legacy default with an empty surveyMandatory object', () => {
      const { questions } = campSurveyQuestionsOf({ overnightSurvey: true, surveyMandatory: {} });
      expect(questions.find((q) => q.id === 'bedtime')?.required).toBe(true);
      expect(questions.find((q) => q.id === 'roommateRequest')?.required).toBe(false);
    });

    it('prefers the new `survey` shape over any legacy fields when present', () => {
      const resolved = campSurveyQuestionsOf({
        overnightSurvey: false, // stale mirrored flag — ignored once `survey` is set
        survey: { enabled: true, questions: customQuestions },
      });
      expect(resolved.enabled).toBe(true);
      expect(resolved.questions).toBe(customQuestions);
    });
  });

  describe('campSurveyAnswersValid', () => {
    it('requires every required legacy question to be answered', () => {
      const legacy = campSurveyQuestionsOf({ overnightSurvey: true }).questions;
      expect(campSurveyAnswersValid({}, legacy)).toBe(false);
      expect(campSurveyAnswersValid({ bedtime: 'before-10', noiseLevel: 'quiet', cabinGenderPref: '' }, legacy)).toBe(false);
      expect(campSurveyAnswersValid({ bedtime: 'before-10', noiseLevel: 'quiet', cabinGenderPref: 'No preference' }, legacy)).toBe(true);
    });

    it('treats non-required questions as always valid regardless of content', () => {
      const legacy = campSurveyQuestionsOf({ overnightSurvey: true }).questions;
      expect(campSurveyAnswersValid({ bedtime: 'before-10', noiseLevel: 'quiet', cabinGenderPref: 'No preference' }, legacy)).toBe(true);
    });

    it('requires a multi question to have at least one selection when required', () => {
      const q: CampSurveyQuestion[] = [{ id: 'm', label: 'Pick one', type: 'multi', options: ['a', 'b'], required: true }];
      expect(campSurveyAnswersValid({}, q)).toBe(false);
      expect(campSurveyAnswersValid({ m: [] }, q)).toBe(false);
      expect(campSurveyAnswersValid({ m: ['a'] }, q)).toBe(true);
    });

    it('validates a custom question set', () => {
      expect(campSurveyAnswersValid({}, customQuestions)).toBe(false);
      expect(campSurveyAnswersValid({ 'q-1': 'Blue', 'q-2': 'Crew' }, customQuestions)).toBe(true);
    });
  });

  describe('campSurveyToStored', () => {
    it('returns undefined when nothing was answered', () => {
      expect(campSurveyToStored({ bedtime: '', roommateRequest: '   ' })).toBeUndefined();
    });
    it('trims text answers and drops blank/empty-array entries', () => {
      expect(campSurveyToStored({ bedtime: 'before-10', noiseLevel: '', roommateRequest: '  Jamie Lee  ', extras: [] }))
        .toEqual({ bedtime: 'before-10', roommateRequest: 'Jamie Lee' });
    });
    it('carries multi (array) answers through untouched', () => {
      expect(campSurveyToStored({ 'q-3': ['Archery', 'Swimming'] })).toEqual({ 'q-3': ['Archery', 'Swimming'] });
    });
  });

  describe('campSurveyAnswerLabel', () => {
    it('maps legacy bedtime/noiseLevel coded values to their labels', () => {
      expect(campSurveyAnswerLabel('bedtime', '10-to-midnight')).toBe('10pm–midnight');
      expect(campSurveyAnswerLabel('noiseLevel', 'quiet')).toBe('Quiet');
    });
    it('is the identity function for any other question id (custom questions store option text verbatim)', () => {
      expect(campSurveyAnswerLabel('cabinGenderPref', 'Female')).toBe('Female');
      expect(campSurveyAnswerLabel('q-2', 'Crew')).toBe('Crew');
    });
  });

  describe('campSurveySummary', () => {
    const legacy = campSurveyQuestionsOf({ overnightSurvey: true }).questions;

    it('is empty for no survey', () => {
      expect(campSurveySummary(undefined, legacy)).toBe('');
    });
    it('joins answered fields with human labels in question order', () => {
      expect(campSurveySummary(
        { bedtime: '10-to-midnight', noiseLevel: 'quiet', cabinGenderPref: 'Female', roommateRequest: 'Jamie' },
        legacy,
      )).toBe(
        'What time do you plan to go to bed?: 10pm–midnight, '
        + 'What is the preferred noise level in your cabin?: Quiet, '
        + 'Would you prefer a co-ed or single gender cabin?: Female, '
        + 'If you have any roommate requests (including people you DO NOT want to room with), please list them here.: Jamie',
      );
    });
    it('only includes questions that were actually answered', () => {
      expect(campSurveySummary({ noiseLevel: 'lively' }, legacy)).toBe('What is the preferred noise level in your cabin?: Lively');
    });
    it('joins a multi answer with commas', () => {
      expect(campSurveySummary({ 'q-3': ['Archery', 'Swimming'] }, customQuestions)).toBe('Activities interested in: Archery, Swimming');
    });
  });
});

describe('refundAmountCents', () => {
  it('refunds 100% when there is no lastDateToEdit at all', () => {
    expect(refundAmountCents(5000, null, '2026-08-01T00:00:00Z')).toBe(5000);
    expect(refundAmountCents(5000, undefined, '2026-08-01T00:00:00Z')).toBe(5000);
  });
  it('refunds 100% when approved exactly at lastDateToEdit (boundary is inclusive)', () => {
    expect(refundAmountCents(5000, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')).toBe(5000);
  });
  it('refunds 100% when approved before lastDateToEdit', () => {
    expect(refundAmountCents(5000, '2026-08-01T00:00:00Z', '2026-07-31T23:59:59Z')).toBe(5000);
  });
  it('refunds 75% when approved after lastDateToEdit', () => {
    expect(refundAmountCents(5000, '2026-08-01T00:00:00Z', '2026-08-01T00:00:01Z')).toBe(3750);
  });
  it('rounds the 75% case to the nearest cent (odd amount)', () => {
    // 3333 * 0.75 = 2499.75 -> rounds up to 2500
    expect(refundAmountCents(3333, '2026-08-01T00:00:00Z', '2026-08-02T00:00:00Z')).toBe(2500);
  });
  it('never refunds the service fee — caller is responsible for excluding it from itemAmountCents', () => {
    // Documents the contract: this function only ever scales the amount it is given.
    expect(refundAmountCents(0, null, '2026-08-01T00:00:00Z')).toBe(0);
  });
});

describe('capRefundCents', () => {
  it('passes the computed amount through when there is plenty left available', () => {
    expect(capRefundCents(5000, 10000)).toBe(5000);
  });
  it('caps at what is left when a coupon meant less was actually paid', () => {
    expect(capRefundCents(5000, 2000)).toBe(2000);
  });
  it('caps at 0 for a free ($0-total) order — no Stripe call, but a valid $0 approval', () => {
    expect(capRefundCents(5000, 0)).toBe(0);
  });
  it('never goes negative even if available is negative (over-refunded already)', () => {
    expect(capRefundCents(5000, -100)).toBe(0);
  });
  it('caps at exactly the available amount on the boundary', () => {
    expect(capRefundCents(5000, 5000)).toBe(5000);
  });
  it('is NOT sufficient alone for a partially-couponed multi-line payment — the base must be paid_cents', () => {
    // Documented defect scenario (fable review of T6): cart = $135 entry
    // discounted to $85 by a "$50 off" coupon + a $30 t-shirt ⇒
    // amount_subtotal $115. With the PRE-discount list price as the base, the
    // payment-level cap alone still pays out $115 for an item the payer paid
    // $85 for — taking the shirt's $30 with it:
    expect(capRefundCents(13500, 11500)).toBe(11500); // wrong money if used as the whole guard
    // The fix is upstream: create-checkout-session freezes each line's
    // POST-discount `paid_cents` onto payments.lines_snapshot, and
    // process-refund uses THAT ($85) as the base; the cap then only guards
    // against cross-request over-refunds on the same payment:
    expect(capRefundCents(8500, 11500)).toBe(8500); // correct with the paid_cents base
  });
});

describe('allocateRegistrationRefund (UAT Z-04 rules 1/2/4 — per-payment refund allocation)', () => {
  it('sums a single payment\'s lines when there is only one payment', () => {
    const lines = [
      { paymentId: 'p1', refLineType: 'entry', paidCents: 5000 },
      { paymentId: 'p1', refLineType: 'entry', paidCents: 3000 },
    ];
    expect(allocateRegistrationRefund(lines, { afterDeadline: false })).toEqual([{ paymentId: 'p1', cents: 8000 }]);
  });

  it('splits into TWO payment allocations when a reg was paid across two invoices (rule 1)', () => {
    // The exact scenario the grouping fix exists for: an original entry
    // invoice (p1, $65) plus a later "add discipline" invoice (p2, $45).
    const lines = [
      { paymentId: 'p1', refLineType: 'entry', paidCents: 6500 },
      { paymentId: 'p2', refLineType: 'entry', paidCents: 4500 },
    ];
    const out = allocateRegistrationRefund(lines, { afterDeadline: false });
    expect(out).toHaveLength(2);
    expect(out).toEqual(expect.arrayContaining([
      { paymentId: 'p1', cents: 6500 },
      { paymentId: 'p2', cents: 4500 },
    ]));
  });

  it('excludes a change-fee line entirely, even when it shares a payment with a refundable line (rule 2)', () => {
    const lines = [
      { paymentId: 'p1', refLineType: 'entry', paidCents: 6500 },
      { paymentId: 'p1', refLineType: 'change', paidCents: 1500 },
    ];
    expect(allocateRegistrationRefund(lines, { afterDeadline: false })).toEqual([{ paymentId: 'p1', cents: 6500 }]);
  });

  it('drops a payment entirely when its only referencing line is a change fee', () => {
    const lines = [
      { paymentId: 'p1', refLineType: 'entry', paidCents: 6500 },
      { paymentId: 'p2', refLineType: 'change', paidCents: 1500 },
    ];
    expect(allocateRegistrationRefund(lines, { afterDeadline: false })).toEqual([{ paymentId: 'p1', cents: 6500 }]);
  });

  it('applies the 75% scale PER PAYMENT, each independently rounded (rule 4)', () => {
    // p1: 3333 * 0.75 = 2499.75 -> 2500. p2: 3334 * 0.75 = 2500.5 -> 2501 (banker's-unaware
    // Math.round rounds .5 up). Rounding one payment must not affect the other's result.
    const lines = [
      { paymentId: 'p1', refLineType: 'entry', paidCents: 3333 },
      { paymentId: 'p2', refLineType: 'entry', paidCents: 3334 },
    ];
    const out = allocateRegistrationRefund(lines, { afterDeadline: true });
    expect(out).toEqual(expect.arrayContaining([
      { paymentId: 'p1', cents: 2500 },
      { paymentId: 'p2', cents: 2501 },
    ]));
  });

  it('a single payment\'s refund is unchanged from the pre-grouping single-payment math', () => {
    // Documents that grouping introduces no regression for the common (one
    // payment, one registration) case that was already correct.
    const lines = [{ paymentId: 'p1', refLineType: 'entry', paidCents: 8500 }];
    expect(allocateRegistrationRefund(lines, { afterDeadline: false })).toEqual([{ paymentId: 'p1', cents: 8500 }]);
    expect(allocateRegistrationRefund(lines, { afterDeadline: true })).toEqual([{ paymentId: 'p1', cents: 6375 }]);
  });

  it('returns an empty array for no lines at all', () => {
    expect(allocateRegistrationRefund([], { afterDeadline: false })).toEqual([]);
  });
});

describe('decideAfterConflict (UAT Z-04 rule 7 — reviewer 409 handling)', () => {
  it('is silent when two reviewers both approved (same outcome)', () => {
    expect(decideAfterConflict('approved', 'approve')).toBe('silent');
  });
  it('is silent when two reviewers both rejected (same outcome)', () => {
    expect(decideAfterConflict('rejected', 'reject')).toBe('silent');
  });
  it('toasts when a genuine conflict occurred — approved after this reviewer tried to reject', () => {
    expect(decideAfterConflict('approved', 'reject')).toBe('toast');
  });
  it('toasts when a genuine conflict occurred — rejected after this reviewer tried to approve', () => {
    expect(decideAfterConflict('rejected', 'approve')).toBe('toast');
  });
  it('toasts (does not assume silent) if the request is somehow still pending', () => {
    expect(decideAfterConflict('pending', 'approve')).toBe('toast');
  });
});

describe('shrinkOrDropCartLines (emv2 P4 T6 — waitlist checkout-conflict resolution)', () => {
  const item = (overrides: Partial<CartItem> = {}): CartItem => ({
    id: 'ci1', label: 'Entry', amount: 5000, kind: 'meet-entry', refRegIds: ['r1', 'r2'], ...overrides,
  });

  it('passes through a line untouched by the waitlisted set (same reference)', () => {
    const cart = [item({ refRegIds: ['r1'] })];
    const next = shrinkOrDropCartLines(cart, new Set(['r9']));
    expect(next).toHaveLength(1);
    expect(next[0]).toBe(cart[0]);
  });

  it('shrinks refRegIds to the unaffected remainder when only some regs are waitlisted', () => {
    const cart = [item({ id: 'ci1', refRegIds: ['r1', 'r2', 'r3'] })];
    const next = shrinkOrDropCartLines(cart, new Set(['r2']));
    expect(next).toHaveLength(1);
    expect(next[0].refRegIds).toEqual(['r1', 'r3']);
    expect(next[0]).not.toBe(cart[0]); // a new object, not mutated in place
  });

  it('drops a line entirely when every referenced reg is waitlisted', () => {
    const cart = [item({ id: 'ci1', refRegIds: ['r1', 'r2'] }), item({ id: 'ci2', refRegIds: ['r3'] })];
    const next = shrinkOrDropCartLines(cart, new Set(['r1', 'r2']));
    expect(next.map((i) => i.id)).toEqual(['ci2']);
  });

  it('leaves lines with no refRegIds (memberships/addons) untouched', () => {
    const cart = [item({ id: 'ci1', kind: 'membership', refRegIds: undefined })];
    const next = shrinkOrDropCartLines(cart, new Set(['r1']));
    expect(next).toEqual(cart);
  });
});

describe('diffCartLinePrices (S4, money-story UX §1 — cart vs. server-preview price agreement)', () => {
  it('returns nothing when every displayed amount matches the server line', () => {
    const displayed = [{ id: 'ci1', label: 'Entry', amount: 45 }, { id: 'ci2', label: 'Shirt', amount: 20 }];
    const server = [{ itemId: 'ci1', label: 'Entry', amountCents: 4500 }, { itemId: 'ci2', label: 'Shirt', amountCents: 2000 }];
    expect(diffCartLinePrices(displayed, server)).toEqual([]);
  });

  it('flags a host-club $0 line: displayed a real fee, server prices it free', () => {
    const displayed = [{ id: 'ci1', label: 'Home Meet Entry', amount: 45 }];
    const server = [{ itemId: 'ci1', label: 'Home Meet Entry', amountCents: 0 }];
    expect(diffCartLinePrices(displayed, server)).toEqual([
      { itemId: 'ci1', label: 'Home Meet Entry', oldDollars: 45, newDollars: 0 },
    ]);
  });

  it('flags a coupon reducing a line below the displayed (pre-coupon) amount', () => {
    const displayed = [{ id: 'ci1', label: 'Nationals Entry', amount: 135 }];
    const server = [{ itemId: 'ci1', label: 'Nationals Entry', amountCents: 8500 }]; // $50 off
    expect(diffCartLinePrices(displayed, server)).toEqual([
      { itemId: 'ci1', label: 'Nationals Entry', oldDollars: 135, newDollars: 85 },
    ]);
  });

  it('flags an entry-vs-change derivation mismatch (client tagged cheap change, server prices full entry)', () => {
    // C4: the client's ref_line_type tag is display-only — the server derives
    // entry-vs-change from the referenced regs' DB state, which can disagree
    // with what the cart displayed when the line was added.
    const displayed = [{ id: 'ci1', label: 'Add WAG', amount: 15 }]; // client thought "change fee"
    const server = [{ itemId: 'ci1', label: 'Add WAG', amountCents: 6500 }]; // server: full entry
    expect(diffCartLinePrices(displayed, server)).toEqual([
      { itemId: 'ci1', label: 'Add WAG', oldDollars: 15, newDollars: 65 },
    ]);
  });

  it('flags a plain stale price (season/event fee changed since add-to-cart)', () => {
    const displayed = [{ id: 'ci1', label: '2025–26 Athlete Membership', amount: 30 }];
    const server = [{ itemId: 'ci1', label: '2025–26 Athlete Membership', amountCents: 3500 }];
    expect(diffCartLinePrices(displayed, server)).toEqual([
      { itemId: 'ci1', label: '2025–26 Athlete Membership', oldDollars: 30, newDollars: 35 },
    ]);
  });

  it('ignores a server line with no matching displayed item', () => {
    const displayed = [{ id: 'ci1', label: 'Entry', amount: 45 }];
    const server = [
      { itemId: 'ci1', label: 'Entry', amountCents: 4500 },
      { itemId: 'ci-ghost', label: 'Ghost', amountCents: 100 },
    ];
    expect(diffCartLinePrices(displayed, server)).toEqual([]);
  });

  it('ignores a displayed item with no matching server line', () => {
    const displayed = [{ id: 'ci1', label: 'Entry', amount: 45 }, { id: 'ci2', label: 'Untouched', amount: 10 }];
    const server = [{ itemId: 'ci1', label: 'Entry', amountCents: 4500 }];
    expect(diffCartLinePrices(displayed, server)).toEqual([]);
  });

  it('is not fooled by float noise in the displayed dollar amount', () => {
    // 0.1 + 0.2 style float drift on a dollar amount must not spuriously diff.
    const displayed = [{ id: 'ci1', label: 'Fee', amount: 29.99 }];
    const server = [{ itemId: 'ci1', label: 'Fee', amountCents: 2999 }];
    expect(diffCartLinePrices(displayed, server)).toEqual([]);
  });
});
