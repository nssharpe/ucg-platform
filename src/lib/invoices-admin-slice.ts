// Tier 2 on-demand escape for `invoices` (whats-next.md §7 / docs/specs/
// 2026-07-24-data-layer-scale.md): loadAll's boot read is scoped to the
// caller's own + managed-club invoices, so a league-wide money surface
// (Finance, RefundReview) needs every invoice on demand instead — CONTRACT
// shape #4 ("everything", admin-only, never on a normal render path).
//
// Routed through the existing slice-cache infra (a single fixed key, since
// there's only one "scope" — the whole league) rather than a bespoke
// useState/useEffect, so `ensureAdminInvoices()` can be called independently
// of any component mounting (e.g. a future prefetch-on-hover) without a
// redesign — see createEventScopedSlice's `ensure` in slice-cache.ts.
import { createEventScopedSlice } from './slice-cache';
import { fetchAllInvoicesAdminRemote } from './supabase';
import type { Invoice } from './types';

const LEAGUE_KEY = 'league';

const invoicesAdminSlice = createEventScopedSlice<Invoice>({
  fetchScope: () => fetchAllInvoicesAdminRemote(),
  idOf: (inv) => inv.id,
});

/** Every invoice league-wide, `{ rows, status }`. Money surfaces MUST gate
 *  every computed total on `status === 'ready'` — a total computed while
 *  `status === 'loading'` would silently render an undercounted number, not
 *  an obviously-missing row. */
export function useAdminInvoices() {
  return invoicesAdminSlice.useScope(LEAGUE_KEY);
}

/** Kick off the league-wide invoices fetch without mounting a consumer —
 *  what a future prefetch-on-hover would call. */
export function ensureAdminInvoices(): void {
  invoicesAdminSlice.ensure(LEAGUE_KEY);
}
