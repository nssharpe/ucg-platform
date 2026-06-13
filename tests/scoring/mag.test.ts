import { describe, it, expect } from 'vitest';
import { init, compute, magRuleset, rowFlags } from '../../src/scoring/mag';

describe('mag scoring engine — structural', () => {
  it('always produces an SV-only outcome', () => {
    const state = init('mag-dev', 'FX');
    const outcome = compute(state, 'mag-dev', 'FX');
    expect(outcome.produces).toBe('d');
    expect(outcome.e).toBeNull();
    expect(outcome.final).toBeNull();
  });

  it('maps level ids to the correct ruleset labels', () => {
    expect(magRuleset('mag-dev')).toBe('NAIGC Developmental');
    expect(magRuleset('mag-int')).toBe('NAIGC Intermediate');
    expect(magRuleset('mag-adv')).toBe('NAIGC Advanced');
    expect(magRuleset('fig')).toBe('FIG');
    expect(magRuleset('anything-else')).toBe('FIG');
  });
});

describe('mag scoring engine — Developmental FX', () => {
  it('Ground truth 1: empty routine — short-exercise deduction is 0.5 per missing skill (6 missing => -3.0)', () => {
    const state = init('mag-dev', 'FX');
    // 6 empty rows, no bonus/deduction options set.
    const outcome = compute(state, 'mag-dev', 'FX');

    // Execution 10 + Skills 0 + EG 0 - shortExerciseDeduction(0.5 * 6 = 3.0) = 7.0
    expect(outcome.d).toBe(7.0);
    expect(outcome.breakdown.find((b) => b.label === 'Execution')?.value).toBe(10.0);
    expect(outcome.breakdown.find((b) => b.label === 'Skills')?.value).toBe(0);
    expect(outcome.breakdown.find((b) => b.label === 'EG bonus')?.value).toBe(0);
    expect(outcome.breakdown.find((b) => b.label === 'Neutral deductions')?.value).toBe(-3.0);
  });

  it('Ground truth 2: skills value (C+B=0.5) + EG bonus (I + II = 1.0) before deductions', () => {
    const state = init('mag-dev', 'FX');
    state.skills[0] = 'C';
    state.egs[0] = 'II';
    state.skills[1] = 'B';
    state.egs[1] = 'I';

    const outcome = compute(state, 'mag-dev', 'FX');

    // Independent check of skill value and EG bonus, per the task's fallback
    // guidance — the original's "1.444" neutral-deduction figure isn't reachable
    // through this engine's discrete deductionOptions (all multiples of 0.1),
    // so we assert the pre-deduction components precisely instead.
    const skillsValue = outcome.breakdown.find((b) => b.label === 'Skills')?.value;
    const egBonus = outcome.breakdown.find((b) => b.label === 'EG bonus')?.value;
    expect(skillsValue).toBe(0.5); // C (0.3) + B (0.2)
    expect(egBonus).toBe(1.0); // EG I (0.5) + EG II flat bonus for Developmental (0.5)

    // raw = 10 + 0.5 + 1.0 = 11.5, not capped (<=12.7)
    // Only 2 of 6 skill rows filled => short-exercise deduction = 0.5 * (6 - 2) = 2.0
    // d = 11.5 - 2.0 = 9.5 (with the engine's default neutral-deduction options
    // left at zero, i.e. without reproducing the original's 1.444 typed value).
    expect(outcome.d).toBe(9.5);
    expect(outcome.breakdown.find((b) => b.label === 'Neutral deductions')?.value).toBe(-2.0);
  });

  it('Ground truth 3: 4-per-EG fix — only 4 of 6 same-EG J skills count, SV is capped, 2 rows excluded', () => {
    const state = init('mag-dev', 'FX');
    for (let i = 0; i < 6; i++) {
      state.skills[i] = 'J';
      state.egs[i] = 'II';
    }

    const outcome = compute(state, 'mag-dev', 'FX');

    // Skills value = 4 * 1.0 = 4.0 (only 4 of the 6 J's count toward SV).
    expect(outcome.breakdown.find((b) => b.label === 'Skills')?.value).toBe(4.0);
    expect(outcome.warnings).toContain('4 Elements/EG Maximum Exceeded');

    // raw = 10 + 4.0 (skills) + 0.5 (flat Dev EG II bonus) = 14.5 > 12.7 => capped.
    expect(outcome.warnings.some((w) => w.includes('Start Value Cap implemented'))).toBe(true);
    expect(outcome.d).toBe(12.7);

    const flags = rowFlags(state, 'mag-dev', 'FX');
    const excludedCount = flags.excluded.filter(Boolean).length;
    expect(excludedCount).toBe(2);
  });
});

describe('mag scoring engine — FIG short-exercise fix', () => {
  it('Ground truth 4: FIG with zero skills applies a 10-point short-exercise deduction (fixed unreachable branch)', () => {
    const state = init('fig', 'FX');
    const outcome = compute(state, 'fig', 'FX');

    // raw = 10 + 0 (skills) + 0 (EG) = 10; shortExerciseDeduction('FIG', 0) = 10
    expect(outcome.breakdown.find((b) => b.label === 'Neutral deductions')?.value).toBe(-10);
    expect(outcome.d).toBe(0);
  });
});

describe('mag scoring engine — Vault (VT) intentional fixes', () => {
  it('Ground truth 5a: no-credit deduction zeroes the vault SV regardless of vault value', () => {
    const state = init('mag-dev', 'VT');
    state.vaultValue = 3.4;
    state.deductions['no-credit'] = true;
    state.hideNeutral = false;

    const outcome = compute(state, 'mag-dev', 'VT');

    expect(outcome.d).toBe(0);
    expect(outcome.warnings).toContain('No credit — vault SV 0.0');
  });

  it('Ground truth 5b: without no-credit, vault SV = 10 + vaultValue (using FIG, which has no SV cap)', () => {
    // mag-dev/mag-int both cap the raw SV (12.7 / 13.2), and 10 + 3.4 = 13.4
    // would exceed both caps. Use the FIG ruleset (uncapped) to get a clean
    // 10 + vaultValue = 13.4 with no neutral options and no cap warning.
    const state = init('fig', 'VT');
    state.vaultValue = 3.4;

    const outcome = compute(state, 'fig', 'VT');

    expect(outcome.d).toBe(13.4);
    expect(outcome.warnings).not.toContain('No credit — vault SV 0.0');
    expect(outcome.warnings.some((w) => w.includes('Start Value Cap implemented'))).toBe(false);
  });
});
