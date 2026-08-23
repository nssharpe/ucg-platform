import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useSession, initialSetPwKind, hasInitialLinkError } from '../lib/auth';

// Reached after clicking an invite / set-password link. Supabase has already
// established the session from the URL token (detectSessionInUrl) by the time we
// render, so we just collect a new password and save it, then send the user
// on: reset links go Home, invite links go to membership (matching the
// invite email's "you'll land on the membership page" copy).
const MIN_LEN = 10; // keep in step with the Supabase password policy

export default function SetPassword() {
  const navigate = useNavigate();
  const session = useSession();
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  // The session is established asynchronously from the URL token, so give it a
  // moment before concluding the link is invalid.
  const [grace, setGrace] = useState(true);
  useEffect(() => { const t = setTimeout(() => setGrace(false), 2500); return () => clearTimeout(t); }, []);
  // Captured once at module load (auth.ts) — see SetPasswordRedirect's
  // comment in App.tsx for why re-parsing the live URL here would be
  // unreliable (this page's own cleanup, and Supabase's own hash-clear,
  // both rewrite it after the fact).
  const setpwKind = initialSetPwKind();
  const linkError = hasInitialLinkError();

  const tooShort = pw.length > 0 && pw.length < MIN_LEN;
  const mismatch = pw2.length > 0 && pw !== pw2;
  const canSubmit = pw.length >= MIN_LEN && pw === pw2 && !busy;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!supabase || !canSubmit) return;
    setBusy(true); setErr(null);
    const { error } = await supabase.auth.updateUser({ password: pw });
    setBusy(false);
    if (error) { setErr(error.message); return; }
    setDone(true);
    // Reset → Home; invite (and legacy pre-marker `?setpw=1` links) →
    // membership, matching the invite email's "you'll land on the
    // membership page" copy (UAT A-07-02 / A-06-01).
    setTimeout(() => navigate(setpwKind === 'reset' ? '/' : '/membership'), 1200);
  };

  if (!session && grace && !linkError) {
    return (
      <div className="card card-pad" style={{ maxWidth: 480, margin: '40px auto' }}>
        <p style={{ color: 'var(--ink-soft)' }}>Verifying your link…</p>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="card card-pad" style={{ maxWidth: 480, margin: '40px auto' }}>
        <h2 className="display" style={{ fontSize: 22 }}>This link has expired</h2>
        <p style={{ color: 'var(--ink-soft)' }}>
          This link has expired or was already used. Ask your club manager to resend your
          invitation, or request a new one below.
        </p>
        <button className="btn primary" type="button" onClick={() => navigate('/me')} style={{ marginTop: 14 }}>
          Request a new link →
        </button>
      </div>
    );
  }

  if (done) {
    return (
      <div className="card card-pad" style={{ maxWidth: 480, margin: '40px auto' }}>
        <h2 className="display" style={{ fontSize: 22 }}>✓ Password set</h2>
        <p style={{ color: 'var(--ink-soft)' }}>Taking you to membership…</p>
      </div>
    );
  }

  return (
    <form className="card card-pad" style={{ maxWidth: 480, margin: '40px auto' }} onSubmit={submit}>
      <h2 className="display" style={{ fontSize: 22, marginTop: 0 }}>Set your password</h2>
      <p style={{ color: 'var(--ink-soft)', marginTop: 0 }}>
        Welcome to United Club Gymnastics. Choose a password to finish setting up your account.
      </p>
      <label style={{ display: 'block', marginBottom: 10 }}>New password
        <input className="input" type="password" autoComplete="new-password" value={pw}
          onChange={(e) => { setPw(e.target.value); setErr(null); }} />
      </label>
      <label style={{ display: 'block', marginBottom: 6 }}>Confirm password
        <input className="input" type="password" autoComplete="new-password" value={pw2}
          onChange={(e) => { setPw2(e.target.value); setErr(null); }} />
      </label>
      <p style={{ fontSize: 12, color: tooShort ? 'var(--coral-text)' : 'var(--ink-soft)', margin: '4px 0 0' }}>
        At least {MIN_LEN} characters.
      </p>
      {mismatch && <p style={{ fontSize: 13, color: 'var(--coral-text)', margin: '6px 0 0' }}>Passwords don’t match.</p>}
      {err && <p style={{ fontSize: 13, color: 'var(--coral-text)', margin: '6px 0 0' }}>{err}</p>}
      <button className="btn primary" type="submit" disabled={!canSubmit} style={{ marginTop: 14 }}>
        {busy ? 'Saving…' : 'Set password & continue →'}
      </button>
    </form>
  );
}
