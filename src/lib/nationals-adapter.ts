/**
 * Adapter: the seam between the platform's data model and the pure Nationals
 * engine (src/nationals/). Builds engine `AthleteEntry[]` from
 * Athlete/Registration/Score/EventSession, maps the admin-entered `NationalsConfig`
 * (keyed by platform levelId) to the engine config, and runs the engine per
 * discipline + phase. Everything is keyed by platform levelId end-to-end, so no
 * Jules-level-code mapping is needed for live data (that map only exists in the
 * fixture extractor). See docs/specs/2026-06-13-nationals-qual-awards.md.
 */
import type { DB, Discipline, Level, Event, NationalsConfig, PlacementCategory, Score } from './types';
import {
  WAG,
  MAG,
  computeArtistic,
  computeTnt,
  computeDecathlon,
  computeOmnithon,
  assembleArtisticAwards,
  validateArtistic,
  validateTeamFinals,
  validateQualCheck,
  type PrelimQualLookup,
  type QualFlag,
  type AthleteEntry,
  type AthleteResult,
  type AwardTable,
  type Category,
  type DecathlonResult,
  type DisciplineDef,
  type ApparatusScore,
  type NationalsEngineConfig,
  type OmnithonResult,
  type TeamResult,
} from '../nationals';

/** Platform TNT: apparatus TR/DM/TU (no Synch Trampoline), one level per registration,
 *  no AA/team — so each apparatus carries the registration's level. */
export const PLATFORM_TNT: DisciplineDef = {
  abbr: 'tnt',
  apparatus: ['TR', 'DM', 'TU'],
  hasAA: false,
  hasTeam: false,
  perApparatusLevel: true,
};

export const DISCIPLINE_DEFS: Record<Discipline, DisciplineDef> = { WAG, MAG, TNT: PLATFORM_TNT };

export type Phase = 'prelim' | 'final';

export const PLACEMENT_CATEGORIES: PlacementCategory[] = [
  'Collegiate Women+',
  'Collegiate Men+',
  'Community Women+',
  'Community Men+',
];

/**
 * Scaffold a NationalsConfig with zeroed cutoffs for every competing level, so an
 * admin can fill in the "blue numbers" in the config editor. Artistic levels get
 * event/AA/team (per category) + team-mixed cutoffs; TNT levels get a single
 * cutoff each. Preserves any existing values from `prev` when re-scaffolding.
 */
export function scaffoldNationalsConfig(
  levels: Level[],
  disciplines: Discipline[],
  finalsLevelIds: string[],
  prev?: NationalsConfig,
): NationalsConfig {
  const artisticLevels = levels.filter((l) => (l.discipline === 'WAG' || l.discipline === 'MAG') && disciplines.includes(l.discipline));
  const tntLevels = levels.filter((l) => l.discipline === 'TNT' && disciplines.includes('TNT'));

  const scope = (key: 'event' | 'aa' | 'team'): Partial<Record<PlacementCategory, Record<string, number>>> => {
    const out: Partial<Record<PlacementCategory, Record<string, number>>> = {};
    for (const cat of PLACEMENT_CATEGORIES) {
      out[cat] = {};
      for (const l of artisticLevels) out[cat]![l.id] = prev?.cutoffs[key]?.[cat]?.[l.id] ?? 0;
    }
    return out;
  };
  const teamMixed: Record<string, number> = {};
  for (const l of artisticLevels) teamMixed[l.id] = prev?.cutoffs.teamMixed?.[l.id] ?? 0;
  const tntCutoffs: Record<string, number> = {};
  for (const l of tntLevels) tntCutoffs[l.id] = prev?.tntCutoffs?.[l.id] ?? 0;

  return {
    finalsLevelIds,
    cutoffs: { event: scope('event'), aa: scope('aa'), team: scope('team'), teamMixed },
    ...(tntLevels.length ? { tntCutoffs } : {}),
    ...(prev?.svCaps ? { svCaps: prev.svCaps } : {}),
  };
}

/** Placement category, preferring the athlete's explicit per-discipline
 *  `placement` (men+/women+) and falling back to gender. Student → Collegiate. */
export function platformCategory(
  placement: 'men+' | 'women+' | undefined,
  gender: string,
  studentStatus: 'Student' | 'Non-Student',
): Category {
  const women = placement ? placement === 'women+' : gender === 'Female';
  const collegiate = studentStatus === 'Student';
  return `${collegiate ? 'Collegiate' : 'Community'} ${women ? 'Women+' : 'Men+'}` as PlacementCategory;
}

/** Map the admin-entered NationalsConfig to the engine's artistic config. */
export function toEngineConfig(cfg: NationalsConfig): NationalsEngineConfig {
  return {
    cutoffs: {
      apparatus: cfg.cutoffs.event,
      aa: cfg.cutoffs.aa,
      team: cfg.cutoffs.team,
      teamMixed: cfg.cutoffs.teamMixed ?? {},
    },
    finalsLevels: cfg.finalsLevelIds,
    // Every competing level that isn't a finals level awards from prelims. We can't
    // enumerate "all levels" here, so non-finals is derived per-discipline below.
    nonFinalsLevels: [],
    svCaps: cfg.svCaps ?? {},
  };
}

