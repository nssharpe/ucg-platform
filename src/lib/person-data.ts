// Pure collector: everything the app holds about one person, gathered from
// the DB shape (F5, docs/specs/2026-07-18-...-recon-export-seasons.md §F5).
// Used by the admin "Export data" action (JSON + PDF) and, indirectly, to
// scope what `admin-delete-person` must delete/anonymize/keep.
//
// COMPLETENESS: every key of `DB` (src/lib/types.ts) must appear in EXACTLY
// ONE of `EXCLUDED_COLLECTIONS` (with a one-line reason) or the set of
// collections `collectPersonData` actually reads. `ALL_DB_COLLECTIONS` below
// is a `Record<keyof DB, true>` object literal — TypeScript requires every
// key of `DB` to be present, so adding a new DB collection without updating
// this file is a COMPILE error, not just a stale doc. `tests/person-data.test.ts`
// additionally verifies (a) EXCLUDED_COLLECTIONS + the collected set exactly
// partition ALL_DB_COLLECTIONS and (b) a seeded row in every COLLECTED
// collection actually surfaces in `collectPersonData`'s output.
import type {
  DB, Athlete, Club, Registration, Score, Invoice, CartItem, ClubRequest,
  AccountInvite, SanctionRequest, SanctionVote, WaiverSignature, Payment,
  EventAdmin, RefundRequest, WaitlistGroup, SessionRequest, EventCheckin, Coupon,
} from './types';

/** Exhaustiveness anchor — see file header. Every `DB` key must be listed
 *  here (value is irrelevant; only key-presence is checked by TS). */
const ALL_DB_COLLECTIONS: Record<keyof DB, true> = {
  seasons: true, levels: true, clubs: true, people: true, events: true,
  registrations: true, scores: true, invoices: true, coupons: true, carts: true,
  clubRequests: true, regionOverrides: true, accountInvites: true, sanctionRequests: true,
  sanctionVotes: true, waiverDocuments: true, waiverSignatures: true, clubMemberships: true,
  payments: true, eventAdmins: true, refundRequests: true, waitlistGroups: true,
  sessionRequests: true, competitionOrders: true, finalsLineups: true, eventCheckins: true,
  accountingCodes: true, hostPayouts: true, judgeAccessCodes: true,
};
export const ALL_DB_COLLECTION_KEYS = Object.keys(ALL_DB_COLLECTIONS) as (keyof DB)[];

/** DB collections that hold NO person-shaped data (or whose only person link
 *  is operational/audit metadata, not data ABOUT the export subject) — each
 *  with a one-line reason. Every other `DB` key is read by `collectPersonData`. */
export const EXCLUDED_COLLECTIONS: Partial<Record<keyof DB, string>> = {
  seasons: 'season reference data (dates/fees) — no person link',
  levels: 'level reference data — no person link',
  events: 'event metadata — director/owner fields are free text or auth-user ids, not a people.id FK',
  regionOverrides: 'admin state→region map — no person link',
  waiverDocuments: 'versioned legal TEXT of the waiver itself — the signatures (person-linked) are in waiverSignatures',
  clubMemberships: "club-level (clubId+seasonId) — no person link; the person's own Membership objects are embedded on their people row and included via `person`",
  competitionOrders: 'club-scoped drag/drop competing order — no direct person FK column',
  finalsLineups: "club-scoped roster (regIds array); the athlete's own data is already covered via registrations/scores",
  accountingCodes: 'admin bookkeeping config — no person link',
  hostPayouts: 'operational payout record; createdBy is the staffer who RECORDED it, not the export subject — no subject-person FK',
  judgeAccessCodes: 'operational security artifact (event access code/token); createdBy is the host who GENERATED it, not the export subject — no subject-person FK',
};

/** Every piece of data the app holds about one person, gathered for the
 *  admin "Export data" action. Deliberately a plain data shape (not the
 *  live `db` object) so it's easy to unit test and to serialize as-is. */
