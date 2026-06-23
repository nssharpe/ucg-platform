// Pure capability derivation — no React, no store, no Supabase imports (only
// types, which erase at compile time). This is the security-critical core, kept
// importable in a plain Node test environment. The React hooks that feed it the
// live session/DB/impersonation live in capabilities.ts.
import type { Athlete, DB, MembershipStatus } from './types';

export interface Capabilities {
  signedIn: boolean;
  /** True when the real signed-in user holds the 'admin' role, regardless of
   *  impersonation. Use this to show the impersonation ("View as") control. */
  isAdmin: boolean;
  /** True when the user is on the Sanctioning Team (or an admin). Gates the
   *  Sanctioning queue / vote pages. Admins are implicitly on the team. */
  isSanctioning: boolean;
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
