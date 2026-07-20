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
  addonConfig,
  addonPrice,
  addonPurchaseOpen,
  initialAddonDraft,
  addonDraftValid,
  buildAddonCartItems,
  anyAddonWindowOpen,
  initialClubAddonDraft,
  buildClubAddonCartItems,
  initialCampSurveyDraft,
  campSurveyValid,
  campSurveyToStored,
  campSurveySummary,
  refundAmountCents,
  capRefundCents,
  shrinkOrDropCartLines,
} from '../src/lib/pricing';
import type { AddonPricingEvent, AddonDraftEvent, ClubAddonDraftEvent, PartnerReg, RegFeeEvent, SynchroReg } from '../src/lib/pricing';
import type { CartItem, Coupon, Membership, Season } from '../src/lib/types';

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

describe('camp overnight-accommodations survey (emv2 P2 T5, spec §G)', () => {
  it('initialCampSurveyDraft starts blank with no existing answers', () => {
    expect(initialCampSurveyDraft()).toEqual({ bedtime: '', noiseLevel: '', cabinGenderPref: '', roommateRequest: '' });
  });
  it('initialCampSurveyDraft prefills from an existing stored survey (edit case)', () => {
    expect(initialCampSurveyDraft({ bedtime: 'after-midnight', noiseLevel: 'lively', cabinGenderPref: 'Female', roommateRequest: 'Jamie' }))
      .toEqual({ bedtime: 'after-midnight', noiseLevel: 'lively', cabinGenderPref: 'Female', roommateRequest: 'Jamie' });
  });

  it('campSurveyValid requires bedtime + noiseLevel + cabinGenderPref, not roommateRequest', () => {
    expect(campSurveyValid({ bedtime: '', noiseLevel: '', cabinGenderPref: '', roommateRequest: '' })).toBe(false);
    expect(campSurveyValid({ bedtime: 'before-10', noiseLevel: 'quiet', cabinGenderPref: '', roommateRequest: '' })).toBe(false);
    expect(campSurveyValid({ bedtime: 'before-10', noiseLevel: 'quiet', cabinGenderPref: 'No preference', roommateRequest: '' })).toBe(true);
  });

  it('campSurveyToStored returns undefined for a fully-blank draft', () => {
    expect(campSurveyToStored({ bedtime: '', noiseLevel: '', cabinGenderPref: '', roommateRequest: '   ' })).toBeUndefined();
  });
  it('campSurveyToStored trims roommateRequest and omits unanswered keys', () => {
    expect(campSurveyToStored({ bedtime: 'before-10', noiseLevel: '', cabinGenderPref: '', roommateRequest: '  Jamie Lee  ' }))
      .toEqual({ bedtime: 'before-10', roommateRequest: 'Jamie Lee' });
  });
  it('campSurveyToStored carries every answered field', () => {
    expect(campSurveyToStored({ bedtime: '10-to-midnight', noiseLevel: 'moderate', cabinGenderPref: 'Male', roommateRequest: 'Alex' }))
      .toEqual({ bedtime: '10-to-midnight', noiseLevel: 'moderate', cabinGenderPref: 'Male', roommateRequest: 'Alex' });
  });

  it('campSurveySummary is empty for no survey', () => {
    expect(campSurveySummary(undefined)).toBe('');
  });
  it('campSurveySummary joins answered fields with human labels', () => {
    expect(campSurveySummary({ bedtime: '10-to-midnight', noiseLevel: 'quiet', cabinGenderPref: 'Female', roommateRequest: 'Jamie' }))
      .toBe('bedtime: 10pm–midnight, noise: Quiet, cabin: Female, roommate: Jamie');
  });
  it('campSurveySummary only includes fields that were actually answered', () => {
    expect(campSurveySummary({ noiseLevel: 'lively' })).toBe('noise: Lively');
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
