// Phase 2 (2026-07-26 data-layer-scale): `scores` moves off global hydration
// onto the slice layer (src/lib/slice-cache.ts). See "The slice-layer
// CONTRACT" in docs/specs/2026-07-24-data-layer-scale.md for the four access
// shapes implemented here:
//   1. By event   — useEventScores(eventId)            → { rows, status }
//   2. Mine       — useMyScores()                       → Score[] (sync)
//   3. Single id  — useScoreById(id)                     → { score, status }
//   4. Everything — (unchanged) db.scores, read ONLY by supabase.ts's
//      pushAll — see the comment on that field in loadAll (supabase.ts).
//
// Unconfigured-Supabase (localStorage-only prototype) mode: every hook here
// falls back to reading `db.scores` synchronously (status always 'ready')
// instead of hitting the network — buildSeed()/loadNationals()/Judge writes
// already populate db.scores in that mode, so there's nothing to fetch.
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Score } from './types';
import { getDB, mutate, useDB } from './store';
import {
  isSupabaseConfigured, pushScore, subscribeEventScores, rowToScore,
  fetchEventScoresRemote, fetchScoreByIdRemote, fetchScoresForRegIdsRemote,
} from './supabase';
import { isBrowserOnline } from './write-queue';
import { pushToast } from './toast-bus';
import { useCapabilities } from './capabilities';
import { createEventScopedSlice, mineCacheKey, type SliceStatus } from './slice-cache';

// ---------------------------------------------------------------------------
// 1. By event
// ---------------------------------------------------------------------------

const scoreSlice = createEventScopedSlice<Score>({
  fetchScope: fetchEventScoresRemote,
  idOf: (s) => s.id,
  subscribeRealtime: (eventId, helpers) => subscribeEventScores(eventId, (payload) => {
    if (payload.eventType === 'DELETE') {
      const oldId = (payload.old as { id?: string } | null)?.id;
      if (oldId) helpers.remove(oldId);
      return;
    }
    helpers.upsert(rowToScore(payload.new));
  }),
});

/** By-event slice read (shape #1). Demo mode derives synchronously from
 *  db.scores; a Supabase-backed session reads the network-backed slice. */
export function useEventScores(eventId: string | undefined | null): { rows: Score[]; status: SliceStatus } {
  const demoDb = useDB();
  // Always call the hook (Rules of Hooks) — isSupabaseConfigured is a
  // module-level constant that never flips within a session, so branching on
  // which RESULT to use afterward is safe; pass a null key in demo mode so
  // the slice's internal effect/fetch stays a no-op.
  const remote = scoreSlice.useScope(isSupabaseConfigured ? eventId : null);
  if (!isSupabaseConfigured) {
    const rows = eventId ? demoDb.scores.filter((s) => s.eventId === eventId) : [];
    return { rows, status: 'ready' };
  }
  return remote;
}

/** Non-hook, one-off fetch of every score for an event — for the admin CSV
 *  export (Events.tsx) and other non-reactive call sites that shouldn't pull
 *  in the reactive cache/realtime subscription for a single click action. */
export async function fetchEventScoresOnce(eventId: string): Promise<Score[]> {
  if (!isSupabaseConfigured) return getDB().scores.filter((s) => s.eventId === eventId);
  return fetchEventScoresRemote(eventId);
}

// ---------------------------------------------------------------------------
// 2. Mine (Tier 2) — hydrated at boot, scoped to the signed-in caller, and
// synchronous: Home.tsx must never see a `status` field to forget to check.
// ---------------------------------------------------------------------------

let myScoresCache: Score[] = [];
let myScoresKey = '';
const myScoresListeners = new Set<() => void>();

function notifyMyScores() { myScoresListeners.forEach((l) => l()); }

/** Kicks off (or no-ops if already current) the "mine" fetch for a person's
 *  own registrations. Called from <MyScoresBoot/> (mounted once near the app
 *  root) whenever the signed-in personId or their registration id set
 *  changes. No-ops entirely in demo mode — useMyScores reads db.scores
 *  directly there. */
