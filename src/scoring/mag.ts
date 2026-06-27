// NAIGC MAG start-value engine (FIG + NAIGC Developmental/Intermediate/Advanced).
// Ported from public/calculators/mag/script.js. Produces an SV only ('d') —
// the judge applies execution deductions in the score form.
//
// Intentional divergences from the original (bugs there, flagged to rules@naigc.org):
//  1. 4-per-EG rule: the original double-counted an over-limit EG's top 4 skills
//     (added once in the sweep, then again when trimming). Here each included
//     skill counts exactly once and skills beyond 4 per EG are excluded.
//  2. FIG short exercise with 0 skills: the original's "=== 0 → 10" branch was
//     unreachable (the <6 branch yielded 8). 10 is applied here.
//  3. Vault no-credit: the original set a flag it never read. Here it zeroes the
//     SV with a warning.
//  4. Vault no longer receives a short-exercise deduction for its (empty) skill
//     rows (the original computed it from stale/empty selectedSkills on VT).
import { round3, type ScoringOutcome } from './types';

export type MagSkill = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J';
export type MagEG = 'I' | 'II' | 'III' | 'IV';
export type MagRuleset = 'FIG' | 'NAIGC Developmental' | 'NAIGC Intermediate' | 'NAIGC Advanced';

export const SKILL_LETTERS: MagSkill[] = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
export const EG_VALUES: MagEG[] = ['I', 'II', 'III', 'IV'];

export const SKILL_VALUES: Record<MagSkill, number> = {
  A: 0.1, B: 0.2, C: 0.3, D: 0.4, E: 0.5, F: 0.6, G: 0.7, H: 0.8, I: 0.9, J: 1.0,
};

export function magRuleset(levelId: string): MagRuleset {
  switch (levelId) {
    case 'mag-dev': return 'NAIGC Developmental';
    case 'mag-int': return 'NAIGC Intermediate';
    case 'mag-adv': return 'NAIGC Advanced';
    default: return 'FIG';
  }
}

export function rowCount(ruleset: MagRuleset): number {
  return ruleset === 'NAIGC Developmental' ? 6 : 8;
}

/** Vault value choices: 1.2 – 5.6 in 0.2 steps. */
export const VAULT_VALUES: number[] = Array.from({ length: 23 }, (_, i) => round3(1.2 + i * 0.2));

export interface MagState {
  skills: (MagSkill | null)[];
  egs: (MagEG | null)[];
  vaultValue: number;
  /** Keyed by MagOption.key: booleans for checks, numbers for counts/selects. */
  bonus: Record<string, number | boolean>;
  deductions: Record<string, number | boolean>;
  hideNeutral: boolean;
}

export function init(levelId: string, _apparatusCode: string): MagState {
  const n = rowCount(magRuleset(levelId));
  return {
    skills: Array(n).fill(null),
    egs: Array(n).fill(null),
    vaultValue: 1.2,
    bonus: {},
    deductions: {},
    hideNeutral: false,
  };
}

// ---- Bonus / neutral-deduction option catalogues --------------------------

export interface MagOption {
  key: string;
  label: string;
  kind: 'check' | 'count' | 'select';
  /** check: added when true; count: per-unit value (0–5 steps). */
  amount?: number;
  /** select: chosen value added directly. */
  choices?: { label: string; value: number }[];
  /** key of a mutually-exclusive partner (stick-bonus pairs). */
  exclusiveWith?: string;
}

const stick01 = (label = 'Stick Bonus +0.1'): MagOption => ({ key: 'stick-01', label, kind: 'check', amount: 0.1 });
const stickB: MagOption = { key: 'stick-b', label: 'Stick Bonus +0.1 (B)', kind: 'check', amount: 0.1, exclusiveWith: 'stick-c' };
const stickC: MagOption = { key: 'stick-c', label: 'Stick Bonus +0.2 (≥C)', kind: 'check', amount: 0.2, exclusiveWith: 'stick-b' };
const fxConn: MagOption[] = [
  { key: 'conn-01', label: '≥D + B/C connection (+0.1 each)', kind: 'count', amount: 0.1 },
  { key: 'conn-02', label: '≥D + ≥D connection (+0.2 each)', kind: 'count', amount: 0.2 },
];
const hbConn01: MagOption = { key: 'conn-01', label: 'C + C connection, flight or in-bar (+0.1 each)', kind: 'count', amount: 0.1 };
const strength01: MagOption = { key: 'strength-01', label: 'Strength skill ≥C (+0.1)', kind: 'check', amount: 0.1 };

