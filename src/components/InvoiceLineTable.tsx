import { fmtMoney } from '../lib/scoring';
import type { Invoice } from '../lib/types';

/** UAT M-20-01: the receipt detail table — shared by every "view this
 *  invoice" surface (Cart.tsx's personal/club ReceiptsSection modal,
 *  PurchaseHistory.tsx, ClubPurchaseHistory.tsx) so they can't drift apart on
 *  the one rule that matters: this ALWAYS renders the WHOLE invoice — every
 *  line, the discount row, the persisted service-fee line (already just an
 *  ordinary `kind:'fee'` item — see `_shared/fulfill.ts`), and the total —
 *  never filtered down to "just the viewer's own athlete" the way
 *  PurchaseHistory.tsx's old per-viewer modal used to (harmless for a
 *  personal invoice, where the viewer IS the only athlete on it, but wrong
 *  for a shared club invoice: it silently hid other athletes' lines AND the
 *  refUserId-less discount/fee rows). Deliberately takes only `invoice` —
 *  "billed to"/"paid by" wording varies per caller and stays their
 *  responsibility, rendered above/below this table. */
export function InvoiceLineTable({ invoice }: { invoice: Invoice }) {
  const lineItems = invoice.items.filter((i) => i.kind !== 'discount');
  const subtotal = lineItems.reduce((s, i) => s + (i.refunded ? 0 : i.amount), 0);
  const discount = -invoice.items.filter((i) => i.kind === 'discount').reduce((s, i) => s + (i.refunded ? 0 : i.amount), 0);
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
              <td style={{ color: 'var(--ink-soft)' }}>Promo code{invoice.couponCode ? ` (${invoice.couponCode})` : ''}</td>
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
}

export default InvoiceLineTable;
