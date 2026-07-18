import { describe, it, expect } from 'vitest';
import { jwtAalClaim, jwtAmrMethods, callerAalSatisfies } from '../supabase/functions/_shared/jwt-aal';

/** Build a fake (unsigned) JWT with the given payload object. */
function fakeJwt(payload: unknown): string {
  const b64url = (s: string) =>
    Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64url('{"alg":"HS256"}')}.${b64url(JSON.stringify(payload))}.sig`;
}

describe('jwtAalClaim', () => {
  it('reads aal2 off a well-formed token', () => {
    expect(jwtAalClaim(fakeJwt({ sub: 'u1', aal: 'aal2' }))).toBe('aal2');
  });

  it('reads aal1 off a well-formed token', () => {
    expect(jwtAalClaim(fakeJwt({ aal: 'aal1' }))).toBe('aal1');
  });

  it('returns null when the claim is absent', () => {
    expect(jwtAalClaim(fakeJwt({ sub: 'u1' }))).toBeNull();
  });

  it('returns null when the claim is not a string', () => {
    expect(jwtAalClaim(fakeJwt({ aal: 2 }))).toBeNull();
  });

  it('returns null for a malformed token (not 3 segments)', () => {
    expect(jwtAalClaim('not-a-jwt')).toBeNull();
    expect(jwtAalClaim('a.b')).toBeNull();
    expect(jwtAalClaim('')).toBeNull();
  });

  it('returns null for a token whose payload is not valid base64/JSON', () => {
    expect(jwtAalClaim('aaa.!!!!.bbb')).toBeNull();
  });

  it('handles base64url payloads that need padding', () => {
    // Payload length chosen so the base64url form is not a multiple of 4.
    expect(jwtAalClaim(fakeJwt({ aal: 'aal2', x: 'y' }))).toBe('aal2');
  });
});

describe('callerAalSatisfies (Phase-B conditional rule)', () => {
  it('no verified factor → any aal (even null) passes', () => {
    expect(callerAalSatisfies(null, false)).toBe(true);
    expect(callerAalSatisfies('aal1', false)).toBe(true);
    expect(callerAalSatisfies('aal2', false)).toBe(true);
  });

  it('verified factor + aal2 passes', () => {
    expect(callerAalSatisfies('aal2', true)).toBe(true);
  });

  it('verified factor + aal1 is denied (the stolen-aal1-JWT attack)', () => {
    expect(callerAalSatisfies('aal1', true)).toBe(false);
  });

  it('verified factor + missing/unparseable aal is denied (fail closed)', () => {
    expect(callerAalSatisfies(null, true)).toBe(false);
  });

  it('verified factor + aal1 passes when the session has a passkey amr (2026-07-18 exemption)', () => {
    expect(callerAalSatisfies('aal1', true, ['passkey'])).toBe(true);
    expect(callerAalSatisfies(null, true, ['passkey', 'token_refresh'])).toBe(true);
  });

  it('non-passkey amr methods do not exempt', () => {
    expect(callerAalSatisfies('aal1', true, ['password'])).toBe(false);
    expect(callerAalSatisfies('aal1', true, ['mfa/webauthn'])).toBe(false);
  });
});

describe('jwtAmrMethods', () => {
  it('reads method strings off a well-formed amr claim', () => {
    expect(jwtAmrMethods(fakeJwt({ amr: [{ method: 'password', timestamp: 1 }, { method: 'passkey', timestamp: 2 }] })))
      .toEqual(['password', 'passkey']);
  });

  it('returns [] when amr is absent, not an array, or entries are malformed', () => {
    expect(jwtAmrMethods(fakeJwt({ sub: 'u1' }))).toEqual([]);
    expect(jwtAmrMethods(fakeJwt({ amr: 'passkey' }))).toEqual([]);
    expect(jwtAmrMethods(fakeJwt({ amr: [{ nope: true }, null, { method: 42 }] }))).toEqual([]);
  });

  it('returns [] for a malformed token', () => {
    expect(jwtAmrMethods('not-a-jwt')).toEqual([]);
    expect(jwtAmrMethods('aaa.!!!!.bbb')).toEqual([]);
  });
});
