// Pure capability derivation — no React, no store, no Supabase imports (only
// types, which erase at compile time). This is the security-critical core, kept
// importable in a plain Node test environment. The React hooks that feed it the
// live session/DB/impersonation live in capabilities.ts.
import type { Athlete, DB, Membership, MembershipStatus, Registration } from './types';

export interface Capabilities {
  signedIn: boolean;
  /** True when the real signed-in user holds the 'admin' role, regardless of
   *  impersonation. Use this to show the impersonation ("View as") control. */
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
  /** True only when the user is a real admin AND not currently impersonating
   *  anyone. Use this to gate admin POWERS in the UI (admin nav, edit buttons,
   *  grant/revoke) so that "View as (person)" faithfully shows what that
   *  non-admin person would see. */
  actingAsAdmin: boolean;
  /** The acting person (impersonated target if an admin is impersonating). */
  personId: string | null;
  person: Athlete | null;
  managedClubIds: string[];
  isMeetHost: (meetId: string) => boolean;
  /** The acting person's current-season membership status. */
  currentMembership: MembershipStatus;
  canRegister: boolean;
  impersonating: boolean;
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
 *  with for a meet — so they can't be registered again under a DIFFERENT club.
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
  opts: { athleteId: string; meetId: string; excludeClubId?: string | null },
): string | null {
  const { athleteId, meetId, excludeClubId } = opts;
  const hit = registrations.find(
    (r) =>
      r.meetId === meetId &&
      r.athleteId === athleteId &&
      r.paid === true &&
      !r.refunded &&
      r.clubId !== excludeClubId,
  );
  return hit ? hit.clubId : null;
}

/** Derive what the current (possibly impersonated) user can do.
 *  Impersonation only applies when the real user is an admin — a non-admin with
 *  a stray viewPersonId stays themselves. */
export function deriveCapabilities(
  db: DB,
  signedIn: boolean,
  roles: string[],
  authPersonId: string | null,
  viewPersonId: string | null,
  seasonId: string | null,
): Capabilities {
  const isAdmin = roles.includes('admin');
  const isSanctioning = isAdmin || roles.includes('sanctioning');
  const isFinanceAdmin = roles.includes('finance_admin');
  const isRegionalRep = roles.includes('regional_rep');
  const impersonating = isAdmin && !!viewPersonId && viewPersonId !== authPersonId;
  const personId = impersonating ? viewPersonId : authPersonId;
  const person = personId ? db.people.find((p) => p.id === personId) ?? null : null;
  const managedClubIds = personId
    ? db.clubs.filter((c) => c.managerIds.includes(personId)).map((c) => c.id)
    : [];
  const membership = person && seasonId
    ? person.memberships.find((m) => m.seasonId === seasonId)
    : undefined;
  const currentMembership: MembershipStatus = membership?.status ?? 'none';
  return {
    signedIn,
    isAdmin,
    isSanctioning,
    isFinanceAdmin,
    isRegionalRep,
    actingAsAdmin: isAdmin && !impersonating,
    personId,
    person,
    managedClubIds,
    impersonating,
    isMeetHost: (meetId: string) => {
      if (isAdmin) return true;
      const meet = db.meets.find((m) => m.id === meetId);
      return !!meet && managedClubIds.includes(meet.hostClubId);
    },
    currentMembership,
    canRegister: signedIn && currentMembership === 'active',
  };
}
