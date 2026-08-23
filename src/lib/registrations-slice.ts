// Phase 3 (2026-07-27 data-layer-scale): `registrations` moves off global
// hydration onto the slice layer (src/lib/slice-cache.ts), reusing Phase 2's
// infrastructure and worked example (src/lib/scores-slice.ts) as-is. See "The
// slice-layer CONTRACT" in docs/specs/2026-07-24-data-layer-scale.md for the
// SIX access shapes implemented here — registrations needed two more than
// scores did:
//   1. By event             — useEventRegistrations(eventId)  → { rows, status }
//   2. Mine (Tier 2, sync)  — useMyRegistrations()              → Registration[]
//   3. Single id            — useRegistrationById(id)            → { registration, status }
//   4. Everything           — (unchanged) db.registrations, read/written ONLY
//      by supabase.ts's pushAll (admin Demo Tools) and nationals.ts's admin
//      Nationals-2026 import — both already operate on the local store via
//      mutate()/a passed-in DB object, never a normal render path, and (like
//      Phase 2's scores) need NO changes here.
//   5. By club, cross-event — useClubRegistrations(clubId)     → { rows, status }
//   6. Arbitrary person, all events — NOT a slice/cache.
//      fetchRegistrationsForPerson(personId) is a targeted direct fetch so
//      completeness comes from the query, never a warm cache (AdminMembers.tsx
//      duplicate-athlete merge, person-data.ts GDPR export — see that
//      function's doc comment for why this one is the sharpest case in the
//      whole refactor).
//
// Unconfigured-Supabase (localStorage-only prototype) mode: every hook here
// falls back to reading `db.registrations` synchronously (status always
// 'ready') instead of hitting the network — buildSeed()/Club.tsx/Events.tsx
// writes already populate db.registrations in that mode, so there's nothing
// to fetch.
//
// WRITES keep their current shape (CLAUDE.md, the CONTRACT's "Other rules"):
// mutate() + push*/delete* through the write queue is UNCHANGED at every
// existing call site, including its own `d.registrations` bookkeeping (still
// required for unconfigured/demo mode, where these caches are never read).
// What Phase 3 ADDS, right alongside each existing pushRegistration/
// deleteRegistration call, is one call to applyLocalRegistrationUpsert/Remove
// below so the optimistic update also reaches whichever slice(s)/the "mine"
// cache currently hold the row. A registration can live in the by-event
// slice, the by-club slice, AND the Tier-2 "mine" cache simultaneously — the
// two fan-out functions below update all three unconditionally. That's safe:
// slice-cache's applyLocalUpsert/applyLocalRemove already no-op on a scope
// key that isn't loaded, and the "mine" cache below only updates when the
// row's athleteId matches the currently-cached person.
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Registration } from './types';
import { getDB, mutate, useDB } from './store';
import {
  isSupabaseConfigured, pushRegistration, deleteRegistration,
  fetchEventRegistrationsRemote, fetchClubRegistrationsRemote,
  fetchRegistrationByIdRemote, fetchRegistrationsForPersonRemote,
} from './supabase';
import { isBrowserOnline } from './write-queue';
import { pushToast } from './toast-bus';
import { useCapabilities } from './capabilities';
import { createEventScopedSlice, type SliceStatus } from './slice-cache';

/** The subset of a Registration needed to fan a removal out to every cache
 *  that might hold it — callers should pass the row as it existed BEFORE
 *  deletion (its eventId/clubId/athleteId), not just the bare id. */
export type RegKeyFields = Pick<Registration, 'id' | 'eventId' | 'clubId' | 'athleteId'>;

/** Pure: `base` with every row in `upserted` replacing its same-id row (or
 *  appended if new). Order is NOT preserved for replaced rows (mirrors
 *  slice-cache.ts's applyLocalUpsert exactly) — callers here only need
 *  correct membership/values, never array order. Used by money-critical
 *  mutate() blocks (Club.tsx's saveRegs/swapAthlete and counterparts) that
 *  need to re-derive a "what does this event's registration set look like
 *  AFTER the write I'm about to make" view WITHIN THE SAME synchronous call,
 *  before React re-renders and the by-event slice hook would otherwise
 *  reflect it. Those call sites used to get this for free by reading
 *  `d.registrations` (mutated in place moments earlier in the same
 *  callback) — that stops working once registrations are no longer
 *  globally hydrated (Phase 3 Stage 4), so this replaces it: pass the
 *  pre-write by-event slice snapshot as `base` and the rows about to be
 *  written as `upserted`. */
export function mergeUpsertedRegs(base: Registration[], upserted: Registration[]): Registration[] {
  if (upserted.length === 0) return base;
  const ids = new Set(upserted.map((r) => r.id));
  return [...base.filter((r) => !ids.has(r.id)), ...upserted];
}

