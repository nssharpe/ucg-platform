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

describe('hasPasskeySatisfaction (UAT A-11-03: session AMR only)', () => {
  it('false when the session did not authenticate with a passkey', () => {
    expect(hasPasskeySatisfaction(['password'])).toBe(false);
    expect(hasPasskeySatisfaction([])).toBe(false);
    expect(hasPasskeySatisfaction(null)).toBe(false);
    expect(hasPasskeySatisfaction(undefined)).toBe(false);
  });

  it('A-11-03 hole closed: a merely-enrolled passkey credential does NOT satisfy a password session', () => {
    // The S1 Julia found: enrolled passkey + password login = single factor.
    // Satisfaction is decided off the session amr, so an enrolled-but-unused
    // passkey on a password session is now correctly NOT satisfied.
    expect(hasPasskeySatisfaction(['password'])).toBe(false);
  });

  it('true when the session AMR is passkey', () => {
    expect(hasPasskeySatisfaction(['passkey'])).toBe(true);
    expect(hasPasskeySatisfaction(['password', 'passkey'])).toBe(true);
  });
});
