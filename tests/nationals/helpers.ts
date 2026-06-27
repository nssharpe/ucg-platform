import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { deriveCategory } from '../../src/nationals/categories';
import { roundScore } from '../../src/nationals/round';
import { WAG, MAG, TNT, type AthleteEntry, type DisciplineDef } from '../../src/nationals/types';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, '..', 'fixtures', 'nationals');

export interface Fixture {
  meta: { year: string; phase: string; discipline: string };
  config?: Record<string, Record<string, string>>;
  input?: Record<string, unknown>[];
  expected: Record<string, unknown>[];
  expectedTeam?: Record<string, unknown>[];
  expectedWebsite?: Record<string, unknown>[];
  expectedTeamWebsite?: Record<string, unknown>[];
}

export function loadFixture(name: string): Fixture {
  return JSON.parse(readFileSync(join(FIX, name), 'utf8'));
}

export const DEFS: Record<string, DisciplineDef> = { wag: WAG, mag: MAG, tnt: TNT };

/** Event abbr (engine) -> source spreadsheet column metadata. Beam is the odd
 *  one: input/score/place-eligible use BM, qual uses BB, place is "Beam Place". */
export const EVENT_COLS: Record<string, { prefix: string; qual: string; place: string }> = {
  VT: { prefix: 'VT', qual: 'VT?', place: 'Vault Place' },
  UB: { prefix: 'UB', qual: 'UB?', place: 'Bars Place' },
  BB: { prefix: 'BM', qual: 'BB?', place: 'Beam Place' },
  FX: { prefix: 'FX', qual: 'FX?', place: 'Floor Place' },
  PH: { prefix: 'PH', qual: 'PH?', place: 'PH Place' },
  SR: { prefix: 'SR', qual: 'SR?', place: 'Rings Place' },
  PB: { prefix: 'PB', qual: 'PB?', place: 'PB Place' },
  HB: { prefix: 'HB', qual: 'HB?', place: 'HB Place' },
};

function bool(v: unknown): boolean {
  return v === true || v === 1 || v === '1' || v === 'True';
}

/** Map a reference-tool input row to an engine AthleteEntry (artistic). */
export function rowToEntry(row: Record<string, unknown>, def: DisciplineDef, index: number): AthleteEntry {
  // The reference tool strips every string cell on read (process_data .map(strip));
  // notably club names carry stray trailing spaces in the SF export.
  const str = (v: unknown): string => String(v ?? '').trim();
  const gender = str(row.Gender);
  const student = bool(row.Student);
  const apparatus: AthleteEntry['apparatus'] = {};
  for (const ev of def.apparatus) {
    const c = EVENT_COLS[ev];
    apparatus[ev] = {
      apparatus: ev,
      score: Number(row[`${c.prefix}_Score`] ?? 0),
      status: String(row[`${c.prefix}_Event_Status`] ?? '') as AthleteEntry['apparatus'][string]['status'],
      placeEligible: bool(row[`${c.prefix}_Place_Eligible`]),
      sv: row[`${c.prefix}_SV`] == null ? null : Number(row[`${c.prefix}_SV`]),
    };
  }
  return {
    id: `${str(row.Athlete_Email)}|${str(row.FirstName)}|${str(row.LastName)}|${str(row.CompLevel)}|${index}`,
    first: str(row.FirstName),
    last: str(row.LastName),
    email: str(row.Athlete_Email),
    club: str(row.Club_Name),
    gender,
    student,
    level: str(row.CompLevel),
    category: deriveCategory(gender, student),
    session: str(row.Session),
    apparatus,
    aaPlaceEligible: bool(row.AA_Place_Eligible),
    aaScore: row.AA_Score == null ? undefined : Number(row.AA_Score),
  };
}

/** TNT event abbr -> source column metadata (per-event level; synch is irregular). */
export const TNT_COLS: Record<string, { score: string; status: string; level: string; pe: string; qual: string; place: string }> = {
  Tumbling: { score: 'Tumbling_Score', status: 'Tumbling_Event_Status', level: 'Tumbling_Level', pe: 'Tumbling_Place_Eligible', qual: 'Tumbling?', place: 'Tumbling Place' },
  Trampoline: { score: 'Trampoline_Score', status: 'Trampoline_Event_Status', level: 'Trampoline_Level', pe: 'Trampoline_Place_Eligible', qual: 'Trampoline?', place: 'Trampoline Place' },
  Synch_Trampoline: { score: 'Synch_Trampoline_Score', status: 'Synch_Event_Status', level: 'Synch_Trampoline_Level', pe: 'Synch_Trampoline_Place_Eligible', qual: 'Synch_Trampoline?', place: 'Synch Trampoline Place' },
  DMT: { score: 'DMT_Score', status: 'DMT_Event_Status', level: 'DMT_Level', pe: 'DMT_Place_Eligible', qual: 'DMT?', place: 'DMT Place' },
};

/** Map a TNT input row to an engine AthleteEntry (per-event level + synch partner). */
export function tntRowToEntry(row: Record<string, unknown>, index: number): AthleteEntry {
  const str = (v: unknown): string => String(v ?? '').trim();
  const gender = str(row.Gender);
  const student = bool(row.Student);
  const apparatus: AthleteEntry['apparatus'] = {};
  for (const ev of Object.keys(TNT_COLS)) {
    const c = TNT_COLS[ev];
    apparatus[ev] = {
      apparatus: ev,
      score: Number(row[c.score] ?? 0),
      status: String(row[c.status] ?? '') as AthleteEntry['apparatus'][string]['status'],
      placeEligible: bool(row[c.pe]),
      level: str(row[c.level]),
    };
  }
  return {
    id: `${str(row.Athlete_Email)}|${str(row.FirstName)}|${str(row.LastName)}|${index}`,
    first: str(row.FirstName),
    last: str(row.LastName),
    email: str(row.Athlete_Email),
    club: str(row.Club_Name),
    gender,
    student,
    level: '',
    category: deriveCategory(gender, student),
    session: str(row.Session),
    apparatus,
    partnerFirst: str(row.Synch_PartnerFirstName),
    partnerLast: str(row.Synch_PartnerLastName),
  };
}

/** Build entries with a stable id matching the expected row by identity. */
export function entriesFrom(fixture: Fixture, def: DisciplineDef): AthleteEntry[] {
  return (fixture.input ?? []).map((r, i) => rowToEntry(r, def, i));
}

/** Key identifying an athlete across input/expected (rows realign after sorting). */
export function identityKey(row: Record<string, unknown>): string {
  return `${row.Athlete_Email ?? ''}|${row.FirstName}|${row.LastName}|${row.CompLevel}`;
}

export function entryIdentity(e: AthleteEntry): string {
  return `${e.email}|${e.first}|${e.last}|${e.level}`;
}

/** Normalize a place cell (float/None) to number|null. */
export function place(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

export function sameScore(a: number, b: unknown): boolean {
  return Math.abs(roundScore(a) - roundScore(Number(b ?? 0))) < 1e-9;
}
