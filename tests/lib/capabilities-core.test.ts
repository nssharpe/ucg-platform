import { describe, it, expect } from 'vitest';
import { deriveCapabilities, currentSeasonId } from '../../src/lib/capabilities-core';
import type { Athlete, Club, DB, Meet, Season } from '../../src/lib/types';

// --- Fixture helpers --------------------------------------------------------

function makeDb(partial: Partial<DB>): DB {
  return {
    seasons: [],
    levels: [],
    clubs: [],
    people: [],
    meets: [],
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

function makeMeet(overrides: Partial<Meet>): Meet {
  return {
    id: 'meet-x',
    slug: 'meet-x',
    name: 'Meet X',
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
// meets: meet-1 (hosted by club-A)

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

const clubA = makeClub({ id: 'club-A', name: 'Club A', shortName: 'CA', managerIds: ['p-coach'] });
const clubB = makeClub({ id: 'club-B', name: 'Club B', shortName: 'CB', managerIds: [] });

const meet1 = makeMeet({ id: 'meet-1', slug: 'meet-1', name: 'Meet 1', hostClubId: 'club-A' });
const meetClubB = makeMeet({ id: 'meet-clubB', slug: 'meet-clubb', name: 'Meet Club B', hostClubId: 'club-B' });

const db = makeDb({
  seasons: [s1],
  people: [pAdmin, pCoach, pAthleteActive, pAthleteNone],
  clubs: [clubA, clubB],
  meets: [meet1, meetClubB],
});

// --- Tests --------------------------------------------------------------------

describe('deriveCapabilities', () => {
  it('1. admin: full access, hosts any meet, no impersonation', () => {
    const caps = deriveCapabilities(db, true, ['admin'], 'p-admin', null, 's1');

    expect(caps.isAdmin).toBe(true);
    expect(caps.impersonating).toBe(false);
    expect(caps.personId).toBe('p-admin');
    expect(caps.isMeetHost('meet-1')).toBe(true); // admins host any meet
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

  it('4. club manager: managedClubIds includes their club, isMeetHost reflects host club', () => {
    const caps = deriveCapabilities(db, true, [], 'p-coach', null, 's1');

    expect(caps.managedClubIds).toContain('club-A');
    expect(caps.isMeetHost('meet-1')).toBe(true); // manages club-A, which hosts meet-1
    expect(caps.isMeetHost('meet-clubB')).toBe(false); // hosted by club-B, not managed
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
});

describe('currentSeasonId', () => {
  it('7. returns the id of the season flagged current', () => {
    expect(currentSeasonId(db)).toBe('s1');
  });
});
