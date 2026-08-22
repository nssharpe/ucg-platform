import { describe, it, expect } from 'vitest';
import { shouldConflict } from '../src/lib/scores-core';

describe('shouldConflict', () => {
  it('conflicts when a row exists but the caller expected none (the two-judges case)', () => {
    expect(shouldConflict('2026-08-22T10:00:00Z', null)).toBe(true);
    expect(shouldConflict('2026-08-22T10:00:00Z', undefined)).toBe(true);
  });

  it('is ok when the expected timestamp matches the existing row exactly', () => {
    expect(shouldConflict('2026-08-22T10:00:00Z', '2026-08-22T10:00:00Z')).toBe(false);
  });

  it('conflicts when the expected timestamp differs from the existing row', () => {
    expect(shouldConflict('2026-08-22T10:00:00Z', '2026-08-22T09:00:00Z')).toBe(true);
  });

  it('is ok when there is no existing row at all, regardless of what was expected', () => {
    expect(shouldConflict(null, null)).toBe(false);
    expect(shouldConflict(undefined, '2026-08-22T10:00:00Z')).toBe(false);
    expect(shouldConflict(null, undefined)).toBe(false);
  });
});
