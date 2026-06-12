// Supabase auth session tracking, exposed via useSyncExternalStore the same
// way src/lib/store.ts exposes its other reactive state.
import { useSyncExternalStore } from 'react';
import type { Session } from '@supabase/supabase-js';
import { isSupabaseConfigured, supabase } from './supabase';

let session: Session | null = null;
// True until the initial getSession() resolves — lets callers avoid flashing
// the gate for a signed-in user on refresh.
let loading = isSupabaseConfigured;
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((l) => l());
}

if (isSupabaseConfigured && supabase) {
  supabase.auth.getSession().then(({ data }) => {
    session = data.session;
    loading = false;
    notify();
  });
  supabase.auth.onAuthStateChange((_event, newSession) => {
    session = newSession;
    loading = false;
    notify();
  });
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
