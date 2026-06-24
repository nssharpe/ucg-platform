import { useState } from 'react';
import { checkPassword } from '../lib/store';
import { isSupabaseConfigured, supabase } from '../lib/supabase';

// Keep in step with the Supabase password policy (Auth → Policies). See
// docs/research/2026-06-22-password-policy.md.
const MIN_PASSWORD_LEN = 10;

export function Gate({ onUnlock }: { onUnlock: () => void }) {
  if (isSupabaseConfigured) return <AuthGate />;
  return <PasswordGate onUnlock={onUnlock} />;
}

function PasswordGate({ onUnlock }: { onUnlock: () => void }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const ok = await checkPassword(pw);
    setBusy(false);
    if (ok) onUnlock();
    else setErr(true);
  };

  return (
    <div className="gate">
      <form className="gate-card" onSubmit={submit}>
        <div className="gate-logo">UCG<span className="spark">.</span></div>
        <div className="gate-tag">For the love<br />of the sport.</div>
        <input
          type="password"
          placeholder="ACCESS PASSWORD"
          value={pw}
          autoFocus
          onChange={(e) => { setPw(e.target.value); setErr(false); }}
        />
        <button className="btn primary" disabled={busy || !pw}>Enter the gym →</button>
        {err && <div className="gate-err">That's not it — check with Nate or Julia.</div>}
        <div className="gate-note">United Club Gymnastics · Registration & Scoring Platform · Private prototype</div>
      </form>
    </div>
  );
}

