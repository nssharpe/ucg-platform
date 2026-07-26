import { useMemo, useState } from 'react';
import { useDB } from '../lib/store';
import { useCapabilities } from '../lib/capabilities';
import { Badge, Modal } from '../components/ui';
import { useFmtDate } from '../components/ui-hooks';
import { fmtMoney } from '../lib/scoring';
import { downloadReceipt, downloadRefundReceipt, invoiceTotal } from '../lib/receipt';
import type { DB, Invoice, InvoiceItem, RefundRequest } from '../lib/types';

/** Purchases History (MY UCG): every invoice tied to this account — memberships
 *  and event entries — with a plain-English summary, a details overlay, and a
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
  const eventNames = [...new Set(
    db.events.filter((m) => items.some((i) =>
      (i.kind === 'meet-entry' || i.kind === 'addon' || i.kind === 'banquet') && i.label.includes(m.name),
    )).map((m) => m.name),
  )];
  const parts: string[] = [];
  if (hasMembership) parts.push('Memberships');
  if (eventNames.length) parts.push(`Registrations for ${eventNames.join(', ')}`);
  if (parts.length === 0) {
    // Fallback: list distinct item kinds.
    const kinds = [...new Set(items.map((i) => i.kind))];
    return kinds.join(', ') || 'Purchase';
  }
  return parts.join(' & ');
}

function PurchaseHistoryInner({ personId, name }: { personId: string; name: string }) {
  const db = useDB();
  const fmtDate = useFmtDate();
  const [detail, setDetail] = useState<Invoice | null>(null);

  // S4 (money-story UX §2): an unpaid invoice is not a supported member-facing
  // state — UCG never bills; an invoice here is a receipt of money that
  // already moved. Filter to `paidAt != null`; a null-paidAt row is a data
  // anomaly for admin reconciliation (`reconcile-payments`), not something a
  // member should ever see or be asked to act on.
  const invoices = useMemo(() =>
    db.invoices
      .filter((inv) => inv.paidAt != null)
      .filter((inv) => inv.athleteId === personId || inv.items.some((i) => i.refUserId === personId))
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [db.invoices, personId],
  );

  // The invoice item + parent invoice a refund request refers to (mirrors
  // RefundReview.tsx's itemFor — scans every invoice since a refund_requests
  // row only stores invoiceItemId, not the invoice it lives on).
  const itemAndInvoiceFor = (r: RefundRequest): { item: InvoiceItem | null; invoice: Invoice | null } => {
    if (!r.invoiceItemId) return { item: null, invoice: null };
    for (const inv of db.invoices) {
      const item = inv.items.find((i) => i.id === r.invoiceItemId);
      if (item) return { item, invoice: inv };
    }
    return { item: null, invoice: null };
  };

  // Approved refunds visible to this viewer: they requested it, or the
  // refunded item was purchased for them (e.g. a club manager requested it
  // on their behalf) — same visibility shape as the invoices filter above.
  const refunds = useMemo(() => {
    const all = db.refundRequests ?? [];
    return all
      .filter((r) => r.status === 'approved')
      .filter((r) => {
        if (r.requesterPersonId === personId) return true;
        const { item } = itemAndInvoiceFor(r);
        return item?.refUserId === personId;
      })
      .slice()
      .sort((a, b) => (b.reviewedAt ?? b.createdAt).localeCompare(a.reviewedAt ?? a.createdAt));
    // itemAndInvoiceFor closes over db.invoices, recomputed each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db.refundRequests, db.invoices, personId]);

  const eventName = (id: string) => db.events.find((e) => e.id === id)?.name ?? '';

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
                <span style={{ color: 'var(--ink-soft)', fontSize: 13 }}>{fmtDate(inv.createdAt)}</span>
                <Badge tone="ok">Paid</Badge>
                <strong style={{ marginLeft: 'auto' }}>{fmtMoney(invoiceTotal(inv))}</strong>
              </div>
              <p style={{ margin: '8px 0 10px', fontSize: 14 }}>{summarize(inv, db, personId)}</p>
              <button className="btn small ghost" onClick={() => setDetail(inv)}>Click for details →</button>
            </div>
          ))}
        </div>
      )}

      {refunds.length > 0 && (
        <>
          <h2 className="page-title display" style={{ fontSize: 22, marginTop: 28 }}>Refunds</h2>
          <p className="page-sub">Refunds don't change your original receipts above — they're recorded separately.</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {refunds.map((r) => {
              const { item, invoice } = itemAndInvoiceFor(r);
              const itemLabel = item?.label ?? (r.kind === 'registration' ? `${eventName(r.eventId)} — registration entry` : 'Add-on');
              const cents = r.refundAmountCents ?? 0;
              return (
                <div key={r.id} className="card card-pad">
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                    <strong>{itemLabel}</strong>
                    <Badge tone="info">Refunded</Badge>
                    <span style={{ color: 'var(--ink-soft)', fontSize: 13 }}>
                      {r.reviewedAt ? fmtDate(r.reviewedAt) : fmtDate(r.createdAt)}
                    </span>
                    <strong style={{ marginLeft: 'auto' }}>−{fmtMoney(cents / 100)}</strong>
                  </div>
                  <p style={{ margin: '8px 0 10px', fontSize: 14, color: 'var(--ink-soft)' }}>
                    {eventName(r.eventId)}{invoice ? ` · original receipt ${invoice.number}` : ''}
                  </p>
                  <button
                    className="btn small ghost"
                    onClick={() => downloadRefundReceipt({
                      requestId: r.id,
                      reviewedAt: r.reviewedAt ?? r.createdAt,
                      itemLabel,
                      eventName: eventName(r.eventId),
                      refundAmountCents: cents,
                      originalInvoiceNumber: invoice?.number ?? null,
                    }, name)}
                  >
                    Download refund receipt (PDF)
                  </button>
                </div>
              );
            })}
          </div>
        </>
      )}

      {detail && (
        <Modal title={`Receipt ${detail.number}`} onClose={() => setDetail(null)}>
          <div style={{ fontSize: 13.5, color: 'var(--ink-soft)', marginBottom: 12 }}>
            {fmtDate(detail.createdAt)} · Paid · Billed to {name}
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
