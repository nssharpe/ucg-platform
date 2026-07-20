// Pure capability derivation — no React, no store, no Supabase imports (only
// types, which erase at compile time). This is the security-critical core, kept
// importable in a plain Node test environment. The React hooks that feed it the
// live session/DB/impersonation live in capabilities.ts.
import type { Athlete, DB, Event, Membership, MembershipStatus, Registration } from './types';

export interface Capabilities {
  signedIn: boolean;
  /** True when the signed-in user holds the 'admin' role. Gates admin powers
   *  in the UI (admin nav, edit buttons, grant/revoke). */
  isAdmin: boolean;
  /** True when the user is on the Sanctioning Team (or an admin). Gates the
   *  Sanctioning queue / vote pages. Admins are implicitly on the team. */
  isSanctioning: boolean;
  /** True when the user holds the 'finance_admin' role. Gates a later
   *  finance-dashboard phase. Admins are NOT implicitly finance admins. */
  isFinanceAdmin: boolean;
  /** True when the user holds the 'regional_rep' role. Admins are NOT
   *  implicitly regional reps. */
  isRegionalRep: boolean;
  /** True when the user holds the 'refund_manager' role (event-mgmt v2 Phase
   *  3, spec §H). Admins are NOT implicitly refund managers — page gates use
   *  `isAdmin || isRefundManager` explicitly, matching isFinanceAdmin. */
  isRefundManager: boolean;
  /** The acting (signed-in) person. */
  personId: string | null;
  person: Athlete | null;
  managedClubIds: string[];
  isEventHost: (eventId: string) => boolean;
  /** The acting person's current-season membership status, preferring the
   *  ATHLETE-type row (falls back to the COACH-type row, then 'none'). This is
   *  a generic "do they have SOME membership" summary for display — it does
   *  NOT gate registration (use `canRegister`) and does NOT tell you which
   *  type is active (use `athleteMembership`/`coachMembership` for that). */
  currentMembership: MembershipStatus;
  /** The acting person's ATHLETE-type membership row for the current season,
   *  or null if they hold none. A membership row with no `type` (legacy data
   *  predating typed memberships) is treated as an athlete row — matching the
   *  DB column default (`type` defaults to 'athlete', migration 0007). This is
   *  the row that gates `canRegister` — competing requires an ACTIVE athlete
   *  membership; a coach-only membership does not confer it. */
  athleteMembership: Membership | null;
  /** The acting person's COACH-type membership row for the current season, or
   *  null if they hold none. Display-only (e.g. the topbar coach badge) — a
   *  coach membership never gates competition registration. */
  coachMembership: Membership | null;
  /** True only when the acting person holds an ACTIVE athlete-type membership
   *  for the current season. A coach-only membership does NOT grant this —
   *  registering to compete always requires an athlete membership. */
  canRegister: boolean;
}

/** Treats a membership row with no `type` (legacy data from before typed
 *  memberships shipped) as an athlete row — this mirrors the DB column
 *  default (`type` defaults to 'athlete', migration 20260618000007). */
export function membershipTypeOf(m: Pick<Membership, 'type'>): 'athlete' | 'coach' {
  return m.type === 'coach' ? 'coach' : 'athlete';
}

export function currentSeasonId(db: DB): string | null {
  return db.seasons.find((s) => s.current)?.id ?? null;
}

/** The season whose [startsOn, endsOn] window contains `dateISO` (YYYY-MM-DD).
 *  Falls back to the current season when no window matches. */
export function seasonForDate(db: DB, dateISO: string): string | null {
  const d = (dateISO ?? '').slice(0, 10);
  if (d) {
    const hit = db.seasons.find((s) => s.startsOn && s.endsOn && d >= s.startsOn && d <= s.endsOn);
    if (hit) return hit.id;
  }
  return currentSeasonId(db);
}

/** True when a club holds an active membership for the given season — the gate
 *  for that club's athletes registering and the club hosting that season. */
export function clubHasActiveMembership(db: DB, clubId: string | null, seasonId: string | null): boolean {
  if (!clubId || !seasonId) return false;
  return (db.clubMemberships ?? []).some(
    (cm) => cm.clubId === clubId && cm.seasonId === seasonId && cm.status === 'active',
  );
}

/** Whether the club-membership gate applies to REGISTERING for an event of
 *  this type (event-mgmt v2 §G, Julia-confirmed 2026-07-06). Camps are
 *  individual self-registration only — a camp registrant's club needn't hold
 *  a club membership, so the gate is waived. Competitions (the default, incl.
 *  `undefined`) keep the gate. This does NOT touch the separate individual-
 *  membership requirement (`Capabilities.canRegister`), which still applies
 *  to camps, nor a club's OWN membership requirement to HOST an event. */
export function clubMembershipGateApplies(eventType: Event['eventType'] | undefined): boolean {
  return eventType !== 'camp';
}

