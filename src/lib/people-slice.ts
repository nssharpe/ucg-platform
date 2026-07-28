// Phase 4 (2026-07-28 data-layer-scale, rewritten): `people` moves off
// unconditional global hydration for the Supabase-backed path. loadAll's
// boot read stays scoped (self + managed-club rosters — src/lib/supabase.ts
// loadAll); everything a page needs BEYOND that scope goes through here or
// people-admin-slice.ts. See "Phase 4 is REWRITTEN" in
// docs/specs/2026-07-24-data-layer-scale.md — every row any of these return
// is a COMPLETE row (or, for this file specifically, the thin
// `public_competitors` name+club projection — see below), never a partial
// field split.
//
// This file: shape #2, "by ids" — event/results pages showing names for
// competitors from OTHER clubs (Results, Judge, ScoreDetail,
// EventCheckinCard, CompetitionOrderCard, FinalsLineupEditor,
// CapacityConflictDialog). Backed by `public_competitors`
// (id/firstName/lastName/mainClubId), a security-invoker=false VIEW
// readable by anon AND every authenticated caller regardless of club
// affiliation — unlike the real `people` table, whose only SELECT policy is
// self/managed-club/admin/refund_manager/finance_admin (see the long doc
// comment on fetchPublicPeopleForIdsRemote in supabase.ts for how this was
// discovered, and the live-prod-anon proof that names are silently blank on
// the public Results page today without it).
//
// Consumers needing MORE than name+club (nationals categorization's
// gender/placement/studentStatus, the registration-workbook export's
// shirt/dietary/email/phone/emergency) use people-admin-slice.ts's
// usePeopleForIds instead (the real `people` table, RLS-gated to
// admin/sanctioning/host — those surfaces are already gated that way).
import { useMemo } from 'react';
import { useDB } from './store';
import { isSupabaseConfigured, fetchPublicPeopleForIdsRemote, type CompetitorRef } from './supabase';
import { createEventScopedSlice, type SliceResult } from './slice-cache';

export type { CompetitorRef };

/** Pure: a stable, order-independent cache key for a set of person ids —
 *  mirrors slice-cache.ts's mineCacheKey but without a personId prefix
 *  (this shape isn't tied to one signed-in caller). */
export function idsCacheKey(ids: string[]): string {
  return [...new Set(ids)].filter(Boolean).sort().join(',');
}

const competitorsByIdsSlice = createEventScopedSlice<CompetitorRef>({
  fetchScope: (key) => fetchPublicPeopleForIdsRemote(key.split(',').filter(Boolean)),
  idOf: (r) => r.id,
});

/** Thin name+club lookup for a SET of person ids (shape #2). Batches into
 *  one fetch per unique id-set (never N sequential per-athlete fetches) and
 *  caches by that set, so two components asking for the same event's field
 *  share one fetch. Demo/unconfigured mode reads `db.people` directly
 *  (never scoped there — buildSeed() fully hydrates it). */
export function usePeopleNames(ids: string[]): SliceResult<CompetitorRef> {
  const demoDb = useDB();
  const key = useMemo(() => idsCacheKey(ids), [ids]);
  const remote = competitorsByIdsSlice.useScope(isSupabaseConfigured && key ? key : null);
  if (!isSupabaseConfigured) {
    const wanted = new Set(ids);
    const rows: CompetitorRef[] = demoDb.people
      .filter((p) => wanted.has(p.id))
      .map((p) => ({ id: p.id, firstName: p.firstName, lastName: p.lastName, mainClubId: p.mainClubId }));
    return { rows, status: 'ready' };
  }
  if (!key) return { rows: [], status: 'ready' };
  return remote;
}

/** Kick off the fetch for a set of ids without mounting a consumer (e.g. a
 *  future prefetch-on-hover). No-op in demo mode. */
export function ensurePeopleNames(ids: string[]): void {
  if (!isSupabaseConfigured) return;
  const key = idsCacheKey(ids);
  if (key) competitorsByIdsSlice.ensure(key);
}

/** Build a fast id -> "First Last" lookup from a usePeopleNames result —
 *  most consumers just want a name string, not the row. */
export function nameLookup(rows: CompetitorRef[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rows) out.set(r.id, `${r.firstName} ${r.lastName}`.trim());
  return out;
}
