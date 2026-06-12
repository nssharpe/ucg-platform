// NAIGC WAG Open routine engine (bars/beam/floor) — top-8 skills + EG bonus.
// Ported from public/calculators/wag-open.html. Produces a full D/E/Final score.
import { round3, num, type ScoringOutcome } from './types';

export const MAX_SKILLS = 8;
const MIN_SKILLS_FOR_NO_DEDUCTION = 6;
const SHORT_ROUTINE_DEDUCTION_PER_SKILL = 1.0;
const ELEMENT_GROUP_BONUS = 0.3;

export const SKILL_VALUES = { a: 0.1, b: 0.3, c: 0.5, d: 0.7, e: 0.9 } as const;
export type SkillLetter = keyof typeof SKILL_VALUES;
export const SKILL_LETTERS: SkillLetter[] = ['a', 'b', 'c', 'd', 'e'];

/** Element-group labels keyed by UCG event code (UB → bars, BB → beam, FX → floor). */
const APPARATUS_DATA: Record<string, string[]> = {
  UB: [
    'Mounts (1) & Dismounts (8)',
    'Casts/Counterswings (2)',
    'Underswings/Clear Hips (3), Stalders (6), & Circle Swings/Hechts (7)',
    'Giant Swings Backward (4) & Giants/Circles Forward (5)',
  ],
  BB: [
    'Mounts (1) & Dismounts (9)',
    'Leaps/Jumps/Hops (2) & Turns (3)',
    'Waves (4), Holds/Stands (5), & Rolls (6)',
    'Walkovers/Cartwheels (7) & Saltos (8)',
  ],
  FX: [
    'Leaps/Jumps/Hops (1) & Turns (2)',
    'Handstands (3), Rolls (4), & Walkovers/Cartwheels etc. (5)',
    'Saltos Forward (6) & Saltos Sideward/Arabians (7)',
    'Saltos Backward (8)',
  ],
};

export interface WagOpenState {
  counts: Record<SkillLetter, number>;
  egs: boolean[];
  deductions: string;
}

export function egLabels(eventCode: string): string[] {
  return APPARATUS_DATA[eventCode] ?? APPARATUS_DATA.FX;
}

export function init(_levelId: string, _eventCode: string): WagOpenState {
  return {
    counts: { a: 0, b: 0, c: 0, d: 0, e: 0 },
    egs: [false, false, false, false],
    deductions: '',
  };
}

export function compute(state: WagOpenState, _levelId: string, _eventCode: string): ScoringOutcome {
  let skills = 0;
  let count = 0;
  for (const letter of SKILL_LETTERS) {
    const c = state.counts[letter] || 0;
    skills += c * SKILL_VALUES[letter];
    count += c;
  }
  skills = round3(skills);
  const egBonus = round3(state.egs.filter(Boolean).length * ELEMENT_GROUP_BONUS);
  const deductions = num(state.deductions, 0, 10);
  const short = round3(
    Math.max(0, MIN_SKILLS_FOR_NO_DEDUCTION - count) * SHORT_ROUTINE_DEDUCTION_PER_SKILL,
  );

  const d = round3(skills + egBonus);
  const e = round3(10 - (deductions + short));
  const final = round3(Math.max(0, d + e));

  return {
    d,
    e,
    final,
    produces: 'full',
    breakdown: [
      { label: 'Skills', value: skills },
      { label: 'EG bonus', value: egBonus },
      { label: 'Deductions', value: -deductions },
      { label: 'Short routine', value: -short },
    ],
    warnings: [],
  };
}
