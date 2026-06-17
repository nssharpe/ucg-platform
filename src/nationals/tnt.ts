import { roundScore } from './round';
import { assignPlaces } from './placement';
import type { AthleteEntry, AthleteResult, DisciplineDef, EventPlacement, QualFlag } from './types';

/** TNT cutoffs: one blue number per level (same across events/categories),
 *  from the `[Levels]` section of the TNT config.ini. */
export type TntCutoffs = Record<string, number>;

const SYNCH = 'Synch_Trampoline';

/** Unordered partner-pair + synch level key, so both partners share a place.
 *  Ports `SyncroTrampoline.calc_extra_places_index_syncro`. */
function synchPairKey(e: AthleteEntry, level: string): string {
  const me = `${e.first} ${e.last}`;
  const partner = `${e.partnerFirst ?? ''} ${e.partnerLast ?? ''}`;
  const [a, b] = [me, partner].sort();
  return `${a}|${b}|${level}`;
}

/**
 * Compute TNT placement + qualification. Each event has its own level; grouping
 * and blue numbers are per (event-level), with no category, AA, team, or 50%
 * rule. Ports `tnt.TNT.calculate_results` + `add_progression`.
 */
export function computeTnt(
  entries: AthleteEntry[],
  def: DisciplineDef,
  cutoffs: TntCutoffs,
): AthleteResult[] {
  const byId = new Map<string, AthleteEntry>();
  const results: AthleteResult[] = entries.map((e) => {
    byId.set(e.id, e);
    const events: Record<string, EventPlacement> = {};
    for (const ev of def.events) {
      const es = e.events[ev];
      events[ev] = {
        event: ev,
        score: roundScore(es?.score ?? 0),
        place: null,
        qual: null,
        placeEligible: !!es?.placeEligible,
      };
    }
    return { entry: e, category: e.category, level: '', events };
  });

  for (const ev of def.events) {
    const rows = results.map((r) => ({
      id: r.entry.id,
      score: r.events[ev].score,
      level: byId.get(r.entry.id)!.events[ev]?.level ?? '',
    }));
    const places = assignPlaces(
      rows,
      (row) => byId.get(row.id)!.events[ev]?.status !== 'Scratched',
      (row) => row.level,
      ev === SYNCH ? (row) => synchPairKey(byId.get(row.id)!, row.level) : undefined,
    );
    for (const r of results) {
      const ep = r.events[ev];
      ep.place = places.get(r.entry.id) ?? null;
      const level = r.entry.events[ev]?.level ?? '';
      const n = cutoffs[level] ?? 0;
      ep.qual = ep.place != null && ep.place <= n ? 'Y' : 'N';
    }
  }
  return results;
}

/** Build TNT cutoffs from a raw parsed config.ini ([Levels] section). */
export function buildTntCutoffs(raw: Record<string, Record<string, string>>): TntCutoffs {
  const out: TntCutoffs = {};
  for (const [k, v] of Object.entries(raw['Levels'] ?? {})) out[k] = parseInt(v, 10);
  return out;
}

export type { QualFlag };