/** Sessions of an event for one discipline + phase (phase optional). */
function sessionsFor(event: Event, discipline: Discipline, phase?: Phase) {
  return event.sessions.filter(
    (s) => s.discipline === discipline && (phase ? s.phase === phase : true),
  );
}

/**
 * Build engine entries for one discipline + phase from the platform DB. AA is the
 * natural apparatus sum (the platform computes scores natively, so there is no
 * separate "provided AA" to diverge from). Scratched apparatus → status
 * 'Scratched'; everything else entered is 'Included'. Finalists are place-eligible.
 */
export function buildEntries(db: DB, event: Event, discipline: Discipline, scores: Score[], phase?: Phase): AthleteEntry[] {
  const def = DISCIPLINE_DEFS[discipline];
  const sessionIds = new Set(sessionsFor(event, discipline, phase).map((s) => s.id));
  const regs = db.registrations.filter(
    (r) => r.eventId === event.id && r.sessionId && sessionIds.has(r.sessionId) && !r.refunded,
  );
  const scoreMap = new Map<string, Score>();
  for (const s of scores) if (sessionIds.has(s.sessionId)) scoreMap.set(`${s.regId}|${s.apparatus}`, s);

  const peopleById = new Map(db.people.map((p) => [p.id, p]));
  const clubsById = new Map(db.clubs.map((c) => [c.id, c]));

  return regs.map((reg) => {
    const athlete = peopleById.get(reg.athleteId);
    const club = clubsById.get(reg.clubId);
    const apparatus: Record<string, ApparatusScore> = {};
    for (const ev of def.apparatus) {
      const sc = scoreMap.get(`${reg.id}|${ev}`);
      apparatus[ev] = {
        apparatus: ev,
        score: sc?.final ?? 0,
        status: sc?.scratched ? 'Scratched' : 'Included',
        placeEligible: true,
        sv: sc?.sv ?? null,
        ...(def.perApparatusLevel ? { level: reg.levelId } : {}),
      };
    }
    return {
      id: reg.id,
      first: athlete?.firstName ?? '',
      last: athlete?.lastName ?? '',
      email: athlete?.email ?? '',
      club: club?.name ?? reg.clubId,
      gender: athlete?.gender ?? '',
      student: athlete?.studentStatus === 'Student',
      level: reg.levelId,
      // studentStatus may now be '' (unset) for an incomplete profile; treat that as Non-Student
      // for category placement (|| catches '' where ?? would not).
      category: platformCategory(athlete?.placement?.[discipline], athlete?.gender ?? '', athlete?.studentStatus || 'Non-Student'),
      session: reg.sessionId ?? '',
      apparatus,
      aaPlaceEligible: true,
      // aaScore omitted ⇒ engine sums apparatus scores (platform AA is always the sum).
    } satisfies AthleteEntry;
  });
}

/** Every competing levelId for a discipline in this event (from its sessions). */
function competingLevels(event: Event, discipline: Discipline): string[] {
  const set = new Set<string>();
  for (const s of sessionsFor(event, discipline)) for (const id of s.levelIds) set.add(id);
  return [...set];
}

export interface ArtisticDisciplineResult {
  discipline: Discipline;
  prelims: { results: AthleteResult[]; teams: TeamResult[] };
  finals: { results: AthleteResult[]; teams: TeamResult[] };
  awards: AwardTable[];
}

/** Run an artistic discipline (WAG/MAG) end-to-end: prelims, finals, awards. */
export function computeArtisticDiscipline(db: DB, event: Event, discipline: 'WAG' | 'MAG', scores: Score[]): ArtisticDisciplineResult {
  const def = DISCIPLINE_DEFS[discipline];
  const cfg = event.nationalsConfig!;
  const engineCfg = toEngineConfig(cfg);
  // Non-finals levels = competing levels that aren't finals levels.
  engineCfg.nonFinalsLevels = competingLevels(event, discipline).filter((l) => !engineCfg.finalsLevels.includes(l));

  const prelimEntries = buildEntries(db, event, discipline, scores, 'prelim');
  const prelims = computeArtistic(prelimEntries, def, engineCfg, { finals: false });

  const finalEntries = buildEntries(db, event, discipline, scores, 'final');
  const qualifiedTeams = new Set<string>();
  for (const t of prelims.teams)
    if (t.category !== 'Mixed' && t.qual === 'Y') qualifiedTeams.add(`${t.club}|${t.level}|${t.category}`);
  const finals = computeArtistic(finalEntries, def, engineCfg, { finals: true, qualifiedTeams });

  const awards = assembleArtisticAwards(def, engineCfg, prelims, finals);
  return { discipline, prelims, finals, awards };
}

export interface NationalsBundle {
  wag?: ArtisticDisciplineResult;
  mag?: ArtisticDisciplineResult;
  tnt?: { results: AthleteResult[] };
  decathlon: DecathlonResult[];
  omnithon: OmnithonResult[];
}

