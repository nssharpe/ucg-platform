// NAIGC Masters scoring engine (MAG + WAG, age decades, vault tables).
// Ported from public/calculators/masters.html — pure TS, no React/DOM.
import { num, round3, type ScoringOutcome } from './types';

export type MastersDiscipline = 'MAG' | 'WAG';
export type AgeDecade = '30' | '40' | '50' | '60' | '70';
export type MastersSkillLevel = 'd+' | 'c' | 'b' | 'a' | 'me' | 'misc';
export type MastersDismountLevel = 'none' | MastersSkillLevel;
export type MastersApparatus =
  | 'floor' | 'pommel' | 'rings' | 'vault' | 'pbars' | 'hbar' // MAG
  | 'bars' | 'beam'; // WAG (plus vault/floor)

export interface MastersVault {
  name: string;
  fig: number;
}

const MAX_SKILLS = 6;
const MIN_SKILLS = 6;
const SHORT_ROUTINE_DEDUCTION_PER_SKILL = 1.0;
const EG_BONUS_AMOUNT = 0.5; // per EG for both MAG (I-III) and WAG (I-IV)

// Skill difficulty values by age decade (identical for MAG and WAG).
export const SKILL_VALUES: Record<AgeDecade, Record<MastersSkillLevel, number | null>> = {
  '30': { misc: null, me: 0.0, a: 0.2, b: 0.4, c: 0.6, 'd+': 0.8 },
  '40': { misc: null, me: 0.1, a: 0.3, b: 0.5, c: 0.7, 'd+': 0.9 },
  '50': { misc: 0.1, me: 0.2, a: 0.4, b: 0.6, c: 0.8, 'd+': 1.0 },
  '60': { misc: 0.2, me: 0.3, a: 0.5, b: 0.7, c: 0.9, 'd+': 1.1 },
  '70': { misc: 0.3, me: 0.4, a: 0.6, b: 0.8, c: 1.0, 'd+': 1.2 },
};

// Display order: highest difficulty first.
export const SKILL_LEVELS: MastersSkillLevel[] = ['d+', 'c', 'b', 'a', 'me', 'misc'];
export const SKILL_LABELS: Record<MastersSkillLevel, string> = {
  'd+': 'D+', c: 'C', b: 'B', a: 'A', me: 'ME', misc: 'Misc.',
};

export const EG_LABELS: Record<MastersDiscipline, Partial<Record<MastersApparatus, string[]>>> = {
  MAG: {
    floor: ['I: Non-Acrobatic', 'II: Acro Forward', 'III: Acro Backward', 'IV: Single Saltos with ≥1 twist'],
    pommel: ['I: Scissors', 'II: Circles/Russians', 'III: Travels'],
    rings: ['I: Kips & Swings', 'II: Strength', 'III: Swing to Strength'],
    pbars: ['I: Upper Arm', 'II: Support', 'III: Long Hang & Underswing'],
    hbar: ['I: Long Hang Swings', 'II: Flight Elements', 'III: In-Bar/Adler'],
  },
  WAG: {
    bars: ['I: Mounts', 'II: Casts, Clear Hips, Stalders, Pike Circles', 'III: Giant Circles', 'IV: Dismounts'],
    beam: ['I: Leaps, Jumps, and Hops', 'II: Turns', 'III: Holds, Acro Non-Flight, Acro Flight', 'IV: Mounts and Dismounts'],
    floor: ['I: Leaps, Jumps, and Hops', 'II: Turns', 'III: Hand Support Elements', 'IV: Saltos Fwd, Sideward, and Bwd'],
  },
};

export const VAULT_AGE_BONUS: Record<MastersDiscipline, Record<AgeDecade, number>> = {
  MAG: { '30': 0.8, '40': 1.6, '50': 2.4, '60': 2.8, '70': 3.2 },
  WAG: { '30': 1.8, '40': 2.6, '50': 3.4, '60': 4.2, '70': 5.0 },
};

