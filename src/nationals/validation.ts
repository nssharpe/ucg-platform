import { roundScore } from './round';
import type { AthleteEntry, Category, DisciplineDef, NationalsEngineConfig, QualFlag } from './types';

/**
 * Validation checks ported from the reference tool (`artistic.validate`,
 * `discipline._validate_decimal_places`, `validate_place_eligible_vs_qual`,
 * `validate_included_team_finals`, `tnt.validate`). Each returns a list of
 * findings; an empty list means clean. Events are reported by engine abbr — the
 * platform/test maps to display names or SF column names as needed.
 *
 * On the platform many of these are moot (scores are entered natively, so AA is
 * always the event sum and scores are always 0.001-multiples), but SV caps,
 * team completeness, prelim-qual-vs-finals-eligibility, and syncro pairing remain
 * real data-integrity checks. See docs/specs/2026-06-13-nationals-qual-awards.md.
 */

export interface AaFinding { first: string; last: string; session: string; sfAA: number; calcAA: number; }
export interface SvCapFinding { first: string; last: string; session: string; event: string; score: number; }
export interface IncludedFinding { first: string; last: string; session: string; event: string; }
export interface DecimalFinding { first: string; last: string; session: string; event: string; score: number; }
export type TeamValidity = 'Valid' | 'Too many included' | 'Not enough included' | 'Missing Scores';
export interface TeamIncludedFinding { club: string; level: string; category: Category; validity: Record<string, TeamValidity>; }
export interface QualCheckFinding {
  first: string; last: string; session: string; club: string; level: string;
  event: string; prelimsQual: QualFlag; finalsPlaceEligible: boolean; problem: string;
}

const isDecimalBad = (score: number): boolean => {
  if (!Number.isFinite(score)) return false;
  const scaled = score * 1000;
  return Math.abs(scaled - Math.round(scaled)) > 1e-9;
};

/** AA-sum, SV-cap, decimal (+ prelims-included when not finals). */
export function validateArtistic(
  entries: AthleteEntry[],
  def: DisciplineDef,
  config: NationalsEngineConfig,
  finals: boolean,
): { aa: AaFinding[]; svCap: SvCapFinding[]; prelimsIncluded: IncludedFinding[]; decimal: DecimalFinding[] } {
  const aa: AaFinding[] = [];
  const svCap: SvCapFinding[] = [];
  const prelimsIncluded: IncludedFinding[] = [];
  const decimal: DecimalFinding[] = [];

  for (const e of entries) {
    const session = e.session ?? '';
    // AA-sum check
    let sum = 0;
    for (const ev of def.events) sum += roundScore(e.events[ev]?.score ?? 0);
    sum = roundScore(sum);
    if (e.aaScore != null && sum !== roundScore(e.aaScore)) {
      aa.push({ first: e.first, last: e.last, session, sfAA: roundScore(e.aaScore), calcAA: sum });
    }
    // SV caps
    const cap = config.svCaps[e.level];
    if (cap != null) {
      for (const ev of def.events) {
        const es = e.events[ev];
        if (!es) continue;
        if ((es.score ?? 0) > cap || (es.sv ?? 0) > cap) {
          svCap.push({ first: e.first, last: e.last, session, event: ev, score: es.score });
        }
      }
    }
    // Prelims included: nonzero score on an Excluded event
    if (!finals) {
      for (const ev of def.events) {
        const es = e.events[ev];
        if (es && es.score !== 0 && es.status === 'Excluded') {
          prelimsIncluded.push({ first: e.first, last: e.last, session, event: ev });
        }
      }
    }
    // Decimal: scores (and AA) must be 0.001-multiples (raw values)
    for (const ev of def.events) {
      const es = e.events[ev];
      if (es && isDecimalBad(es.score)) decimal.push({ first: e.first, last: e.last, session, event: ev, score: es.score });
    }
    if (e.aaScore != null && isDecimalBad(e.aaScore)) {
      decimal.push({ first: e.first, last: e.last, session, event: 'AA', score: e.aaScore });
    }
  }
  return { aa, svCap, prelimsIncluded, decimal };
}

/** Finals team completeness per (club,level,category) among prelim-qualified teams.
 *  Ports `validate_included_team_finals` + `validate_team`. */