export interface PersonDataExport {
  personId: string;
  generatedAt: string;
  /** Null if the person id doesn't resolve (already deleted/tombstoned). */
  person: Athlete | null;
  /** Clubs this person manages (clubs.managerIds includes personId) — part
   *  of "club affiliations" alongside person.mainClubId/altClubIds (already
   *  on `person`). */
  managedClubs: Club[];
  registrations: Registration[];
  /** Scores for THIS person's registrations (joined via registrations.id). */
  scores: Score[];
  /** Invoices billed to this person (invoices.athleteId === personId). */
  invoicesBilled: Invoice[];
  /** This person's own cart (db.carts keyed by personId). */
  cartItems: CartItem[];
  clubRequests: ClubRequest[];
  accountInvites: AccountInvite[];
  sanctionRequests: SanctionRequest[];
  /** Sanctioning-team votes cast by this person (voterUserId matches either
   *  their people.id or their authUserId — both are used as the key in
   *  practice, see Sanction.tsx). */
  sanctionVotes: SanctionVote[];
  waiverSignatures: WaiverSignature[];
  payments: Payment[];
  /** Per-event admin grants held by this person (eventAdmins.userId is an
   *  auth user id — matched against person.authUserId). */
  eventAdmins: EventAdmin[];
  refundRequests: RefundRequest[];
  waitlistGroups: WaitlistGroup[];
  sessionRequests: SessionRequest[];
  eventCheckins: EventCheckin[];
  /** Coupons restricted to this person only (Coupon.restrictedToPersonId). */
  restrictedCoupons: Coupon[];
}

/** Pure: gather every piece of data the app holds about `personId` from a
 *  DB-shaped object. No I/O — callers pass the live `db` (or, for the
 *  vitest suite, a small seeded fixture). */
export function collectPersonData(db: DB, personId: string): PersonDataExport {
  const person = db.people.find((p) => p.id === personId) ?? null;
  const authUserId = person?.authUserId ?? null;

  const registrations = db.registrations.filter((r) => r.athleteId === personId);
  const regIds = new Set(registrations.map((r) => r.id));
  const scores = db.scores.filter((s) => regIds.has(s.regId));

  const invoicesBilled = db.invoices.filter((inv) => inv.athleteId === personId);
  const cartItems = db.carts[personId] ?? [];

  const managedClubs = db.clubs.filter((c) => c.managerIds.includes(personId));

  const clubRequests = (db.clubRequests ?? []).filter((r) => r.requesterPersonId === personId);
  const accountInvites = (db.accountInvites ?? []).filter((i) => i.personId === personId);
  const sanctionRequests = (db.sanctionRequests ?? []).filter((r) => r.requesterPersonId === personId);
  const sanctionVotes = (db.sanctionVotes ?? []).filter(
    (v) => v.voterUserId === personId || (!!authUserId && v.voterUserId === authUserId),
  );
  const waiverSignatures = (db.waiverSignatures ?? []).filter((w) => w.personId === personId);
  const payments = (db.payments ?? []).filter((pm) => pm.personId === personId);
  const eventAdmins = (db.eventAdmins ?? []).filter((ea) => !!authUserId && ea.userId === authUserId);
  const refundRequests = (db.refundRequests ?? []).filter((r) => r.requesterPersonId === personId);
  const waitlistGroups = (db.waitlistGroups ?? []).filter((w) => w.personId === personId);
  const sessionRequests = (db.sessionRequests ?? []).filter((s) => s.personId === personId);
  const eventCheckins = (db.eventCheckins ?? []).filter((c) => c.personId === personId);
  const restrictedCoupons = (db.coupons ?? []).filter((c) => c.restrictedToPersonId === personId);

  return {
    personId,
    generatedAt: new Date().toISOString(),
    person,
    managedClubs,
    registrations,
    scores,
    invoicesBilled,
    cartItems,
    clubRequests,
    accountInvites,
    sanctionRequests,
    sanctionVotes,
    waiverSignatures,
    payments,
    eventAdmins,
    refundRequests,
    waitlistGroups,
    sessionRequests,
    eventCheckins,
    restrictedCoupons,
  };
}
