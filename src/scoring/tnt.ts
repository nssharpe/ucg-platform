// NAIGC Trampoline & Tumbling engine (TR / DM / TU, per NAIGC T&T COP v3.41).
// Ported from public/calculators/tnt.html. Final = execution + difficulty − CJP.
import { num, round2, round3, type ScoringOutcome } from './types';
import { TT_SKILLS, type TtSkill } from './ttSkills';

export type TntEvent = 'TR' | 'DM' | 'TU';
export type TntLevel = 'New Flyers' | 'Intermediate Flyers' | 'High Flyers';

const APPARATUS_KEY: Record<TntEvent, keyof typeof TT_SKILLS> = { TR: 'trampoline', DM: 'dmt', TU: 'tumbling' };

export interface TntPassSpec { name: string; skills: number; labels?: string[]; exec: string }

/** Per-event pass structure. */
export const STRUCTURE: Record<TntEvent, { passes: TntPassSpec[] }> = {
  TR: { passes: [{ name: 'Routine', skills: 10, exec: 'Execution (out of 10)' }] },
  DM: {
    passes: [
      { name: 'Pass 1', skills: 2, labels: ['First skill', 'Dismount'], exec: 'Pass 1 execution (out of 10)' },
      { name: 'Pass 2', skills: 2, labels: ['First skill', 'Dismount'], exec: 'Pass 2 execution (out of 10)' },
    ],
  },
  TU: {
    passes: [
      { name: 'Pass 1', skills: 8, exec: 'Pass 1 execution (out of 10)' },
      { name: 'Pass 2', skills: 8, exec: 'Pass 2 execution (out of 10)' },
    ],
  },
};

interface LevelRule {
  maxSkill?: number; maxSkillSoft?: boolean;
  maxTotal?: number; minTotal?: number;
  maxPass?: number; minPass?: number; maxPassEach?: number[];
  note: string;
}

export const LEVEL_RULES: Record<TntEvent, Record<TntLevel, LevelRule>> = {
  TR: {
    'New Flyers': { maxSkill: 0.4, maxSkillSoft: true, note: 'Skills ≤0.4 (up to 2 listed exceptions, e.g. tucks/baranis). 0.0 skills may repeat once. Violations = 2.0 CJP.' },
    'Intermediate Flyers': { maxSkill: 0.8, maxTotal: 5.0, note: 'Skills ≤0.8 · ≥3 skills with ≥360° flip · routine DD ≤5.0.' },
    'High Flyers': { minTotal: 4.5, note: 'Routine DD must be ≥4.5.' },
  },
  DM: {
    'New Flyers': { maxSkill: 0.7, maxSkillSoft: true, note: 'Skills ≤0.5 (one 0.6/0.7 allowed) · max 1 salto per pass.' },
    'Intermediate Flyers': { maxSkill: 1.2, maxPass: 1.6, note: 'Skills ≤1.2 · ≥2 of 4 skills ≥0.5 · each pass DD ≤1.6.' },
    'High Flyers': { minPass: 1.4, note: 'Each pass DD must be ≥1.4.' },
  },
  TU: {
    'New Flyers': { maxSkill: 0.2, maxPass: 1.3, note: '4–7 skills/pass · skills ≤0.2 · pass DD ≤1.3.' },
    'Intermediate Flyers': { maxSkill: 1.0, maxPassEach: [2.6, 2.9], note: 'Pass 1: 5–8 skills, DD ≤2.6 · Pass 2: 8 skills, DD ≤2.9 · skills ≥0.2 (rebound 0.1 ok).' },
    'High Flyers': { minPass: 2.0, note: 'Two 8-skill passes · each pass DD ≥2.0.' },
  },
};

export function tntLevel(levelId: string): TntLevel {
  switch (levelId) {
    case 'tnt-int': return 'Intermediate Flyers';
    case 'tnt-high': return 'High Flyers';
    default: return 'New Flyers';
  }
}

