import { describe, it, expect } from 'vitest';
import { resolveSetPasswordFlavor } from '../../src/lib/set-password-core';

describe('resolveSetPasswordFlavor (UAT round 2 A-06-02)', () => {
  it('reset marker with no event resolves to reset', () => {
    expect(resolveSetPasswordFlavor('reset', false)).toBe('reset');
  });

  it('invite marker with no event resolves to invite', () => {
    expect(resolveSetPasswordFlavor('invite', false)).toBe('invite');
  });

  it('legacy marker (old bare ?setpw=1) resolves to invite', () => {
    expect(resolveSetPasswordFlavor('legacy', false)).toBe('invite');
  });

  it('no marker and no event defaults to reset (the safe default)', () => {
    expect(resolveSetPasswordFlavor(null, false)).toBe('reset');
  });

  it('PASSWORD_RECOVERY event resolves to reset when no marker survived', () => {
    expect(resolveSetPasswordFlavor(null, true)).toBe('reset');
  });

  it('an explicit invite marker wins over a PASSWORD_RECOVERY event — the event must never override the marker', () => {
    // invite-account falls back to a RECOVERY-type link (still marked
    // ?setpw=invite) when the invitee's auth user already exists, so a real
    // PASSWORD_RECOVERY event fires for a link that is legitimately an
    // invite. Overriding the marker here would send that person Home after
    // an email that told them they'd land on Membership.
    expect(resolveSetPasswordFlavor('invite', true)).toBe('invite');
  });

  it('an explicit legacy marker also wins over a PASSWORD_RECOVERY event', () => {
    expect(resolveSetPasswordFlavor('legacy', true)).toBe('invite');
  });

  it('an explicit reset marker is unaffected by the event either way', () => {
    expect(resolveSetPasswordFlavor('reset', true)).toBe('reset');
  });
});
