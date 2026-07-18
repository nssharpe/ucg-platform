// Pure passkey (passwordless sign-in) helpers — no React, no Supabase
// imports, mirroring mfa-core.ts so this stays testable in plain Node.
// Passkeys here means Supabase's free "Passkeys" sign-in feature
// (auth.signInWithPasskey / auth.registerPasskey / auth.passkey.*), NOT the
// paid "Advanced MFA - WebAuthn" factor (see docs/CLAUDE.md Auth patterns).

/** A cancelled/dismissed WebAuthn ceremony surfaces as a browser `AbortError`
 *  or `NotAllowedError` (see @supabase/auth-js's identifyRegistrationError /
 *  identifyAuthenticationError, which pass these through largely unchanged).
 *  Map those to a calm, expected-outcome message instead of the raw browser
 *  text — cancelling is normal, not a crash. */
export function passkeySignInErrorMessage(error: { name?: string; message?: string } | null | undefined): string {
  if (!error) return 'Passkey sign-in failed.';
  if (error.name === 'AbortError' || error.name === 'NotAllowedError') {
    return 'Passkey sign-in was cancelled.';
  }
  return error.message || 'Passkey sign-in failed.';
}

/** Same cancellation mapping for the Profile "Add a passkey" registration
 *  ceremony, worded for that context. */
export function passkeyRegisterErrorMessage(error: { name?: string; message?: string } | null | undefined): string {
  if (!error) return 'Could not add a passkey.';
  if (error.name === 'AbortError' || error.name === 'NotAllowedError') {
    return 'Passkey setup was cancelled.';
  }
  return error.message || 'Could not add a passkey.';
}

/** Default friendly name offered when registering a new passkey — good
 *  enough without trying to sniff browser/OS; the user can rename it. */
export function defaultPasskeyFriendlyName(now: Date = new Date()): string {
  return `Passkey ${now.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}`;
}