function AuthGate() {
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in');
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [kind, setKind] = useState<'athlete' | 'coach'>('athlete');
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const clearMsg = () => { setErr(null); setInfo(null); };

  const forgotPassword = async () => {
    if (!supabase) return;
    clearMsg();
    if (!email.trim()) { setErr('Enter your email first.'); return; }
    setBusy(true);
    const redirectTo = `${window.location.origin}${import.meta.env.BASE_URL ?? '/'}?setpw=1`;
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
    setBusy(false);
    if (error) setErr(error.message);
    else setInfo('Check your email for a password-reset link.');
  };

  const magicLink = async () => {
    if (!supabase) return;
    clearMsg();
    if (!email.trim()) { setErr('Enter your email first.'); return; }
    setBusy(true);
    const emailRedirectTo = `${window.location.origin}${import.meta.env.BASE_URL ?? '/'}`;
    const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo } });
    setBusy(false);
    if (error) setErr(error.message);
    else setInfo('Check your email for a sign-in link — click it to log in.');
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!supabase) return;
    setBusy(true);
    clearMsg();
    if (mode === 'sign-in') {
      const { error } = await supabase.auth.signInWithPassword({ email, password: pw });
      setBusy(false);
      if (error) setErr(error.message);
      // onAuthStateChange picks up the new session and re-renders App.
    } else {
      // Stash name + kind so auth.ts can pass them to link_or_create_person on
      // the first authenticated load (after email confirmation + sign-in).
      sessionStorage.setItem('ucg-signup-name', JSON.stringify([first.trim(), last.trim()]));
      sessionStorage.setItem('ucg-signup-kind', kind);

      // emailRedirectTo ensures the confirmation link returns to the real app
      // instead of Supabase's default localhost:3000. Works in dev and on
      // GitHub Pages (e.g. https://nssharpe.github.io/ucg-platform/).
      const redirectTo = `${window.location.origin}${import.meta.env.BASE_URL ?? '/'}`;
      const { data, error } = await supabase.auth.signUp({
        email,
        password: pw,
        options: { emailRedirectTo: redirectTo },
      });
      setBusy(false);
      if (error) { setErr(error.message); return; }
      if (!data.session) {
        setInfo('Check your email to confirm your account — the link returns you here to sign in.');
      }
    }
  };

  const radioStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer',
    color: 'var(--ice-200)', fontSize: 13, userSelect: 'none',
  };

  return (
    <div className="gate">
      <form className="gate-card" onSubmit={submit}>
        <div className="gate-logo">UCG<span className="spark">.</span></div>
        <div className="gate-tag">For the love<br />of the sport.</div>
        {mode === 'sign-up' && (
          <>
            <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
              <input
                type="text" placeholder="FIRST NAME" value={first} autoFocus autoComplete="given-name"
                onChange={(e) => { setFirst(e.target.value); clearMsg(); }}
              />
              <input
                type="text" placeholder="LAST NAME" value={last} autoComplete="family-name"
                onChange={(e) => { setLast(e.target.value); clearMsg(); }}
              />
            </div>
            <div style={{ display: 'flex', gap: 20, marginBottom: 12, paddingLeft: 2 }}>
              <span style={{ color: 'var(--ice-200)', fontSize: 12, alignSelf: 'center', opacity: 0.7 }}>I&apos;m registering as:</span>
              <label style={radioStyle}>
                <input
                  type="radio" name="ucg-kind" value="athlete"
                  checked={kind === 'athlete'} onChange={() => setKind('athlete')}
                />
                Athlete
              </label>
              <label style={radioStyle}>
                <input
                  type="radio" name="ucg-kind" value="coach"
                  checked={kind === 'coach'} onChange={() => setKind('coach')}
                />
                Coach
              </label>
            </div>
          </>
        )}
        <input
          type="email"
          placeholder="EMAIL"
          value={email}
          autoFocus={mode === 'sign-in'}
          autoComplete="email"
          onChange={(e) => { setEmail(e.target.value); clearMsg(); }}
          style={{ marginBottom: 10 }}
        />
        <input
          type="password"
          placeholder="PASSWORD"
          value={pw}
          autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
          onChange={(e) => { setPw(e.target.value); setErr(null); setInfo(null); }}
        />
        {mode === 'sign-up' && (
          <div className="gate-note" style={{ color: pw.length > 0 && pw.length < MIN_PASSWORD_LEN ? 'var(--coral-100)' : 'var(--ice-200)', marginTop: 6, textAlign: 'left' }}>
            Use at least {MIN_PASSWORD_LEN} characters.
          </div>
        )}
        <button className="btn primary" disabled={busy || !email || !pw || (mode === 'sign-up' && pw.length < MIN_PASSWORD_LEN)}>
          {busy ? 'Please wait…' : mode === 'sign-in' ? 'Sign in →' : 'Sign up →'}
        </button>
        {err && <div className="gate-err">{err}</div>}
        {info && <div className="gate-note" style={{ color: 'var(--ice-200)', marginTop: 12 }}>{info}</div>}
        {mode === 'sign-in' && (
          <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 14, marginTop: 12 }}>
            <button
              type="button"
              onClick={forgotPassword}
              disabled={busy}
              style={{
                background: 'none', border: 'none', padding: 0, cursor: busy ? 'default' : 'pointer',
                color: 'var(--ice-200)', fontSize: 13, textDecoration: 'underline', opacity: busy ? 0.6 : 1,
              }}
            >
              Forgot my password?
            </button>
            <button
              type="button"
              onClick={magicLink}
              disabled={busy}
              style={{
                background: 'none', border: 'none', padding: 0, cursor: busy ? 'default' : 'pointer',
                color: 'var(--ice-200)', fontSize: 13, textDecoration: 'underline', opacity: busy ? 0.6 : 1,
              }}
            >
              Email me a sign-in link
            </button>
          </div>
        )}
        <button
          type="button"
          className="btn ghost"
          style={{
            width: '100%', justifyContent: 'center', marginTop: 10,
            // the gate sits on navy — the default ghost button text is invisible here
            color: 'var(--ice-200)', border: '1px solid rgba(219, 235, 237, 0.35)', background: 'transparent',
          }}
          onClick={() => { setMode((m) => (m === 'sign-in' ? 'sign-up' : 'sign-in')); setErr(null); setInfo(null); }}
        >
          {mode === 'sign-in' ? 'Need an account? Sign up' : 'Have an account? Sign in'}
        </button>
        <div className="gate-note">United Club Gymnastics · Registration & Scoring Platform · Private prototype</div>
      </form>
    </div>
  );
}
