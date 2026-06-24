import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { fetchManagerAccessRequest, decideManagerAccess } from '../lib/supabase';

/** No-login review page for a "Request Club Admin Role" request. A club manager
 *  or league admin opens the emailed link and approves or denies. The first
 *  responder decides it; afterwards the page shows it was already reviewed. */
export default function ManagerAccessReview() {
  const { token = '' } = useParams();
  const [state, setState] = useState<'loading' | 'ready' | 'invalid' | 'done'>('loading');
  const [info, setInfo] = useState<{ status: string; requesterName: string; clubName: string } | null>(null);
  const [outcome, setOutcome] = useState<string>('');
  const [decider, setDecider] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const r = await fetchManagerAccessRequest(token);
      if (!r) { setState('invalid'); return; }
      setInfo(r);
      setState(r.status === 'pending' ? 'ready' : 'done');
      if (r.status !== 'pending') setOutcome(r.status);
    })();
  }, [token]);

  const decide = async (decision: 'approve' | 'deny') => {
    setBusy(true);
    const res = await decideManagerAccess(token, decision, decider.trim());
    setBusy(false);
    setOutcome(res);
    setState('done');
  };

  const wrap = (children: React.ReactNode) => (
    <div className="card card-pad" style={{ maxWidth: 560, margin: '40px auto' }}>{children}</div>
  );

  if (state === 'loading') return wrap(<p>Loading…</p>);
  if (state === 'invalid') return wrap(<>
    <h2>Request not found</h2>
    <p style={{ color: 'var(--ink-soft)' }}>This review link is invalid or has expired.</p>
  </>);

  if (state === 'done') {
    const msg =
      outcome === 'approved' ? `${info?.requesterName} now manages ${info?.clubName}.`
      : outcome === 'denied' ? `The request from ${info?.requesterName} was denied.`
      : outcome === 'already' ? 'Someone already reviewed this request — no further action is needed.'
      : outcome === 'invalid' ? 'This review link is invalid or has expired.'
      : 'Something went wrong recording your decision. Please try again.';
    return wrap(<>
      <h2>{outcome === 'approved' ? '✓ Approved' : outcome === 'denied' ? 'Request denied' : 'Already reviewed'}</h2>
      <p style={{ color: 'var(--ink-soft)' }}>{msg}</p>
    </>);
  }

  return wrap(<>
    <h2>Manager access request</h2>
    <p style={{ fontSize: 15 }}>
      <strong>{info?.requesterName}</strong> has requested admin/manager access to{' '}
      <strong>{info?.clubName}</strong>. Approving lets them manage the club's roster, meet
      registration, and club cart.
    </p>
    <label style={{ display: 'block', fontSize: 13, color: 'var(--ink-soft)', margin: '12px 0 6px' }}>
      Your name (optional, recorded with the decision)
    </label>
    <input className="input" value={decider} onChange={(e) => setDecider(e.target.value)} placeholder="e.g. Jane Coach" />
    <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
      <button className="btn primary" disabled={busy} onClick={() => decide('approve')}>
        {busy ? 'Saving…' : 'Approve'}
      </button>
      <button className="btn ghost" disabled={busy} onClick={() => decide('deny')}>Deny</button>
    </div>
  </>);
}
