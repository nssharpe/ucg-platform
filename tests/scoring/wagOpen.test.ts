import { describe, it, expect } from 'vitest';
import { init, compute } from '../../src/scoring/wagOpen';

describe('wagOpen scoring engine', () => {
  it('FX: 8 skills with EG bonus, no short-routine deduction', () => {
    const state = init('wag-open', 'FX');
    state.counts.a = 2;
    state.counts.b = 4;
    state.counts.c = 2;
    state.egs[0] = true;
    state.egs[1] = true;
    state.deductions = '1.2';

    const out = compute(state, 'wag-open', 'FX');

    // skills: 2*0.1 + 4*0.3 + 2*0.5 = 0.2 + 1.2 + 1.0 = 2.4
    // EG bonus: 2 * 0.3 = 0.6
    // D = 2.4 + 0.6 = 3.0
    expect(out.d).toBe(3.0);
    // 8 skills >= 6, no short-routine deduction
    // E = 10 - 1.2 = 8.8
    expect(out.e).toBe(8.8);
    expect(out.final).toBe(11.8);
    expect(out.produces).toBe('full');
  });

  it('short routine: fewer than 6 skills incurs a 1.0-per-skill deduction', () => {
    const state = init('wag-open', 'UB');
    state.counts.a = 2; // only 2 skills total
    state.deductions = '0.5';

    const out = compute(state, 'wag-open', 'UB');

    // skills: 2 * 0.1 = 0.2, no EGs -> D = 0.2
    expect(out.d).toBeCloseTo(0.2, 3);
    // short deduction: (6 - 2) * 1.0 = 4.0
    // E = 10 - (typed deductions 0.5 + short 4.0) = 10 - 4.5 = 5.5
    expect(out.e).toBeCloseTo(10 - (0.5 + 4.0), 3);
    expect(out.e).toBeCloseTo(5.5, 3);
    expect(out.final).toBeCloseTo(out.d! + out.e!, 3);
    expect(out.produces).toBe('full');
  });

  it('returns numeric d/e/final for a default state', () => {
    const state = init('wag-open', 'BB');
    const out = compute(state, 'wag-open', 'BB');
    expect(out.produces).toBe('full');
    expect(typeof out.d).toBe('number');
    expect(typeof out.e).toBe('number');
    expect(typeof out.final).toBe('number');
  });
});
