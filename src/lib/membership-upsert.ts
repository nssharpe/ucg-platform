import { membershipTypeOf } from './capabilities-core';
import type { Membership } from './types';

/** Pure: replace the membership matching `m`'s (seasonId, type) in `list`, or
 *  append it when absent — the "reset from the freshly-fetched rows, then
 *  upsert this one" step Profile.tsx's admin Activate/Revoke use for both the
 *  boot-scoped `db.people` row (when the administered person happens to be in
 *  it) and the per-person memberships slice (always). Type is compared via
 *  `membershipTypeOf`, so a legacy row with no explicit type still matches an
 *  explicit `'athlete'`. Never mutates `list`. */
export function upsertMembership(list: readonly Membership[], m: Membership): Membership[] {
  const idx = list.findIndex((x) => x.seasonId === m.seasonId && membershipTypeOf(x) === membershipTypeOf(m));
  return idx >= 0 ? list.map((x, i) => (i === idx ? m : x)) : [...list, m];
}
