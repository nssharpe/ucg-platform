// Generic scoped-slice cache — the shared infrastructure behind Phase 2
// (scores) and, per the contract, reusable by Phase 3 (registrations)
// without a redesign. See "The slice-layer CONTRACT (settled 2026-07-26)"
// in docs/specs/2026-07-24-data-layer-scale.md.
//
// A slice holds rows scoped to a key (e.g. one event id), fetched on demand
// and cached in memory ONLY — nothing here ever touches localStorage, which
// is the whole point (removes the multi-MB snapshot the spec measured).
//
// Kept dependency-free (no Supabase client, no store, no React-specific
// business logic beyond the two hooks) so the pure parts — status
// transitions, local upsert/remove — are directly unit-testable without a
// DOM. See tests/lib/slice-cache.test.ts.
import { useEffect, useSyncExternalStore } from 'react';

export type SliceStatus = 'loading' | 'ready' | 'error';
export interface SliceResult<T> { rows: T[]; status: SliceStatus; }

// Shared, frozen sentinel for "not yet loaded" so getSnapshot returns a
// STABLE reference for any key not in the cache — useSyncExternalStore
// compares snapshots with Object.is, so a fresh `{ rows: [], status:
// 'loading' }` literal on every call would loop.
const NOT_LOADED: SliceResult<never> = Object.freeze({ rows: Object.freeze([]) as never[], status: 'loading' });

export interface RealtimeHelpers<T> {
  /** Insert or replace one row (matched by idOf) in the scope's cached rows. */
  upsert: (row: T) => void;
  /** Remove one row (by id) from the scope's cached rows. */
  remove: (id: string) => void;
  /** Silently refetch the whole scope (replaces rows on success; status is
   *  left as-is until the refetch resolves — no loading flicker). */
  invalidate: () => void;
}

export interface SliceSource<T> {
  /** Fetch every row for one scope key (e.g. one event id). Must page past
   *  PostgREST's row cap itself (see fetchAllRows/fetchScopedRows in
   *  supabase.ts) — a slice fetch that doesn't paginate reintroduces the
   *  silent-truncation bug Phase 0 fixed. */
  fetchScope: (key: string) => Promise<T[]>;
  /** Row identity — used for local upsert/remove + realtime patching. */
  idOf: (row: T) => string;
  /** Optional realtime wiring: called once per actively-observed key with
   *  helpers to patch or invalidate this scope's cache; returns an
   *  unsubscribe fn. */
  subscribeRealtime?: (key: string, helpers: RealtimeHelpers<T>) => () => void;
}

export interface EventScopedSlice<T> {
  /** React hook: subscribes to one scope key, kicking off a fetch (and a
   *  realtime subscription, if configured) the first time it's observed.
   *  `status` is always present — never optional — so a caller can't
   *  accidentally treat "not loaded" as "loaded and empty". */
  useScope: (key: string | undefined | null) => SliceResult<T>;
  /** Kick off a fetch for `key` if it isn't already cached or in flight.
   *  Safe to call from outside React. */
  ensure: (key: string) => void;
  /** Silently refetch `key`, replacing its rows on success. */
  invalidate: (key: string) => void;
  /** Optimistically insert/replace one row in `key`'s cache. No-op if `key`
   *  isn't loaded yet (the eventual real fetch will already include it — an
   *  optimistic write into an unloaded scope has nothing to be optimistic
   *  ABOUT, since nothing is displayed from it yet). */
  applyLocalUpsert: (key: string, row: T) => void;
  /** Optimistically remove one row (by id) from `key`'s cache. */
  applyLocalRemove: (key: string, id: string) => void;
  /** Non-hook read of the current cached state for `key`. */
  getSnapshot: (key: string) => SliceResult<T>;
}

export function createEventScopedSlice<T>(source: SliceSource<T>): EventScopedSlice<T> {
  const cache = new Map<string, SliceResult<T>>();
  const listeners = new Set<() => void>();
  const inFlight = new Map<string, Promise<void>>();
  const realtimeRefs = new Map<string, { unsub: () => void; count: number }>();

  function notify() { listeners.forEach((l) => l()); }

  function getSnapshot(key: string): SliceResult<T> {
    return cache.get(key) ?? (NOT_LOADED as SliceResult<T>);
  }

  function load(key: string): Promise<void> {
    const existing = inFlight.get(key);
    if (existing) return existing;
    const p = source.fetchScope(key)
      .then((rows) => { cache.set(key, { rows, status: 'ready' }); })
      .catch((e: unknown) => {
        console.error(`[slice-cache] fetch failed for scope "${key}":`, e);
        // Preserve whatever rows were previously cached (e.g. a realtime-
        // triggered refetch that failed shouldn't wipe a working display).
        cache.set(key, { rows: cache.get(key)?.rows ?? [], status: 'error' });
      })
      .finally(() => { inFlight.delete(key); notify(); });
    inFlight.set(key, p);
    return p;
  }

  function ensure(key: string): void {
    if (!key || cache.has(key) || inFlight.has(key)) return;
    void load(key);
  }

  function invalidate(key: string): void {
    if (!key) return;
    void load(key);
  }

  function applyLocalUpsert(key: string, row: T): void {
    if (!key) return;
    const cur = cache.get(key);
    if (!cur) return;
    const id = source.idOf(row);
    cache.set(key, { rows: [...cur.rows.filter((r) => source.idOf(r) !== id), row], status: 'ready' });
    notify();
  }

  function applyLocalRemove(key: string, id: string): void {
    if (!key) return;
    const cur = cache.get(key);
    if (!cur) return;
    cache.set(key, { rows: cur.rows.filter((r) => source.idOf(r) !== id), status: cur.status });
    notify();
  }

  function useScope(key: string | undefined | null): SliceResult<T> {
    const k = key ?? '';
    useEffect(() => {
      if (!k) return;
      ensure(k);
      if (!source.subscribeRealtime) return;
      let ref = realtimeRefs.get(k);
      if (!ref) {
        const unsub = source.subscribeRealtime(k, {
          upsert: (row) => applyLocalUpsert(k, row),
          remove: (id) => applyLocalRemove(k, id),
          invalidate: () => invalidate(k),
        });
        ref = { unsub, count: 0 };
        realtimeRefs.set(k, ref);
      }
      ref.count++;
      return () => {
        const r = realtimeRefs.get(k);
        if (!r) return;
        r.count--;
        if (r.count <= 0) { r.unsub(); realtimeRefs.delete(k); }
      };
    }, [k]);
    return useSyncExternalStore(
      (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
      () => getSnapshot(k),
    );
  }

  return { useScope, ensure, invalidate, applyLocalUpsert, applyLocalRemove, getSnapshot };
}

/** Pure: a stable cache key for a "mine" (Tier 2) fetch scoped to one person
 *  + a set of ids (e.g. their own registration ids) — order-independent, so
 *  a re-render that produces the same id set in a different array order
 *  doesn't look like a change. Shared by scores-slice.ts's "mine" cache and,
 *  per the CONTRACT, reusable by Phase 3 for "my registrations". */
export function mineCacheKey(personId: string, ids: string[]): string {
  return `${personId}|${[...ids].sort().join(',')}`;
}