export function bonusOptions(ruleset: MagRuleset, apparatus: string): MagOption[] {
  if (ruleset === 'NAIGC Developmental') {
    switch (apparatus) {
      case 'FX': return [...fxConn, stick01()];
      case 'PH': return [{
        key: 'mushroom', label: 'Pommel Horse Mushroom Bonus', kind: 'select',
        choices: Array.from({ length: 11 }, (_, i) => ({ label: (i / 10).toFixed(1), value: round3(i / 10) })),
      }];
      case 'SR': return [strength01, stick01()];
      case 'VT': return [stick01()];
      case 'PB': return [stick01()];
      case 'HB': return [hbConn01, stick01()];
    }
  }
  if (ruleset === 'NAIGC Intermediate') {
    switch (apparatus) {
      case 'FX': return [...fxConn, stick01()];
      case 'SR': return [strength01, stick01()];
      case 'VT': return [
        { key: 'stick-01', label: 'Stick Bonus +0.1 (Non-Flipping Vault)', kind: 'check', amount: 0.1, exclusiveWith: 'stick-02' },
        { key: 'stick-02', label: 'Stick Bonus +0.2 (Flipping Vault)', kind: 'check', amount: 0.2, exclusiveWith: 'stick-01' },
      ];
      case 'PB': return [stick01()];
      case 'HB': return [hbConn01, stick01()];
    }
  }
  if (ruleset === 'NAIGC Advanced') {
    switch (apparatus) {
      case 'FX': return [
        ...fxConn,
        { key: 'dbl-dismount', label: 'Double Flipping Dismount (+0.1)', kind: 'check', amount: 0.1 },
        stickB, stickC,
      ];
      case 'SR': return [strength01, stickB, stickC];
      case 'VT': return [{ key: 'stick-02', label: 'Stick Bonus +0.2 (Flipping Vault)', kind: 'check', amount: 0.2 }];
      case 'PB': return [stickB, stickC];
      case 'HB': return [hbConn01, stickB, stickC];
    }
  }
  if (ruleset === 'FIG') {
    switch (apparatus) {
      case 'FX': return [...fxConn, stick01('Stick Bonus (≥C) +0.1')];
      case 'SR': return [stick01('Stick Bonus (≥C) +0.1')];
      case 'VT': return [stick01('Stick Bonus (Flipping Vault) +0.1')];
      case 'PB': return [stick01('Stick Bonus (≥C) +0.1')];
      case 'HB': return [
        { key: 'hb-conn-cd', label: 'C/D flight + D flight connection (+0.1 each)', kind: 'count', amount: 0.1 },
        { key: 'hb-conn-de', label: '≥D flight + ≥E flight connection (+0.2 each)', kind: 'count', amount: 0.2 },
        { key: 'hb-conn-d1', label: 'D flight + ≥D EG I/III connection (+0.1 each)', kind: 'count', amount: 0.1 },
        { key: 'hb-conn-e1', label: '≥E flight + ≥D EG I/III connection (+0.2 each)', kind: 'count', amount: 0.2 },
        stick01('Stick Bonus (≥C) +0.1'),
      ];
    }
  }
  return [];
}

export function deductionOptions(ruleset: MagRuleset, apparatus: string): MagOption[] {
  if (apparatus === 'FX') {
    const opts: MagOption[] = [
      {
        key: 'fx-time', label: 'Exercise longer than 70 sec.', kind: 'select',
        choices: [
          { label: 'None', value: 0 },
          { label: '≤ 2 sec. : −0.1', value: 0.1 },
          { label: '>2 – 5 sec. : −0.3', value: 0.3 },
          { label: '> 5 sec. : −0.5', value: 0.5 },
        ],
      },
      { key: 'oob-01', label: 'One foot/hand outside the floor area (−0.1 each)', kind: 'count', amount: 0.1 },
      { key: 'oob-03', label: 'Feet, hands, or body outside the floor area (−0.3 each)', kind: 'count', amount: 0.3 },
      { key: 'no-corner', label: 'No pass to/from each corner (−0.3)', kind: 'check', amount: 0.3 },
      { key: 'same-diagonal', label: 'Same diagonal more than 2× in a row (−0.3)', kind: 'check', amount: 0.3 },
    ];
    if (ruleset === 'NAIGC Advanced') {
      opts.push({ key: 'no-multi-salto', label: "No multiple salto element (doesn't have to be the dismount) (−0.3)", kind: 'check', amount: 0.3 });
    } else if (ruleset === 'FIG') {
      opts.push({ key: 'no-multi-salto', label: 'No multiple salto element (dismount for seniors) (−0.3)', kind: 'check', amount: 0.3 });
      opts.push({ key: 'no-balance', label: 'No balance on one leg (−0.3)', kind: 'check', amount: 0.3 });
    }
    return opts;
  }
  if (apparatus === 'SR' && (ruleset === 'NAIGC Advanced' || ruleset === 'FIG')) {
    return [{ key: 'no-swing-hs', label: 'No swing to handstand (−0.3)', kind: 'check', amount: 0.3 }];
  }
  if (apparatus === 'VT') {
    return [
      { key: 'vt-oob-01', label: 'One foot/hand outside the landing area (−0.1)', kind: 'check', amount: 0.1 },
      { key: 'vt-oob-03', label: 'Feet/hands/body outside the landing area (−0.3)', kind: 'check', amount: 0.3 },
      { key: 'vt-oob-05', label: 'Feet/hands/body outside the landing area (−0.5)', kind: 'check', amount: 0.5 },
      { key: 'no-credit', label: 'No vault board safety collar for round-off entry — No Credit', kind: 'check', amount: 0 },
    ];
  }
  return [];
}