// ---------------------------------------------------------------------------
// 1. By event
// ---------------------------------------------------------------------------

const regsByEventSlice = createEventScopedSlice<Registration>({
  fetchScope: fetchEventRegistrationsRemote,
  idOf: (r) => r.id,
});

/** By-event slice read (shape #1). Demo mode derives synchronously from
 *  db.registrations; a Supabase-backed session reads the network-backed
 *  slice. `status` is never optional — see the CONTRACT's completeness
 *  requirement: capacity.ts, the nationals engine, and Club.tsx's roster
 *  classification must all gate on `status === 'ready'` before computing. */
export function useEventRegistrations(eventId: string | undefined | null): { rows: Registration[]; status: SliceStatus } {
  const demoDb = useDB();
  // Always call the hook (Rules of Hooks) — isSupabaseConfigured is a
  // module-level constant that never flips within a session, so branching on
  // which RESULT to use afterward is safe; pass a null key in demo mode so
  // the slice's internal effect/fetch stays a no-op.
  const remote = regsByEventSlice.useScope(isSupabaseConfigured ? eventId : null);
  if (!isSupabaseConfigured) {
    const rows = eventId ? demoDb.registrations.filter((r) => r.eventId === eventId) : [];
    return { rows, status: 'ready' };
  }
  return remote;
}

/** Non-hook, one-off fetch of every registration for an event — for CSV/
 *  workbook exports and other non-reactive call sites that shouldn't pull in
 *  the reactive cache/realtime subscription for a single click action
 *  (mirrors fetchEventScoresOnce). */
export async function fetchEventRegistrationsOnce(eventId: string): Promise<Registration[]> {
  if (!isSupabaseConfigured) return getDB().registrations.filter((r) => r.eventId === eventId);
  return fetchEventRegistrationsRemote(eventId);
}

// ---------------------------------------------------------------------------
// 5. By club, cross-event
// ---------------------------------------------------------------------------

const regsByClubSlice = createEventScopedSlice<Registration>({
  fetchScope: fetchClubRegistrationsRemote,
  idOf: (r) => r.id,
});

/** By-club, cross-event slice read (shape #5). Backs Home.tsx's "which
 *  events has this club touched" discovery (no by-event slice can serve
 *  that) and Cart.tsx's managed-club sections, whose refRegIds may point at
 *  ANY event. `status` is never optional for the same completeness reason as
 *  shape #1. */
export function useClubRegistrations(clubId: string | undefined | null): { rows: Registration[]; status: SliceStatus } {
  const demoDb = useDB();
  const remote = regsByClubSlice.useScope(isSupabaseConfigured ? clubId : null);
  if (!isSupabaseConfigured) {
    const rows = clubId ? demoDb.registrations.filter((r) => r.clubId === clubId) : [];
    return { rows, status: 'ready' };
  }
  return remote;
}

// ---------------------------------------------------------------------------
// 2. Mine (Tier 2) — hydrated at boot, scoped to the signed-in caller, and
// SYNCHRONOUS (CONTRACT §2): MyRegistrations.tsx / Home.tsx / Cart.tsx's
// personal-cart section / pricing.ts's priorDisciplineCount callers must
// never see a `status` field to forget to check, and must never derive from
// a partial by-event/by-club slice.
// ---------------------------------------------------------------------------

let myRegsCache: Registration[] = [];
let myRegsPersonId: string | null = null;
const myRegsListeners = new Set<() => void>();

function notifyMyRegs() { myRegsListeners.forEach((l) => l()); }

/** Kicks off (or no-ops if already current) the "mine" fetch for a person's
 *  own registrations, across every event. Called from <MyRegistrationsBoot/>
 *  (mounted once near the app root) whenever the signed-in personId changes.
 *  No-ops entirely in demo mode — useMyRegistrations reads db.registrations
 *  directly there. */
export function ensureMyRegistrationsLoaded(personId: string | null): void {
  if (!isSupabaseConfigured || !personId) return;
  if (personId === myRegsPersonId) return; // already current or already loading this exact scope
  myRegsPersonId = personId;
  void fetchRegistrationsForPersonRemote(personId)
    .then((rows) => { if (personId === myRegsPersonId) myRegsCache = rows; })
    .catch((e: unknown) => { console.error('[registrations-slice] ensureMyRegistrationsLoaded failed:', e); })
    .finally(() => { notifyMyRegs(); });
}

/** Tier-2 "mine" read (shape #2) — a plain array, deliberately NOT
 *  `{ rows, status }`: this tier is synchronous by design, so there is no
 *  loading state for a caller to forget to check. */
export function useMyRegistrations(): Registration[] {
  const demoDb = useDB();
  const remote = useSyncExternalStore(
    (cb) => { myRegsListeners.add(cb); return () => myRegsListeners.delete(cb); },
    () => myRegsCache,
  );
  if (!isSupabaseConfigured) return demoDb.registrations;
  return remote;
}

