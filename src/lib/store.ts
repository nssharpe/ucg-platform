// Data layer shaped like an async API so a real backend can swap in later.
// Backed by a seeded in-memory DB persisted to localStorage.
import { useSyncExternalStore } from 'react';
import type { DB } from './types';
import { buildSeed } from './seed';
import { isSupabaseConfigured, loadAll, logClientError } from './supabase';
import { isBrowserOnline } from './write-queue';
import { pushToast } from './toast-bus';
import { isQuotaExceededError, shouldReportBootMetrics } from './boot-metrics';

const LS_KEY = 'ucg-db-v1';
// Bumped to 6 for the Meet→Event + apparatus rename: the persisted DB shape
// changed (db.meets→db.events, registration.events→apparatus, score.event→
// apparatus), so any localStorage snapshot from a prior version must be
// discarded and reseeded rather than loaded into the new code (which would read
// undefined `db.events` and crash). Bumped to 7 for the follow-up
// registration.eventLevels→apparatusLevels rename (same reasoning: discard the
// stale shape so the new field isn't read as undefined from cache). Bumped to
// 8 for Phase 2 (2026-07-26 data-layer-scale): scores no longer ride along in
// a Supabase-backed snapshot (src/lib/scores-slice.ts owns that read path
// now) — a stale v7 snapshot could carry a multi-MB `db.scores` array from
// before this change, so it must be discarded and reseeded/re-synced rather
// than loaded, which is exactly what removes the payload this phase targets.
const SEED_VERSION = 8;

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

/** Persists `db` to localStorage. Returns the serialized payload's size
 *  (UTF-16 code units — a cheap, already-computed proxy for bytes; the JSON
 *  this store holds is overwhelmingly ASCII, so re-encoding to count real
 *  UTF-8 bytes would just be a second full pass over a multi-MB string for
 *  no material accuracy gain) so callers can pair it with a hydration
 *  duration for boot instrumentation — see `maybeReportBootMetrics` below. */
function persist(): number {
  const json = JSON.stringify({ __v: SEED_VERSION, db });
  const payloadBytes = json.length;
  try {
    localStorage.setItem(LS_KEY, json);
  } catch (err) {
    // Distinguish a genuine storage-quota exception from every other reason
    // setItem can throw (storage disabled, private-browsing denial, etc.) so
    // only the documented trigger (docs/specs/2026-07-24-data-layer-scale.md)
    // lands in error_logs as a named, greppable condition. Fire-and-forget —
    // logClientError never throws — and keep swallowing everything else:
    // persistence failing must never break the app.
    if (isQuotaExceededError(err)) {
      void logClientError({
        message: `localStorage quota exceeded persisting the DB snapshot (${payloadBytes.toLocaleString()} chars)`,
        context: 'store:persist-quota-exceeded',
        detail: { payloadBytes },
      });
    }
    /* storage full or unavailable — demo continues in memory */
  }
  return payloadBytes;
}

// Reported at most once per session (module-level flag — resets on reload).
let bootMetricsReported = false;

/** Cheap, fire-and-forget: reports boot payload size + hydration duration to
 *  error_logs only when one of the two documented triggers
 *  (docs/specs/2026-07-24-data-layer-scale.md) has actually fired, and only
 *  once per session — this is what lets the triggers surface on their own
 *  instead of waiting on a user bug report. No-op (two comparisons) on every
 *  normal boot. */
function maybeReportBootMetrics(payloadBytes: number, hydrationMs: number) {
  if (bootMetricsReported || !shouldReportBootMetrics(payloadBytes, hydrationMs)) return;
  bootMetricsReported = true;
  void logClientError({
    message: `Boot payload ${payloadBytes.toLocaleString()} chars, hydration ${hydrationMs.toFixed(0)}ms`,
    context: 'store:boot-metrics-threshold',
    detail: { payloadBytes, hydrationMs },
  });
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
  const hydrationStart = performance.now();
  const remote = await loadAll();
  const hydrationMs = performance.now() - hydrationStart;
  if (!remote) return;
  // A completely empty remote means the backend hasn't been seeded yet —
  // keep the local snapshot so it can be pushed (Admin → Demo tools).
  if (!remote.seasons.length && !remote.clubs.length && !remote.people.length && !remote.events.length) return;
  db = remote;
  snapshotVersion++;
  const payloadBytes = persist();
  // Cheap, always-on visibility (console only — no network call) so the
  // numbers are inspectable in devtools on every hydration, not just the
  // rare one that crosses a threshold below.
  console.debug(`[store] hydration ${hydrationMs.toFixed(0)}ms, payload ${payloadBytes.toLocaleString()} chars`);
  maybeReportBootMetrics(payloadBytes, hydrationMs);
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
