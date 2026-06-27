import { roundScore } from './round';
import { assignPlaces } from './placement';
import { qualify, type QualRow } from './qualification';
import { computeTeams } from './teams';
import { cutoffFor } from './config';
import type {
  AthleteEntry,
  AthleteResult,
  DisciplineDef,
  ApparatusPlacement,
  NationalsEngineConfig,
  TeamResult,
} from './types';

export interface ArtisticOptions {
  /** Finals consults the per-event `placeEligible` flag in addition to status. */
  finals?: boolean;
  /** Finals only: `club|level|category` keys of prelim-qualified teams. */
  qualifiedTeams?: Set<string>;
}

export interface ArtisticComputation {
  results: AthleteResult[];
  teams: TeamResult[];
}

/** AA score used for placement: the SF-provided value verbatim (the reference
 *  tool does NOT recompute it from apparatus — see types.ts). Falls back to the
 *  apparatus sum only when no provided value exists. */
function aaScore(e: AthleteEntry, def: DisciplineDef): number {
  if (e.aaScore != null) return roundScore(e.aaScore);
  let sum = 0;
  for (const ev of def.apparatus) sum += roundScore(e.apparatus[ev]?.score ?? 0);
  return roundScore(sum);
}

/**
 * Compute artistic (WAG/MAG) placement, qualification, and team scores for one
 * discipline + phase. Ports `artistic.Artistic.calculate_results` +
 * `add_progression` + team scoring. See docs/specs/2026-06-13-nationals-qual-awards.md.
 */
export function computeArtistic(
  entries: AthleteEntry[],
  def: DisciplineDef,
  config: NationalsEngineConfig,
  opts: ArtisticOptions = {},
): ArtisticComputation {
  const finals = !!opts.finals;

  const evEligible = (e: AthleteEntry, ev: string): boolean => {
    const es = e.apparatus[ev];
    if (!es) return false;
    if (es.status === 'Scratched') return false;
    return finals ? !!es.placeEligible : true;
  };
  const aaEligible = (e: AthleteEntry): boolean => {
    if (!def.apparatus.every((ev) => e.apparatus[ev] && e.apparatus[ev].status !== 'Scratched')) return false;
    return finals ? !!e.aaPlaceEligible : true;
  };

  // Build result skeletons.
  const byId = new Map<string, AthleteEntry>();
  const results: AthleteResult[] = entries.map((e) => {
    byId.set(e.id, e);
    const apparatus: Record<string, ApparatusPlacement> = {};
    for (const ev of def.apparatus) {
      const es = e.apparatus[ev];
      apparatus[ev] = {
        apparatus: ev,
        score: roundScore(es?.score ?? 0),
        place: null,
        qual: null,
        placeEligible: !!es?.placeEligible,
      };
    }
    const r: AthleteResult = { entry: e, category: e.category, level: e.level, apparatus };
    if (def.hasAA) {
      r.aa = {
        apparatus: 'AA',
        score: aaScore(e, def),
        place: null,
        qual: null,
        placeEligible: !!e.aaPlaceEligible,
      };
    }
    return r;
  });

  // Placement per apparatus + AA.
  for (const ev of def.apparatus) {
    const placeable = results.map((r) => ({ id: r.entry.id, score: r.apparatus[ev].score }));
    const places = assignPlaces(
      placeable,
      (row) => evEligible(byId.get(row.id)!, ev),
      (row) => `${byId.get(row.id)!.level} ${byId.get(row.id)!.category}`,
    );
    for (const r of results) r.apparatus[ev].place = places.get(r.entry.id) ?? null;
  }
  if (def.hasAA) {
    const placeable = results.map((r) => ({ id: r.entry.id, score: r.aa!.score }));
    const places = assignPlaces(
      placeable,
      (row) => aaEligible(byId.get(row.id)!),
      (row) => `${byId.get(row.id)!.level} ${byId.get(row.id)!.category}`,
    );
    for (const r of results) r.aa!.place = places.get(r.entry.id) ?? null;
  }

  // Qualification per apparatus + AA (blue numbers + 50% rule).
  const qualifyScope = (scope: 'apparatus' | 'aa', pick: (r: AthleteResult) => ApparatusPlacement) => {
    const rows: QualRow[] = results.map((r) => {
      const p = pick(r);
      return { id: r.entry.id, club: r.entry.club, level: r.level, category: r.category, place: p.place, score: p.score, qual: 'N' };
    });
    qualify(rows, (level, category) => cutoffFor(config, scope, level, category));
    const byRow = new Map(rows.map((row) => [row.id, row.qual]));
    for (const r of results) pick(r).qual = byRow.get(r.entry.id)!;
  };
  for (const ev of def.apparatus) qualifyScope('apparatus', (r) => r.apparatus[ev]);
  if (def.hasAA) qualifyScope('aa', (r) => r.aa!);

  // Team scores + per-athlete Team? column.
  const { teams, perTeamQual } = computeTeams(entries, def, config, !finals, opts.qualifiedTeams);
  for (const r of results) {
    const allScratched = def.apparatus.every((ev) => r.entry.apparatus[ev]?.status === 'Scratched');
    const key = `${r.entry.club}|${r.level}|${r.category}`;
    r.teamQual = allScratched ? 'N' : perTeamQual.get(key) ?? 'N';
  }

  return { results, teams };
}
