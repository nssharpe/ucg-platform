// Pure helpers for "Finals roster" (event-mgmt v2 Phase 5, spec §E7, §L.3).
// A nationals team (club + level + placement category) picks up to
// `FINALS_LINEUP_MAX` athletes per apparatus for finals, plus drag order.
// Zero React/store imports — keep this importable from tests and future edge
// functions alike (mirrors src/lib/competition-order.ts's pure-logic split).
//
// No UI here — that's C2. This module only builds/validates/edits the
// `regIds: string[]` shape persisted on `FinalsLineup.regIds`
// (src/lib/types.ts) and the `finals_lineups.reg_ids` jsonb column
// (P5 C1 migration).

/** Max athletes per apparatus lineup (spec §E7): pick up to 4. */
export const FINALS_LINEUP_MAX = 4;

/** True iff `regIds` has at most `max` (default `FINALS_LINEUP_MAX`) entries
 *  and contains no duplicate registration id. */
export function finalsLineupValid(regIds: string[], max: number = FINALS_LINEUP_MAX): boolean {
  if (regIds.length > max) return false;
  return new Set(regIds).size === regIds.length;
}

/** Pure reorder: move the entry at index `from` to index `to`. Defensive —
 *  clamps out-of-range indices into bounds and never mutates the input;
 *  returns a new array. A no-op `from`/empty list returns a shallow copy. */
export function moveInLineup(regIds: string[], from: number, to: number): string[] {
  const next = [...regIds];
  if (next.length === 0) return next;
  const clampedFrom = Math.min(Math.max(from, 0), next.length - 1);
  const [moved] = next.splice(clampedFrom, 1);
  const clampedTo = Math.min(Math.max(to, 0), next.length);
  next.splice(clampedTo, 0, moved);
  return next;
}

/** Toggle `regId` in/out of `regIds` (pure, never mutates the input):
 *  - if present, remove it.
 *  - if absent AND the list is under `max` (default `FINALS_LINEUP_MAX`),
 *    append it.
 *  - if absent and already at `max`, return an unchanged copy (adding past
 *    cap is a no-op — the caller should surface "lineup full" in the UI
 *    rather than silently dropping/replacing an existing pick). */
export function toggleInLineup(regIds: string[], regId: string, max: number = FINALS_LINEUP_MAX): string[] {
  if (regIds.includes(regId)) return regIds.filter((id) => id !== regId);
  if (regIds.length >= max) return [...regIds];
  return [...regIds, regId];
}
