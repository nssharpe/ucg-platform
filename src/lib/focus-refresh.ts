// Multi-manager freshness (F3): realtime subscriptions only cover `scores`,
// so two managers (or admin + manager) editing the same club can silently
// drift out of sync in a backgrounded tab. This module refetches
// (syncFromSupabase) when a tab that was away for a while becomes active
// again — cheap insurance against stale reads, not a substitute for realtime.
import { isSupabaseConfigured } from './supabase';
import { getWriteQueueState, isBrowserOnline } from './write-queue';

/** Minimum time away (hidden/blurred/offline) before a return is worth a
 *  refetch, AND the minimum time since the last completed sync — both bounds
 *  must hold (whichever is stricter wins). */
export const REFRESH_THRESHOLD_MS = 60_000;

export interface ShouldRefetchInput {
  /** ms timestamp the page most recently went away (hidden/blurred/offline),
   *  or null if it hasn't been away since the last check. */
  hiddenAtMs: number | null;
  nowMs: number;
  /** ms timestamp of the last completed full sync, or null if none yet. */
  lastSyncMs: number | null;
  /** True when the write-queue has no pending/in-flight entries — never race
   *  a local optimistic change with a full-snapshot overwrite. */
  queueIdle: boolean;
  online: boolean;
  configured: boolean;
}

/** Pure decision function (no DOM/Supabase access) — unit-tested in isolation. */
export function shouldRefetchOnFocus(input: ShouldRefetchInput): boolean {
  const { hiddenAtMs, nowMs, lastSyncMs, queueIdle, online, configured } = input;
  if (!configured) return false;
  if (!online) return false;
  if (!queueIdle) return false;
  if (hiddenAtMs == null) return false;
  if (nowMs - hiddenAtMs < REFRESH_THRESHOLD_MS) return false;
  if (lastSyncMs != null && nowMs - lastSyncMs < REFRESH_THRESHOLD_MS) return false;
  return true;
}

let hiddenAtMs: number | null = null;
let lastSyncMs: number | null = null;
let syncing = false; // in-flight guard — never let two syncs overlap
let initialized = false;

function markAway() {
  if (hiddenAtMs == null) hiddenAtMs = Date.now();
}

function maybeRefetch() {
  const input: ShouldRefetchInput = {
    hiddenAtMs,
    nowMs: Date.now(),
    lastSyncMs,
    queueIdle: getWriteQueueState().pending === 0,
    online: isBrowserOnline(),
    configured: isSupabaseConfigured,
  };
  // A "return" event ends the away period whether or not we act on it below —
  // deliberately not rescheduled/retried on a timer (see spec F3): if the
  // queue happens to be busy right at the return moment we just skip and wait
  // for the next natural away/return cycle rather than polling aggressively.
  hiddenAtMs = null;
  if (syncing) return;
  if (!shouldRefetchOnFocus(input)) return;
  syncing = true;
  console.debug('[focus-refresh] tab returned after a while — refetching');
  // Dynamic import avoids a static import cycle with store.ts (same reason
  // supabase.ts's rollback-sync does this).
  void import('./store')
    .then((m) => m.syncFromSupabase())
    .catch(() => { /* syncFromSupabase already logs internally on failure */ })
    .finally(() => {
      syncing = false;
      lastSyncMs = Date.now();
    });
}

/** Wire the focus-refresh listeners once at app boot. No-op when Supabase
 *  isn't configured — there's nothing remote to refetch. Idempotent. */
export function initFocusRefresh(): void {
  if (initialized || !isSupabaseConfigured) return;
  initialized = true;
  // store.ts already fires an initial syncFromSupabase() on module load when
  // configured (boot hydration) — seed lastSyncMs so a tab backgrounded a few
  // seconds after boot doesn't immediately trigger a redundant re-sync.
  lastSyncMs = Date.now();

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) markAway();
    else maybeRefetch();
  });
  // Window blur/offline mark the away period without themselves triggering a
  // refetch — only the return events (focus/visible/online) run the check.
  window.addEventListener('blur', markAway);
  window.addEventListener('offline', markAway);
  window.addEventListener('focus', maybeRefetch);
  window.addEventListener('online', maybeRefetch);
}
