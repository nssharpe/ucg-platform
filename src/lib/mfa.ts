// React/Supabase-facing MFA helpers — split from mfa-core.ts (which stays
// pure/no-I/O so its decision logic is directly unit-testable).
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useAal } from './auth';
import { useCapabilities } from './capabilities';
import { supabase } from './supabase';
import { adminMfaGate, hasPasskeySatisfaction } from './mfa-core';

// Enrollment-change signal (UAT round 2 A-11-02): bumped whenever a TOTP
// factor or passkey credential is added/removed/verified anywhere in the app
// (ProfileMfa.tsx, ProfilePasskeys.tsx), so `useAdminMfaSatisfied` re-fetches
// the factor/passkey lists immediately instead of only picking up a change
// the next time it happens to remount (RequireAdmin only remounts it on
// navigating AWAY from and back to an admin route) or, worse, the next
// sign-out/sign-in. Mirrors the `useSyncExternalStore` idiom already used
// throughout auth.ts — no polling.
const enrollmentListeners = new Set<() => void>();
let enrollmentVersion = 0;
/** Call after any TOTP factor or passkey credential enroll/unenroll/verify so
 *  every mounted `useAdminMfaSatisfied` re-fetches immediately. */
export function notifyMfaEnrollmentChanged(): void {
  enrollmentVersion++;
  enrollmentListeners.forEach((l) => l());
}
function subscribeEnrollment(cb: () => void) {
  enrollmentListeners.add(cb);
  return () => enrollmentListeners.delete(cb);
}

/**
 * Reactive: does the signed-in admin satisfy the admin-PAGES MFA hard gate
 * (UAT A-11-01)? `RequireAdmin` (App.tsx) renders a full-page "set up
 * two-factor authentication" panel whenever this is `false`.
 *
 * - `true`  → not an admin (n/a), OR an admin with a verified TOTP factor,
 *             OR a satisfied passkey (see `hasPasskeySatisfaction` in
 *             mfa-core.ts — an enrolled passkey CREDENTIAL, checked
 *             independently of how the CURRENT session signed in, OR signed
 *             in via passkey this session; this hook consumes that pure
 *             function, it does not reimplement the check).
 * - `false` → an admin with neither.
 * - `null`  → still resolving the factor/passkey lists — callers should show
 *             a loader, not the block panel, so a page refresh doesn't flash
 *             "set up MFA" at an already-enrolled admin.
 */
export function useAdminMfaSatisfied(): boolean | null {
  const caps = useCapabilities();
  const aal = useAal();
  // Forces the effect below to re-run whenever enrollment changes anywhere in
  // the app, even though this component never unmounts/remounts for it.
  const enrollmentVersionSnapshot = useSyncExternalStore(subscribeEnrollment, () => enrollmentVersion, () => 0);
  const [hasTotp, setHasTotp] = useState<boolean | null>(null);
  const [hasPasskeyCredential, setHasPasskeyCredential] = useState<boolean | null>(null);

  useEffect(() => {
    if (!caps.isAdmin || !supabase) return;
    let cancelled = false;
    const client = supabase;
    Promise.all([client.auth.mfa.listFactors(), client.auth.passkey.list()]).then(([factorsRes, passkeysRes]) => {
      if (cancelled) return;
      // data.totp already excludes unverified factors — auth-js's
      // _listFactors only buckets a factor into data[factor_type] when
      // factor.status === 'verified' (verified against the installed
      // @supabase/auth-js source), matching is_admin()'s aal2 requirement of
      // a VERIFIED factor. On error, resolve to "not satisfied" rather than
      // hanging on a loader forever — the block panel is escapable (links to
      // /me and Home); an indefinite spinner on every admin page is not.
      setHasTotp(factorsRes.error ? false : factorsRes.data.totp.length > 0);
      setHasPasskeyCredential(passkeysRes.error ? false : (passkeysRes.data ?? []).length > 0);
    }).catch(() => {
      // Either call REJECTING (not resolving `{error}}`) must not leave both
      // states `null` forever — that would make this hook return `null`
      // forever too, and RequireAdmin's `null` case is "show the loader,"
      // not an escapable state. Resolve to "not satisfied" instead, same as
      // the { error } branches above.
      if (cancelled) return;
      setHasTotp(false);
      setHasPasskeyCredential(false);
    });
    return () => { cancelled = true; };
  }, [caps.isAdmin, enrollmentVersionSnapshot]);

  if (!caps.isAdmin) return true;
  if (hasTotp === null || hasPasskeyCredential === null) return null;
  const hasPasskey = hasPasskeySatisfaction(hasPasskeyCredential, aal.methods);
  return adminMfaGate({ isAdmin: true, hasTotp, hasPasskey }) === 'allow';
}

/** Legacy per-tab dismissal key from the old dismissable `AdminMfaNag`
 *  banner, removed in favor of the hard gate above (a dismissal that
 *  survives sign-out defeats the point of a gate). Cleared on sign-out so a
 *  leftover value from before this change can never suppress anything. */
const LEGACY_NAG_DISMISS_KEY = 'ucg-mfa-nag-dismissed';
export function clearLegacyMfaNagDismissal(): void {
  try { sessionStorage.removeItem(LEGACY_NAG_DISMISS_KEY); } catch { /* storage unavailable */ }
}
