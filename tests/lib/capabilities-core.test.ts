import { describe, it, expect } from 'vitest';
import { deriveCapabilities, currentSeasonId, membershipHolds, paidRegistrationClub } from '../../src/lib/capabilities-core';
import type { Athlete, Club, DB, Event, Membership, Registration, Season } from '../../src/lib/types';

function makeReg(overrides: Partial<Registration>): Registration {
  return {
    id: 'r-x',
    eventId: 'meet-1',
    athleteId: 'a-1',
    clubId: 'club-A',
    discipline: 'WAG',
    levelId: 'lvl-1',
    apparatus: ['VT'],
    sessionId: null,
    ...overrides,
  };
}

// --- Fixture helpers --------------------------------------------------------

function makeDb(partial: Partial<DB>): DB {
  return {
    seasons: [],
    levels: [],
    clubs: [],
    people: [],
    events: [],
    registrations: [],
    scores: [],
    invoices: [],
    coupons: [],
    carts: {},
    clubRequests: [],
    ...partial,
  };
}

function makeSeason(overrides: Partial<Season>): Season {
  return {
    id: 's1',
    name: '2025-26',
    startsOn: '2025-07-01',
    endsOn: '2026-06-30',
    athleteFee: 45,
    coachFee: 25,
    active: true,
    current: true,
    ...overrides,
  };
}

function makePerson(overrides: Partial<Athlete>): Athlete {
  return {
    id: 'p-x',
    authUserId: null,
    kind: 'athlete',
    firstName: 'First',
    lastName: 'Last',
    email: 'person@example.com',
    dob: '2005-01-01',
    gender: 'Female',
    gradYear: 1900,
    studentStatus: 'Student',
    shirt: 'Adult M',
    country: 'USA',
    state: 'Ohio',
    phone: '555-555-5555',
    mainClubId: null,
    altClubIds: [],
    levels: {},
    emergency: { contact: '', relation: '', phone: '' },
    dietary: [],
    dietaryNotes: '',
    memberships: [],
    achievements: [],
    ...overrides,
  };
}

