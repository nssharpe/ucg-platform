import { describe, it, expect } from 'vitest';
import { passkeySignInErrorMessage, passkeyRegisterErrorMessage, defaultPasskeyFriendlyName } from '../src/lib/passkey-core';

describe('passkeySignInErrorMessage', () => {
  it('maps a cancelled ceremony (AbortError) to a calm message', () => {
    expect(passkeySignInErrorMessage({ name: 'AbortError', message: 'Registration ceremony was sent an abort signal' }))
      .toBe('Passkey sign-in was cancelled.');
  });

  it('maps a dismissed ceremony (NotAllowedError) to a calm message', () => {
    expect(passkeySignInErrorMessage({ name: 'NotAllowedError', message: 'The operation either timed out or was not allowed.' }))
      .toBe('Passkey sign-in was cancelled.');
  });

  it('passes through other error messages unchanged', () => {
    expect(passkeySignInErrorMessage({ name: 'AuthApiError', message: 'No passkey found for this account.' }))
      .toBe('No passkey found for this account.');
  });

  it('falls back to a generic message when there is no error message', () => {
    expect(passkeySignInErrorMessage({ name: 'UnknownError' })).toBe('Passkey sign-in failed.');
    expect(passkeySignInErrorMessage(null)).toBe('Passkey sign-in failed.');
  });
});

describe('passkeyRegisterErrorMessage', () => {
  it('maps cancellation the same way, worded for registration', () => {
    expect(passkeyRegisterErrorMessage({ name: 'NotAllowedError', message: 'ignored' })).toBe('Passkey setup was cancelled.');
  });

  it('passes through a real error message', () => {
    expect(passkeyRegisterErrorMessage({ message: 'Passkey already registered.' })).toBe('Passkey already registered.');
  });

  it('falls back to a generic message', () => {
    expect(passkeyRegisterErrorMessage(null)).toBe('Could not add a passkey.');
  });
});

describe('defaultPasskeyFriendlyName', () => {
  it('formats a readable date-stamped default name', () => {
    const name = defaultPasskeyFriendlyName(new Date('2026-07-18T12:00:00Z'));
    expect(name).toMatch(/^Passkey /);
    expect(name).toContain('2026');
  });
});
