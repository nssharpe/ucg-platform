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
// Bumped to 9 for Phase 3 (2026-07-27 data-layer-scale): registrations no
// longer ride along in a Supabase-backed snapshot either
// (src/lib/registrations-slice.ts owns that read path now) — same reasoning,
// a stale v8 snapshot could carry a multi-MB `db.registrations` array.
// Bumped to 10 for Phase 5 (2026-07-28 data-layer-scale): the persisted
// snapshot itself is now restricted to Tier 1 reference data + small Tier 2
// caller-scoped data (PERSISTED_KEYS below) when Supabase-backed — a stale
// v9 snapshot carries the FULL db (every Tier 3 collection, unscoped
// people, etc.), which `load()`'s new reconstruction logic doesn't expect,
// so it must be discarded and reseeded/re-synced same as every prior bump.
const SEED_VERSION = 10;

// Phase 5 (data-layer-scale.md): only these keys persist to localStorage
// when Supabase-backed. Tier 1 (seasons/levels/clubs/coupons/
// waiverDocuments/accountingCodes/regionOverrides) is small, bounded
// reference data needed by nearly every page — keeping it persisted is what
// preserves instant first paint on a repeat visit, the one genuinely
// McMaster-ish property this app already has (see the spec's "THE ACTUAL
// GOAL" section — dropping persistence wholesale would work AGAINST the
// goal, not toward it). `events` is added alongside Tier 1 even though the
// spec's original enumeration didn't list it: it's just as small/bounded as
// clubs (tens to low hundreds of rows, never scores/registrations-scale)
// and just as central to first paint (Home, the Events index, Results index
// all read it synchronously on the very first render). Tier 2
// (people/invoices/carts) is the caller-scoped data Phase 4's boot scoping
// already keeps small (self + managed-club rosters). Everything else —
// every Tier 3 collection (clubRequests, sanctionRequests, waiverSignatures,
// payments, refundRequests, waitlistGroups, sessionRequests,
// competitionOrders, finalsLineups, eventCheckins, eventAdmins,
// accountInvites, sanctionVotes, clubMemberships, hostPayouts,
// judgeAccessCodes) plus registrations/scores (already memory-only via the
// slice layer, always `[]` here regardless) — is intentionally NOT
// persisted. It's reconstructed empty/undefined on load and refilled by the
// syncFromSupabase() call that unconditionally follows boot (line ~160
// below) within roughly a second at the measured Tier-2 scoping speeds —
// this is what removes the 28.95 MB snapshot the spec measured at scale.
// Demo/unconfigured mode is UNCHANGED (persists the whole `db`) — there is
// no server to re-sync from there, so restricting persistence would
// silently lose data on every reload rather than get refilled a moment
// later.
const PERSISTED_KEYS = [
  'seasons', 'levels', 'clubs', 'events', 'coupons',
  'waiverDocuments', 'accountingCodes', 'regionOverrides',
  'people', 'invoices', 'carts',
] as const satisfies readonly (keyof DB)[];

/** DB fields required by the `DB` interface but deliberately excluded from
 *  persistence (see PERSISTED_KEYS) — reconstructed empty so the returned
 *  object still satisfies `DB`'s required fields until the next
 *  syncFromSupabase() fills them in for real. Every OTHER excluded field is
 *  optional on `DB` and every consumer already reads it via `db.x ?? []`
 *  (the same defensive pattern used since before these fields existed at
 *  all), so `undefined` there needs no explicit default. */
function emptyRequiredDefaults(): Pick<DB, 'registrations' | 'scores' | 'clubRequests'> {
  return { registrations: [], scores: [], clubRequests: [] };
}

/** Picks only PERSISTED_KEYS off a full `DB` for localStorage — Supabase-
 *  backed mode only (see persist()). */
function pickPersisted(full: DB): Partial<DB> {
  const out: Partial<DB> = {};
  for (const k of PERSISTED_KEYS) (out as Record<string, unknown>)[k] = full[k];
  return out;
}

let db: DB = load();
const listeners = new Set<() => void>();
let snapshotVersion = 0;

function load(): DB {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.__v === SEED_VERSION) {
        // Demo/unconfigured mode: the persisted snapshot is the full db (see
        // persist()) — load it as-is, unchanged from pre-Phase-5 behavior.
        if (!isSupabaseConfigured) return parsed.db as DB;
        // Supabase-backed: the snapshot is the Tier 1 + Tier 2 subset only —
        // reconstruct a full DB shape so every required field is present;
        // the omitted Tier 3 collections read as empty/undefined until
        // syncFromSupabase() (called unconditionally right after this module
        // finishes loading) fills them in for real.
        return { ...emptyRequiredDefaults(), ...(parsed.db as Partial<DB>) } as DB;
      }
    }
  } catch { /* fall through to fresh seed */ }
  return buildSeed();
}

/** Persists `db` to localStorage (Supabase-backed: only PERSISTED_KEYS —
 *  see the block comment above; demo/unconfigured: the whole `db`, unchanged
 *  from pre-Phase-5 behavior). Returns the serialized payload's size
 *  (UTF-16 code units — a cheap, already-computed proxy for bytes; the JSON
 *  this store holds is overwhelmingly ASCII, so re-encoding to count real
 *  UTF-8 bytes would just be a second full pass over a multi-MB string for
 *  no material accuracy gain) so callers can pair it with a hydration
 *  duration for boot instrumentation — see `maybeReportBootMetrics` below. */
function persist(): number {
  const persisted: DB | Partial<DB> = isSupabaseConfigured ? pickPersisted(db) : db;
  const json = JSON.stringify({ __v: SEED_VERSION, db: persisted });
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
        // Phase 5: in Supabase-backed mode the OTHER tab's persisted payload
        // is also just the Tier 1 + Tier 2 subset (see persist()) — merge it
        // onto THIS tab's existing in-memory db rather than replacing it
        // outright, so this tab's own already-fetched Tier 3 collections
        // (refund requests, waiver signatures, etc.) aren't wiped to
        // undefined by a cross-tab event carrying none of that data. Demo
        // mode is unchanged (parsed.db is the full db there too).
        db = isSupabaseConfigured ? { ...db, ...(parsed.db as Partial<DB>) } : (parsed.db as DB);
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