function optionTotal(options: MagOption[], values: Record<string, number | boolean>): number {
  let total = 0;
  for (const opt of options) {
    const v = values[opt.key];
    if (opt.kind === 'check') { if (v) total += opt.amount ?? 0; }
    else if (opt.kind === 'count') total += (typeof v === 'number' ? v : 0) * (opt.amount ?? 0);
    else if (opt.kind === 'select') total += typeof v === 'number' ? v : 0;
  }
  return round3(total);
}

// ---- Routine analysis ------------------------------------------------------

interface RowAnalysis {
  includedValue: number;
  excluded: boolean[];
  egContrib: boolean[];
  warnings: string[];
  egBonus: number;
}

function analyze(state: MagState, ruleset: MagRuleset, apparatus: string): RowAnalysis {
  const n = state.skills.length;
  const excluded = Array(n).fill(false) as boolean[];
  const warnings: string[] = [];

  // Still Rings EG II/III rule: more than 3 EG II/III skills before any ≥B EG I
  // skill stop counting.
  if (apparatus === 'SR') {
    let counter = 0;
    let foundHigherEGI = false;
    let warned = false;
    state.skills.forEach((skill, i) => {
      if (!skill) return;
      const eg = state.egs[i];
      if ((eg === 'II' || eg === 'III') && !foundHigherEGI) {
        counter++;
        if (counter > 3) {
          excluded[i] = true;
          if (!warned) { warnings.push('>3 EGII and/or EGIII skills without a ≥B EGI skill'); warned = true; }
        }
      } else if (eg === 'I' && skill >= 'B') {
        foundHigherEGI = true;
        counter = 0;
      }
    });
  }

  // 4 skills per EG maximum: only the 4 highest-value skills in an EG count.
  const byEG = new Map<MagEG, { i: number; value: number }[]>();
  state.skills.forEach((skill, i) => {
    const eg = state.egs[i];
    if (!skill || !eg || excluded[i]) return;
    if (!byEG.has(eg)) byEG.set(eg, []);
    byEG.get(eg)!.push({ i, value: SKILL_VALUES[skill] });
  });
  let fourWarned = false;
  for (const rows of byEG.values()) {
    if (rows.length <= 4) continue;
    [...rows].sort((a, b) => b.value - a.value).slice(4).forEach((r) => { excluded[r.i] = true; });
    if (!fourWarned) { warnings.push('4 Elements/EG Maximum Exceeded'); fourWarned = true; }
  }

  let includedValue = 0;
  state.skills.forEach((skill, i) => {
    if (skill && !excluded[i]) includedValue += SKILL_VALUES[skill];
  });

  const { egBonus, egContrib } = computeEGBonus(state, ruleset, apparatus);
  return { includedValue: round3(includedValue), excluded, egContrib, warnings, egBonus };
}

/** EG bonus per ruleset. Mirrors the original's calculate*EGBonus functions,
 *  including which rows get the "contributing" highlight. Rows excluded by the
 *  SR / 4-per-EG rules still feed the EG bonus, exactly as in the original. */