export function validateTeamFinals(
  entries: AthleteEntry[],
  def: DisciplineDef,
  qualifiedTeams: Set<string>,
): TeamIncludedFinding[] {
  const groups = new Map<string, AthleteEntry[]>();
  for (const e of entries) {
    const key = `${e.club}|${e.level}|${e.category}`;
    if (!qualifiedTeams.has(key)) continue;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(e);
  }
  const out: TeamIncludedFinding[] = [];
  for (const [key, rows] of groups) {
    const [club, level, category] = key.split('|') as [string, string, Category];
    const validity: Record<string, TeamValidity> = {};
    let anyBad = false;
    for (const ev of def.events) {
      const numIncluded = rows.filter((r) => r.events[ev]?.status === 'Included').length;
      const numRemaining = rows.filter((r) => r.events[ev]?.status === 'Excluded' && (r.events[ev]?.score ?? 0) !== 0).length;
      const missing = rows.filter((r) => r.events[ev]?.status === 'Included' && (r.events[ev]?.score ?? 0) === 0).length;
      let v: TeamValidity;
      if (numIncluded > 4) v = 'Too many included';
      else if (numIncluded < 4 && numRemaining > 0) v = 'Not enough included';
      else if (missing > 0 && numRemaining > 0) v = 'Missing Scores';
      else v = 'Valid';
      validity[ev] = v;
      if (v !== 'Valid') anyBad = true;
    }
    if (anyBad) out.push({ club, level, category, validity });
  }
  return out;
}

/** Per-event prelim qual flag, keyed by `first|last|club|level`. */
export type PrelimQualLookup = Map<string, Record<string, QualFlag>>;

/** Finals: prelim qualifiers must be finals place-eligible and vice-versa.
 *  Ports `validate_place_eligible_vs_qual`. `eventsWithScopes` lists engine event
 *  abbrs plus 'AA'; placeEligibleOf returns the finals place-eligibility per scope. */
export function validateQualCheck(
  entries: AthleteEntry[],
  def: DisciplineDef,
  prelimQual: PrelimQualLookup,
): QualCheckFinding[] {
  const out: QualCheckFinding[] = [];
  const scopes = def.hasAA ? [...def.events, 'AA'] : [...def.events];
  for (const e of entries) {
    const pq = prelimQual.get(`${e.first}|${e.last}|${e.club}|${e.level}`);
    if (!pq) continue;
    for (const scope of scopes) {
      const qualified = pq[scope] === 'Y';
      const placeEligible = scope === 'AA' ? !!e.aaPlaceEligible : !!e.events[scope]?.placeEligible;
      if (qualified === placeEligible) continue;
      out.push({
        first: e.first, last: e.last, session: e.session ?? '', club: e.club, level: e.level,
        event: scope, prelimsQual: qualified ? 'Y' : 'N', finalsPlaceEligible: placeEligible,
        problem: qualified ? 'Qualified but not place eligible' : 'Place eligible but did not qualify',
      });
    }
  }
  return out;
}

// --- TNT syncro validation ---
export interface SyncroMissing { partner1: string; partner2: string; session: string; }
export interface SyncroLevels { partner1: string; partner2: string; session1: string; session2: string; level1: string; level2: string; }
export interface SyncroScores { partner1: string; partner2: string; session1: string; session2: string; score1: number; score2: number; }

/** TNT syncro-pair consistency: both partners present, same level, equal scores.
 *  Ports `tnt.TNT.validate`. */
export function validateSyncro(entries: AthleteEntry[]): {
  missing: SyncroMissing[]; levels: SyncroLevels[]; scores: SyncroScores[];
} {
  interface Pair { levels: string[]; scores: number[]; sessions: string[]; }
  const pairs = new Map<string, Pair>();
  for (const e of entries) {
    const es = e.events['Synch_Trampoline'];
    if (!es) continue;
    // Competed = a non-scratched synch entry (status is always one of the three).
    const competed = es.status !== 'Scratched';
    if (!competed) continue;
    // Trim so a blank partner (a data error this check exists to catch) becomes
    // '' rather than ' ', matching the reference output (empty cell).
    const me = `${e.first} ${e.last}`.trim();
    const partner = `${e.partnerFirst ?? ''} ${e.partnerLast ?? ''}`.trim();
    const [a, b] = [me, partner].sort();
    const key = `${a}|${b}`;
    const p = pairs.get(key) ?? { levels: [], scores: [], sessions: [] };
    p.levels.push(es.level ?? '');
    p.scores.push(es.score);
    p.sessions.push(e.session ?? '');
    pairs.set(key, p);
  }
  const missing: SyncroMissing[] = [];
  const levels: SyncroLevels[] = [];
  const scores: SyncroScores[] = [];
  for (const [key, d] of pairs) {
    const [p1, p2] = key.split('|');
    if (d.levels.length === 1) {
      missing.push({ partner1: p1, partner2: p2, session: d.sessions[0] });
    } else if (d.levels[0] !== d.levels[1]) {
      levels.push({ partner1: p1, partner2: p2, session1: d.sessions[0], session2: d.sessions[1], level1: d.levels[0], level2: d.levels[1] });
    }
    if (d.scores.length === 2 && d.scores[0] !== d.scores[1]) {
      scores.push({ partner1: p1, partner2: p2, session1: d.sessions[0], session2: d.sessions[1], score1: d.scores[0], score2: d.scores[1] });
    }
  }
  return { missing, levels, scores };
}
