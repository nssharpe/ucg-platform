import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useDB } from '../lib/store';
import { useCapabilities } from '../lib/capabilities';
import { Badge, Combo, Modal } from '../components/ui';
import { useFmtDate } from '../components/ui-hooks';
import { fmtMoney } from '../lib/scoring';
import { downloadReceipt, invoiceTotal } from '../lib/receipt';
import { InvoiceLineTable } from '../components/InvoiceLineTable';
import { payerLabel, matchesClubPurchaseSearch } from '../lib/purchases';
import { setCurrentClubId } from '../lib/current-club';
import type { Invoice } from '../lib/types';

/** Club Purchase History (UAT round-1, Z-01-02/M-19-01/M-20-01): ALL of a
 *  club's invoices, including ones a manager paid personally-on-behalf-of the
 *  club (unlike My Purchase History, which is scoped to the viewer's OWN
 *  personal invoices only — `isPersonalInvoice`). Each row/receipt shows
 *  "Paid by <name or email>" (`payerLabel`), and search/filter includes the
 *  payer, not just the receipt number/item/amount. */
export function ClubPurchaseHistoryPage() {
  const { clubId } = useParams();
  const db = useDB();
  const caps = useCapabilities();
  const navigate = useNavigate();
  const fmtDate = useFmtDate();
  const [detail, setDetail] = useState<Invoice | null>(null);
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const club = db.clubs.find((c) => c.id === clubId);
  const canManage = !!club && (caps.isAdmin || caps.managedClubIds.includes(club.id));

  useEffect(() => {
    if (club && canManage) setCurrentClubId(club.id);
  }, [club, canManage]);

  useEffect(() => { window.scrollTo(0, 0); }, []);

  const payerOf = (inv: Invoice) => payerLabel(inv, db.payments ?? [], db.people);

  const allInvoices = useMemo(() =>
    db.invoices
      .filter((i) => i.clubId === (club?.id ?? '__none__') && i.paidAt != null)
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [db.invoices, club?.id],
  );

  const invoices = useMemo(() => {
    return allInvoices.filter((inv) => {
      if (from && inv.createdAt.slice(0, 10) < from) return false;
      if (to && inv.createdAt.slice(0, 10) > to) return false;
      return matchesClubPurchaseSearch(inv, search, payerOf(inv));
    });
    // payerOf closes over db.payments/db.people, recomputed each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allInvoices, search, from, to, db.payments, db.people]);

  if (!club) return <p>Club not found.</p>;
  if (!canManage) {
    return (
      <div className="card card-pad" style={{ maxWidth: 480 }}>
        <h2 className="display" style={{ fontSize: 22 }}>You don&rsquo;t manage this club</h2>
        <p style={{ color: 'var(--ink-soft)' }}>Only club managers or league admins can view a club&rsquo;s purchase history.</p>
      </div>
    );
  }

  const switchableClubs = (caps.isAdmin
    ? db.clubs
    : db.clubs.filter((c) => caps.managedClubIds.includes(c.id))
  ).slice().sort((a, b) => a.name.localeCompare(b.name));
  const displayName = club.shortName || club.name;

  return (
    <div style={{ maxWidth: 820 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h1 className="page-title display" style={{ marginBottom: 0 }}>{displayName} Purchase History</h1>
        {switchableClubs.length > 1 && (
          <div style={{ minWidth: 240 }}>
            <Combo
              options={switchableClubs.map((c) => ({ value: c.id, label: c.name, sub: `${c.state} · ${c.region}` }))}
              value={club.id}
              placeholder="Switch club…"
              onChange={(v) => { if (v && v !== club.id) navigate(`/club/${v}/purchases`); }}
            />
          </div>
        )}
      </div>
      <p className="page-sub" style={{ marginTop: 2 }}>
        Every receipt billed to {displayName} — including ones paid by a fellow manager.{' '}
        <Link to={`/club/${club.id}/cart`}>Club cart →</Link>
      </p>

      {allInvoices.length > 0 && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 12, flexWrap: 'wrap', alignItems: 'end' }}>
          <div style={{ flex: '1 1 220px', minWidth: 160 }}>
            <label style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.04em', color: 'var(--navy-700)', display: 'block', marginBottom: 5 }}>Search</label>
            <input className="input" type="text" value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Name, payer, item, amount…" />
          </div>
          <div style={{ minWidth: 120 }}>
            <label style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.04em', color: 'var(--navy-700)', display: 'block', marginBottom: 5 }}>From</label>
            <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div style={{ minWidth: 120 }}>
            <label style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.04em', color: 'var(--navy-700)', display: 'block', marginBottom: 5 }}>To</label>
            <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          {(search || from || to) && (
            <button className="btn small ghost" style={{ marginBottom: 2 }}
              onClick={() => { setSearch(''); setFrom(''); setTo(''); }}>Clear</button>
          )}
        </div>
      )}

      {allInvoices.length === 0 ? <p style={{ color: 'var(--ink-soft)' }}>No purchases yet.</p>
      : invoices.length === 0 ? <p style={{ color: 'var(--ink-soft)' }}>No purchases match your filters.</p>
      : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {invoices.map((inv) => (
            <div key={inv.id} className="card card-pad">
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                <strong>{inv.number}</strong>
                <span style={{ color: 'var(--ink-soft)', fontSize: 13 }}>{fmtDate(inv.createdAt.slice(0, 10))}</span>
                <Badge tone="ok">Paid</Badge>
                <strong style={{ marginLeft: 'auto' }}>{fmtMoney(invoiceTotal(inv))}</strong>
              </div>
              <p style={{ margin: '8px 0 4px', fontSize: 14, color: 'var(--ink-soft)' }}>
                {inv.items.filter((i) => i.kind !== 'discount').map((i) => i.label).join('; ')}
              </p>
              <p style={{ margin: '0 0 10px', fontSize: 13, color: 'var(--ink-soft)' }}>
                Paid by <strong style={{ color: 'var(--ink)' }}>{payerOf(inv)}</strong>
              </p>
              <button className="btn small ghost" onClick={() => setDetail(inv)}>View details →</button>
            </div>
          ))}
        </div>
      )}

      {detail && (
        <Modal title={`Receipt ${detail.number}`} onClose={() => setDetail(null)}>
          <div style={{ fontSize: 13.5, color: 'var(--ink-soft)', marginBottom: 12 }}>
            {fmtDate(detail.createdAt.slice(0, 10))} · Paid · Billed to {displayName} · Paid by {payerOf(detail)}
          </div>
          <InvoiceLineTable invoice={detail} />
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn primary" onClick={() => downloadReceipt(detail, displayName)}>Download receipt (PDF)</button>
            <button className="btn ghost" onClick={() => setDetail(null)}>Close</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

export default ClubPurchaseHistoryPage;
