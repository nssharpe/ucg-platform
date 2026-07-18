// Supabase auth session tracking, exposed via useSyncExternalStore the same
// way src/lib/store.ts exposes its other reactive state. On the first
// authenticated load it links the auth user to a person row (claim-by-email or
// create) and fetches the user's app roles.
import { useSyncExternalStore } from 'react';
import type { Session } from '@supabase/supabase-js';
import { fetchMyRoles, isSupabaseConfigured, linkOrCreatePerson, pushPerson, supabase } from './supabase';
import { getDB, mutate, syncFromSupabase } from './store';
import type { AalLevel } from './mfa-core';

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

// Authenticator Assurance Level (MFA step-up, emv2-adjacent auth-hardening
// work). `currentLevel` is what the live JWT carries; `nextLevel` is the
// highest level reachable given the account's verified factors. When they
// differ (aal1 → aal2 available) the App-level interstitial (Gate/App.tsx)
// challenges for the second factor before rendering protected UI.
let aal: { currentLevel: AalLevel; nextLevel: AalLevel; methods: string[] } = { currentLevel: null, nextLevel: null, methods: [] };
const aalListeners = new Set<() => void>();
function notifyAal() { aalListeners.forEach((l) => l()); }

/** Re-read the AAL from Supabase and notify subscribers. Call after a
 *  sign-in, after an MFA verify/unenroll, and on every session change — those
 *  are exactly the events that can move currentLevel/nextLevel. */
export async function refreshAal(): Promise<void> {
  if (!isSupabaseConfigured || !supabase) { aal = { currentLevel: null, nextLevel: null, methods: [] }; notifyAal(); return; }
  if (!session) { aal = { currentLevel: null, nextLevel: null, methods: [] }; notifyAal(); return; }
  const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  // `methods` = the session's amr entries (how this session authenticated,
  // e.g. 'password' / 'passkey' / 'totp'); amr claims live on the SESSION in
  // GoTrue, so a token refresh keeps the original 'passkey' entry — the
  // passkey step-up exemption (needsMfaStepUp) survives refreshes.
  aal = error || !data
    ? { currentLevel: null, nextLevel: null, methods: [] }
    : {
        currentLevel: data.currentLevel as AalLevel,
        nextLevel: data.nextLevel as AalLevel,
        // SDK types entries as string | AMREntry — normalize to the method string.
        methods: (data.currentAuthenticationMethods ?? []).map((m) => (typeof m === 'string' ? m : m.method)),
      };
  notifyAal();
}

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
        const applied = mutate((d) => {
          const idx = d.people.findIndex((p) => p.id === personId);
          if (idx !== -1) d.people[idx] = updated;
        });
        // Skip the remote mirror if the local mutation was refused (offline
        // read-only gate) — pushing remote-only would diverge from local.
        if (applied) pushPerson(updated); // mirror to Supabase
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
  void refreshAal();
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

/** Reactive Authenticator Assurance Level — { currentLevel, nextLevel,
 *  methods }. currentLevel === nextLevel === null while unconfigured/
 *  signed-out; both 'aal1' for a no-factor account; 'aal1'/'aal2' when a
 *  step-up is available but not yet presented. `methods` carries the
 *  session's amr entries (e.g. 'password', 'passkey') for the passkey
 *  step-up exemption. See `needsMfaStepUp` (mfa-core.ts) for the gate. */
export function useAal(): { currentLevel: AalLevel; nextLevel: AalLevel; methods: string[] } {
  return useSyncExternalStore(
    (cb) => { aalListeners.add(cb); return () => aalListeners.delete(cb); },
    () => aal,
  );
}

/** Non-reactive AAL snapshot. */
export function getAal(): { currentLevel: AalLevel; nextLevel: AalLevel } {
  return aal;
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

// Captured ONCE at module load, before Supabase JS parses and clears the URL
// hash — a signup-confirmation/magic-link/recovery redirect lands with
// `#access_token=...&type=signup` (or `#error=...` for an expired/invalid
// link) in the hash. `hasLikelySession()` alone misses this case: a BRAND
// NEW confirmation has no prior `sb-*-auth-token` localStorage entry for it
// to find, so the app rendered fully in guest mode for a frame — sign-in
// link, no nav — while getSession() was still resolving the token, then
// flashed through several more states as the session/person/roles caught up
// (reported live: "flashes a page ... before settling on the home page").
const initialUrlHasAuthCallback = /(?:^|[#&])(access_token|error)=/.test(window.location.hash);

/** True if the page loaded with a Supabase auth callback token/error in the
 *  URL hash — used alongside `hasLikelySession()` to also gate the initial
 *  render while a BRAND NEW session (not a returning one) is being
 *  established, so the guest-mode app never paints before it. */
export function hasAuthCallbackInUrl(): boolean {
  return initialUrlHasAuthCallback;
}
