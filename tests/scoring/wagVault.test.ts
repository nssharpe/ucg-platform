import { describe, it, expect } from 'vitest';
import { init, compute, VAULT_DATA } from '../../src/scoring/wagVault';

describe('wagVault scoring engine', () => {
  it('Yurchenko tucked (fig 3.0) with deductions 0.5', () => {
    const idx = VAULT_DATA.findIndex((v) => v?.name === 'Yurchenko tucked');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(VAULT_DATA[idx]?.fig).toBe(3.0);

    const state = init('wag-vault', 'VT');
    state.vaultIndex = idx;
    state.deductions = '0.5';

    const out = compute(state, 'wag-vault', 'VT');

    expect(out.d).toBe(3.0);
    // E = 10 - 0.5 = 9.5
    expect(out.e).toBe(9.5);
    expect(out.final).toBe(12.5);
    expect(out.produces).toBe('full');
  });

  it('index 0 (first vault) with no deductions', () => {
    const state = init('wag-vault', 'VT');
    state.vaultIndex = 0;
    state.deductions = '0';

    const out = compute(state, 'wag-vault', 'VT');

    const expectedD = VAULT_DATA[0]?.fig ?? 0;
    expect(out.d).toBe(expectedD);
    // E = 10 - 0 = 10
    expect(out.e).toBe(10);
    expect(out.final).toBe(expectedD + 10);
    expect(out.produces).toBe('full');
  });

  it('returns numeric d/e/final for a default state', () => {
    const state = init('wag-vault', 'VT');
    const out = compute(state, 'wag-vault', 'VT');
    expect(out.produces).toBe('full');
    expect(typeof out.d).toBe('number');
    expect(typeof out.e).toBe('number');
    expect(typeof out.final).toBe('number');
  });
});
