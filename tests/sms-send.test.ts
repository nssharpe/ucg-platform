import { describe, it, expect } from 'vitest';
import { estimateSmsCost, partitionByConsent, SMS_COST_PER_SEGMENT_USD } from '../src/lib/sms-send';

describe('estimateSmsCost', () => {
  it('is zero when there are no segments or no recipients', () => {
    expect(estimateSmsCost(0, 100)).toBe(0);
    expect(estimateSmsCost(2, 0)).toBe(0);
  });
  it('multiplies segments × recipients × the per-segment rate', () => {
    expect(estimateSmsCost(1, 1)).toBe(SMS_COST_PER_SEGMENT_USD);
    expect(estimateSmsCost(3, 200)).toBeCloseTo(3 * 200 * SMS_COST_PER_SEGMENT_USD, 6);
  });
  it('rounds to 4 decimal places to avoid floating-point noise', () => {
    const v = estimateSmsCost(2, 7);
    expect(v).toBe(Math.round(2 * 7 * SMS_COST_PER_SEGMENT_USD * 10000) / 10000);
  });
});

describe('partitionByConsent', () => {
  it('splits consented recipients from non-consented', () => {
    const rows = [
      { name: 'A', smsConsent: true },
      { name: 'B', smsConsent: false },
      { name: 'C' }, // undefined consent
    ];
    const { eligible, excluded } = partitionByConsent(rows);
    expect(eligible.map((r) => r.name)).toEqual(['A']);
    expect(excluded.map((r) => r.name)).toEqual(['B', 'C']);
  });
  it('treats only strict true as consent (undefined is not consent)', () => {
    const { eligible } = partitionByConsent([{ smsConsent: true }, { smsConsent: undefined }]);
    expect(eligible).toHaveLength(1);
  });
  it('returns empty arrays for empty input', () => {
    expect(partitionByConsent([])).toEqual({ eligible: [], excluded: [] });
  });
});
