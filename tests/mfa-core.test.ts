import { describe, it, expect } from 'vitest';
import { needsMfaStepUp } from '../src/lib/mfa-core';

describe('needsMfaStepUp', () => {
  it('requires step-up when current is aal1 and next is aal2', () => {
    expect(needsMfaStepUp('aal1', 'aal2')).toBe(true);
  });

  it('does not require step-up for a no-factor user (aal1/aal1)', () => {
    expect(needsMfaStepUp('aal1', 'aal1')).toBe(false);
  });

  it('does not require step-up once already at aal2', () => {
    expect(needsMfaStepUp('aal2', 'aal2')).toBe(false);
  });

  it('is false when levels are not yet known (null)', () => {
    expect(needsMfaStepUp(null, null)).toBe(false);
    expect(needsMfaStepUp(null, 'aal2')).toBe(false);
  });
});