export function ensureMyScoresLoaded(personId: string | null, regIds: string[]): void {
  if (!isSupabaseConfigured || !personId) return;
  const key = mineCacheKey(personId, regIds);
  if (key === myScoresKey) return; // already current or already loading this exact scope
  myScoresKey = key;
  if (regIds.length === 0) { myScoresCache = []; notifyMyScores(); return; }
  void fetchScoresForRegIdsRemote(regIds)
    .then((rows) => { myScoresCache = rows; })
    .catch((e: unknown) => { console.error('[scores-slice] ensureMyScoresLoaded failed:', e); })
    .finally(() => { notifyMyScores(); });
}

/** Tier-2 "mine" read (shape #2) — a plain array, deliberately NOT
 *  `{ rows, status }`: this tier is synchronous by design (CONTRACT §2), so
 *  there is no loading state for a caller to forget to check. */
export function useMyScores(): Score[] {
  const demoDb = useDB();
  const remote = useSyncExternalStore(
    (cb) => { myScoresListeners.add(cb); return () => myScoresListeners.delete(cb); },
    () => myScoresCache,
  );
  if (!isSupabaseConfigured) return demoDb.scores;
  return remote;
}

/** Mounted once near the app root (App.tsx), NOT per-page, so the "mine"
 *  cache hydrates at boot the same way the rest of Tier 2 (memberships,
 *  invoices, ...) already does — without adding scores back to loadAll's
 *  global hydration. Renders nothing. */
export function MyScoresBoot(): null {
  const db = useDB();
  const caps = useCapabilities();
  const regIds = caps.personId
    ? db.registrations.filter((r) => r.athleteId === caps.personId && !r.refunded).map((r) => r.id)
    : [];
  // Stable string dependency: mutate() replaces the whole `db` object in
  // place (CLAUDE.md's in-place-mutation trap), so a fresh `regIds` array is
  // a new reference on every store change even when its CONTENTS haven't —
  // depending on the array itself would refetch on every unrelated mutation.
  const regIdsKey = regIds.slice().sort().join(',');
  useEffect(() => {
    ensureMyScoresLoaded(caps.personId, regIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caps.personId, regIdsKey]);
  return null;
}

// ---------------------------------------------------------------------------
// 3. Single record (ScoreDetail.tsx deep link)
// ---------------------------------------------------------------------------

export interface ScoreByIdResult {
  score: Score | null;
  status: SliceStatus;
  /** Reflect a just-saved score immediately, without waiting for a refetch —
   *  this hook's fetch is a one-off (not the by-event slice cache), so a
   *  successful writeScore() elsewhere doesn't otherwise reach this page's
   *  own state. No-op in demo mode (db.scores already reflects the write on
   *  the next render via useDB()). */
  applyOptimistic: (updated: Score) => void;
}

/** NOTE: callers should mount the component using this hook with `key={id}`
 *  when `id` can change without an intervening full navigation (ScoreDetail.tsx
 *  does) — the initial state below is already the correct "loading" value, so
 *  a remount is what resets it for a new id, rather than diffing a ref during
 *  render (which this repo's stricter react-hooks/refs rule disallows). */
export function useScoreById(scoreId: string | undefined): ScoreByIdResult {
  const demoDb = useDB();
  const [remote, setRemote] = useState<{ score: Score | null; status: SliceStatus }>({ score: null, status: 'loading' });
  useEffect(() => {
    if (!isSupabaseConfigured || !scoreId) return;
    let cancelled = false;
    fetchScoreByIdRemote(scoreId)
      .then((score) => { if (!cancelled) setRemote({ score, status: 'ready' }); })
      .catch((e: unknown) => {
        console.error('[scores-slice] useScoreById fetch failed:', e);
        if (!cancelled) setRemote({ score: null, status: 'error' });
      });
    return () => { cancelled = true; };
  }, [scoreId]);
  const applyOptimistic = (updated: Score) => {
    if (isSupabaseConfigured) setRemote({ score: updated, status: 'ready' });
  };
  if (!isSupabaseConfigured) {
    const score = scoreId ? demoDb.scores.find((s) => s.id === scoreId) ?? null : null;
    return { score, status: 'ready', applyOptimistic };
  }
  return { ...remote, applyOptimistic };
}

// ---------------------------------------------------------------------------
// Arbitrary regIds (admin person-data export — may target someone other than
// the signed-in caller, so it can't reuse the "mine" cache above).
// ---------------------------------------------------------------------------

export async function fetchScoresForRegIds(regIds: string[]): Promise<Score[]> {
  if (!isSupabaseConfigured) {
    const set = new Set(regIds);
    return getDB().scores.filter((s) => set.has(s.regId));
  }
  return fetchScoresForRegIdsRemote(regIds);
}

// ---------------------------------------------------------------------------
// Writes — mutate() + push* keep their current shape (CLAUDE.md); the
// optimistic local update now applies to the slice that holds the row
// instead of a globally-hydrated db.scores.
// ---------------------------------------------------------------------------

let offlineToastShown = false;
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => { offlineToastShown = false; });
}

