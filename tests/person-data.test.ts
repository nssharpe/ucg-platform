import { describe, it, expect } from 'vitest';
import { collectPersonData, ALL_DB_COLLECTION_KEYS, EXCLUDED_COLLECTIONS } from '../src/lib/person-data';
import type { DB } from '../src/lib/types';

// The keys collectPersonData actually reads from `db` (kept in sync by hand;
// the completeness test below cross-checks it against ALL_DB_COLLECTION_KEYS
// minus EXCLUDED_COLLECTIONS, and the inclusion tests further down prove each
// one is ACTUALLY wired up, not just named here).
const COLLECTED_KEYS: (keyof DB)[] = [
  'people', 'clubs', 'registrations', 'scores', 'invoices', 'carts',
  'clubRequests', 'accountInvites', 'sanctionRequests', 'sanctionVotes',
  'waiverSignatures', 'payments', 'eventAdmins', 'refundRequests',
  'waitlistGroups', 'sessionRequests', 'eventCheckins', 'coupons',
];

describe('person-data completeness', () => {
  it('every DB collection is either collected or explicitly excluded with a reason', () => {
    const excludedKeys = Object.keys(EXCLUDED_COLLECTIONS) as (keyof DB)[];
    for (const key of ALL_DB_COLLECTION_KEYS) {
      const collected = COLLECTED_KEYS.includes(key);
      const excluded = excludedKeys.includes(key);
      expect(collected || excluded, `DB.${key} must be collected or excluded`).toBe(true);
      expect(collected && excluded, `DB.${key} must not be BOTH collected and excluded`).toBe(false);
    }
  });

  it('EXCLUDED_COLLECTIONS entries all carry a non-empty reason', () => {
    for (const [key, reason] of Object.entries(EXCLUDED_COLLECTIONS)) {
      expect(typeof reason, `reason for ${key}`).toBe('string');
      expect((reason as string).trim().length, `reason for ${key} must be non-empty`).toBeGreaterThan(0);
    }
  });

  it('COLLECTED_KEYS + EXCLUDED_COLLECTIONS exactly partition every DB key (no leftovers, no dupes)', () => {
    const excludedKeys = Object.keys(EXCLUDED_COLLECTIONS) as (keyof DB)[];
    const union = new Set([...COLLECTED_KEYS, ...excludedKeys]);
    expect(union.size).toBe(COLLECTED_KEYS.length + excludedKeys.length); // no overlap
    expect(union.size).toBe(ALL_DB_COLLECTION_KEYS.length); // no leftovers
  });
});

// ---------------------------------------------------------------------------
// Inclusion logic — a small seeded db proves each COLLECTED collection is
// actually wired into collectPersonData's output, not just named above.
// ---------------------------------------------------------------------------
function baseDb(): DB {
  return {
    seasons: [], levels: [], clubs: [], people: [], events: [],
    registrations: [], scores: [], invoices: [], coupons: [], carts: {},
    clubRequests: [], accountInvites: [], sanctionRequests: [], sanctionVotes: [],
    waiverSignatures: [], payments: [], eventAdmins: [], refundRequests: [],
    waitlistGroups: [], sessionRequests: [], eventCheckins: [],
  } as unknown as DB;
}

const PID = 'p1';
const AUTH_UID = 'auth-1';

