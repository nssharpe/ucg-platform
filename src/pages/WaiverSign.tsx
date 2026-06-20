import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { fetchSignRequest, fetchPublishedWaiver, recordWaiverSignature } from '../lib/supabase';
import type { WaiverDocument } from '../lib/types';

export default function WaiverSign() {
  const { token = '' } = useParams();
  const [state, setState] = useState<'loading' | 'ready' | 'invalid' | 'done'>('loading');
  const [req, setReq] = useState<any>(null);
  const [doc, setDoc] = useState<WaiverDocument | null>(null);
  const [name, setName] = useState('');
  const [relationship, setRelationship] = useState('parent');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    (async () => {
      const r = await fetchSignRequest(token);
      if (!r || r.status !== 'pending') { setState('invalid'); return; }
      const d = await fetchPublishedWaiver(r.season_id, r.waiver_type);
      if (!d) { setState('invalid'); return; }
      setReq(r); setDoc(d); setState('ready');
    })();
  }, [token]);

  const submit = async () => {
    if (!doc) return;
    setBusy(true); setErr('');
    const res = await recordWaiverSignature({
      personId: req.person_id, seasonId: req.season_id, waiverType: req.waiver_type,
      membershipType: req.membership_type, waiverDocumentId: doc.id, contentHash: doc.contentHash,
      signerName: name.trim(), signerEmail: req.guardian_email, signerRole: 'guardian',
      signerRelationship: relationship, consent, token,
    });
    setBusy(false);
    if (!res.ok) { setErr(res.error ?? 'Could not record signature.'); return; }
    setState('done');
  };

  if (state === 'loading') return <div className="card card-pad" style={{ maxWidth: 640, margin: '40px auto' }}>Loading…</div>;
  if (state === 'invalid') return (
    <div className="card card-pad" style={{ maxWidth: 640, margin: '40px auto' }}>
      <h2>This signing link is no longer valid.</h2>
      <p style={{ color: 'var(--ink-soft)' }}>Ask the athlete to resend the guardian link from their membership page.</p>
    </div>
  );
  if (state === 'done') return (
    <div className="card card-pad" style={{ maxWidth: 640, margin: '40px auto' }}>
      <h2>✓ Thank you — the waiver is signed.</h2>
      <p style={{ color: 'var(--ink-soft)' }}>The athlete's membership is now active.</p>
    </div>
  );

  return (
    <div className="card card-pad" style={{ maxWidth: 640, margin: '40px auto' }}>
      <h2>{req.waiver_type} waiver — guardian signature</h2>
      <div style={{
        background: 'var(--ice-100)', border: '1px solid var(--line)', borderRadius: 8,
        padding: 14, fontSize: 13, maxHeight: 240, overflowY: 'auto', margin: '12px 0', whiteSpace: 'pre-wrap',
      }}>
        {doc?.body}
      </div>
      <label style={{ display: 'block', marginBottom: 8 }}>Your full legal name
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label style={{ display: 'block', marginBottom: 8 }}>Relationship to athlete
        <input className="input" value={relationship} onChange={(e) => setRelationship(e.target.value)} />
      </label>
      <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13.5, margin: '8px 0 12px' }}>
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        <span>I am the parent/guardian and agree to sign this waiver electronically. Timestamp and IP are recorded.</span>
      </label>
      {err && <p style={{ color: 'var(--coral-600)', fontSize: 13 }}>{err}</p>}
      <button className="btn primary" disabled={busy || consent === false || name.trim().length < 2} onClick={submit}>
        {busy ? 'Signing…' : 'Sign waiver'}
      </button>
    </div>
  );
}
