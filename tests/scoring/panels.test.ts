import { describe, it, expect } from 'vitest';
import { combinePanels } from '../../src/scoring/panels';

describe('combinePanels (two-judge-panel averaging, PM decision 2026-07-19)', () => {
  it('averages deductions when both panels have a value', () => {
    expect(combinePanels({ deductions: 0.5, deductions2: 0.7 }).deductions).toBeCloseTo(0.6, 5);
  });

  it('averages eScore when both panels have a value', () => {
    expect(combinePanels({ eScore: 8.6, eScore2: 8.9 }).eScore).toBeCloseTo(8.75, 5);
  });

  it('rounds the average to 3 decimals, killing float noise', () => {
    // 0.1 + 0.2 = 0.30000000000000004 in float; /2 = 0.150000000000000...02
    expect(combinePanels({ deductions: 0.1, deductions2: 0.2 }).deductions).toBe(0.15);
  });

  it('passes a lone value through unchanged when only one panel has entered (score in progress)', () => {
    expect(combinePanels({ deductions: 0.5, deductions2: null }).deductions).toBe(0.5);
    expect(combinePanels({ deductions: null, deductions2: 0.7 }).deductions).toBe(0.7);
    expect(combinePanels({ eScore: 8.6 }).eScore).toBe(8.6);
  });

  it('returns null when neither panel has a value', () => {
    expect(combinePanels({}).deductions).toBeNull();
    expect(combinePanels({}).eScore).toBeNull();
  });

  it('treats undefined the same as null (fields may be absent, not just null)', () => {
    expect(combinePanels({ deductions: undefined, deductions2: undefined }).deductions).toBeNull();
  });

  it('deductions and eScore are combined independently', () => {
    const result = combinePanels({ deductions: 0.5, deductions2: 0.7, eScore: 8.6, eScore2: 8.9 });
    expect(result.deductions).toBeCloseTo(0.6, 5);
    expect(result.eScore).toBeCloseTo(8.75, 5);
  });

  it('sv is accepted but not part of the averaged result (informational only)', () => {
    const result = combinePanels({ sv: 5.0, deductions: 0.5, deductions2: 0.7 });
    expect(result).toEqual({ deductions: 0.6, eScore: null });
  });
});