// Vault data (from Masters Vault Values.xlsx). null entries are group separators.
export const VAULT_DATA: Record<MastersDiscipline, (MastersVault | null)[]> = {
  MAG: [
    { name: 'Squat onto table - straight jump down', fig: 0.0 },
    { name: 'Roll onto and over the table', fig: 0.0 },
    { name: 'Straddle hecht over table', fig: 0.4 },
    { name: 'Tuck hecht over table', fig: 0.4 },
    { name: 'Pike hecht over table', fig: 0.8 },
    { name: 'Straight hecht over table', fig: 1.2 },
    null,
    { name: 'Front handspring', fig: 1.2 },
    { name: 'Front handspring with 1/2 twist', fig: 1.4 },
    { name: 'Front handspring with 1/1 twist', fig: 1.6 },
    { name: 'Front handspring with 3/2 twist', fig: 1.8 },
    { name: 'Front handspring and salto fwd. tucked', fig: 2.0 },
    { name: 'Front handspring and salto fwd. tucked with 1/2 twist', fig: 2.4 },
    { name: 'Front handspring and salto fwd. piked', fig: 2.4 },
    { name: 'Front handspring and salto fwd. piked with 1/2 twist', fig: 2.8 },
    { name: 'Front handspring and salto fwd. stretched', fig: 3.2 },
    { name: 'Front handspring and salto fwd. stretched with 1/2 twist', fig: 3.6 },
    null,
    { name: 'Front handspring sw with 1/4 twist', fig: 1.2 },
    { name: 'Front handspring sw with 3/4 twist', fig: 1.4 },
    { name: 'Front handspring sw with 5/4 twist', fig: 1.6 },
    { name: 'Tsukahara or Yurchenko tucked', fig: 1.8 },
    { name: 'Tsukahara or Yurchenko piked', fig: 2.0 },
    { name: 'Tsukahara or Yurchenko tucked with 1/2 twist', fig: 2.0 },
    { name: 'Tsukahara or Yurchenko tucked with 1/1 twist', fig: 2.4 },
    { name: 'Tsukahara or Yurchenko stretched', fig: 2.8 },
    { name: 'Tsukahara or Yurchenko stretched with 1/2 twist', fig: 3.2 },
    { name: 'Tsukahara or Yurchenko stretched with 1/1 twist', fig: 3.6 },
  ],
  WAG: [
    { name: 'Squat onto table - straight jump down', fig: 0.0 },
    { name: 'Roll onto and over the table', fig: 0.0 },
    { name: 'Straddle hecht over table', fig: 0.6 },
    { name: 'Tuck hecht over table', fig: 0.6 },
    { name: 'Pike hecht over table', fig: 1.1 },
    { name: 'Straight hecht over table', fig: 1.6 },
    null,
    { name: 'Front handspring', fig: 1.6 },
    { name: 'Front handspring with 1/2 twist', fig: 2.0 },
    { name: 'Front handspring with 1/1 twist', fig: 2.6 },
    { name: 'Front handspring with 3/2 twist', fig: 3.2 },
    { name: 'Front handspring with 1/2 twist 1st phase', fig: 1.6 },
    { name: 'Front handspring with 1/2 twist 1st & 2nd phase', fig: 2.4 },
    { name: 'Yamashita', fig: 2.0 },
    { name: 'Yamashita 1/2 twist', fig: 2.4 },
    { name: 'Yamashita 1/1 twist', fig: 2.8 },
    { name: 'Front handspring and salto fwd. tucked', fig: 3.6 },
    { name: 'Front handspring and salto fwd. tucked with 1/2 twist', fig: 3.8 },
    { name: 'Front handspring and salto fwd. piked', fig: 3.8 },
    { name: 'Front handspring and salto fwd. piked with 1/2 twist', fig: 4.0 },
    null,
    { name: 'Front handspring sw with 1/4 twist', fig: 1.6 },
    { name: 'Front handspring sw with 3/4 twist', fig: 2.0 },
    { name: 'Front handspring sw with 5/4 twist', fig: 2.6 },
    { name: 'Yurchenko tucked', fig: 3.0 },
    { name: 'Yurchenko piked', fig: 3.2 },
    { name: 'Yurchenko tucked with 1/2 twist', fig: 3.2 },
    { name: 'Yurchenko tucked with 1/1 twist', fig: 3.6 },
    { name: 'Yurchenko stretched', fig: 3.6 },
    { name: 'Yurchenko stretched with 1/2 twist', fig: 3.8 },
    { name: 'Yurchenko stretched with 1/1 twist', fig: 4.2 },
    { name: 'Tsukahara tucked', fig: 3.2 },
    { name: 'Tsukahara piked', fig: 3.4 },
    { name: 'Tsukahara tucked with 1/2 twist', fig: 3.4 },
    { name: 'Tsukahara tucked with 1/1 twist', fig: 3.8 },
    { name: 'Tsukahara stretched', fig: 3.8 },
    { name: 'Tsukahara stretched with 1/2 twist', fig: 4.0 },
    { name: 'Tsukahara stretched with 1/1 twist', fig: 4.4 },
  ],
};

