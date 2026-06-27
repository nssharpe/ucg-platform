/**
 * Engine-facing types for the Nationals qualification/awards port.
 *
 * Deliberately platform-agnostic: the engine works on generic level/category
 * strings + a config object, so it can be tested directly against the reference
 * tool's fixtures (its level codes + its config.ini). The platform adapter
 * (src/lib/nationals-*) maps UCG `Athlete`/`Registration`/`Score`/`EventSession`
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

export type ApparatusStatus = 'Included' | 'Excluded' | 'Scratched';

/** One athlete's result on one apparatus, before placement is computed. */
export interface ApparatusScore {
  /** Apparatus abbreviation: VT, UB, BB(beam), FX, PH, SR, PB, HB, or a TNT apparatus. */
  apparatus: string;
  score: number;
  status: ApparatusStatus;
  placeEligible: boolean;
  sv?: number | null;
  /** TNT only: each apparatus carries its own level. */
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
  /** Keyed by apparatus abbreviation. */
  apparatus: Record<string, ApparatusScore>;
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
    apparatus: CutoffMap;
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

/** Per-apparatus computed placement. */
export interface ApparatusPlacement {
  apparatus: string;
  score: number;
  place: number | null;
  qual: QualFlag | null;
  placeEligible: boolean;
}

export interface AthleteResult {
  entry: AthleteEntry;
  category: Category;
  level: string;
  apparatus: Record<string, ApparatusPlacement>;
  aa?: ApparatusPlacement;
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

/** Definition of a discipline: its apparatus and which scopes apply. */
export interface DisciplineDef {
  abbr: 'wag' | 'mag' | 'tnt';
  /** Ordered apparatus abbreviations. */
  apparatus: string[];
  hasAA: boolean;
  hasTeam: boolean;
  /** TNT: group/qualify by each apparatus's own level rather than a single CompLevel. */
  perApparatusLevel: boolean;
}

export const WAG: DisciplineDef = {
  abbr: 'wag',
  apparatus: ['VT', 'UB', 'BB', 'FX'],
  hasAA: true,
  hasTeam: true,
  perApparatusLevel: false,
};

export const MAG: DisciplineDef = {
  abbr: 'mag',
  apparatus: ['FX', 'PH', 'SR', 'VT', 'PB', 'HB'],
  hasAA: true,
  hasTeam: true,
  perApparatusLevel: false,
};

export const TNT: DisciplineDef = {
  abbr: 'tnt',
  apparatus: ['Tumbling', 'Trampoline', 'Synch_Trampoline', 'DMT'],
  hasAA: false,
  hasTeam: false,
  perApparatusLevel: true,
};