function makeClub(overrides: Partial<Club>): Club {
  return {
    id: 'club-x',
    name: 'Club X',
    shortName: 'CX',
    state: 'Ohio',
    region: 'Mideast',
    managerIds: [],
    email: 'club@example.com',
    allowClubPay: false,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<Event>): Event {
  return {
    id: 'meet-x',
    slug: 'meet-x',
    name: 'Event X',
    hostClubId: 'club-x',
    city: 'Columbus',
    state: 'Ohio',
    timezone: 'America/New_York',
    startDate: '2026-03-01',
    endDate: '2026-03-01',
    status: 'reg-open',
    regOpens: '2026-01-01',
    regCloses: '2026-02-28',
    entryFee: 50,
    secondDisciplineFee: 25,
    disciplines: ['WAG'],
    sessions: [],
    ...overrides,
  };
}

// --- Shared fixture ----------------------------------------------------------
//
// season s1 (current)
// people: p-admin, p-coach (manages club-A), p-athlete-active (active
//         membership in s1), p-athlete-none (no membership)
// clubs: club-A (managerIds: ['p-coach']), club-B (managerIds: [])
// events: meet-1 (hosted by club-A)

const s1 = makeSeason({ id: 's1', current: true });

const pAdmin = makePerson({ id: 'p-admin', kind: 'coach', firstName: 'Admin' });
const pCoach = makePerson({ id: 'p-coach', kind: 'coach', firstName: 'Coach' });
const pAthleteActive = makePerson({
  id: 'p-athlete-active',
  kind: 'athlete',
  firstName: 'Active',
  memberships: [
    {
      seasonId: 's1',
      status: 'active',
      waiverSignedAt: '2025-07-15',
      waiverSignedBy: 'self',
      paidVia: 'card',
    },
  ],
});
const pAthleteNone = makePerson({ id: 'p-athlete-none', kind: 'athlete', firstName: 'NoMembership' });

// Typed-membership residuals (T1) fixtures: a coach-ONLY active member (no
// athlete row at all), and a dual-role person with BOTH types active.
const pCoachActiveOnly = makePerson({
  id: 'p-coach-active-only',
  kind: 'coach',
  roles: { athlete: false, coach: true },
  firstName: 'CoachOnly',
  memberships: [
    {
      seasonId: 's1',
      type: 'coach',
      status: 'active',
      waiverSignedAt: '2025-07-15',
      waiverSignedBy: 'self',
      paidVia: 'card',
    },
  ],
});
const pDualActive = makePerson({
  id: 'p-dual-active',
  kind: 'athlete',
  roles: { athlete: true, coach: true },
  firstName: 'Dual',
  memberships: [
    {
      seasonId: 's1',
      type: 'athlete',
      status: 'active',
      waiverSignedAt: '2025-07-15',
      waiverSignedBy: 'self',
      paidVia: 'card',
    },
    {
      seasonId: 's1',
      type: 'coach',
      status: 'active',
      waiverSignedAt: '2025-07-15',
      waiverSignedBy: 'self',
      paidVia: 'card',
    },
  ],
});

const clubA = makeClub({ id: 'club-A', name: 'Club A', shortName: 'CA', managerIds: ['p-coach'] });
const clubB = makeClub({ id: 'club-B', name: 'Club B', shortName: 'CB', managerIds: [] });

const meet1 = makeEvent({ id: 'meet-1', slug: 'meet-1', name: 'Event 1', hostClubId: 'club-A' });
const meetClubB = makeEvent({ id: 'meet-clubB', slug: 'meet-clubb', name: 'Event Club B', hostClubId: 'club-B' });

const db = makeDb({
  seasons: [s1],
  people: [pAdmin, pCoach, pAthleteActive, pAthleteNone, pCoachActiveOnly, pDualActive],
  clubs: [clubA, clubB],
  events: [meet1, meetClubB],
});

// --- Tests --------------------------------------------------------------------

describe('deriveCapabilities', () => {
  it('1. admin: full access, hosts any event, no impersonation', () => {
    const caps = deriveCapabilities(db, true, ['admin'], 'p-admin', null, 's1');

    expect(caps.isAdmin).toBe(true);
    expect(caps.impersonating).toBe(false);
    expect(caps.personId).toBe('p-admin');
    expect(caps.isEventHost('meet-1')).toBe(true); // admins host any event
  });

  it('1b. sanctioning role (and admin) are on the sanctioning team', () => {
    expect(deriveCapabilities(db, true, ['sanctioning'], 'p-x', null, 's1').isSanctioning).toBe(true);
    expect(deriveCapabilities(db, true, ['admin'], 'p-admin', null, 's1').isSanctioning).toBe(true);
    expect(deriveCapabilities(db, true, [], 'p-athlete-active', null, 's1').isSanctioning).toBe(false);
  });

  it('2. plain signed-in athlete with an active membership can register', () => {
    const caps = deriveCapabilities(db, true, [], 'p-athlete-active', null, 's1');

    expect(caps.isAdmin).toBe(false);
    expect(caps.canRegister).toBe(true); // active membership
    expect(caps.currentMembership).toBe('active');
    expect(caps.managedClubIds).toEqual([]);
  });

  it('3. athlete with no membership cannot register', () => {
    const caps = deriveCapabilities(db, true, [], 'p-athlete-none', null, 's1');

    expect(caps.canRegister).toBe(false);
    expect(caps.currentMembership).toBe('none');
  });

  it('4. club manager: managedClubIds includes their club, isEventHost reflects host club', () => {
    const caps = deriveCapabilities(db, true, [], 'p-coach', null, 's1');

    expect(caps.managedClubIds).toContain('club-A');
    expect(caps.isEventHost('meet-1')).toBe(true); // manages club-A, which hosts meet-1
    expect(caps.isEventHost('meet-clubB')).toBe(false); // hosted by club-B, not managed
  });

  describe('4b. per-event admin grants (event_admins, emv2 §C)', () => {
    it('a grant makes isEventHost true for exactly that event', () => {
      const caps = deriveCapabilities(db, true, [], 'p-athlete-active', null, 's1', ['meet-clubB']);

      expect(caps.isEventHost('meet-clubB')).toBe(true); // granted
      expect(caps.isEventHost('meet-1')).toBe(false); // NOT granted, not a manager
      expect(caps.managedClubIds).toEqual([]); // grant does not confer club management
    });

    it('no grants (default param) leaves isEventHost purely club-derived', () => {
      const caps = deriveCapabilities(db, true, [], 'p-coach', null, 's1');

      expect(caps.isEventHost('meet-1')).toBe(true);
      expect(caps.isEventHost('meet-clubB')).toBe(false);
    });

    it('grants and club management combine (union)', () => {
      const caps = deriveCapabilities(db, true, [], 'p-coach', null, 's1', ['meet-clubB']);

      expect(caps.isEventHost('meet-1')).toBe(true); // via managed club-A
      expect(caps.isEventHost('meet-clubB')).toBe(true); // via grant
    });
  });

  describe('5. impersonation requires admin', () => {
    it('5a. admin impersonating a club manager: capabilities recompute for the target person', () => {
      const caps = deriveCapabilities(db, true, ['admin'], 'p-admin', 'p-coach', 's1');

      expect(caps.impersonating).toBe(true);
      expect(caps.personId).toBe('p-coach');
      expect(caps.managedClubIds).toContain('club-A'); // recomputed for impersonated person
      expect(caps.person?.id).toBe('p-coach');
      // isAdmin still reflects the real user (keeps the "View as" control visible),
      // but actingAsAdmin drops so the UI shows the impersonated person's view.
      expect(caps.isAdmin).toBe(true);
      expect(caps.actingAsAdmin).toBe(false);
    });

    it('5b. SECURITY: a non-admin cannot impersonate via viewPersonId', () => {
      const caps = deriveCapabilities(db, true, [], 'p-athlete-active', 'p-coach', 's1');

      expect(caps.impersonating).toBe(false);
      expect(caps.personId).toBe('p-athlete-active'); // stays themselves
      expect(caps.managedClubIds).toEqual([]); // NOT club-A — no privilege escalation
    });

    it('5c. admin "impersonating" themselves is not impersonation', () => {
      const caps = deriveCapabilities(db, true, ['admin'], 'p-admin', 'p-admin', 's1');

      expect(caps.impersonating).toBe(false);
      expect(caps.actingAsAdmin).toBe(true);
    });
  });

  it('6. signed-out guest has no person, no capabilities', () => {
    const caps = deriveCapabilities(db, false, [], null, null, 's1');

    expect(caps.personId).toBeNull();
    expect(caps.person).toBeNull();
    expect(caps.canRegister).toBe(false);
    expect(caps.managedClubIds).toEqual([]);
  });

  describe('8. typed-membership residuals (T1): registering requires an ATHLETE-type membership', () => {
    it('coach-only member (active coach row, no athlete row) CANNOT register', () => {
      const caps = deriveCapabilities(db, true, [], 'p-coach-active-only', null, 's1');

      expect(caps.canRegister).toBe(false);
      expect(caps.athleteMembership).toBeNull();
    });

    it('coach-only member still shows their ACTIVE coach membership (display unaffected)', () => {
      const caps = deriveCapabilities(db, true, [], 'p-coach-active-only', null, 's1');

      expect(caps.coachMembership?.status).toBe('active');
      // Generic "any membership" summary falls back to the coach row when
      // there's no athlete row.
      expect(caps.currentMembership).toBe('active');
    });

    it('athlete-only member (active athlete row) CAN register', () => {
      const caps = deriveCapabilities(db, true, [], 'p-athlete-active', null, 's1');

      expect(caps.canRegister).toBe(true);
      expect(caps.athleteMembership?.status).toBe('active');
      expect(caps.coachMembership).toBeNull();
    });

    it('dual-role member with BOTH types active CAN register and shows both rows', () => {
      const caps = deriveCapabilities(db, true, [], 'p-dual-active', null, 's1');

      expect(caps.canRegister).toBe(true);
      expect(caps.athleteMembership?.status).toBe('active');
      expect(caps.coachMembership?.status).toBe('active');
    });

    it('a membership row with no `type` (legacy data) is treated as an athlete row', () => {
      // pAthleteActive's fixture membership omits `type` entirely — this
      // mirrors real pre-typed-membership data (DB column defaults to
      // 'athlete'). Confirms canRegister still gates correctly on it.
      const caps = deriveCapabilities(db, true, [], 'p-athlete-active', null, 's1');

      expect(caps.athleteMembership).not.toBeNull();
      expect(caps.canRegister).toBe(true);
    });
  });
});

describe('currentSeasonId', () => {
  it('7. returns the id of the season flagged current', () => {
    expect(currentSeasonId(db)).toBe('s1');
  });
});

describe('membershipHolds', () => {
  const base = (over: Partial<Membership>): Membership => ({
    seasonId: 's1',
    type: 'athlete',
    status: 'pending-waiver',
    waiverSignedAt: null,
    waiverSignedBy: null,
    paidVia: null,
    ...over,
  });

  it('active when waiver signed and no club-cart payment pending', () => {
    const h = membershipHolds(base({ status: 'active', waiverSignedAt: '2026-01-01T00:00:00Z' }));
    expect(h).toEqual({ waiverHold: false, paymentHold: false, active: true });
  });

  it('waiver-only hold: adult card path before signing (no payment hold)', () => {
    const h = membershipHolds(base({ status: 'pending-waiver', waiverSignedAt: null }));
    expect(h.waiverHold).toBe(true);
    expect(h.paymentHold).toBe(false);
    expect(h.active).toBe(false);
  });

  it('payment-only hold: adult pushed fee to club cart, waiver already signed', () => {
    const h = membershipHolds(base({
      status: 'pending-club-payment',
      waiverSignedAt: '2026-01-01T00:00:00Z',
      paidVia: 'club',
      clubCartPending: true,
    }));
    expect(h.waiverHold).toBe(false);
    expect(h.paymentHold).toBe(true);
    expect(h.active).toBe(false);
  });

  it('BOTH holds: minor pushed fee to club cart with an unsigned guardian waiver', () => {
    const h = membershipHolds(base({
      status: 'pending-waiver', // single enum can only show one; the flag carries the rest
      waiverSignedAt: null,
      paidVia: 'club',
      clubCartPending: true,
    }));
    expect(h.waiverHold).toBe(true);
    expect(h.paymentHold).toBe(true);
    expect(h.active).toBe(false);
  });

  it('after club pays a minor: clubCartPending cleared but waiver still open → waiver-only', () => {
    const h = membershipHolds(base({
      status: 'pending-waiver',
      waiverSignedAt: null,
      paidVia: 'club',
      clubCartPending: false,
    }));
    expect(h.waiverHold).toBe(true);
    expect(h.paymentHold).toBe(false);
    expect(h.active).toBe(false);
  });

  it('legacy back-compat: pending-club-payment status without the flag still reads as payment hold', () => {
    const h = membershipHolds(base({
      status: 'pending-club-payment',
      waiverSignedAt: '2026-01-01T00:00:00Z',
      paidVia: 'club',
    }));
    expect(h.paymentHold).toBe(true);
  });
});

describe('paidRegistrationClub (3d cross-club lock)', () => {
  const args = { athleteId: 'a-1', eventId: 'meet-1' };

  it('returns null when there are no registrations', () => {
    expect(paidRegistrationClub([], { ...args, excludeClubId: 'club-A' })).toBeNull();
  });

  it('a PAID reg under another club locks the athlete (returns that clubId)', () => {
    const regs = [makeReg({ clubId: 'club-B', paid: true })];
    expect(paidRegistrationClub(regs, { ...args, excludeClubId: 'club-A' })).toBe('club-B');
  });

  it('a PENDING (paid !== true) reg under another club does NOT lock', () => {
    expect(paidRegistrationClub([makeReg({ clubId: 'club-B', paid: false })], { ...args, excludeClubId: 'club-A' })).toBeNull();
    expect(paidRegistrationClub([makeReg({ clubId: 'club-B' })], { ...args, excludeClubId: 'club-A' })).toBeNull();
  });

  it('a paid reg under the SAME (excluded) club is not a conflict — normal edit', () => {
    const regs = [makeReg({ clubId: 'club-A', paid: true })];
    expect(paidRegistrationClub(regs, { ...args, excludeClubId: 'club-A' })).toBeNull();
  });

  it('a REFUNDED paid reg under another club does not lock', () => {
    const regs = [makeReg({ clubId: 'club-B', paid: true, refunded: true })];
    expect(paidRegistrationClub(regs, { ...args, excludeClubId: 'club-A' })).toBeNull();
  });

  it('ignores other events and other athletes', () => {
    const regs = [
      makeReg({ clubId: 'club-B', paid: true, eventId: 'meet-2' }),
      makeReg({ clubId: 'club-B', paid: true, athleteId: 'a-2' }),
    ];
    expect(paidRegistrationClub(regs, { ...args, excludeClubId: 'club-A' })).toBeNull();
  });

  it('omitting excludeClubId returns ANY paid-reg club (self-reg lock probe)', () => {
    const regs = [makeReg({ clubId: 'club-A', paid: true })];
    expect(paidRegistrationClub(regs, args)).toBe('club-A');
  });
});
