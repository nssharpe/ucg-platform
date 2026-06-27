import { roundScore } from './round';
import { assignPlaces, type Placeable } from './placement';
import { cutoffFor } from './config';
import type {
  AthleteEntry,
  Category,
  DisciplineDef,
  NationalsEngineConfig,
  QualFlag,
  TeamResult,
} from './types';

const INDEPENDENT = new Set(['Independent Community Athlete', 'Independent Student Athlete']);
const WOMEN: Category[] = ['Community Women+', 'Collegiate Women+'];
const MEN: Category[] = ['Community Men+', 'Collegiate Men+'];

function evScore(e: AthleteEntry, ev: string): { score: number; status: string } | undefined {
  const es = e.apparatus[ev];
  if (!es) return undefined;
  return { score: roundScore(es.score), status: es.status };
}

/** Top-3 included nonzero per apparatus; a team needs >=3 on every apparatus or scores 0.
 *  Ports `artistic.calculate_score_per_team`. */
function teamScore(rows: AthleteEntry[], def: DisciplineDef): number {
  let total = 0;
  for (const ev of def.apparatus) {
    const usable = rows
      .map((r) => evScore(r, ev))
      .filter((e): e is { score: number; status: string } => !!e && e.status === 'Included' && e.score !== 0)
      .map((e) => e.score);
    if (usable.length < 3) return 0;
    usable.sort((a, b) => b - a);
    total += usable.slice(0, 3).reduce((s, v) => s + v, 0);
  }
  return roundScore(total);
}

/** Mixed-team score: top-3 nonzero non-scratched per apparatus; the used set must
 *  contain both a Men+ and a Women+ scorer. Ports `calculate_mixed_team_single_score`. */
function mixedTeamScore(rows: AthleteEntry[], def: DisciplineDef): number {
  let total = 0;
  let hasMen = false;
  let hasWomen = false;
  for (const ev of def.apparatus) {
    const nonzero = rows
      .filter((r) => {
        const e = evScore(r, ev);
        return !!e && e.status !== 'Scratched' && e.score !== 0;
      })
      .sort((a, b) => evScore(b, ev)!.score - evScore(a, ev)!.score);
    if (nonzero.length < 3) return 0;
    const used = nonzero.slice(0, 3);
    const cutoffScore = evScore(nonzero[2], ev)!.score;
    const usable = nonzero.filter((r) => evScore(r, ev)!.score >= cutoffScore);
    total += used.reduce((s, r) => s + evScore(r, ev)!.score, 0);
    if (usable.some((r) => WOMEN.includes(r.category))) hasWomen = true;
    if (usable.some((r) => MEN.includes(r.category))) hasMen = true;
  }
  return hasMen && hasWomen ? roundScore(total) : 0;
}

export interface TeamComputation {
  teams: TeamResult[];
  /** `${club}|${level}|${category}` -> qual, for the per-athlete Team? column. */
  perTeamQual: Map<string, QualFlag>;
}

/** Compute team scores, places, and qualification. Mixed teams only for prelims
 *  (`includeMixed`). Ports `artistic.calculate_team_scores`. */
export function computeTeams(
  entries: AthleteEntry[],
  def: DisciplineDef,
  config: NationalsEngineConfig,
  includeMixed: boolean,
  /** Finals only: `club|level|category` keys of teams that qualified in prelims.
   *  A team places in finals only if it qualified; others appear unplaced. */
  qualifiedTeams?: Set<string>,
): TeamComputation {
  const teamEligible = (club: string, level: string, category: Category | 'Mixed'): boolean => {
    if (INDEPENDENT.has(club)) return false;
    if (qualifiedTeams && category !== 'Mixed') return qualifiedTeams.has(`${club}|${level}|${category}`);
    return true;
  };
  // --- regular teams: group by (club, level, category) ---
  const regGroups = new Map<string, AthleteEntry[]>();
  for (const e of entries) {
    const k = `${e.club}|${e.level}|${e.category}`;
    (regGroups.get(k) ?? regGroups.set(k, []).get(k)!).push(e);
  }
  interface TeamRow extends Placeable {
    club: string;
    level: string;
    category: Category | 'Mixed';
  }
  const regRows: TeamRow[] = [];
  for (const [k, rows] of regGroups) {
    const [club, level, category] = k.split('|') as [string, string, Category];
    const score = teamScore(rows, def);
    if (score === 0) continue;
    regRows.push({ id: k, club, level, category, score });
  }
  const regPlaces = assignPlaces(
    regRows,
    (r) => teamEligible(r.club, r.level, r.category),
    (r) => `${r.level} ${r.category}`,
  );

  // --- mixed teams (prelims only): group by (club, level) ---
  const mixedRows: TeamRow[] = [];
  if (includeMixed) {
    const mixGroups = new Map<string, AthleteEntry[]>();
    for (const e of entries) {
      const k = `${e.club}|${e.level}`;
      (mixGroups.get(k) ?? mixGroups.set(k, []).get(k)!).push(e);
    }
    for (const [k, rows] of mixGroups) {
      const [club, level] = k.split('|');
      const score = mixedTeamScore(rows, def);
      if (score === 0) continue;
      mixedRows.push({ id: `${k}|Mixed`, club, level, category: 'Mixed', score });
    }
  }
  const mixedPlaces = assignPlaces(
    mixedRows,
    (r) => !INDEPENDENT.has(r.club),
    (r) => r.level,
  );

  const teams: TeamResult[] = [];
  const perTeamQual = new Map<string, QualFlag>();
  const finalize = (rows: TeamRow[], places: Map<string, number>) => {
    for (const r of rows) {
      const place = places.get(r.id) ?? null;
      const n = cutoffFor(config, 'team', r.level, r.category);
      const qual: QualFlag = place != null && place <= n ? 'Y' : 'N';
      teams.push({ club: r.club, level: r.level, category: r.category, score: r.score, place, qual });
      if (r.category !== 'Mixed') perTeamQual.set(`${r.club}|${r.level}|${r.category}`, qual);
    }
  };
  finalize(regRows, regPlaces);
  finalize(mixedRows, mixedPlaces);

  return { teams, perTeamQual };
}
