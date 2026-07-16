import { useMemo, useState } from 'react';
import { useDB, mutate } from '../../../lib/store';
import { Field } from '../../../components/ui';
import { useToast } from '../../../components/ui-hooks';
import { GENERAL_WAIVER_TYPE } from '../../../lib/types';
import type { WaiverType, WaiverDocument } from '../../../lib/types';
import { sha256Hex, nextVersion, certificateText } from '../../../lib/waivers-core';
import { downloadWaiverProof, formatSignedAt } from '../../../lib/waiver-proof';
import { sanitizeWaiverHtml } from '../../../lib/sanitize-html';
import { pushWaiverDocument } from '../../../lib/supabase';

// ---------- Waivers ----------
export function Waivers() {
  const db = useDB();
  const toast = useToast();
  const currentSeason = db.seasons.find((s) => s.current) ?? db.seasons[0];
  const [selectedSeasonId, setSelectedSeasonId] = useState(currentSeason?.id ?? '');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [signedQ, setSignedQ] = useState('');
  const selectedSeason = db.seasons.find((s) => s.id === selectedSeasonId) ?? currentSeason;

  const docsFor = (t: WaiverType): WaiverDocument[] =>
    (db.waiverDocuments ?? [])
      .filter((d) => d.seasonId === selectedSeasonId && d.waiverType === t)
      .sort((a, b) => a.version - b.version);
  const publishedFor = (t: WaiverType) => {
    const pubs = docsFor(t).filter((d) => d.published);
    return pubs[pubs.length - 1];
  };

  const saveVersion = async (t: WaiverType) => {
    const key = `${selectedSeasonId}:${t}`;
    const body = (drafts[key] ?? publishedFor(t)?.body ?? '').trim();
    if (body.length < 20) { toast('Waiver text is too short to publish.'); return; }
    const existing = docsFor(t);
    const doc: WaiverDocument = {
      id: crypto.randomUUID(), seasonId: selectedSeasonId, waiverType: t,
      version: nextVersion(existing), body, contentHash: await sha256Hex(body),
      published: true, createdAt: new Date().toISOString(),
    };
    mutate((d) => { (d.waiverDocuments ??= []).push(doc); });
    pushWaiverDocument(doc);
    setDrafts((p) => ({ ...p, [key]: doc.body }));
    toast(`${t} waiver v${doc.version} published.`);
  };

  const signed = useMemo(() => {
    const lq = signedQ.toLowerCase();
    return (db.waiverSignatures ?? [])
      .filter((s) => s.seasonId === selectedSeasonId)
      .map((s) => {
        const p = db.people.find((x) => x.id === s.personId);
        const name = p ? `${p.firstName} ${p.lastName}` : s.personId;
        const v = (db.waiverDocuments ?? []).find((d) => d.id === s.waiverDocumentId)?.version ?? 0;
        return { sig: s, name, version: v };
      })
      .filter((r) => !lq || r.name.toLowerCase().includes(lq))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [db.waiverSignatures, db.waiverDocuments, db.people, selectedSeasonId, signedQ]);

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <Field label="Season">
          <select className="input" style={{ maxWidth: 200 }} value={selectedSeasonId}
            onChange={(e) => setSelectedSeasonId(e.target.value)}>
            {db.seasons.map((s) => (
              <option key={s.id} value={s.id}>{s.name}{s.current ? ' (current)' : ''}</option>
            ))}
          </select>
        </Field>
      </div>

      {(() => {
        const t = GENERAL_WAIVER_TYPE;
        const key = `${selectedSeasonId}:${t}`;
        const pub = publishedFor(t);
        const value = drafts[key] ?? pub?.body ?? '';
        return (
          <div className="card card-pad" style={{ marginBottom: 24 }}>
            <h3 className="card-title">Member waiver — {selectedSeason?.name ?? '—'}</h3>
            <p style={{ fontSize: 13.5, color: 'var(--ink-soft)', marginTop: 0 }}>
              A single waiver applies to all members. Enter <strong>HTML</strong> — it renders as shown in the preview when members sign.
              {' '}{pub ? `Published v${pub.version}.` : 'Not published yet.'} E-signed with timestamp, IP &amp; consent recorded.
            </p>
            <div className="grid cols-2" style={{ gap: 16, alignItems: 'start' }}>
              <div>
                <label style={{ fontSize: 12.5, color: 'var(--ink-soft)', display: 'block', marginBottom: 4 }}>HTML source</label>
                <textarea className="input" rows={18} style={{ fontFamily: 'monospace', fontSize: 12 }} value={value}
                  onChange={(e) => setDrafts((p) => ({ ...p, [key]: e.target.value }))}
                  placeholder="<h1>Waiver…</h1>" />
              </div>
              <div>
                <label style={{ fontSize: 12.5, color: 'var(--ink-soft)', display: 'block', marginBottom: 4 }}>Preview</label>
                <div style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 14, fontSize: 13, maxHeight: 400, overflowY: 'auto', background: 'var(--ice-100)' }}
                  dangerouslySetInnerHTML={{ __html: sanitizeWaiverHtml(value) || '<p>Nothing to preview yet.</p>' }} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
              <button className="btn small primary" onClick={() => saveVersion(t)}>Save new version</button>
              {docsFor(t).length >= 1 && (
                <details><summary style={{ fontSize: 12.5, color: 'var(--ink-soft)', cursor: 'pointer' }}>
                  History ({docsFor(t).length})</summary>
                  <ul style={{ margin: '4px 0 0 16px', fontSize: 12.5, color: 'var(--ink-soft)' }}>
                    {[...docsFor(t)].reverse().map((d) => (
                      <li key={d.id}>v{d.version} — {new Date(d.createdAt).toLocaleString()} (hash {d.contentHash.slice(0, 8)}…)</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          </div>
        );
      })()}

      <div className="card card-pad">
        <h3 className="card-title">Signed waivers — {selectedSeason?.name ?? '—'}</h3>
        <input className="input" style={{ maxWidth: 280, marginBottom: 12 }} placeholder="Search by name"
          value={signedQ} onChange={(e) => setSignedQ(e.target.value)} />
        {signed.length === 0 ? (
          <p style={{ fontSize: 13.5, color: 'var(--ink-soft)' }}>
            No signatures recorded for {selectedSeason?.name ?? 'this season'}.
            {(db.waiverSignatures ?? []).length > 0 && (
              <> {(db.waiverSignatures ?? []).length} signature{(db.waiverSignatures ?? []).length !== 1 ? 's' : ''} exist in other seasons — switch the season above to view them.</>
            )}
          </p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {signed.slice(0, 300).map(({ sig, name, version }) => (
              <li key={sig.id} style={{ borderBottom: '1px solid var(--line)', padding: '8px 0' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                  <strong>{name}</strong> <span style={{ color: 'var(--ink-soft)' }}>({sig.signerRole})</span>
                  <span style={{ color: 'var(--ink-soft)', fontSize: 12.5 }}>{formatSignedAt(sig.signedAt)}</span>
                  <button className="btn small ghost" style={{ marginLeft: 'auto' }}
                    onClick={() => downloadWaiverProof(sig, version, name, (db.waiverDocuments ?? []).find((d) => d.id === sig.waiverDocumentId)?.body)}>Download proof (PDF)</button>
                </div>
                <details>
                  <summary style={{ fontSize: 12.5, color: 'var(--teal-900)', cursor: 'pointer' }}>Certificate</summary>
                  <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', margin: '4px 0 0' }}>
                    {certificateText(sig, version, name)}
                  </p>
                </details>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
