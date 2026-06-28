import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { fetchSignRequest, fetchPublishedWaiver, recordWaiverSignature } from '../lib/supabase';
import type { WaiverDocument } from '../lib/types';
import { sanitizeWaiverHtml } from '../lib/sanitize-html';
import { expectedWaiverSignerName, waiverNameMatches } from '../lib/waivers-core';

export default function WaiverSign() {
  const { token = '' } = useParams();
  const [state, setState] = useState<'loading' | 'ready' | 'invalid' | 'done'>('loading');
  const [req, setReq] = useState<Awaited<ReturnType<typeof fetchSignRequest>>>(null);
  const [doc, setDoc] = useState<WaiverDocument | null>(null);
  const [name, setName] = useState('');
  const [relationship, setRelationship] = useState('parent');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [pendingPayment, setPendingPayment] = useState(false);

  useEffect(() => {
    (async () => {
      const r = await fetchSignRequest(token);
      if (!r || r.status !== 'pending') { setState('invalid'); return; }
      const d = await fetchPublishedWaiver(r.season_id, r.waiver_type);
      if (!d) { setState('invalid'); return; }
      setReq(r); setDoc(d); setState('ready');
    })();
  }, [token]);

  // 'self' = an adult signing their own waiver; 'guardian' = a parent signing for
  // a minor. The mint decides this and it rides on the request row. The recorded
  // signer_role is taken from the stored row server-side, so the value we send is
  // advisory — but we still send the matching one for clarity.
  const signerRole: 'self' | 'guardian' = req?.signer_role === 'self' ? 'self' : 'guardian';
  const isSelf = signerRole === 'self';

  const expectedSig = req ? expectedWaiverSignerName(req.first_name, req.last_name) : '';
  const sigMatchesName = req ? waiverNameMatches(name, req.first_name, req.last_name) : false;

  const submit = async () => {
    if (!doc || !req) return;
    setBusy(true); setErr('');
    const res = await recordWaiverSignature({
      personId: req.person_id, seasonId: req.season_id, waiverType: req.waiver_type,
      membershipType: req.membership_type, waiverDocumentId: doc.id, contentHash: doc.contentHash,
      signerName: name.trim(), signerEmail: req.guardian_email, signerRole,
      signerRelationship: isSelf ? undefined : relationship, consent, token,
    });
    setBusy(false);
    if (!res.ok) { setErr(res.error ?? 'Could not record signature.'); return; }
    setPendingPayment(!!res.pendingPayment);
    setState('done');
  };

  if (state === 'loading') return <div className="card card-pad" style={{ maxWidth: 640, margin: '40px auto' }}>Loading…</div>;
  if (state === 'invalid') return (
    <div className="card card-pad" style={{ maxWidth: 640, margin: '40px auto' }}>
      <h2>This signing link is no longer valid.</h2>
      <p style={{ color: 'var(--ink-soft)' }}>Ask for a fresh signing link to be resent from the membership page.</p>
    </div>
  );
  if (state === 'done') return (
    <div className="card card-pad" style={{ maxWidth: 640, margin: '40px auto' }}>
      <h2>✓ Thank you — the waiver is signed.</h2>
      <p style={{ color: 'var(--ink-soft)' }}>
        {pendingPayment
          ? "The waiver is on file. The athlete's membership activates once their club pays the membership fee from its club cart."
          : isSelf
            ? 'Your membership is now active.'
            : "The athlete's membership is now active."}
      </p>
    </div>
  );

  return (
    <div className="card card-pad" style={{ maxWidth: 640, margin: '40px auto' }}>
      <h2>NAIGC waiver — {isSelf ? 'athlete signature' : 'guardian signature'}</h2>
      <div style={{
        background: 'var(--ice-100)', border: '1px solid var(--line)', borderRadius: 8,
        padding: 14, fontSize: 13, maxHeight: 280, overflowY: 'auto', margin: '12px 0',
      }}
        dangerouslySetInnerHTML={{ __html: sanitizeWaiverHtml(doc?.body ?? '') }} />
      <label style={{ display: 'block', marginBottom: 8 }}>Your full legal name
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={isSelf ? expectedSig : undefined} />
      </label>
      {isSelf && name.trim().length > 0 && !sigMatchesName && (
        <p style={{ color: 'var(--coral-600)', fontSize: 13, marginTop: -4, marginBottom: 10 }}>
          Your signature must match your name on file: <strong>{expectedSig}</strong>.
        </p>
      )}
      {!isSelf && (
        <label style={{ display: 'block', marginBottom: 8 }}>Relationship to athlete
          <input className="input" value={relationship} onChange={(e) => setRelationship(e.target.value)} />
        </label>
      )}
      <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13.5, margin: '8px 0 12px' }}>
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        <span>{isSelf
          ? 'I am the athlete and I agree to sign this waiver electronically. Timestamp and IP are recorded.'
          : 'I am the parent/guardian and agree to sign this waiver electronically. Timestamp and IP are recorded.'}</span>
      </label>
      {err && <p style={{ color: 'var(--coral-600)', fontSize: 13 }}>{err}</p>}
      <button className="btn primary" disabled={busy || consent === false || name.trim().length < 2 || (isSelf && !sigMatchesName)} onClick={submit}>
        {busy ? 'Signing…' : 'Sign waiver'}
      </button>
    </div>
  );
}
