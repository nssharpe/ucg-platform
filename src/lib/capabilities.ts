// The single source of truth for "what can the current user do", derived from
// the auth session, the user's roles, the DB, and (admin-only) impersonation.
// Replaces the prototype's single-role useRole() switcher.
//
// When Supabase is not configured (password-gate prototype), there is no real
// session, so we grant full admin tied to the selected persona — this keeps the
// local-seed demo fully explorable while real auth governs the configured app.
import type { Athlete, DB, MembershipStatus } from './types';
import { getDB, getPersona, getViewPersonId, useDB, usePersona, useViewPersonId } from './store';
import { getSession, getMyRoles, useMyRoles, useSession } from './auth';
import { isSupabaseConfigured } from './supabase';

export interface Capabilities {
  signedIn: boolean;
  isAdmin: boolean;
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

function currentSeasonId(db: DB): string | null {
  return db.seasons.find((s) => s.current)?.id ?? null;
}

/** Pure derivation — testable without React or Supabase. */
export function deriveCapabilities(
  db: DB,
  signedIn: boolean,
  roles: string[],
  authPersonId: string | null,
  viewPersonId: string | null,
  seasonId: string | null,
): Capabilities {
  const isAdmin = roles.includes('admin');
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

/** Match the signed-in user's email to a person row (the linked row shares it). */
function personIdForEmail(db: DB, email: string | undefined | null): string | null {
  if (!email) return null;
  const lower = email.toLowerCase();
  return db.people.find((p) => p.email && p.email.toLowerCase() === lower)?.id ?? null;
}

export function useCapabilities(): Capabilities {
  // Hooks run unconditionally; we branch on configuration afterward.
  const db = useDB();
  const session = useSession();
  const roles = useMyRoles();
  useViewPersonId();
  const persona = usePersona();
  const season = currentSeasonId(db);

  if (!isSupabaseConfigured) {
    return deriveCapabilities(db, true, ['admin'], persona.athleteId, null, season);
  }
  const authPersonId = personIdForEmail(db, session?.user?.email);
  return deriveCapabilities(db, !!session, roles, authPersonId, getViewPersonId(), season);
}

export function getCapabilities(): Capabilities {
  const db = getDB();
  const season = currentSeasonId(db);
  if (!isSupabaseConfigured) {
    return deriveCapabilities(db, true, ['admin'], getPersona().athleteId, null, season);
  }
  const authPersonId = personIdForEmail(db, getSession()?.user?.email);
  return deriveCapabilities(db, !!getSession(), getMyRoles(), authPersonId, getViewPersonId(), season);
}
