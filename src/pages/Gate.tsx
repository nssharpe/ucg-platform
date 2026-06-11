import { useState } from 'react';
import { checkPassword } from '../lib/store';

export function Gate({ onUnlock }: { onUnlock: () => void }) {
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
