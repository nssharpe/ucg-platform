import { useMemo, useState } from 'react';
import { useDB } from '../lib/store';
import { useCapabilities } from '../lib/capabilities';
import { Badge, Modal } from '../components/ui';
import { fmtMoney } from '../lib/scoring';
import { downloadReceipt, invoiceTotal } from '../lib/receipt';
import type { DB, Invoice } from '../lib/types';

/** Purchases History (MY UCG): every invoice tied to this account — memberships
 *  and meet entries — with a plain-English summary, a details overlay, and a
 *  downloadable PDF receipt. */
export function PurchaseHistory() {
  const caps = useCapabilities();
  if (!caps.person) {
    return (
      <div className="card card-pad" style={{ maxWidth: 520 }}>
        <h2 className="display" style={{ fontSize: 22 }}>Sign in to view your purchases</h2>
      </div>
    );
  }
  return <PurchaseHistoryInner personId={caps.person.id} name={`${caps.person.firstName} ${caps.person.lastName}`} />;
}

/** "Memberships & Registrations for Nationals, Regionals" — derived from items. */
function summarize(inv: Invoice, db: DB, personId: string): string {
  const items = inv.athleteId === personId ? inv.items : inv.items.filter((i) => i.refUserId === personId);
  const hasMembership = items.some((i) => i.kind === 'membership');
  const meetNames = [...new Set(
    db.meets.filter((m) => items.some((i) =>
      (i.kind === 'meet-entry' || i.kind === 'addon' || i.kind === 'banquet') && i.label.includes(m.name),
    )).map((m) => m.name),
  )];
  const parts: string[] = [];
  if (hasMembership) parts.push('Memberships');
  if (meetNames.length) parts.push(`Registrations for ${meetNames.join(', ')}`);
  if (parts.length === 0) {
    // Fallback: list distinct item kinds.
    const kinds = [...new Set(items.map((i) => i.kind))];
    return kinds.join(', ') || 'Purchase';
  }
  return parts.join(' & ');
}

function PurchaseHistoryInner({ personId, name }: { personId: string; name: string }) {
  const db = useDB();
  const [detail, setDetail] = useState<Invoice | null>(null);

  const invoices = useMemo(() =>
    db.invoices
      .filter((inv) => inv.athleteId === personId || inv.items.some((i) => i.refUserId === personId))
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [db.invoices, personId],
  );

  return (
    <div style={{ maxWidth: 820 }}>
      <h1 className="page-title display">Purchase History</h1>
      <p className="page-sub">Receipts processed on your account.</p>

      {invoices.length === 0 ? (
        <p style={{ color: 'var(--ink-soft)' }}>No purchases yet.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {invoices.map((inv) => (
            <div key={inv.id} className="card card-pad">
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                <strong>{inv.number}</strong>
                <span style={{ color: 'var(--ink-soft)', fontSize: 13 }}>{inv.createdAt.slice(0, 10)}</span>
                {inv.paidAt ? <Badge tone="ok">Paid</Badge> : <Badge tone="warn">Unpaid</Badge>}
                <strong style={{ marginLeft: 'auto' }}>{fmtMoney(invoiceTotal(inv))}</strong>
              </div>
              <p style={{ margin: '8px 0 10px', fontSize: 14 }}>{summarize(inv, db, personId)}</p>
              <button className="btn small ghost" onClick={() => setDetail(inv)}>Click for details →</button>
            </div>
          ))}
        </div>
      )}

      {detail && (
        <Modal title={`Receipt ${detail.number}`} onClose={() => setDetail(null)}>
          <div style={{ fontSize: 13.5, color: 'var(--ink-soft)', marginBottom: 12 }}>
            {detail.createdAt.slice(0, 10)} · {detail.paidAt ? 'Paid' : 'Unpaid'} · Billed to {name}
          </div>
          {(() => {
            // Lines visible to this viewer (their own line(s) on a shared club
            // invoice, or every line on their own invoice).
            const shown = detail.athleteId === personId ? detail.items : detail.items.filter((i) => i.refUserId === personId);
            const lineItems = shown.filter((i) => i.kind !== 'discount');
            const subtotal = lineItems.reduce((s, i) => s + (i.refunded ? 0 : i.amount), 0);
            const discount = -shown.filter((i) => i.kind === 'discount').reduce((s, i) => s + (i.refunded ? 0 : i.amount), 0);
            const total = subtotal - discount;
            return (
              <table className="tbl" style={{ marginBottom: 12 }}>
                <tbody>
                  {lineItems.map((i) => (
                    <tr key={i.id}>
                      <td>{i.label}{i.refunded ? ' (refunded)' : ''}</td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{fmtMoney(i.refunded ? 0 : i.amount)}</td>
                    </tr>
                  ))}
                  {discount > 0 && (
                    <>
                      <tr style={{ borderTop: '1px solid var(--line)' }}>
                        <td style={{ color: 'var(--ink-soft)' }}>Subtotal</td>
                        <td style={{ textAlign: 'right', color: 'var(--ink-soft)' }}>{fmtMoney(subtotal)}</td>
                      </tr>
                      <tr>
                        <td style={{ color: 'var(--ink-soft)' }}>Promo code{detail.couponCode ? ` (${detail.couponCode})` : ''}</td>
                        <td style={{ textAlign: 'right', color: 'var(--ink-soft)' }}>−{fmtMoney(discount)}</td>
                      </tr>
                    </>
                  )}
                  <tr style={{ borderTop: '2px solid var(--navy-800)', fontWeight: 700 }}>
                    <td>Total{discount > 0 ? ' paid' : ''}</td>
                    <td style={{ textAlign: 'right' }}>{fmtMoney(total)}</td>
                  </tr>
                </tbody>
              </table>
            );
          })()}
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn primary" onClick={() => downloadReceipt(detail, name)}>Download receipt (PDF)</button>
            <button className="btn ghost" onClick={() => setDetail(null)}>Close</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

export default PurchaseHistory;