function guardOnline(): boolean {
  if (isBrowserOnline()) return true;
  if (!offlineToastShown) {
    offlineToastShown = true;
    pushToast("You're offline — changes are disabled until you reconnect.", { variant: 'error' });
  }
  return false;
}

export type WriteScoreResult =
  | { ok: true; current: Score }
  | { ok: false; reason: 'offline' }
  | { ok: false; reason: 'conflict'; current: Score | null }
  | { ok: false; reason: 'error'; error: string };

/** Privileged score write (Judge.tsx's own-identity path, ScoreDetail.tsx
 *  admin adjustment) — compare-and-set (UAT Z-06-01): posts through
 *  `post_score` via `pushScore`, which returns a conflict WITHOUT writing
 *  when `expectedUpdatedAt` no longer matches the row's current
 *  `updated_at` (including "a row now exists but the caller expected none"
 *  — two judges posting the same athlete/apparatus seconds apart). On
 *  success, applies the SERVER's returned row (carrying its fresh
 *  `updated_at`) to the slice, so the caller's next post carries the right
 *  expectation. `expectedUpdatedAt: null` means "I believe no score exists
 *  here yet". Demo/unconfigured mode has no concurrent-writer concern (one
 *  local `db`), so it keeps the old direct mutate with no CAS check. */
export async function writeScore(score: Score, expectedUpdatedAt: string | null): Promise<WriteScoreResult> {
  if (!isSupabaseConfigured) {
    const applied = mutate((d) => {
      d.scores = d.scores.filter((s) => s.id !== score.id);
      d.scores.push(score);
    });
    return applied ? { ok: true, current: score } : { ok: false, reason: 'offline' };
  }
  if (!guardOnline()) return { ok: false, reason: 'offline' };
  const result = await pushScore(score, expectedUpdatedAt);
  if (!result.ok) {
    if (result.conflict) return { ok: false, reason: 'conflict', current: result.current ?? null };
    return { ok: false, reason: 'error', error: result.error ?? 'Could not post the score.' };
  }
  const saved = result.current ?? score;
  scoreSlice.applyLocalUpsert(saved.eventId, saved);
  return { ok: true, current: saved };
}

/** Local-only optimistic update — for the codeless judge path, where the
 *  judge-entry Edge Function has ALREADY written the row server-side (service
 *  role, since an anonymous device has no RLS write access to `scores`);
 *  calling writeScore/pushScore here would just re-enqueue the same write and
 *  fail RLS a second time. */
export function applyLocalScoreUpdate(score: Score): void {
  if (!isSupabaseConfigured) {
    mutate((d) => {
      d.scores = d.scores.filter((s) => s.id !== score.id);
      d.scores.push(score);
    });
    return;
  }
  scoreSlice.applyLocalUpsert(score.eventId, score);
}