/** Force a refetch of the "mine" tier for whichever person is CURRENTLY
 *  cached, bypassing `ensureMyRegistrationsLoaded`'s same-person no-op guard
 *  (UAT M-12-02). Needed after a server-side write to a registration's
 *  `paid`/`updatedPending` state that the client learns about only by
 *  polling a `payments` row (checkout fulfillment, free or Stripe) rather
 *  than through `writeRegistration`'s own optimistic
 *  `applyLocalRegistrationUpsert` — `syncFromSupabase()` does NOT cover this:
 *  registrations were moved off `loadAll`'s global hydration onto this slice
 *  layer (Phase 3, data-layer.md), so without this call the "mine" cache
 *  stays on its pre-payment snapshot until something changes `personId`
 *  (e.g. a full page reload, which resets this module's state) — exactly
 *  the "Pending Purchase until hard reload" bug. No-op in demo mode or
 *  before the "mine" cache has ever loaded a person. */
export function invalidateMyRegistrations(): void {
  if (!isSupabaseConfigured || !myRegsPersonId) return;
  const personId = myRegsPersonId;
  void fetchRegistrationsForPersonRemote(personId)
    .then((rows) => { if (personId === myRegsPersonId) myRegsCache = rows; })
    .catch((e: unknown) => { console.error('[registrations-slice] invalidateMyRegistrations failed:', e); })
    .finally(() => { notifyMyRegs(); });
}

/** Force a refetch of one club's cross-event registrations (shape #5) — same
 *  post-payment staleness gap as `invalidateMyRegistrations`, for a managed
 *  club's cart checkout. */
export function invalidateClubRegistrations(clubId: string): void {
  regsByClubSlice.invalidate(clubId);
}

/** Force a refetch of one event's registrations (shape #1) — same gap, for
 *  any event-scoped view (e.g. a club roster page) whose event a
 *  just-completed checkout's items reference. */
export function invalidateEventRegistrations(eventId: string): void {
  regsByEventSlice.invalidate(eventId);
}

/** Mounted once near the app root (App.tsx), NOT per-page, so the "mine"
 *  cache hydrates at boot the same way the rest of Tier 2 (memberships,
 *  invoices, ...) already does — without adding registrations back to
 *  loadAll's global hydration. Renders nothing. */
export function MyRegistrationsBoot(): null {
  const caps = useCapabilities();
  useEffect(() => {
    ensureMyRegistrationsLoaded(caps.personId);
  }, [caps.personId]);
  return null;
}

// ---------------------------------------------------------------------------
// 3. Single record (direct id lookup — deliberately not routed through
// either slice, so a caller doesn't have to pull a whole event's or club's
// worth of rows just to resolve one id).
// ---------------------------------------------------------------------------

export interface RegistrationByIdResult {
  registration: Registration | null;
  status: SliceStatus;
  /** Reflect a just-saved registration immediately, without waiting for a
   *  refetch. No-op in demo mode (db.registrations already reflects the
   *  write on the next render via useDB()). */
  applyOptimistic: (updated: Registration) => void;
}

/** NOTE: mount the component using this hook with `key={id}` when `id` can
 *  change without an intervening full navigation — the initial state below
 *  is already the correct "loading" value, so a remount is what resets it
 *  for a new id (mirrors useScoreById's doc comment). */
export function useRegistrationById(id: string | undefined | null): RegistrationByIdResult {
  const demoDb = useDB();
  const [remote, setRemote] = useState<{ registration: Registration | null; status: SliceStatus }>({ registration: null, status: 'loading' });
  useEffect(() => {
    if (!isSupabaseConfigured || !id) return;
    let cancelled = false;
    fetchRegistrationByIdRemote(id)
      .then((registration) => { if (!cancelled) setRemote({ registration, status: 'ready' }); })
      .catch((e: unknown) => {
        console.error('[registrations-slice] useRegistrationById fetch failed:', e);
        if (!cancelled) setRemote({ registration: null, status: 'error' });
      });
    return () => { cancelled = true; };
  }, [id]);
  const applyOptimistic = (updated: Registration) => {
    if (isSupabaseConfigured) setRemote({ registration: updated, status: 'ready' });
  };
  if (!isSupabaseConfigured) {
    const registration = id ? demoDb.registrations.find((r) => r.id === id) ?? null : null;
    return { registration, status: 'ready', applyOptimistic };
  }
  return { ...remote, applyOptimistic };
}

/** Non-hook, one-off fetch of a single registration by id. */
export async function fetchRegistrationById(id: string): Promise<Registration | null> {
  if (!isSupabaseConfigured) return getDB().registrations.find((r) => r.id === id) ?? null;
  return fetchRegistrationByIdRemote(id);
}

