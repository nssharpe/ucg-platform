// Pure MFA/AAL decision logic — no React, no Supabase imports, so it's
// importable in a plain Node test environment (mirrors capabilities-core.ts).
// Feeds the App.tsx step-up interstitial and the Gate sign-in challenge.

export type AalLevel = 'aal1' | 'aal2' | null;

/** Supabase's own step-up signal: `nextLevel` is the level the account COULD
 *  reach (has a verified factor to challenge), `currentLevel` is what the
 *  active JWT actually carries. A user with no factors has
 *  currentLevel === nextLevel === 'aal1' — this returns false for them, so
 *  the seeded dev/E2E users (no factors) are never blocked. */
export function needsMfaStepUp(currentLevel: AalLevel, nextLevel: AalLevel): boolean {
  return currentLevel === 'aal1' && nextLevel === 'aal2';
}

/** Fixed friendly names so re-enrolling doesn't collide with an abandoned
 *  factor of the same type (Supabase 422s on a duplicate friendly_name per
 *  user) — callers should unenroll any stale unverified factor with the same
 *  name before enrolling a fresh one of that type. */
export const TOTP_FRIENDLY_NAME = 'Authenticator app';
export const PASSKEY_FRIENDLY_NAME = 'Passkey';
