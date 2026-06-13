import { describe, it, expect } from 'vitest';
import { round3 } from '../src/scoring/types';

describe('test harness', () => {
  it('runs and imports app source', () => {
    expect(round3(0.1 + 0.2)).toBe(0.3);
  });
});
