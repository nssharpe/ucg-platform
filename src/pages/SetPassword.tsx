import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useSession } from '../lib/auth';

// Reached after clicking an invite / set-password link. Supabase has already
// established the session from the URL token (detectSessionInUrl) by the time we
// render, so we just collect a new password and save it, then send the user to
// the membership page.
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
  // Supabase appends an error to the URL for expired/invalid links — detect it so
  // we can show the "expired" message immediately rather than after the grace wait.
  const linkError = /error=|otp_expired|access_denied/i.test(window.location.hash + window.location.search);

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
    setTimeout(() => navigate('/membership'), 1200);
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
          Ask your club manager to resend your invitation, or use “Forgot password” to get a new link.
        </p>
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
      <p style={{ fontSize: 12, color: tooShort ? 'var(--coral-600)' : 'var(--ink-soft)', margin: '4px 0 0' }}>
        At least {MIN_LEN} characters.
      </p>
      {mismatch && <p style={{ fontSize: 13, color: 'var(--coral-600)', margin: '6px 0 0' }}>Passwords don’t match.</p>}
      {err && <p style={{ fontSize: 13, color: 'var(--coral-600)', margin: '6px 0 0' }}>{err}</p>}
      <button className="btn primary" type="submit" disabled={!canSubmit} style={{ marginTop: 14 }}>
        {busy ? 'Saving…' : 'Set password & continue →'}
      </button>
    </form>
  );
}
