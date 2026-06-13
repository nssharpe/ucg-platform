import { describe, it, expect } from 'vitest';
import { init, compute, tntLevel, tntEvent } from '../../src/scoring/tnt';

describe('tnt scoring engine', () => {
  it('TR Intermediate: a skill DD exceeding the level max warns and final = DD + exec', () => {
    const state = init('tnt-int', 'TR');

    // init() gives one pass with 10 skill slots and exec default '10.0'.
    expect(state.passes).toHaveLength(1);
    expect(state.passes[0]?.skills).toHaveLength(10);
    expect(state.passes[0]?.exec).toBe('10.0');

    // Intermediate Flyers TR maxSkill is 0.8 — this exceeds it.
    state.passes[0]!.skills[0]!.dd = '1.0';

    const out = compute(state, 'tnt-int', 'TR');

    expect(out.warnings.some((w) => w.includes('exceeds') && w.includes('Intermediate Flyers'))).toBe(true);

    expect(out.d).toBe(1.0);
    expect(out.e).toBe(10.0);
    expect(out.final).toBe(11.0);
    expect(out.produces).toBe('full');
  });

  it('TR Intermediate: a CJP penalty of 0.2 reduces final accordingly', () => {
    const state = init('tnt-int', 'TR');
    state.passes[0]!.skills[0]!.dd = '1.0';
    state.penalty = '0.2';

    const out = compute(state, 'tnt-int', 'TR');

    expect(out.d).toBe(1.0);
    expect(out.e).toBe(10.0);
    expect(out.final).toBe(10.8);
  });

  it('exposes structural helpers: produces, tntEvent, tntLevel', () => {
    const state = init('tnt-int', 'TR');
    const out = compute(state, 'tnt-int', 'TR');

    expect(out.produces).toBe('full');
    expect(tntEvent('DM')).toBe('DM');
    expect(tntLevel('tnt-high')).toBe('High Flyers');
  });
});
