// Tier 2 on-demand escapes for `memberships` (whats-next.md §7 / docs/specs/
// 2026-07-24-data-layer-scale.md): loadAll's boot read attaches memberships
// only to `person.memberships` for the caller's own + managed-club rosters,
// so anything needing memberships for OTHER people fetches on demand here
// instead. Two shapes, both routed through the shared slice-cache infra so
// `ensure`/prefetch-on-hover works without a redesign later:
//
//   - "Everything" (shape #4): a single fixed key, admin-only, used by
//     AdminClubs.tsx (per-club active-member counts), Communicate.tsx (the
//     audience membership filter), and Home.tsx's admin dashboard. Never on
//     a normal render path for a non-admin.
//   - "One arbitrary person" (a view/edit read, not a destructive merge —
//     see supabase.ts's fetchMembershipsForPersonRemote for the merge-modal
//     case, which deliberately stays an UNCACHED direct fetch instead):
//     Profile.tsx's adminView needs a specific OTHER person's memberships
//     that Tier 2's boot scope doesn't carry. Caching here is a genuine win
//     (revisit the same admin profile ⇒ instant render + background
//     refresh) rather than a correctness risk, since nothing destructive
//     reads straight off this cache.
import { createEventScopedSlice } from './slice-cache';
import { fetchAllMembershipsAdminRemote, fetchMembershipsForPersonRemote } from './supabase';
import type { Membership } from './types';

export interface MembershipRowWithPerson { personId: string; membership: Membership; }

const LEAGUE_KEY = 'league';

const adminMembershipsSlice = createEventScopedSlice<MembershipRowWithPerson>({
  fetchScope: async () => {
    const byPerson = await fetchAllMembershipsAdminRemote();
    const out: MembershipRowWithPerson[] = [];
    for (const [personId, list] of byPerson) for (const membership of list) out.push({ personId, membership });
    return out;
  },
  idOf: (r) => `${r.personId}:${r.membership.seasonId}:${r.membership.type}`,
});

/** Every membership league-wide (flat rows tagged with personId), `{ rows,
 *  status }`. Use `groupAdminMembershipsByPerson` to get the per-person map
 *  most consumers actually want. Any computation over this MUST gate on
 *  `status === 'ready'` first — a partial read here undercounts exactly
 *  like the invoices case (e.g. AdminClubs' "Active" column). */
export function useAdminMemberships() {
  return adminMembershipsSlice.useScope(LEAGUE_KEY);
}

/** Kick off the league-wide memberships fetch without mounting a consumer. */
export function ensureAdminMemberships(): void {
  adminMembershipsSlice.ensure(LEAGUE_KEY);
}

/** Groups a flat admin-memberships slice result by person_id. */
export function groupAdminMembershipsByPerson(rows: MembershipRowWithPerson[]): Map<string, Membership[]> {
  const out = new Map<string, Membership[]>();
  for (const r of rows) {
    const arr = out.get(r.personId) ?? [];
    arr.push(r.membership);
    out.set(r.personId, arr);
  }
  return out;
}

// ---------------------------------------------------------------------------
// One arbitrary person's memberships (Profile.tsx adminView)
// ---------------------------------------------------------------------------

const personMembershipsSlice = createEventScopedSlice<Membership>({
  fetchScope: (personId) => fetchMembershipsForPersonRemote(personId),
  // Membership has no TS id of its own (matches the server's derived
  // `${personId}:${seasonId}:${type}` key, but personId is constant within
  // one scope call here so seasonId+type alone is a unique row identity).
  idOf: (m) => `${m.seasonId}:${m.type}`,
});

/** One arbitrary person's memberships, `{ rows, status }` — for viewing/
 *  editing someone OTHER than the signed-in caller (Profile.tsx adminView).
 *  `personId` is the scope key, so switching target people naturally
 *  refetches. */
export function useMembershipsForPerson(personId: string | undefined | null) {
  return personMembershipsSlice.useScope(personId);
}
