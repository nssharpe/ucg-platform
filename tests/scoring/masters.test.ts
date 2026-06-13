import { describe, it, expect } from 'vitest';
import { init, compute, VAULT_DATA, VAULT_AGE_BONUS } from '../../src/scoring/masters';

describe('masters scoring engine', () => {
  it('MAG Pommel Horse, age 30: skills + EG + dismount bonus', () => {
    const state = init('mag-masters', 'PH');
    state.age = '30';
    state.counts.c = 2;
    state.counts.a = 4;
    // EG_LABELS.MAG.pommel has 3 entries (I, II, III); check I and II.
    state.egs[0] = true;
    state.egs[1] = true;
    state.dismountLevel = 'b';
    state.deductions = '1.0';

    const out = compute(state, 'mag-masters', 'PH');

    // skills: 2*0.6 (C) + 4*0.2 (A) = 1.2 + 0.8 = 2.0
    // EG bonus: 2 * 0.5 = 1.0
    // dismount bonus (non-floor MAG apparatus): age-30 B value = 0.4
    // D = 2.0 + 1.0 + 0.4 = 3.4
    expect(out.d).toBe(3.4);
    // deductions = 1.0 -> E = 10 - 1.0 = 9.0
    expect(out.e).toBe(9.0);
    expect(out.final).toBe(12.4);
    expect(out.produces).toBe('full');
  });

  it('Masters vault: D = base fig + age bonus, E = 10 - vaultDeductions', () => {
    const state = init('mag-masters', 'VT');
    state.age = '30';

    // MAG VAULT_DATA[7] = 'Front handspring', fig 1.2
    const vaultIndex = 7;
    const vault = VAULT_DATA[state.discipline][vaultIndex];
    expect(vault).not.toBeNull();
    expect(vault?.fig).toBe(1.2);

    state.vaultIndex = vaultIndex;
    state.vaultDeductions = '0.5';

    const out = compute(state, 'mag-masters', 'VT');

    const ageBonus = VAULT_AGE_BONUS[state.discipline][state.age];
    expect(ageBonus).toBe(0.8);

    // D = base fig (1.2) + age bonus (0.8) = 2.0
    expect(out.d).toBeCloseTo(1.2 + ageBonus, 3);
    expect(out.d).toBeCloseTo(2.0, 3);
    // E = 10 - 0.5 = 9.5
    expect(out.e).toBeCloseTo(9.5, 3);
    expect(out.final).toBeCloseTo(11.5, 3);
    expect(out.produces).toBe('full');
  });

  it('returns numeric d/e/final for a default state', () => {
    const state = init('mag-masters', 'FX');
    const out = compute(state, 'mag-masters', 'FX');
    expect(out.produces).toBe('full');
    expect(typeof out.d).toBe('number');
    expect(typeof out.e).toBe('number');
    expect(typeof out.final).toBe('number');
  });
});
