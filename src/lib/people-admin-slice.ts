// Phase 4 (data-layer-scale.md) on-demand escapes for `people`, mirroring
// memberships-admin-slice.ts's shape exactly (same three cache shapes, same
// reasoning) now that `people` itself is Tier-2 boot-scoped instead of
// globally hydrated — see supabase.ts's loadAll + the block comment above
// fetchPersonRemote/fetchPeopleForIdsRemote/fetchPeopleForClubRemote/
// fetchAllPeopleAdminRemote for the RLS-visibility reasoning (same ceiling
// as the old unscoped select('*'), just a narrower query).
//
//   - "Everything" (shape #3/#4): a single fixed key, admin-only — used by
//     AdminMembers.tsx (people picker), AdminClubs.tsx, Communicate.tsx's
//     audience filter, Home.tsx's admin dashboard, UserRoles.tsx. Never on a
//     normal render path for a non-admin.
//   - "One club's roster" (shape #1's sibling): Club.tsx's Roster/
//     ClubManagers/EventRegGrid — reachable by ANY signed-in account for ANY
//     club, and an admin's `canManage` is true everywhere, so a caller
//     viewing a club they don't personally manage needs this (a manager's
//     OWN club is already correct via Tier 2 boot scope; this is a cheap
//     redundant-but-harmless refetch for that case, same pattern as
//     useClubRosterMemberships).
//   - "One arbitrary person" (shape #4, cached — a view/edit read, NOT a
//     destructive merge): Profile.tsx adminView. See fetchPersonRemote
//     (supabase.ts) for the UNCACHED version used by AdminMembers' actual
//     merge (shape #6 — completeness must come from the query right before
//     a destructive write, never a maybe-stale cache) and person-data.ts's
//     GDPR export.
import { createEventScopedSlice } from './slice-cache';
import { fetchAllPeopleAdminRemote, fetchPersonRemote, fetchPeopleForClubRemote, fetchPeopleForIdsRemote } from './supabase';
import { idsCacheKey } from './people-slice';
import type { Athlete } from './types';

const LEAGUE_KEY = 'league';

const adminPeopleSlice = createEventScopedSlice<Athlete>({
  fetchScope: () => fetchAllPeopleAdminRemote(),
  idOf: (p) => p.id,
});

/** Every person league-wide, `{ rows, status }`. Any computation over this
 *  (counts, filters) MUST gate on `status === 'ready'` first — a count
 *  computed while `status === 'loading'` silently undercounts instead of
 *  visibly showing "not loaded yet" (e.g. AdminMembers' "{rows.length}
 *  people", Communicate's audienceCount, Home's admin member stats). */
export function useAdminPeople() {
  return adminPeopleSlice.useScope(LEAGUE_KEY);
}

/** Kick off the league-wide people fetch without mounting a consumer. */
export function ensureAdminPeople(): void {
  adminPeopleSlice.ensure(LEAGUE_KEY);
}

/** Silently refetch the league-wide people list — call after a write that
 *  changes who exists/what a row looks like league-wide but that this
 *  cache wouldn't otherwise see (e.g. AdminMembers' duplicate-athlete merge,
 *  which deletes one person and edits another via direct push* calls rather
 *  than a local mutate() this cache could patch itself from). No-op if the
 *  league-wide slice was never loaded (nothing to refresh). */
export function invalidateAdminPeople(): void {
  adminPeopleSlice.invalidate(LEAGUE_KEY);
}

// ---------------------------------------------------------------------------
// One club's roster (mainClubId OR alt-club affiliation — see
// fetchPeopleForClubRemote's doc comment in supabase.ts)
// ---------------------------------------------------------------------------

const clubRosterPeopleSlice = createEventScopedSlice<Athlete>({
  fetchScope: (clubId) => fetchPeopleForClubRemote(clubId),
  idOf: (p) => p.id,
});

/** One club's full roster (people rows), `{ rows, status }`. `clubId` is the
 *  scope key. */
export function usePeopleForClub(clubId: string | undefined | null) {
  return clubRosterPeopleSlice.useScope(clubId);
}

// ---------------------------------------------------------------------------
// One arbitrary person, full row, CACHED (Profile.tsx adminView — a
// view/edit page where caching is a genuine win, same distinction
// memberships-admin-slice.ts's personMembershipsSlice already draws)
// ---------------------------------------------------------------------------

const personAdminSlice = createEventScopedSlice<Athlete>({
  fetchScope: async (personId) => {
    const p = await fetchPersonRemote(personId);
    return p ? [p] : [];
  },
  idOf: (p) => p.id,
});

/** One arbitrary person's full row, `{ rows, status }` — `rows[0] ?? null`
 *  is the person (0 rows if not found/deleted). `personId` is the scope key,
 *  so switching target people naturally refetches. For a destructive write
 *  (merge, delete), use fetchPersonRemote directly instead — never this
 *  cache — so completeness comes from a fresh query, not a maybe-stale one. */
export function usePersonAdmin(personId: string | undefined | null) {
  return personAdminSlice.useScope(personId);
}

// ---------------------------------------------------------------------------
// By ids, FULL rows (shape #2 for consumers needing more than
// people-slice.ts's thin name+club projection — nationals categorization,
// the registration-workbook export). Keyed the same way people-slice.ts's
// idsCacheKey works, reusing that helper so the two shapes' keys never
// collide in confusing ways even though they're separate slice instances.
// ---------------------------------------------------------------------------

const peopleByIdsFullSlice = createEventScopedSlice<Athlete>({
  fetchScope: (key) => fetchPeopleForIdsRemote(key.split(',').filter(Boolean)),
  idOf: (p) => p.id,
});

/** Full-row lookup for a SET of person ids (nationals-adapter.ts's
 *  categorization math needs gender/placement/studentStatus;
 *  Events.tsx's registration-workbook export needs
 *  shirt/dietary/email/phone/emergency). Gated the same way as the rest of
 *  this file's admin-ish surfaces — see fetchPeopleForIdsRemote's doc
 *  comment in supabase.ts for the RLS ceiling this inherits. */
export function usePeopleForIds(ids: string[]) {
  const key = idsCacheKey(ids);
  return peopleByIdsFullSlice.useScope(key || null);
}

/** Non-hook one-off fetch for the same shape (CSV/workbook export click
 *  actions, nationals-adapter.ts callers that aren't React components). */
export async function fetchPeopleForIdsOnce(ids: string[]): Promise<Athlete[]> {
  return fetchPeopleForIdsRemote(ids);
}
