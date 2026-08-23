import { useMemo, useState } from 'react';
import { useDB } from '../lib/store';
import { useCapabilities } from '../lib/capabilities';
import { Badge, Modal } from '../components/ui';
import { useFmtDate } from '../components/ui-hooks';
import { fmtMoney } from '../lib/scoring';
import { downloadReceipt, downloadRefundReceipt, invoiceTotal } from '../lib/receipt';
import { InvoiceLineTable } from '../components/InvoiceLineTable';
import { isPersonalInvoice } from '../lib/purchases';
import type { DB, Invoice, InvoiceItem, RefundRequest } from '../lib/types';

/** My Purchase History (UAT round-1, Z-01-02): PERSONAL invoices only —
 *  invoices whose payer is the viewer AND that are not club-cart invoices
 *  (`isPersonalInvoice`). A club invoice a manager happened to pay lives on
 *  that club's OWN Purchase History page (`/club/:id/purchases`,
 *  `ClubPurchaseHistory.tsx`) instead — before this split, both showed up
 *  mixed together here with no way to tell which money was whose. */
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
    // Fallback chain (H4.4): distinct item kinds, then the line labels
    // themselves, then a dated placeholder — never a bare "Purchase" with no
    // information. Uses only data already loaded on `inv`/`items` (no new
    // queries).
    const kinds = [...new Set(items.map((i) => i.kind))];
    if (kinds.length) return kinds.join(', ');
    const labels = [...new Set(items.map((i) => i.label).filter(Boolean))];
    if (labels.length) return labels.join(', ');
    const dateLabel = new Date(inv.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    return `Purchase on ${dateLabel}`;
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
      .filter((inv) => inv.paidAt != null && isPersonalInvoice(inv, personId))
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
              <button className="btn small ghost" onClick={() => setDetail(inv)}>View details →</button>
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
          {/* UAT M-20-01: unfiltered — this page is scoped to PERSONAL
              invoices only now (isPersonalInvoice), so the viewer IS the
              invoice's only athlete; the old per-viewer refUserId filter was
              dead weight here and actively wrong for a shared invoice (see
              InvoiceLineTable's doc comment / ClubPurchaseHistory.tsx, which
              is where that case now lives, unfiltered, with "Paid by"). */}
          <InvoiceLineTable invoice={detail} />
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