export interface ValidationIssue {
  discipline: Discipline;
  group: string;
  detail: string;
}

const NAME: Record<string, string> = { VT: 'Vault', UB: 'Bars', BB: 'Beam', FX: 'Floor', PH: 'PH', SR: 'Rings', PB: 'PB', HB: 'HB', AA: 'AA' };

/** Run the engine's validation checks for a Nationals event → flat issue list for
 *  the UI. On the platform AA is always the event sum, so AA-sum/decimal checks
 *  rarely fire; SV caps, finals team completeness, and prelim-qual-vs-finals
 *  eligibility are the meaningful ones. */
export function computeNationalsValidation(db: DB, event: Event, scores: Score[]): ValidationIssue[] {
  const cfg = event.nationalsConfig;
  if (!cfg) return [];
  const issues: ValidationIssue[] = [];
  for (const discipline of ['WAG', 'MAG'] as const) {
    if (!event.disciplines.includes(discipline)) continue;
    const def = DISCIPLINE_DEFS[discipline];
    const engineCfg = toEngineConfig(cfg);
    engineCfg.nonFinalsLevels = competingLevels(event, discipline).filter((l) => !engineCfg.finalsLevels.includes(l));

    const prelimEntries = buildEntries(db, event, discipline, scores, 'prelim');
    const vp = validateArtistic(prelimEntries, def, engineCfg, false);
    for (const f of vp.svCap) issues.push({ discipline, group: 'Prelim SV cap', detail: `${f.first} ${f.last} — ${NAME[f.apparatus]} ${f.score} over cap` });
    for (const f of vp.decimal) issues.push({ discipline, group: 'Prelim score precision', detail: `${f.first} ${f.last} — ${NAME[f.apparatus] ?? f.apparatus} ${f.score} not a 0.001 multiple` });

    const finalEntries = buildEntries(db, event, discipline, scores, 'final');
    if (!finalEntries.length) continue;
    const prelims = computeArtistic(prelimEntries, def, engineCfg, { finals: false });
    const qualifiedTeams = new Set<string>();
    for (const t of prelims.teams) if (t.category !== 'Mixed' && t.qual === 'Y') qualifiedTeams.add(`${t.club}|${t.level}|${t.category}`);
    const prelimQual: PrelimQualLookup = new Map();
    for (const r of prelims.results) {
      const rec: Record<string, QualFlag> = {};
      for (const ev of def.apparatus) rec[ev] = r.apparatus[ev].qual!;
      if (r.aa) rec.AA = r.aa.qual!;
      prelimQual.set(`${r.entry.first}|${r.entry.last}|${r.entry.club}|${r.level}`, rec);
    }
    for (const t of validateTeamFinals(finalEntries, def, qualifiedTeams)) {
      const bad = def.apparatus.filter((ev) => t.validity[ev] !== 'Valid').map((ev) => `${ev}: ${t.validity[ev]}`).join(', ');
      issues.push({ discipline, group: 'Finals team roster', detail: `${t.club} · ${t.level} · ${t.category} — ${bad}` });
    }
    for (const q of validateQualCheck(finalEntries, def, prelimQual)) {
      issues.push({ discipline, group: 'Finals eligibility', detail: `${q.first} ${q.last} (${q.level} ${NAME[q.apparatus] ?? q.apparatus}) — ${q.problem}` });
    }
  }
  return issues;
}

/** Compute everything for a Nationals event that the UI needs. */
export function computeNationals(db: DB, event: Event, scores: Score[]): NationalsBundle {
  const cfg = event.nationalsConfig;
  if (!cfg) return { decathlon: [], omnithon: [] };
  const bundle: NationalsBundle = { decathlon: [], omnithon: [] };

  if (event.disciplines.includes('WAG')) bundle.wag = computeArtisticDiscipline(db, event, 'WAG', scores);
  if (event.disciplines.includes('MAG')) bundle.mag = computeArtisticDiscipline(db, event, 'MAG', scores);
  if (event.disciplines.includes('TNT')) {
    const entries = buildEntries(db, event, 'TNT', scores, 'prelim');
    bundle.tnt = { results: computeTnt(entries, PLATFORM_TNT, cfg.tntCutoffs ?? {}) };
  }

  // Combined awards (prelims), only when both artistic disciplines ran.
  const wagEntries = event.disciplines.includes('WAG') ? buildEntries(db, event, 'WAG', scores, 'prelim') : [];
  const magEntries = event.disciplines.includes('MAG') ? buildEntries(db, event, 'MAG', scores, 'prelim') : [];
  if (wagEntries.length && magEntries.length) {
    bundle.decathlon = computeDecathlon(wagEntries, magEntries);
    if (event.disciplines.includes('TNT')) {
      bundle.omnithon = computeOmnithon(wagEntries, magEntries, buildEntries(db, event, 'TNT', scores, 'prelim'));
    }
  }
  return bundle;
}
