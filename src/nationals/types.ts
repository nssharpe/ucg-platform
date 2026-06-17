/**
 * Engine-facing types for the Nationals qualification/awards port.
 *
 * Deliberately platform-agnostic: the engine works on generic level/category
 * strings + a config object, so it can be tested directly against the reference
 * tool's fixtures (its level codes + its config.ini). The platform adapter
 * (src/lib/nationals-*) maps UCG `Athlete`/`Registration`/`Score`/`MeetSession`
 * onto these shapes. See docs/specs/2026-06-13-nationals-qual-awards.md.
 */

export type Category =
  | 'Collegiate Women+'
  | 'Collegiate Men+'
  | 'Community Women+'
  | 'Community Men+';

export const CATEGORIES: Category[] = [
  'Collegiate Women+',
  'Collegiate Men+',
  'Community Women+',
  'Community Men+',
];

export type EventStatus = 'Included' | 'Excluded' | 'Scratched';

/** One athlete's result on one apparatus, before placement is computed. */
export interface EventScore {
  /** Apparatus abbreviation: VT, UB, BB(beam), FX, PH, SR, PB, HB, or a TNT event. */
  event: string;
  score: number;
  status: EventStatus;
  placeEligible: boolean;
  sv?: number | null;
  /** TNT only: each event carries its own level. */
  level?: string;
}

/** One athlete in one discipline. */
export interface AthleteEntry {
  id: string;
  first: string;
  last: string;
  email: string;
  club: string;
  gender: string;
  student: boolean;
  /** CompLevel for artistic disciplines; ignored for TNT (events carry level). */
  level: string;
  category: Category;
  session?: string;
  /** Keyed by event abbreviation. */
  events: Record<string, EventScore>;
  /** All-around place-eligibility flag from the source (finals filtering / passthrough). */
  aaPlaceEligible?: boolean;
  /** SF-provided AA score. The reference tool PLACES on this value verbatim (not a
   *  recomputed event sum); validation separately flags sum≠provided mismatches. */
  aaScore?: number;
  /** Synch Trampoline partner (TNT only). */
  partnerFirst?: string;
  partnerLast?: string;
}

/** Cutoffs ("blue numbers") for one scope, keyed [category][level] = N. */
export type CutoffMap = Partial<Record<Category, Record<string, number>>>;

export interface NationalsEngineConfig {
  cutoffs: {
    event: CutoffMap;
    aa: CutoffMap;
    team: CutoffMap;
    /** Mixed-team cutoffs keyed by level (Mixed is its own category). */
    teamMixed: Record<string, number>;
  };
  finalsLevels: string[];
  nonFinalsLevels: string[];
  svCaps: Record<string, number>;
}

export type QualFlag = 'Y' | 'N';

/** Per-event computed placement. */
export interface EventPlacement {
  event: string;
  score: number;
  place: number | null;
  qual: QualFlag | null;
  placeEligible: boolean;
}

export interface AthleteResult {
  entry: AthleteEntry;
  category: Category;
  level: string;
  events: Record<string, EventPlacement>;
  aa?: EventPlacement;
  /** Set after team scoring merges in (artistic only). */
  teamQual?: QualFlag;
}

export interface TeamResult {
  club: string;
  level: string;
  category: Category | 'Mixed';
  score: number;
  place: number | null;
  qual: QualFlag;
}

/** Definition of a discipline: its events and which scopes apply. */
export interface DisciplineDef {
  abbr: 'wag' | 'mag' | 'tnt';
  /** Ordered apparatus abbreviations. */
  events: string[];
  hasAA: boolean;
  hasTeam: boolean;
  /** TNT: group/qualify by each event's own level rather than a single CompLevel. */
  perEventLevel: boolean;
}

export const WAG: DisciplineDef = {
  abbr: 'wag',
  events: ['VT', 'UB', 'BB', 'FX'],
  hasAA: true,
  hasTeam: true,
  perEventLevel: false,
};

export const MAG: DisciplineDef = {
  abbr: 'mag',
  events: ['FX', 'PH', 'SR', 'VT', 'PB', 'HB'],
  hasAA: true,
  hasTeam: true,
  perEventLevel: false,
};

export const TNT: DisciplineDef = {
  abbr: 'tnt',
  events: ['Tumbling', 'Trampoline', 'Synch_Trampoline', 'DMT'],
  hasAA: false,
  hasTeam: false,
  perEventLevel: true,
};