describe('collectPersonData inclusion', () => {
  it('returns null person for an unknown id, empty collections otherwise', () => {
    const db = baseDb();
    const out = collectPersonData(db, PID, [], [], db.invoices);
    expect(out.person).toBeNull();
    expect(out.registrations).toEqual([]);
    expect(out.scores).toEqual([]);
  });

  it('collects the person row', () => {
    const db = baseDb();
    db.people = [{ id: PID, authUserId: AUTH_UID, firstName: 'A', lastName: 'B' } as never];
    const out = collectPersonData(db, PID, db.scores, db.registrations, db.invoices);
    expect(out.person?.id).toBe(PID);
  });

  it('collects clubs the person manages', () => {
    const db = baseDb();
    db.clubs = [{ id: 'c1', managerIds: [PID] } as never, { id: 'c2', managerIds: ['other'] } as never];
    const out = collectPersonData(db, PID, db.scores, db.registrations, db.invoices);
    expect(out.managedClubs.map((c) => c.id)).toEqual(['c1']);
  });

  it('collects registrations by athleteId and their scores by regId join', () => {
    const db = baseDb();
    db.registrations = [
      { id: 'r1', athleteId: PID } as never,
      { id: 'r2', athleteId: 'other' } as never,
    ];
    db.scores = [
      { id: 's1', regId: 'r1' } as never,
      { id: 's2', regId: 'r2' } as never,
    ];
    const out = collectPersonData(db, PID, db.scores, db.registrations, db.invoices);
    expect(out.registrations.map((r) => r.id)).toEqual(['r1']);
    expect(out.scores.map((s) => s.id)).toEqual(['s1']);
  });

  it('collects invoices billed to the person', () => {
    const db = baseDb();
    db.invoices = [{ id: 'i1', athleteId: PID } as never, { id: 'i2', athleteId: 'other' } as never];
    const out = collectPersonData(db, PID, db.scores, db.registrations, db.invoices);
    expect(out.invoicesBilled.map((i) => i.id)).toEqual(['i1']);
  });

  it("collects the person's own cart", () => {
    const db = baseDb();
    db.carts = { [PID]: [{ id: 'ci1' } as never], other: [{ id: 'ci2' } as never] };
    const out = collectPersonData(db, PID, db.scores, db.registrations, db.invoices);
    expect(out.cartItems.map((i) => i.id)).toEqual(['ci1']);
  });

  it('collects clubRequests/accountInvites/sanctionRequests/refundRequests by their person-fk fields', () => {
    const db = baseDb();
    db.clubRequests = [{ id: 'cr1', requesterPersonId: PID } as never];
    db.accountInvites = [{ id: 'ai1', personId: PID } as never];
    db.sanctionRequests = [{ id: 'sr1', requesterPersonId: PID } as never];
    db.refundRequests = [{ id: 'rr1', requesterPersonId: PID } as never];
    const out = collectPersonData(db, PID, db.scores, db.registrations, db.invoices);
    expect(out.clubRequests.map((r) => r.id)).toEqual(['cr1']);
    expect(out.accountInvites.map((r) => r.id)).toEqual(['ai1']);
    expect(out.sanctionRequests.map((r) => r.id)).toEqual(['sr1']);
    expect(out.refundRequests.map((r) => r.id)).toEqual(['rr1']);
  });

  it('collects sanctionVotes matching either personId or authUserId', () => {
    const db = baseDb();
    db.people = [{ id: PID, authUserId: AUTH_UID } as never];
    db.sanctionVotes = [
      { id: 'v1', voterUserId: PID } as never,
      { id: 'v2', voterUserId: AUTH_UID } as never,
      { id: 'v3', voterUserId: 'someone-else' } as never,
    ];
    const out = collectPersonData(db, PID, db.scores, db.registrations, db.invoices);
    expect(out.sanctionVotes.map((v) => v.id).sort()).toEqual(['v1', 'v2']);
  });

  it('collects waiverSignatures/payments/waitlistGroups/sessionRequests/eventCheckins by personId', () => {
    const db = baseDb();
    db.waiverSignatures = [{ id: 'w1', personId: PID } as never];
    db.payments = [{ id: 'pay1', personId: PID } as never];
    db.waitlistGroups = [{ id: 'wg1', personId: PID } as never];
    db.sessionRequests = [{ id: 'sq1', personId: PID } as never];
    db.eventCheckins = [{ id: 'ck1', personId: PID } as never];
    const out = collectPersonData(db, PID, db.scores, db.registrations, db.invoices);
    expect(out.waiverSignatures.map((r) => r.id)).toEqual(['w1']);
    expect(out.payments.map((r) => r.id)).toEqual(['pay1']);
    expect(out.waitlistGroups.map((r) => r.id)).toEqual(['wg1']);
    expect(out.sessionRequests.map((r) => r.id)).toEqual(['sq1']);
    expect(out.eventCheckins.map((r) => r.id)).toEqual(['ck1']);
  });

  it('collects eventAdmins by matching authUserId (not personId)', () => {
    const db = baseDb();
    db.people = [{ id: PID, authUserId: AUTH_UID } as never];
    db.eventAdmins = [{ id: 'ea1', userId: AUTH_UID } as never, { id: 'ea2', userId: 'someone-else' } as never];
    const out = collectPersonData(db, PID, db.scores, db.registrations, db.invoices);
    expect(out.eventAdmins.map((r) => r.id)).toEqual(['ea1']);
  });

  it('collects coupons restricted to this person', () => {
    const db = baseDb();
    db.coupons = [
      { code: 'PERSONAL', restrictedToPersonId: PID } as never,
      { code: 'GENERAL', restrictedToPersonId: null } as never,
    ];
    const out = collectPersonData(db, PID, db.scores, db.registrations, db.invoices);
    expect(out.restrictedCoupons.map((c) => c.code)).toEqual(['PERSONAL']);
  });
});
