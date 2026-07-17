// _shared/jwt-aal.ts — pure helpers for reading the AAL (Authenticator
// Assurance Level) claim off an already-authenticated Supabase JWT, and for
// the Phase-B conditional rule ("an MFA-enrolled caller must present aal2").
//
// No signature verification here BY DESIGN: callers must only pass a token
// that `auth.getUser(token)` has already authenticated — this just reads a
// claim off that same, already-trusted token string. Runtime-agnostic
// (uses global `atob`, present in both Deno and Node ≥16) so vitest can
// import it directly (tests/jwt-aal.test.ts).

/** The `aal` claim from a JWT's payload segment, or null when the token is
 *  malformed / the claim is absent or non-string. Never throws. */
export function jwtAalClaim(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const payload: unknown = JSON.parse(atob(padded));
    const aal = (payload as { aal?: unknown } | null)?.aal;
    return typeof aal === 'string' ? aal : null;
  } catch {
    return null;
  }
}

/** Phase-B conditional rule, mirroring the hardened `is_admin()` migration
 *  (20260717140238): a caller WITH a verified MFA factor must present an
 *  exactly-'aal2' JWT; a caller with no verified factor is unaffected.
 *  Fail-closed: a missing/unparseable aal (null) with a verified factor
 *  present is DENIED. */
export function callerAalSatisfies(aal: string | null, hasVerifiedFactor: boolean): boolean {
  return !hasVerifiedFactor || aal === 'aal2';
}
