// React hooks that feed the live session/DB/impersonation into the pure
// capability derivation (capabilities-core.ts). Replaces the prototype's
// single-role useRole() switcher.
//
// When Supabase is not configured (password-gate prototype), there is no real
// session, so we grant full admin tied to the selected persona — this keeps the
// local-seed demo fully explorable while real auth governs the configured app.
import type { DB } from './types';
import { getDB, getPersona, getViewPersonId, useDB, usePersona, useViewPersonId } from './store';
import { getSession, getMyRoles, useMyRoles, useSession } from './auth';
import { isSupabaseConfigured } from './supabase';
import { type Capabilities, currentSeasonId, deriveCapabilities } from './capabilities-core';

export type { Capabilities };
export { deriveCapabilities };

/** Resolve the signed-in user's person row. The authoritative key is the auth
 *  uid (people.auth_user_id, set by link_or_create_person); email is only a
 *  fallback while the linked row hasn't hydrated yet. Email is NOT unique, so
 *  never trust it over the uid. */
function authPersonId(db: DB, uid: string | undefined | null, email: string | undefined | null): string | null {
  if (uid) {
    const byUid = db.people.find((p) => p.authUserId === uid);
    if (byUid) return byUid.id;
  }
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
  const personId = authPersonId(db, session?.user?.id, session?.user?.email);
  return deriveCapabilities(db, !!session, roles, personId, getViewPersonId(), season);
}

export function getCapabilities(): Capabilities {
  const db = getDB();
  const season = currentSeasonId(db);
  if (!isSupabaseConfigured) {
    return deriveCapabilities(db, true, ['admin'], getPersona().athleteId, null, season);
  }
  const session = getSession();
  const personId = authPersonId(db, session?.user?.id, session?.user?.email);
  return deriveCapabilities(db, !!session, getMyRoles(), personId, getViewPersonId(), season);
}
