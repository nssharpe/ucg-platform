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

  it('passkey sign-in is exempt even when a TOTP step-up is available', () => {
    expect(needsMfaStepUp('aal1', 'aal2', ['passkey'])).toBe(false);
    expect(needsMfaStepUp('aal1', 'aal2', ['passkey', 'token_refresh'])).toBe(false);
  });

  it('password sign-in amr does not exempt', () => {
    expect(needsMfaStepUp('aal1', 'aal2', ['password'])).toBe(true);
    expect(needsMfaStepUp('aal1', 'aal2', [])).toBe(true);
    expect(needsMfaStepUp('aal1', 'aal2', null)).toBe(true);
  });

  it('mfa/webauthn (the paid factor) is NOT treated as the passkey exemption', () => {
    expect(needsMfaStepUp('aal1', 'aal2', ['mfa/webauthn'])).toBe(true);
  });
});
