// Browser-only: render a printable receipt for an invoice and open the print
// dialog (Save as PDF). Mirrors waiver-proof.ts. A server-generated, emailed PDF
// receipt is a later addition (Phase 6 email step) once that path is verified;
// this gives a reliable downloadable/printable receipt now.
import type { Invoice } from './types';
import { fmtMoney } from './scoring';

const esc = (s: string) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Net total of an invoice (discount items are negative-style 'discount' kind). */
export function invoiceTotal(inv: Invoice): number {
  return inv.items.reduce((sum, i) => sum + (i.refunded ? 0 : i.amount), 0);
}

/** Open a print-ready receipt for an invoice and trigger print. */
export function downloadReceipt(inv: Invoice, forName: string): void {
  const total = invoiceTotal(inv);
  const created = new Date(inv.createdAt);
  const dateStr = Number.isNaN(created.getTime()) ? inv.createdAt
    : created.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const rows = inv.items.map((i) =>
    `<tr><td>${esc(i.label)}${i.refunded ? ' <em>(refunded)</em>' : ''}</td><td class="amt">${esc(fmtMoney(i.refunded ? 0 : i.amount))}</td></tr>`,
  ).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8">
<title>Receipt ${esc(inv.number)}</title>
<style>
  body { font-family: Arial, Helvetica, sans-serif; color: #14233a; max-width: 640px; margin: 40px auto; padding: 0 24px; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #14233a; padding-bottom: 10px; }
  .brand { font-weight: 700; font-size: 18px; }
  .muted { color: #5a6b82; font-size: 12.5px; }
  table { width: 100%; border-collapse: collapse; margin-top: 18px; font-size: 13.5px; }
  td { padding: 8px 6px; border-bottom: 1px solid #d8e0ea; }
  td.amt { text-align: right; white-space: nowrap; }
  .total td { border-top: 2px solid #14233a; border-bottom: none; font-weight: 700; font-size: 15px; padding-top: 10px; }
  .foot { margin-top: 26px; font-size: 11px; color: #8a98ab; }
  @media print { body { margin: 0; } }
</style></head><body>
  <div class="head">
    <div><div class="brand">United Club Gymnastics</div><div class="muted">Payment receipt</div></div>
    <div class="muted" style="text-align:right">Receipt ${esc(inv.number)}<br>${esc(dateStr)}${inv.paidAt ? '<br>Paid' : '<br>Unpaid'}</div>
  </div>
  <div class="muted" style="margin-top:12px">Billed to: <strong style="color:#14233a">${esc(forName)}</strong></div>
  <table><tbody>
    ${rows}
    ${inv.couponCode ? `<tr><td class="muted">Promo code applied</td><td class="amt muted">${esc(inv.couponCode)}</td></tr>` : ''}
    <tr class="total"><td>Total</td><td class="amt">${esc(fmtMoney(total))}</td></tr>
  </tbody></table>
  <p class="foot">Thank you. This receipt was generated from your United Club Gymnastics account.
  Use your browser's “Save as PDF” to keep a copy.</p>
  <script>window.onload = function () { window.print(); };</script>
</body></html>`;
  const w = window.open('', '_blank');
  if (!w) return;
  w.document.open();
  w.document.write(html);
  w.document.close();
}
