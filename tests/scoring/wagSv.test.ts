import { describe, it, expect } from 'vitest';
import { init, compute, wagSvLevel, vpParts, LEVELS, vaultsFor } from '../../src/scoring/wagSv';

describe('wagSv scoring engine', () => {
  it('Silver vault (vaultIndex 0) returns the Xcel Silver vault table value', () => {
    const level = wagSvLevel('wag-silver');
    expect(level).toBe('Silver');

    const vaults = vaultsFor(level);
    expect(vaults[0]?.[1]).toBe(10.0);

    const state = init('wag-silver', 'VT');
    state.vaultIndex = 0;

    const out = compute(state, 'wag-silver', 'VT');

    expect(out.produces).toBe('d');
    expect(out.d).toBe(10.0);
    expect(out.e).toBeNull();
    expect(out.final).toBeNull();
  });

  it('Silver UB: one missed SR (-0.5) and no dismount (-0.3) -> d = 9.2', () => {
    const level = wagSvLevel('wag-silver');
    const req = LEVELS[level].req;

    const state = init('wag-silver', 'UB');
    // Satisfy the A value-part requirement so missingVP === 0.
    state.vp = { A: req.A, B: req.B, C: req.C };
    // Uncheck one special requirement -> -0.5.
    state.sr[1] = false;
    // No dismount -> -0.3.
    state.noDismount = true;

    const out = compute(state, 'wag-silver', 'UB');

    expect(out.produces).toBe('d');
    expect(out.d).toBe(9.2);
    expect(out.e).toBeNull();
    expect(out.final).toBeNull();
  });

  it('Level 9 UB: all VP/SR requirements met + 0.2 bonus -> d = 9.90', () => {
    const level = wagSvLevel('wag-l9');
    expect(level).toBe('Level 9');
    const req = LEVELS[level].req;

    const state = init('wag-l9', 'UB');
    // Satisfy A/B/C value-part requirements so missingVP === 0.
    state.vp = { A: req.A, B: req.B, C: req.C };
    // All SRs already default to true (met).
    expect(state.sr.every((ok) => ok)).toBe(true);
    // D-E / CV bonus, within bonusMax (0.30).
    state.bonus = 0.2;

    const out = compute(state, 'wag-l9', 'UB');

    expect(out.produces).toBe('d');
    expect(out.d).toBe(9.90);
    expect(out.e).toBeNull();
    expect(out.final).toBeNull();
  });

  it('vpParts shows A/B for Silver (no C requirement) and A/B/C for Level 9', () => {
    expect(vpParts('Silver')).toEqual(['A', 'B']);
    expect(vpParts('Level 9')).toEqual(['A', 'B', 'C']);
  });
});
