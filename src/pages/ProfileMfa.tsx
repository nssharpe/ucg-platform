// Two-factor authentication (TOTP) section for the self-service Profile
// page. Not shown in adminView — MFA factors belong to the signed-in auth
// session, not to an arbitrary person record an admin is editing (docs/
// research/2026-06-22-auth-2fa-passkeys.md Phase A/C). Passkey SIGN-IN lives
// in the separate ProfilePasskeys.tsx card — this file only ever dealt with
// WebAuthn as an MFA *factor* (the paid "Advanced MFA - WebAuthn" add-on,
// which Nate declined and which was never actually enabled server-side, so
// no account could ever have enrolled one — that UI is removed below).
import { useEffect, useState } from 'react';
import type { Factor } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { refreshAal } from '../lib/auth';
import { TOTP_FRIENDLY_NAME } from '../lib/mfa-core';
import { Modal } from '../components/ui';
import { useToast } from '../components/ui-hooks';

type TotpEnrollState = {
  factorId: string;
  qrCode: string; // data:image/svg+xml;... URI
  secret: string;
} | null;

export function MfaSection() {
  const toast = useToast();
  const [factors, setFactors] = useState<Factor[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [totpEnroll, setTotpEnroll] = useState<TotpEnrollState>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<Factor | null>(null);

  const loadFactors = async () => {
    if (!supabase) return;
    const { data, error } = await supabase.auth.mfa.listFactors();
    if (error) { setLoadErr(error.message); return; }
    setLoadErr(null);
    setFactors(data.all);
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!supabase) return;
      const { data, error } = await supabase.auth.mfa.listFactors();
      if (cancelled) return;
      if (error) { setLoadErr(error.message); return; }
      setLoadErr(null);
      setFactors(data.all);
    })();
    return () => { cancelled = true; };
  }, []);

  if (!supabase) return null;

  const verifiedFactors = (factors ?? []).filter((f) => f.status === 'verified');
  const unverifiedTotp = (factors ?? []).filter((f) => f.status === 'unverified' && f.factor_type === 'totp');

  const startTotpEnroll = async () => {
    if (!supabase) return;
    setBusy(true);
    // Supabase 422s on a duplicate friendly_name for the same user — clean up
    // any abandoned unverified TOTP factor from a prior enroll attempt first.
    for (const f of unverifiedTotp) {
      await supabase.auth.mfa.unenroll({ factorId: f.id });
    }
    const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: TOTP_FRIENDLY_NAME });
    setBusy(false);
    if (error || !data || data.type !== 'totp') {
      toast(error?.message ?? 'Could not start enrollment.', { variant: 'error' });
      await loadFactors();
      return;
    }
    setTotpEnroll({ factorId: data.id, qrCode: data.totp.qr_code, secret: data.totp.secret });
    setCode('');
  };

  const cancelTotpEnroll = async () => {
    if (!supabase || !totpEnroll) return;
    await supabase.auth.mfa.unenroll({ factorId: totpEnroll.factorId });
    setTotpEnroll(null);
    setCode('');
    await loadFactors();
  };

  const verifyTotp = async () => {
    if (!supabase || !totpEnroll) return;
    setBusy(true);
    const { data: challenge, error: challengeErr } = await supabase.auth.mfa.challenge({ factorId: totpEnroll.factorId });
    if (challengeErr || !challenge) {
      setBusy(false);
      toast(challengeErr?.message ?? 'Could not start verification.', { variant: 'error' });
      return;
    }
    const { error: verifyErr } = await supabase.auth.mfa.verify({
      factorId: totpEnroll.factorId,
      challengeId: challenge.id,
      code: code.trim(),
    });
    setBusy(false);
    if (verifyErr) {
      toast(`Incorrect code — try again. (${verifyErr.message})`, { variant: 'error' });
      return;
    }
    toast('Two-factor authentication is now on for your account.');
    setTotpEnroll(null);
    setCode('');
    await loadFactors();
    await refreshAal();
  };

  const removeFactor = async (f: Factor) => {
    if (!supabase) return;
    setBusy(true);
    const { error } = await supabase.auth.mfa.unenroll({ factorId: f.id });
    setBusy(false);
    setRemoveTarget(null);
    if (error) { toast(`Could not remove: ${error.message}`, { variant: 'error' }); return; }
    toast(`Removed "${f.friendly_name ?? f.factor_type}".`);
    await loadFactors();
    await refreshAal();
  };

  return (
    <div className="card card-pad" style={{ marginBottom: 16 }}>
      <h3 className="card-title">Two-factor authentication</h3>

      {loadErr && <p style={{ fontSize: 13, color: 'var(--coral-600)' }}>{loadErr}</p>}

      {verifiedFactors.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
          {verifiedFactors.map((f) => (
            <div key={f.id} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 13, fontWeight: 500 }}>
                📱 {f.friendly_name ?? f.factor_type}
              </span>
              <span style={{ fontSize: 12, color: 'var(--ink-soft)' }}>
                Added {new Date(f.created_at).toLocaleDateString()}
              </span>
              <button className="btn ghost small" disabled={busy} onClick={() => setRemoveTarget(f)}>Remove</button>
            </div>
          ))}
        </div>
      )}

      {verifiedFactors.length === 0 && (
        <p style={{ fontSize: 13.5, color: 'var(--ink-soft)', marginTop: 0 }}>
          Add a second step to sign-in with an authenticator app (Google Authenticator, Authy, 1Password, …).
        </p>
      )}

      {!totpEnroll ? (
        <button className="btn primary small" disabled={busy} onClick={startTotpEnroll}>
          {verifiedFactors.some((f) => f.factor_type === 'totp') ? 'Add another authenticator app' : 'Set up authenticator app'}
        </button>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 4 }}>
          <p style={{ fontSize: 13.5, margin: 0 }}>
            Scan this QR code with your authenticator app, or enter the secret manually, then enter the 6-digit code it shows.
          </p>
          <img src={totpEnroll.qrCode} alt="Scan with your authenticator app" style={{ width: 180, height: 180, alignSelf: 'flex-start' }} />
          <div>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-soft)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
              Manual entry secret
            </span>
            <p style={{ fontSize: 13, fontFamily: 'monospace', margin: '2px 0 0', wordBreak: 'break-all' }}>{totpEnroll.secret}</p>
          </div>
          <input
            className="input"
            style={{ maxWidth: 200 }}
            inputMode="numeric"
            placeholder="6-digit code"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            autoFocus
          />
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn primary" disabled={busy || code.length !== 6} onClick={verifyTotp}>
              {busy ? 'Verifying…' : 'Verify & turn on'}
            </button>
            <button className="btn ghost" disabled={busy} onClick={cancelTotpEnroll}>Cancel</button>
          </div>
        </div>
      )}

      <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', marginTop: 16, marginBottom: 0 }}>
        If you lose your authenticator, a league admin can reset two-factor authentication for
        your account — contact one to regain access.
      </p>

      {removeTarget && (
        <Modal title="Remove this factor?" onClose={() => setRemoveTarget(null)}>
          <p style={{ marginTop: 0, fontSize: 14 }}>
            Removing <strong>{removeTarget.friendly_name ?? removeTarget.factor_type}</strong> means you'll no longer
            be asked for it at sign-in. {verifiedFactors.length === 1 && 'This is your only factor — two-factor authentication will be fully off.'}
          </p>
          <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
            <button
              className="btn primary"
              style={{ background: 'var(--coral-600)', borderColor: 'var(--coral-600)' }}
              disabled={busy}
              onClick={() => removeFactor(removeTarget)}
            >
              Yes, remove
            </button>
            <button className="btn ghost" disabled={busy} onClick={() => setRemoveTarget(null)}>Cancel</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
