// Data layer shaped like an async API so a real backend can swap in later.
// Backed by a seeded in-memory DB persisted to localStorage.
import { useSyncExternalStore } from 'react';
import type { DB } from './types';
import { buildSeed } from './seed';
import { isSupabaseConfigured, loadAll } from './supabase';
import { isBrowserOnline } from './write-queue';
import { pushToast } from './toast-bus';

const LS_KEY = 'ucg-db-v1';
// Bumped to 6 for the Meet→Event + apparatus rename: the persisted DB shape
// changed (db.meets→db.events, registration.events→apparatus, score.event→
// apparatus), so any localStorage snapshot from a prior version must be
// discarded and reseeded rather than loaded into the new code (which would read
// undefined `db.events` and crash). Bumped to 7 for the follow-up
// registration.eventLevels→apparatusLevels rename (same reasoning: discard the
// stale shape so the new field isn't read as undefined from cache).
const SEED_VERSION = 7;

let db: DB = load();
const listeners = new Set<() => void>();
let snapshotVersion = 0;

function load(): DB {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.__v === SEED_VERSION) return parsed.db;
    }
  } catch { /* fall through to fresh seed */ }
  return buildSeed();
}

function persist() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ __v: SEED_VERSION, db }));
  } catch { /* storage full or unavailable — demo continues in memory */ }
}

export function getDB(): DB {
  return db;
}

// Read-only while offline (Supabase-backed only — the localStorage-only
// prototype mode has no remote to diverge from, so it stays writable). Every
// push* call site invokes its remote write from INSIDE the mutate() callback
// (e.g. `mutate((d) => { ...; pushClub(d.clubs[i]); })`), so refusing to run
// fn at all here is a single choke point that guarantees BOTH no optimistic
// local change AND no write ever gets enqueued for it — there's no path for
// local/remote state to diverge from a blocked mutation.
let offlineToastShown = false;
window.addEventListener('online', () => { offlineToastShown = false; });

/** Mutate the DB inside fn; persists + notifies subscribers (multi-tab safe).
 *  Returns false (without applying fn) when Supabase-backed and offline. */
export function mutate(fn: (db: DB) => void): boolean {
  if (isSupabaseConfigured && !isBrowserOnline()) {
    if (!offlineToastShown) {
      offlineToastShown = true;
      pushToast("You're offline — changes are disabled until you reconnect.", { variant: 'error' });
    }
    return false;
  }
  fn(db);
  snapshotVersion++;
  persist();
  listeners.forEach((l) => l());
  return true;
}

export function resetDemo() {
  db = buildSeed();
  snapshotVersion++;
  persist();
  listeners.forEach((l) => l());
}

/** Replace the in-memory snapshot with a fresh load from Supabase, if configured. */
export async function syncFromSupabase() {
  if (!isSupabaseConfigured) return;
  const remote = await loadAll();
  if (!remote) return;
  // A completely empty remote means the backend hasn't been seeded yet —
  // keep the local snapshot so it can be pushed (Admin → Demo tools).
  if (!remote.seasons.length && !remote.clubs.length && !remote.people.length && !remote.events.length) return;
  db = remote;
  snapshotVersion++;
  persist();
  listeners.forEach((l) => l());
}

// Boot hydration: keep the localStorage/seed snapshot for first paint (no
// flash), then replace it with Supabase data once it arrives.
if (isSupabaseConfigured) void syncFromSupabase();

// Cross-tab sync
window.addEventListener('storage', (e) => {
  if (e.key === LS_KEY && e.newValue) {
    try {
      const parsed = JSON.parse(e.newValue);
      if (parsed.__v === SEED_VERSION) {
        db = parsed.db;
        snapshotVersion++;
        listeners.forEach((l) => l());
      }
    } catch { /* ignore malformed cross-tab payload */ }
  }
});

export function useDB(): DB {
  useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => snapshotVersion,
  );
  return db;
}

// ---- Unconfigured-prototype identity ----
// When Supabase isn't configured (password-gate demo mode), there is no real
// auth session, so capabilities.ts grants full admin acting as this fixed
// seed person. See capabilities.ts.
export interface Persona {
  athleteId: string;
  clubId: string;
  hostClubId: string;
}

const DEFAULT_PERSONA: Persona = {
  athleteId: 'p-1', // Maya Okafor
  clubId: 'club-1', // U. Minnesota
  hostClubId: 'club-6', // Ohio State, hosts Midwest Regional
};

/** The fixed prototype identity (unconfigured-Supabase demo mode only). */
export function getPersona(): Persona {
  return DEFAULT_PERSONA;
}

// ---- Password gate ----
const GATE_KEY = 'ucg-gate-ok';
// SHA-256 of the access password
const GATE_HASH = 'a362d06a6c7b321fa6a9fc17c5219549e062fcc8db93f409236175704d718ac6';

export async function checkPassword(pw: string): Promise<boolean> {
  const data = new TextEncoder().encode(pw.trim());
  const buf = await crypto.subtle.digest('SHA-256', data);
  const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (hex === GATE_HASH) {
    localStorage.setItem(GATE_KEY, GATE_HASH);
    return true;
  }
  return false;
}

export function isUnlocked(): boolean {
  return localStorage.getItem(GATE_KEY) === GATE_HASH;
}
