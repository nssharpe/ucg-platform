// The installed @supabase/supabase-js (2.108.1, via @supabase/auth-js 2.108.1)
// implements `supabase.auth.mfa.webauthn.{register,authenticate}` at runtime
// (GoTrueClient.js's constructor sets `this.mfa = { ..., webauthn: new
// WebAuthnApi(this) }`, and `mfa.enroll({ factorType: 'webauthn' })` is fully
// typed) — but the shipped `GoTrueMFAApi` type does NOT declare the
// `webauthn` property (it's marked @experimental in the SDK's own JSDoc and
// evidently held back from the public type surface a version ahead of the
// implementation; confirmed by reading GoTrueClient.js directly, not just
// the .d.ts). This thin, narrowly-typed accessor is the one place that
// bridges the gap so callers elsewhere don't need their own `as unknown as`
// casts. Re-check on every @supabase/supabase-js upgrade whether `webauthn`
// has been added to the public types — if so, delete this file and call
// `supabase.auth.mfa.webauthn` directly.
import type { SupabaseClient } from '@supabase/supabase-js';

export interface WebauthnMfaApi {
  /** Full enroll → browser credential-create → verify ceremony for a new
   *  passkey factor. Resolves with an error (not a throw) if the browser
   *  doesn't support WebAuthn or the ceremony is cancelled/fails. */
  register(params: { friendlyName: string }): Promise<{ data: unknown; error: { message: string } | null }>;
  /** Full challenge → browser credential-get → verify ceremony against an
   *  existing verified passkey factor. */
  authenticate(params: { factorId: string }): Promise<{ data: unknown; error: { message: string } | null }>;
}

export function getWebauthnApi(client: SupabaseClient): WebauthnMfaApi | null {
  const api = (client.auth.mfa as unknown as { webauthn?: WebauthnMfaApi }).webauthn;
  return api ?? null;
}
