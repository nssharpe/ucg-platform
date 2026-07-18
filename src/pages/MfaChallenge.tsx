// Sign-in step-up interstitial: rendered by App.tsx (outside the router, like
// the existing initial-paint auth-flash gate) whenever the live session is at
// aal1 but a verified factor makes aal2 available (`needsMfaStepUp`,
// src/lib/mfa-core.ts). Blocks ALL protected UI until the second factor is
// verified — a seeded dev/E2E user with no factors never reaches this (their
// nextLevel stays 'aal1', so needsMfaStepUp is false for them).
//
// Only TOTP is a real MFA factor here — WebAuthn-as-MFA-factor (the paid
// "Advanced MFA - WebAuthn" add-on) was never enabled server-side, so no
// account could ever have a verified webauthn factor to challenge. Passkey
// SIGN-IN (Gate.tsx) is a separate, free feature and yields an aal1 session —
// a TOTP-enrolled user still lands here after a passkey sign-in, which is the
// intended step-up behavior, not a bug.
import { useEffect, useState } from 'react';
import type { Factor } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { refreshAal } from '../lib/auth';
import primaryLogoWhite from '../assets/brand/primary-logo-white.svg';

export function MfaChallenge() {
  const [factors, setFactors] = useState<Factor[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!supabase) return;
      const { data, error } = await supabase.auth.mfa.listFactors();
      if (cancelled) return;
      if (error) { setLoadErr(error.message); return; }
      setFactors(data.all.filter((f) => f.status === 'verified'));
    })();
    return () => { cancelled = true; };
  }, []);

  if (!supabase) return null;

  const totpFactor = (factors ?? []).find((f) => f.factor_type === 'totp');

  const verifyTotp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!supabase || !totpFactor) return;
    setBusy(true);
    setErr(null);
    const { data: challenge, error: challengeErr } = await supabase.auth.mfa.challenge({ factorId: totpFactor.id });
    if (challengeErr || !challenge) {
      setBusy(false);
      setErr(challengeErr?.message ?? 'Could not start verification.');
      return;
    }
    const { error: verifyErr } = await supabase.auth.mfa.verify({
      factorId: totpFactor.id,
      challengeId: challenge.id,
      code: code.trim(),
    });
    setBusy(false);
    if (verifyErr) { setErr('Incorrect code — try again.'); setCode(''); return; }
    await refreshAal();
  };

  const signOut = async () => {
    if (!supabase) return;
    await supabase.auth.signOut();
  };

  return (
    <div className="gate">
      <div className="gate-card">
        <img src={primaryLogoWhite} alt="United Club Gymnastics" className="gate-logo" />
        <div className="gate-tag">Verify it's you</div>
        {loadErr ? (
          <div className="gate-err">{loadErr}</div>
        ) : !factors ? (
          <p className="gate-note">Loading…</p>
        ) : totpFactor ? (
          <form onSubmit={verifyTotp}>
            <p className="gate-note" style={{ marginBottom: 12, textAlign: 'left' }}>
              Enter the 6-digit code from your authenticator app.
            </p>
            <input
              type="text"
              inputMode="numeric"
              placeholder="6-DIGIT CODE"
              value={code}
              autoFocus
              onChange={(e) => { setCode(e.target.value.replace(/\D/g, '').slice(0, 6)); setErr(null); }}
            />
            <button className="btn primary" disabled={busy || code.length !== 6} style={{ marginTop: 10 }}>
              {busy ? 'Verifying…' : 'Verify →'}
            </button>
            {err && <div className="gate-err">{err}</div>}
          </form>
        ) : (
          <p className="gate-err">No verified factor found — contact a league admin.</p>
        )}
        <button
          type="button"
          className="btn ghost"
          style={{ width: '100%', justifyContent: 'center', marginTop: 16, color: 'var(--ice-200)', border: '1px solid rgba(219, 235, 237, 0.35)', background: 'transparent' }}
          onClick={signOut}
        >
          Sign out
        </button>
        <div className="gate-note">United Club Gymnastics · Registration &amp; Scoring Platform</div>
      </div>
    </div>
  );
}
