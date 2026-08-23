// React/Supabase-facing MFA helpers — split from mfa-core.ts (which stays
// pure/no-I/O so its decision logic is directly unit-testable).
import { useEffect, useState } from 'react';
import { useAal } from './auth';
import { useCapabilities } from './capabilities';
import { supabase } from './supabase';
import { PASSKEY_AMR_METHOD, adminMfaGate } from './mfa-core';

/**
 * Reactive: does the signed-in admin satisfy the admin-PAGES MFA hard gate
 * (UAT A-11-01)? `RequireAdmin` (App.tsx) renders a full-page "set up
 * two-factor authentication" panel whenever this is `false`.
 *
 * - `true`  → not an admin (n/a), OR an admin with a verified TOTP factor,
 *             OR signed in via passkey this session (see `adminMfaGate` /
 *             `PASSKEY_AMR_METHOD` in mfa-core.ts — the exact exemption
 *             `needsMfaStepUp` uses for the TOTP step-up interstitial; this
 *             hook consumes it, it does not reimplement it).
 * - `false` → an admin with neither.
 * - `null`  → still resolving the factor list — callers should show a
 *             loader, not the block panel, so a page refresh doesn't flash
 *             "set up MFA" at an already-enrolled admin.
 */
export function useAdminMfaSatisfied(): boolean | null {
  const caps = useCapabilities();
  const aal = useAal();
  const [hasTotp, setHasTotp] = useState<boolean | null>(null);

  useEffect(() => {
    if (!caps.isAdmin || !supabase) return;
    let cancelled = false;
    supabase.auth.mfa.listFactors().then(({ data, error }) => {
      if (cancelled) return;
      // data.totp already excludes unverified factors — auth-js's
      // _listFactors only buckets a factor into data[factor_type] when
      // factor.status === 'verified' (verified against the installed
      // @supabase/auth-js source), matching is_admin()'s aal2 requirement of
      // a VERIFIED factor. On error, resolve to "not satisfied" rather than
      // hanging on a loader forever — the block panel is escapable (links to
      // /me and Home); an indefinite spinner on every admin page is not.
      setHasTotp(error ? false : data.totp.length > 0);
    });
    return () => { cancelled = true; };
  }, [caps.isAdmin]);

  if (!caps.isAdmin) return true;
  if (hasTotp === null) return null;
  const hasPasskey = aal.methods.includes(PASSKEY_AMR_METHOD);
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
