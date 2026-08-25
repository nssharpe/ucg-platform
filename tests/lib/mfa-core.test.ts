import { describe, it, expect } from 'vitest';
import { adminMfaGate, hasPasskeySatisfaction } from '../../src/lib/mfa-core';

describe('adminMfaGate (UAT A-11-01 admin-pages MFA hard gate)', () => {
  it('allows a non-admin regardless of factors', () => {
    expect(adminMfaGate({ isAdmin: false, hasTotp: false, hasPasskey: false })).toBe('allow');
  });

  it('blocks an admin with no TOTP factor and no passkey session', () => {
    expect(adminMfaGate({ isAdmin: true, hasTotp: false, hasPasskey: false })).toBe('block');
  });

  it('allows an admin with a verified TOTP factor', () => {
    expect(adminMfaGate({ isAdmin: true, hasTotp: true, hasPasskey: false })).toBe('allow');
  });

  it('allows an admin signed in via passkey even with no TOTP factor', () => {
    expect(adminMfaGate({ isAdmin: true, hasTotp: false, hasPasskey: true })).toBe('allow');
  });
});

describe('hasPasskeySatisfaction (UAT round 2 A-11-02)', () => {
  it('false when neither an enrolled credential nor the session AMR is passkey', () => {
    expect(hasPasskeySatisfaction(false, ['password'])).toBe(false);
    expect(hasPasskeySatisfaction(false, [])).toBe(false);
    expect(hasPasskeySatisfaction(false, null)).toBe(false);
    expect(hasPasskeySatisfaction(false, undefined)).toBe(false);
  });

  it('true when a passkey credential is enrolled, regardless of session AMR', () => {
    // The core bug this fixes: enrolling a passkey mid-session (still signed
    // in via password) must satisfy the gate immediately, without waiting for
    // a sign-out/sign-in that would put 'passkey' in the session's AMR.
    expect(hasPasskeySatisfaction(true, ['password'])).toBe(true);
    expect(hasPasskeySatisfaction(true, [])).toBe(true);
    expect(hasPasskeySatisfaction(true, null)).toBe(true);
  });

  it('true when the session AMR is passkey, even with no enrolled credential known yet', () => {
    expect(hasPasskeySatisfaction(false, ['passkey'])).toBe(true);
  });

  it('true when both signals agree', () => {
    expect(hasPasskeySatisfaction(true, ['passkey'])).toBe(true);
  });
});