export function tntEvent(apparatusCode: string): TntEvent {
  return (apparatusCode === 'DM' || apparatusCode === 'TU') ? apparatusCode : 'TR';
}

export function skillsFor(apparatusCode: string): TtSkill[] {
  return TT_SKILLS[APPARATUS_KEY[tntEvent(apparatusCode)]];
}

export function levelNote(levelId: string, apparatusCode: string): string {
  return LEVEL_RULES[tntEvent(apparatusCode)][tntLevel(levelId)].note;
}

export interface TntSkillEntry {
  name: string;
  /** DD as typed/filled — chart skills fill it, unlisted skills take a Rules-Team-approved DD. */
  dd: string;
}
export interface TntPassState { exec: string; skills: TntSkillEntry[] }
export interface TntState { passes: TntPassState[]; penalty: string }

export function init(_levelId: string, apparatusCode: string): TntState {
  return {
    passes: STRUCTURE[tntEvent(apparatusCode)].passes.map((p) => ({
      exec: '10.0',
      skills: Array.from({ length: p.skills }, () => ({ name: '', dd: '' })),
    })),
    penalty: '',
  };
}

export function passDD(pass: TntPassState): number {
  return round2(pass.skills.reduce((sum, s) => {
    const v = parseFloat(s.dd);
    return !isNaN(v) && v > 0 ? sum + v : sum;
  }, 0));
}

export function compute(state: TntState, levelId: string, apparatusCode: string): ScoringOutcome {
  const ev = tntEvent(apparatusCode);
  const level = tntLevel(levelId);
  const rules = LEVEL_RULES[ev][level];
  const warnings: string[] = [];
  let totalDD = 0;
  let totalExec = 0;

  STRUCTURE[ev].passes.forEach((spec, pi) => {
    const pass = state.passes[pi];
    if (!pass) return;
    for (const s of pass.skills) {
      const v = parseFloat(s.dd);
      if (!isNaN(v) && v > 0 && rules.maxSkill != null && v > rules.maxSkill + 1e-9) {
        warnings.push(`Skill DD ${v.toFixed(1)} exceeds ${level} max ${rules.maxSkill.toFixed(1)}${rules.maxSkillSoft ? ' (check listed exceptions)' : ''} — 2.0 CJP if not allowed.`);
      }
    }
    const dd = passDD(pass);
    totalDD += dd;
    totalExec += num(pass.exec, 0, 10);
    if (rules.maxPass != null && dd > rules.maxPass + 1e-9) warnings.push(`${spec.name} DD ${dd.toFixed(1)} exceeds max ${rules.maxPass.toFixed(1)}.`);
    if (rules.maxPassEach?.[pi] != null && dd > rules.maxPassEach[pi] + 1e-9) warnings.push(`${spec.name} DD ${dd.toFixed(1)} exceeds max ${rules.maxPassEach[pi].toFixed(1)}.`);
    if (rules.minPass != null && dd > 0 && dd < rules.minPass - 1e-9) warnings.push(`${spec.name} DD ${dd.toFixed(1)} below required ${rules.minPass.toFixed(1)}.`);
  });

  if (rules.maxTotal != null && totalDD > rules.maxTotal + 1e-9) warnings.push(`Routine DD ${totalDD.toFixed(1)} exceeds max ${rules.maxTotal.toFixed(1)}.`);
  if (rules.minTotal != null && totalDD > 0 && totalDD < rules.minTotal - 1e-9) warnings.push(`Routine DD ${totalDD.toFixed(1)} below required ${rules.minTotal.toFixed(1)}.`);

  const penalty = num(state.penalty, 0, 30);
  const d = round2(totalDD);
  const e = round2(totalExec);
  const breakdown = [
    { label: 'Difficulty', value: d },
    { label: 'Execution', value: e },
  ];
  if (penalty) breakdown.push({ label: 'CJP penalties', value: -penalty });

  return {
    d,
    e,
    final: round3(Math.max(0, totalDD + totalExec - penalty)),
    produces: 'full',
    breakdown,
    warnings,
  };
}
