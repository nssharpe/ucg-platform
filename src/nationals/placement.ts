import { roundScore } from './round';

/**
 * Competition-ranking (1,2,2,4) placement within groups, a faithful port of the
 * reference tool's `discipline.calculate_results_per_event`.
 *
 * Rows are sorted by score descending and walked once; each group
 * (`groupKey`) keeps a `(place, lastScore, numConsecutive)` state machine.
 * Equal (rounded) scores share a place; the next strictly-lower score jumps by
 * the number of tied competitors. Only `isEligible` rows are placed; ineligible
 * rows are skipped without disturbing the state.
 *
 * `extraIndex` supports Synch Trampoline: when two rows share an index (a partner
 * pair), the second reuses the first's place instead of advancing the state.
 */
export interface Placeable {
  id: string;
  score: number;
}

interface GroupState {
  place: number;
  lastScore: number;
  numConsecutive: number;
}

export function assignPlaces<T extends Placeable>(
  rows: T[],
  isEligible: (row: T) => boolean,
  groupKey: (row: T) => string,
  extraIndex?: (row: T) => string,
): Map<string, number> {
  const places = new Map<string, number>(); // row id -> place
  const groups = new Map<string, GroupState>();
  const extra = new Map<string, number>();

  // Stable sort by rounded score descending. (The reference relies only on the
  // score order; ties get equal places regardless of intra-tie ordering.)
  const sorted = [...rows].sort((a, b) => roundScore(b.score) - roundScore(a.score));

  for (const row of sorted) {
    if (!isEligible(row)) continue;
    const key = groupKey(row);
    let st = groups.get(key);
    if (!st) {
      st = { place: 1, lastScore: 0.0, numConsecutive: 0 };
      groups.set(key, st);
    }
    const score = roundScore(row.score);
    const xi = extraIndex?.(row);
    if (xi !== undefined && extra.has(xi)) {
      places.set(row.id, extra.get(xi)!);
      continue;
    }
    if (score < st.lastScore) {
      st.place = st.place + st.numConsecutive;
      st.lastScore = score;
      st.numConsecutive = 1;
    } else {
      st.lastScore = score;
      st.numConsecutive += 1;
    }
    places.set(row.id, st.place);
    if (xi !== undefined) extra.set(xi, st.place);
  }
  return places;
}
