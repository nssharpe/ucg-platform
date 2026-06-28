// Supabase auth session tracking, exposed via useSyncExternalStore the same
// way src/lib/store.ts exposes its other reactive state. On the first
// authenticated load it links the auth user to a person row (claim-by-email or
// create) and fetches the user's app roles.
import { useSyncExternalStore } from 'react';
import type { Session } from '@supabase/supabase-js';
import { fetchMyRoles, isSupabaseConfigured, linkOrCreatePerson, pushPerson, supabase } from './supabase';
import { getDB, mutate, syncFromSupabase } from './store';

let session: Session | null = null;
// True until the initial getSession() resolves — lets callers avoid flashing
// the gate for a signed-in user on refresh.
let loading = isSupabaseConfigured;
let roles: string[] = [];
// False until the first fetchMyRoles() resolves for the current user, so role
// gates can show a loader instead of flashing "access denied" on refresh while
// roles are still in flight. When Supabase is unconfigured there are no roles to
// load, so treat them as already resolved.
let rolesLoaded = !isSupabaseConfigured;
let linkedUserId: string | null = null; // auth user we've already linked this session
const listeners = new Set<() => void>();
const roleListeners = new Set<() => void>();

function notify() { listeners.forEach((l) => l()); }
function notifyRoles() { roleListeners.forEach((l) => l()); }

/** Read first/last name stashed by the sign-up form (Gate.tsx). */
function stashedName(): [string, string] {
  try {
    const raw = localStorage.getItem('ucg-signup-name');
    if (raw) { const [f, l] = JSON.parse(raw); return [f ?? '', l ?? '']; }
  } catch { /* ignore */ }
  return ['', ''];
}

/** Read the person kind stashed by the sign-up form (Gate.tsx). */
function stashedKind(): 'athlete' | 'coach' | null {
  try {
    const raw = localStorage.getItem('ucg-signup-kind');
    if (raw === 'athlete' || raw === 'coach') return raw;
  } catch { /* ignore */ }
  return null;
}

/** Once per signed-in user: link/create their person row, then load roles. */
async function onAuthenticated(user: Session['user']) {
  if (linkedUserId === user.id) return;
  linkedUserId = user.id;
  rolesLoaded = false; // new user — roles unknown until fetchMyRoles resolves below
  notifyRoles();
  const [first, last] = stashedName();
  const signupKind = stashedKind();
  const personId = await linkOrCreatePerson(first, last);
  if (personId) {
    localStorage.removeItem('ucg-signup-name');
    await syncFromSupabase(); // pull the claimed/created person into the snapshot

    // If the user registered as a coach, upgrade the freshly-created person row.
    // We only apply this when:
    //   (a) ucg-signup-kind is 'coach' (stashed at sign-up time), AND
    //   (b) the person's current kind is still 'athlete' (the RPC default), AND
    //   (c) they have no memberships yet — a conservative guard that avoids
    //       clobbering an existing athlete who coincidentally shares the email.
    if (signupKind === 'coach') {
      localStorage.removeItem('ucg-signup-kind');
      const db = getDB();
      const person = db.people.find((p) => p.id === personId);
      if (person && person.kind === 'athlete' && person.memberships.length === 0) {
        const updated = { ...person, kind: 'coach' as const };
        mutate((d) => {
          const idx = d.people.findIndex((p) => p.id === personId);
          if (idx !== -1) d.people[idx] = updated;
        });
        pushPerson(updated); // mirror to Supabase
      }
    } else {
      localStorage.removeItem('ucg-signup-kind');
    }
  }
  roles = await fetchMyRoles(user.id);
  rolesLoaded = true;
  notifyRoles();
}

function applySession(next: Session | null) {
  session = next;
  loading = false;
  notify();
  if (next?.user) {
    void onAuthenticated(next.user);
  } else {
    linkedUserId = null;
    rolesLoaded = !isSupabaseConfigured;
    if (roles.length) { roles = []; notifyRoles(); }
  }
}

if (isSupabaseConfigured && supabase) {
  const bootSession = supabase.auth.getSession().then(({ data }) => {
    applySession(data.session);
    return data.session;
  });
  supabase.auth.onAuthStateChange((_event, newSession) => applySession(newSession));
  // DEV-ONLY seeded auto-login. Dynamic import behind `import.meta.env.DEV` so
  // the dev-auth module (and its VITE_DEV_AUTH_* literals) is dead-code
  // eliminated from production builds — it is never bundled when DEV is false.
  if (import.meta.env.DEV) {
    void import('./dev-auth').then((m) => m.initDevAuth(bootSession));
  }
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Reactive Supabase auth session (null when signed out or not configured). */
export function useSession(): Session | null {
  return useSyncExternalStore(subscribe, () => session);
}

/** True while the initial getSession() call is still in flight. */
export function useAuthLoading(): boolean {
  return useSyncExternalStore(subscribe, () => loading);
}

/** Non-reactive snapshot, e.g. for one-off checks. */
export function getSession(): Session | null {
  return session;
}

/** The signed-in user's app roles (reactive). Empty until loaded / when signed out. */
export function useMyRoles(): string[] {
  return useSyncExternalStore(
    (cb) => { roleListeners.add(cb); return () => roleListeners.delete(cb); },
    () => roles,
  );
}

/** Non-reactive roles snapshot. */
export function getMyRoles(): string[] {
  return roles;
}

/** True once the signed-in user's roles have been fetched (or when Supabase is
 *  unconfigured and there are none to fetch). Role gates use this to show a
 *  loader instead of an "access denied" flash on refresh. Reactive. */
export function useRolesLoaded(): boolean {
  return useSyncExternalStore(
    (cb) => { roleListeners.add(cb); return () => roleListeners.delete(cb); },
    () => rolesLoaded,
  );
}

/** Synchronous best-effort check for a likely-signed-in user, used to avoid
 *  flashing the gate while getSession() resolves on refresh. Supabase persists
 *  the session under a `sb-<project-ref>-auth-token` localStorage key. */
export function hasLikelySession(): boolean {
  if (!isSupabaseConfigured) return false;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('sb-') && key.endsWith('-auth-token')) return true;
    }
  } catch { /* localStorage unavailable */ }
  return false;
}
