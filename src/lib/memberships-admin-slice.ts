// Tier 2 on-demand escapes for `memberships` (whats-next.md §7 / docs/specs/
// 2026-07-24-data-layer-scale.md): loadAll's boot read attaches memberships
// only to `person.memberships` for the caller's own + managed-club rosters,
// so anything needing memberships for OTHER people fetches on demand here
// instead. Three shapes, all routed through the shared slice-cache infra so
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
//   - "One club's roster" (below): Club.tsx's Roster is reachable by ANY
//     signed-in account for ANY club (RequireAccount, not manager-gated),
//     and an admin's `canManage` is true for every club — but Tier 2's boot
//     scope only covers clubs the caller is a registered manager of, so an
//     admin opening a club they don't personally manage needs this too.
import { createEventScopedSlice } from './slice-cache';
import { fetchAllMembershipsAdminRemote, fetchMembershipsForPersonRemote, fetchMembershipsForPersonIdsRemote } from './supabase';
import { getDB } from './store';
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

// ---------------------------------------------------------------------------
// One club's roster memberships (Club.tsx's Roster — an admin can open ANY
// club's page, not just ones they manage, so Tier 2's boot scope (which only
// covers the caller's OWN managed clubs) doesn't carry a non-managed club's
// roster data for them; a real manager's OWN club is already correct via
// Tier 2, so this is a cheap redundant-but-harmless refetch for that case)
// ---------------------------------------------------------------------------

const clubRosterMembershipsSlice = createEventScopedSlice<MembershipRowWithPerson>({
  // Resolves the roster from the already-hydrated `people` (Tier 1/special
  // case, unaffected by this refactor) rather than requiring the caller to
  // pass person ids through the single-string scope key.
  fetchScope: async (clubId) => {
    const rosterIds = getDB().people.filter((p) => p.mainClubId === clubId).map((p) => p.id);
    const byPerson = await fetchMembershipsForPersonIdsRemote(rosterIds);
    const out: MembershipRowWithPerson[] = [];
    for (const [personId, list] of byPerson) for (const membership of list) out.push({ personId, membership });
    return out;
  },
  idOf: (r) => `${r.personId}:${r.membership.seasonId}:${r.membership.type}`,
});

/** One club's roster memberships, `{ rows, status }` (use
 *  `groupAdminMembershipsByPerson` for the per-person map). `clubId` is the
 *  scope key. */
export function useClubRosterMemberships(clubId: string | undefined | null) {
  return clubRosterMembershipsSlice.useScope(clubId);
}
