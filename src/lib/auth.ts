// Supabase auth session tracking, exposed via useSyncExternalStore the same
// way src/lib/store.ts exposes its other reactive state. On the first
// authenticated load it links the auth user to a person row (claim-by-email or
// create) and fetches the user's app roles.
import { useSyncExternalStore } from 'react';
import type { Session } from '@supabase/supabase-js';
import { fetchMyRoles, isSupabaseConfigured, linkOrCreatePerson, supabase } from './supabase';
import { syncFromSupabase } from './store';

let session: Session | null = null;
// True until the initial getSession() resolves — lets callers avoid flashing
// the gate for a signed-in user on refresh.
let loading = isSupabaseConfigured;
let roles: string[] = [];
let linkedUserId: string | null = null; // auth user we've already linked this session
const listeners = new Set<() => void>();
const roleListeners = new Set<() => void>();

function notify() { listeners.forEach((l) => l()); }
function notifyRoles() { roleListeners.forEach((l) => l()); }

/** Read first/last name stashed by the sign-up form (Gate.tsx). */
function stashedName(): [string, string] {
  try {
    const raw = sessionStorage.getItem('ucg-signup-name');
    if (raw) { const [f, l] = JSON.parse(raw); return [f ?? '', l ?? '']; }
  } catch { /* ignore */ }
  return ['', ''];
}

/** Once per signed-in user: link/create their person row, then load roles. */
async function onAuthenticated(user: Session['user']) {
  if (linkedUserId === user.id) return;
  linkedUserId = user.id;
  const [first, last] = stashedName();
  const personId = await linkOrCreatePerson(first, last);
  if (personId) {
    sessionStorage.removeItem('ucg-signup-name');
    await syncFromSupabase(); // pull the claimed/created person into the snapshot
  }
  roles = await fetchMyRoles();
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
    if (roles.length) { roles = []; notifyRoles(); }
  }
}

if (isSupabaseConfigured && supabase) {
  supabase.auth.getSession().then(({ data }) => applySession(data.session));
  supabase.auth.onAuthStateChange((_event, newSession) => applySession(newSession));
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
