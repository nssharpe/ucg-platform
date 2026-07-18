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

/** The `amr` claim's method strings from a JWT's payload segment ([] when
 *  the token is malformed / the claim is absent or not an array). GoTrue
 *  writes entries like {method: 'password'|'passkey'|'totp'|…, timestamp}.
 *  Never throws. */
export function jwtAmrMethods(token: string): string[] {
  const parts = token.split('.');
  if (parts.length !== 3) return [];
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
    const payload: unknown = JSON.parse(atob(padded));
    const amr = (payload as { amr?: unknown } | null)?.amr;
    if (!Array.isArray(amr)) return [];
    return amr
      .map((e) => (e as { method?: unknown } | null)?.method)
      .filter((m): m is string => typeof m === 'string');
  } catch {
    return [];
  }
}

/** Phase-B conditional rule, mirroring the hardened `is_admin()` migration
 *  (20260717140238 + the 20260718 passkey amendment): a caller WITH a
 *  verified MFA factor must present an exactly-'aal2' JWT — UNLESS the
 *  session was established via passkey sign-in (amr contains 'passkey'; a
 *  passkey is already possession + user-verification, decided 2026-07-18).
 *  A caller with no verified factor is unaffected. Fail-closed: a
 *  missing/unparseable aal (null) with a verified factor present and no
 *  passkey amr is DENIED. Keep in lockstep with needsMfaStepUp
 *  (src/lib/mfa-core.ts) and is_admin() — all three layers must agree. */
export function callerAalSatisfies(
  aal: string | null,
  hasVerifiedFactor: boolean,
  amrMethods: readonly string[] = [],
): boolean {
  return !hasVerifiedFactor || aal === 'aal2' || amrMethods.includes('passkey');
}