// ---------------------------------------------------------------------------
// 6. Arbitrary person, all events — NOT a slice/cache. Used by
// AdminMembers.tsx's duplicate-athlete merge and person-data.ts's GDPR
// export, which may target someone OTHER than the signed-in caller (so they
// can't reuse the "mine" cache above) and whose correctness depends on the
// read being COMPLETE, not on a cache being warm. AdminMembers.tsx is the
// sharpest case in the whole refactor: its read feeds a mutate() that
// reassigns/hard-deletes these rows and then deletes the person — an
// incomplete read here would silently ORPHAN registrations against a
// deleted athleteId (data corruption, not a wrong count). Always issue a
// fresh network fetch; never read from myRegsCache/regsByClubSlice even when
// personId happens to match, since those may be loading, stale, or scoped to
// someone else entirely.
// ---------------------------------------------------------------------------

export async function fetchRegistrationsForPerson(personId: string): Promise<Registration[]> {
  if (!isSupabaseConfigured) return getDB().registrations.filter((r) => r.athleteId === personId);
  return fetchRegistrationsForPersonRemote(personId);
}

// ---------------------------------------------------------------------------
// Local-cache fan-out for writes. Every existing pushRegistration/
// deleteRegistration call site keeps its current mutate()-based shape
// (including its own `d.registrations` bookkeeping, still required for
// unconfigured/demo mode) and additionally calls one of these two functions
// so the optimistic update also reaches whichever slice(s)/the "mine" cache
// currently hold the row. Safe to call unconditionally, including in demo
// mode: the caches below are simply never read there (useEventRegistrations/
// useClubRegistrations/useMyRegistrations all short-circuit to a
// db.registrations read first).
// ---------------------------------------------------------------------------

function applyLocalMineUpsert(reg: Registration): void {
  if (reg.athleteId !== myRegsPersonId) return;
  myRegsCache = [...myRegsCache.filter((r) => r.id !== reg.id), reg];
  notifyMyRegs();
}

function applyLocalMineRemove(id: string, athleteId: string): void {
  if (athleteId !== myRegsPersonId) return;
  myRegsCache = myRegsCache.filter((r) => r.id !== id);
  notifyMyRegs();
}

/** Fan a write out to every cache that might hold this row (by-event slice,
 *  by-club slice, "mine" cache). */
export function applyLocalRegistrationUpsert(reg: Registration): void {
  regsByEventSlice.applyLocalUpsert(reg.eventId, reg);
  if (reg.clubId) regsByClubSlice.applyLocalUpsert(reg.clubId, reg);
  applyLocalMineUpsert(reg);
}

/** Fan a removal out to every cache that might hold this row. Needs the
 *  eventId/clubId/athleteId the row HAD (pass it as it existed BEFORE
 *  deletion), not just the bare id, so every cache that might hold it can be
 *  found and patched. */
export function applyLocalRegistrationRemove(reg: RegKeyFields): void {
  regsByEventSlice.applyLocalRemove(reg.eventId, reg.id);
  if (reg.clubId) regsByClubSlice.applyLocalRemove(reg.clubId, reg.id);
  applyLocalMineRemove(reg.id, reg.athleteId);
}

// ---------------------------------------------------------------------------
// Top-level write helpers — for call sites that write a registration on
// their OWN (not as one step inside a larger existing mutate() transaction
// that already handles its own offline gating + d.registrations bookkeeping,
// e.g. Club.tsx's/Events.tsx's multi-field cart+registration mutations).
// Mirrors scores-slice.ts's writeScore/applyLocalScoreUpdate shape.
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

/** Standalone registration write: applies the optimistic local update AND
 *  enqueues the remote push. Returns false (without applying anything) when
 *  offline and Supabase-backed — mirrors store.ts's mutate() offline
 *  read-only gate, so callers can skip a false "saved!" toast the same way
 *  they already do elsewhere. */
export function writeRegistration(reg: Registration, squadId: string | null = null): boolean {
  if (!isSupabaseConfigured) {
    return mutate((d) => {
      d.registrations = d.registrations.filter((r) => r.id !== reg.id);
      d.registrations.push(reg);
    });
  }
  if (!guardOnline()) return false;
  applyLocalRegistrationUpsert(reg);
  pushRegistration(reg, squadId);
  return true;
}

/** Standalone registration delete: applies the optimistic local removal AND
 *  enqueues the remote delete. Same offline-gate semantics as
 *  writeRegistration. */
export function writeRegistrationDelete(reg: RegKeyFields): boolean {
  if (!isSupabaseConfigured) {
    return mutate((d) => { d.registrations = d.registrations.filter((r) => r.id !== reg.id); });
  }
  if (!guardOnline()) return false;
  applyLocalRegistrationRemove(reg);
  deleteRegistration(reg.id);
  return true;
}