// UCG event code → Masters apparatus.
const EVENT_APPARATUS: Record<MastersDiscipline, Record<string, MastersApparatus>> = {
  MAG: { FX: 'floor', PH: 'pommel', SR: 'rings', VT: 'vault', PB: 'pbars', HB: 'hbar' },
  WAG: { VT: 'vault', UB: 'bars', BB: 'beam', FX: 'floor' },
};

export function apparatusFor(discipline: MastersDiscipline, eventCode: string): MastersApparatus {
  return EVENT_APPARATUS[discipline][eventCode] ?? 'floor';
}

export function skillValue(age: AgeDecade, level: MastersSkillLevel): number | null {
  return SKILL_VALUES[age][level];
}

export function egLabels(discipline: MastersDiscipline, apparatus: MastersApparatus): string[] {
  if (apparatus === 'vault') return [];
  return EG_LABELS[discipline][apparatus]
    ?? (discipline === 'MAG' ? ['EG I', 'EG II', 'EG III'] : ['EG I', 'EG II', 'EG III', 'EG IV']);
}

export function vaultList(discipline: MastersDiscipline): (MastersVault | null)[] {
  return VAULT_DATA[discipline];
}

export interface MastersState {
  discipline: MastersDiscipline;
  age: AgeDecade;
  counts: Record<MastersSkillLevel, number>;
  egs: boolean[];
  dismountLevel: MastersDismountLevel;
  deductions: string;
  vaultIndex: number | 'custom' | null;
  vaultDeductions: string;
}

export function init(_levelId: string, eventCode: string): MastersState {
  // The only masters level is mag-masters; engine + panel retain WAG support.
  const discipline: MastersDiscipline = 'MAG';
  return {
    discipline,
    age: '30',
    counts: { 'd+': 0, c: 0, b: 0, a: 0, me: 0, misc: 0 },
    egs: egLabels(discipline, apparatusFor(discipline, eventCode)).map(() => false),
    dismountLevel: 'none',
    deductions: '',
    vaultIndex: null,
    vaultDeductions: '',
  };
}

function dismountBonus(state: MastersState): number {
  if (state.dismountLevel === 'none') return 0;
  return SKILL_VALUES[state.age][state.dismountLevel] ?? 0;
}

export function compute(state: MastersState, _levelId: string, eventCode: string): ScoringOutcome {
  const apparatus = apparatusFor(state.discipline, eventCode);

  if (apparatus === 'vault') {
    const idx = state.vaultIndex;
    let base = 0;
    let ageBonus = VAULT_AGE_BONUS[state.discipline][state.age];
    if (idx === null) {
      ageBonus = 0; // nothing selected — matches the original's '-1' option
    } else if (idx !== 'custom') {
      base = VAULT_DATA[state.discipline][idx]?.fig ?? 0;
    }
    const ded = num(state.vaultDeductions, 0, 10);
    const d = round3(base + ageBonus);
    const e = round3(10 - ded);
    return {
      d,
      e,
      final: round3(Math.max(0, d + e)),
      produces: 'full',
      breakdown: [
        { label: 'Base value', value: base },
        { label: 'Age bonus', value: ageBonus },
        { label: 'Deductions', value: -ded },
      ],
      warnings: [],
    };
  }

  const values = SKILL_VALUES[state.age];
  let skills = 0;
  let totalCount = 0;
  for (const level of SKILL_LEVELS) {
    const val = values[level];
    if (val === null) continue;
    skills += state.counts[level] * val;
    totalCount += state.counts[level];
  }

  let egBonus = state.egs.filter(Boolean).length * EG_BONUS_AMOUNT;
  if (state.discipline === 'MAG' && apparatus !== 'floor') egBonus += dismountBonus(state);

  const short = Math.max(0, MIN_SKILLS - totalCount) * SHORT_ROUTINE_DEDUCTION_PER_SKILL;
  const ded = num(state.deductions, 0, 10);
  const d = round3(skills + egBonus);
  const e = round3(10 - (ded + short));

  const warnings: string[] = [];
  if (totalCount > MAX_SKILLS) warnings.push(`Total skills cannot exceed ${MAX_SKILLS}.`);

  const breakdown = [
    { label: 'Skills', value: round3(skills) },
    { label: 'EG bonus', value: round3(egBonus) },
    { label: 'Deductions', value: -ded },
  ];
  if (short > 0) breakdown.push({ label: 'Short routine', value: -short });

  return {
    d,
    e,
    final: round3(Math.max(0, d + e)),
    produces: 'full',
    breakdown,
    warnings,
  };
}
