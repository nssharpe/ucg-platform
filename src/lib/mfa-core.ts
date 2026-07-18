// Pure MFA/AAL decision logic — no React, no Supabase imports, so it's
// importable in a plain Node test environment (mirrors capabilities-core.ts).
// Feeds the App.tsx step-up interstitial and the Gate sign-in challenge.

export type AalLevel = 'aal1' | 'aal2' | null;

/** GoTrue's `amr` method string for a passkey SIGN-IN session (PasskeyLogin
 *  in supabase/auth internal/models/factor.go — verified against source
 *  2026-07-18). Distinct from 'mfa/webauthn' (the paid MFA factor, unused
 *  here). The amr claim is server-signed and only obtainable by completing a
 *  real passkey ceremony, so trusting it is equivalent to trusting `aal`. */
export const PASSKEY_AMR_METHOD = 'passkey';

/** Supabase's own step-up signal: `nextLevel` is the level the account COULD
 *  reach (has a verified factor to challenge), `currentLevel` is what the
 *  active JWT actually carries. A user with no factors has
 *  currentLevel === nextLevel === 'aal1' — this returns false for them, so
 *  the seeded dev/E2E users (no factors) are never blocked.
 *
 *  Passkey exemption (Nate, 2026-07-18): a session established via passkey
 *  sign-in (amr contains 'passkey') skips the TOTP step-up — a passkey is
 *  already possession + user-verification, so a second challenge is pure
 *  burden. GoTrue keeps such sessions at aal1, so this must be decided off
 *  the amr methods, NOT the level. Mirrored in is_admin() (migration
 *  20260718*) and the edge-function AAL guard (_shared/jwt-aal.ts) — all
 *  three layers must stay in agreement or passkey-signed-in enrolled admins
 *  get locked out of admin surfaces. */
export function needsMfaStepUp(
  currentLevel: AalLevel,
  nextLevel: AalLevel,
  authMethods?: readonly string[] | null,
): boolean {
  if (authMethods?.includes(PASSKEY_AMR_METHOD)) return false;
  return currentLevel === 'aal1' && nextLevel === 'aal2';
}

/** Fixed friendly names so re-enrolling doesn't collide with an abandoned
 *  factor of the same type (Supabase 422s on a duplicate friendly_name per
 *  user) — callers should unenroll any stale unverified factor with the same
 *  name before enrolling a fresh one of that type. */
export const TOTP_FRIENDLY_NAME = 'Authenticator app';
export const PASSKEY_FRIENDLY_NAME = 'Passkey';
