import { describe, it, expect } from 'vitest';
import { shouldSendInviteOnCreate } from '../../src/lib/person-form-core';

describe('shouldSendInviteOnCreate (UAT A-07-01 "+ New Person" optional invite)', () => {
  it('sends when new, checked, and email present', () => {
    expect(shouldSendInviteOnCreate({ isNew: true, email: 'a@b.com', checked: true })).toBe(true);
  });

  it('does not send when unchecked', () => {
    expect(shouldSendInviteOnCreate({ isNew: true, email: 'a@b.com', checked: false })).toBe(false);
  });

  it('does not send without an email, even if checked', () => {
    expect(shouldSendInviteOnCreate({ isNew: true, email: '', checked: true })).toBe(false);
  });

  it('does not send on an edit, even if checked with an email', () => {
    expect(shouldSendInviteOnCreate({ isNew: false, email: 'a@b.com', checked: true })).toBe(false);
  });

  it('treats a whitespace-only email as absent', () => {
    expect(shouldSendInviteOnCreate({ isNew: true, email: '   ', checked: true })).toBe(false);
  });
});