function computeEGBonus(state: MagState, ruleset: MagRuleset, apparatus: string): { egBonus: number; egContrib: boolean[] } {
  const n = state.skills.length;
  const contrib = Array(n).fill(false) as boolean[];
  const bonuses: Record<MagEG, number> = { I: 0, II: 0, III: 0, IV: 0 };
  const rows: Record<MagEG, number[]> = { I: [], II: [], III: [], IV: [] };

  // Tiered best-bonus accumulator shared by EG II/III (and FX EG IV):
  // tiers = [ [matches, bonus], ... ] evaluated in order, first match wins.
  const applyTiers = (eg: MagEG, i: number, tiers: [boolean, number][]) => {
    for (const [match, bonus] of tiers) {
      if (!match) continue;
      if (bonuses[eg] < bonus) { bonuses[eg] = bonus; rows[eg] = [i]; }
      else if (bonuses[eg] === bonus) rows[eg].push(i);
      return;
    }
  };

  state.skills.forEach((skill, i) => {
    const eg = state.egs[i];
    if (!skill || !eg) return;

    if (eg === 'I') {
      bonuses.I = 0.5;
      rows.I.push(i);
      return;
    }

    if (ruleset === 'NAIGC Developmental') {
      // Flat 0.5 per fulfilled EG (capped below).
      bonuses[eg] = 0.5;
      rows[eg].push(i);
      return;
    }

    const isEGIV = eg === 'IV';
    if (isEGIV && apparatus !== 'FX') {
      // Dismount EG: bonus equals the best dismount skill's value.
      const v = SKILL_VALUES[skill];
      if (bonuses.IV < v) { bonuses.IV = v; rows.IV = [i]; }
      else if (bonuses.IV === v) rows.IV.push(i);
      return;
    }

    if (ruleset === 'NAIGC Intermediate') {
      applyTiers(eg, i, [[skill === 'A', 0.3], [true, 0.5]]);
    } else if (ruleset === 'NAIGC Advanced') {
      applyTiers(eg, i, [[skill === 'A' || skill === 'B', 0.3], [skill === 'C', 0.4], [skill > 'C', 0.5]]);
    } else {
      // FIG: ≥D = 0.5, else 0.3.
      applyTiers(eg, i, [[skill > 'C', 0.5], [true, 0.3]]);
    }
  });

  let egBonus = bonuses.I + bonuses.II + bonuses.III + bonuses.IV;
  if (ruleset === 'NAIGC Developmental') egBonus = Math.min(egBonus, 1.5);

  for (const eg of EG_VALUES) rows[eg].forEach((i) => { contrib[i] = true; });
  return { egBonus: round3(egBonus), egContrib: contrib };
}

function shortExerciseDeduction(ruleset: MagRuleset, skillCount: number): number {
  if (skillCount >= 6) return 0;
  if (ruleset === 'FIG') return skillCount === 0 ? 10 : 2 + (6 - skillCount);
  if (ruleset === 'NAIGC Intermediate' || ruleset === 'NAIGC Advanced') return 6 - skillCount;
  return 0.5 * (6 - skillCount); // Developmental
}

/** Per-row UI flags for the panel (red excluded chips, green contributing EG chips). */
export function rowFlags(state: MagState, levelId: string, apparatusCode: string): { excluded: boolean[]; egContrib: boolean[] } {
  const a = analyze(state, magRuleset(levelId), apparatusCode);
  return { excluded: a.excluded, egContrib: a.egContrib };
}

export function compute(state: MagState, levelId: string, apparatusCode: string): ScoringOutcome {
  const ruleset = magRuleset(levelId);
  const apparatus = apparatusCode;
  const warnings: string[] = [];

  let skillsValue: number;
  let egBonus = 0;
  let short = 0;
  if (apparatus === 'VT') {
    skillsValue = state.vaultValue;
  } else {
    const a = analyze(state, ruleset, apparatus);
    skillsValue = a.includedValue;
    egBonus = a.egBonus;
    warnings.push(...a.warnings);
    short = shortExerciseDeduction(ruleset, state.skills.filter(Boolean).length);
  }

  const otherBonus = optionTotal(bonusOptions(ruleset, apparatus), state.bonus);
  const optionDeductions = state.hideNeutral ? 0 : optionTotal(deductionOptions(ruleset, apparatus), state.deductions);

  const raw = round3(10.0 + skillsValue + egBonus + otherBonus);
  let capped: number | null = null;
  if (ruleset === 'NAIGC Developmental' && raw > 12.7) capped = 12.7;
  else if (ruleset === 'NAIGC Intermediate' && raw > 13.2) capped = 13.2;
  if (capped !== null) warnings.push(`Start Value Cap implemented, SV reduced to ${capped.toFixed(1)} from ${raw.toFixed(1)}`);

  // Short-exercise deduction reduces the start value (SV rule).
  // Neutral option deductions (OOB, floor time, etc.) belong in total deductions
  // alongside execution deductions — they do NOT reduce start value.
  let sv = round3((capped ?? raw) - short);
  if (apparatus === 'VT' && !state.hideNeutral && state.deductions['no-credit']) {
    sv = 0;
    warnings.push('No credit — vault SV 0.0');
  }

  const breakdown = [
    { label: 'Base value', value: 10.0 },
    { label: 'Skills', value: skillsValue },
    { label: 'EG bonus', value: egBonus },
    { label: 'Other bonus', value: otherBonus },
    ...(short > 0 ? [{ label: 'Short exercise deduction', value: -short }] : []),
    // Neutral option deductions are surfaced here for the judge form to pick up
    // and add to total deductions — they are NOT subtracted from start value.
    ...(optionDeductions > 0 ? [{ label: 'Neutral deductions', value: -optionDeductions }] : []),
  ];

  return { d: sv, e: null, final: null, produces: 'd', breakdown, warnings };
}