/** Event-aware wrapper around `clubHasActiveMembership`: for a camp, the club
 *  gate is waived entirely (always "satisfied"); for a competition, delegates
 *  to the plain check. Use this at every REGISTRATION entry point that gates
 *  on the competing club's membership; use the plain `clubHasActiveMembership`
 *  for non-registration purposes (e.g. the club membership status card, or a
 *  club's hosting eligibility). */
export function clubHasActiveMembershipForEvent(
  db: DB,
  clubId: string | null,
  seasonId: string | null,
  eventType: Event['eventType'] | undefined,
): boolean {
  if (!clubMembershipGateApplies(eventType)) return true;
  return clubHasActiveMembership(db, clubId, seasonId);
}

/** The independent holds keeping a membership from being fully active. Both can
 *  apply at once: a minor athlete who pushed their fee to the club cart is BOTH
 *  awaiting a guardian waiver AND awaiting the club's payment. Derived purely
 *  from the membership's own fields so callers don't have to reason about the
 *  single status enum (which can't represent both holds simultaneously).
 *
 *  - waiverHold: the waiver is not yet signed.
 *  - paymentHold: the fee is sitting unpaid in a club cart (member-pushed).
 *  When neither holds, the membership is active. */
export function membershipHolds(m: Pick<Membership, 'status' | 'waiverSignedAt' | 'clubCartPending'>): {
  waiverHold: boolean;
  paymentHold: boolean;
  active: boolean;
} {
  const waiverHold = !m.waiverSignedAt;
  // A club-pushed fee is pending until paid. `clubCartPending` is the explicit
  // flag; fall back to the legacy `pending-club-payment` status for memberships
  // created before the flag existed.
  const paymentHold = m.clubCartPending === true || m.status === 'pending-club-payment';
  return { waiverHold, paymentHold, active: !waiverHold && !paymentHold };
}

/** Cross-club registration lock (3d): the club a member is already PAID-registered
 *  with for an event — so they can't be registered again under a DIFFERENT club.
 *
 *  Only a non-refunded, PAID registration locks the member. A merely
 *  pending-purchase (paid !== true) registration sitting in some club's cart does
 *  NOT block another club from registering them. Registrations under the club
 *  currently being registered for (`excludeClubId`) are ignored — that's a normal
 *  edit of an existing registration, not a cross-club conflict.
 *
 *  Returns the locking club's id, or null when the member is free to register
 *  under `excludeClubId`. */
export function paidRegistrationClub(
  registrations: Registration[],
  opts: { athleteId: string; eventId: string; excludeClubId?: string | null },
): string | null {
  const { athleteId, eventId, excludeClubId } = opts;
  const hit = registrations.find(
    (r) =>
      r.eventId === eventId &&
      r.athleteId === athleteId &&
      r.paid === true &&
      !r.refunded &&
      r.clubId !== excludeClubId,
  );
  return hit ? hit.clubId : null;
}

/** Derive what the current signed-in user can do. */
export function deriveCapabilities(
  db: DB,
  signedIn: boolean,
  roles: string[],
  personId: string | null,
  seasonId: string | null,
  /** Event ids where the signed-in auth user holds a per-event admin grant
   *  (`event_admins` rows, event-mgmt v2 §C) — makes isEventHost() true for
   *  exactly those events. Grants are auth-uid-scoped (not person-scoped),
   *  so callers derive this from the session uid, paralleling how RLS scopes
   *  the readable rows. Defaults to none. */
  eventAdminEventIds: string[] = [],
): Capabilities {
  const isAdmin = roles.includes('admin');
  const isSanctioning = isAdmin || roles.includes('sanctioning');
  const isFinanceAdmin = roles.includes('finance_admin');
  const isRegionalRep = roles.includes('regional_rep');
  const isRefundManager = roles.includes('refund_manager');
  const person = personId ? db.people.find((p) => p.id === personId) ?? null : null;
  const managedClubIds = personId
    ? db.clubs.filter((c) => c.managerIds.includes(personId)).map((c) => c.id)
    : [];
  const athleteMembership = person && seasonId
    ? person.memberships.find((m) => m.seasonId === seasonId && membershipTypeOf(m) === 'athlete') ?? null
    : null;
  const coachMembership = person && seasonId
    ? person.memberships.find((m) => m.seasonId === seasonId && membershipTypeOf(m) === 'coach') ?? null
    : null;
  const currentMembership: MembershipStatus = athleteMembership?.status ?? coachMembership?.status ?? 'none';
  return {
    signedIn,
    isAdmin,
    isSanctioning,
    isFinanceAdmin,
    isRegionalRep,
    isRefundManager,
    personId,
    person,
    managedClubIds,
    isEventHost: (eventId: string) => {
      if (isAdmin) return true;
      if (eventAdminEventIds.includes(eventId)) return true;
      const event = db.events.find((m) => m.id === eventId);
      return !!event && managedClubIds.includes(event.hostClubId);
    },
    currentMembership,
    athleteMembership,
    coachMembership,
    canRegister: signedIn && athleteMembership?.status === 'active',
  };
}
