// Dismissible-but-recurring nag banner on /admin/* pages for admin-role users
// who have no verified MFA factor yet (auth-hardening Phase B, item 3).
// "Recurring" = the dismissal is per-tab-session (sessionStorage), so it comes
// back next time they open the app rather than being silenced forever.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useCapabilities } from '../lib/capabilities';
import { supabase } from '../lib/supabase';

const DISMISS_KEY = 'ucg-mfa-nag-dismissed';

export function AdminMfaNag() {
  const caps = useCapabilities();
  const [dismissed, setDismissed] = useState(() => {
    try { return sessionStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; }
  });
  const [hasFactor, setHasFactor] = useState<boolean | null>(null);

  useEffect(() => {
    if (!caps.isAdmin || !supabase) return;
    let cancelled = false;
    supabase.auth.mfa.listFactors().then(({ data, error }) => {
      if (cancelled || error) return;
      // Only TOTP can ever be a verified factor here — WebAuthn-as-MFA-factor
      // (the paid add-on) was never enabled server-side.
      setHasFactor(data.totp.length > 0);
    });
    return () => { cancelled = true; };
  }, [caps.isAdmin]);

  if (!caps.isAdmin || dismissed || hasFactor !== false) return null;

  const dismiss = () => {
    try { sessionStorage.setItem(DISMISS_KEY, '1'); } catch { /* storage unavailable */ }
    setDismissed(true);
  };

  return (
    // `.badge.err` (coral), not `.warn` (gold) — kept deliberately: this is an
    // urgency/error nag, not a mild warning, so the coral-500/navy-800 pairing
    // (~4.8:1, AA-pass for this sentence-length body text) is the right tone
    // even though gold/navy-800 (~8.8:1, 2026-07-19 rebrand) now has higher
    // contrast than coral does.
    <div
      className="badge err"
      // whiteSpace overrides .badge's nowrap — the sentence must wrap on phones
      // instead of stretching the page sideways.
      style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', borderRadius: 6, marginBottom: 16, whiteSpace: 'normal' }}
    >
      <span style={{ flex: 1 }}>
        League admin accounts must enable two-factor authentication —{' '}
        <Link to="/me" style={{ color: 'inherit', textDecoration: 'underline', fontWeight: 600 }}>
          set it up in your Profile
        </Link>.
      </span>
      <button
        className="btn ghost small"
        style={{ color: 'inherit', border: '1px solid currentColor' }}
        onClick={dismiss}
        aria-label="Dismiss"
      >
        Dismiss
      </button>
    </div>
  );
}
