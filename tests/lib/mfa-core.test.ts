import { describe, it, expect } from 'vitest';
import { adminMfaGate } from '../../src/lib/mfa-core';

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
