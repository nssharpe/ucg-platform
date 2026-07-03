// Browser-only: generate and directly download a PDF receipt for an invoice.
import { jsPDF } from 'jspdf';
import type { CartItem, Invoice } from './types';
import { fmtMoney } from './scoring';
import { processingFee } from './pricing';

/** Net total of an invoice (refunded items don't count). */
export function invoiceTotal(inv: Invoice): number {
  return inv.items.reduce((sum, i) => sum + (i.refunded ? 0 : i.amount), 0);
}

/** Subtotal before any promo/discount lines (refunded items don't count). */
export function invoiceSubtotal(inv: Invoice): number {
  return inv.items.reduce((sum, i) => sum + (i.refunded || i.kind === 'discount' ? 0 : i.amount), 0);
}

/** Total of discount lines as a positive number (0 when there are none). */
export function invoiceDiscount(inv: Invoice): number {
  return -inv.items.reduce((sum, i) => sum + (i.refunded || i.kind !== 'discount' ? 0 : i.amount), 0);
}

/** Generate and download a PDF receipt for an invoice. */
export function downloadReceipt(inv: Invoice, forName: string): void {
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const margin = 56;
  const pageW = doc.internal.pageSize.getWidth();
  const width = pageW - margin * 2;
  const bottom = doc.internal.pageSize.getHeight() - margin;
  let y = margin;
  const ensure = (h: number) => { if (y + h > bottom) { doc.addPage(); y = margin; } };

  doc.setFont('helvetica', 'bold'); doc.setFontSize(17); doc.setTextColor(20);
  doc.text('United Club Gymnastics', margin, y);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(120);
  doc.text('Payment receipt', margin, y + 16);
  doc.text(`Receipt ${inv.number}`, pageW - margin, y, { align: 'right' });
  const created = new Date(inv.createdAt);
  const dateStr = Number.isNaN(created.getTime()) ? inv.createdAt
    : created.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  doc.text(dateStr, pageW - margin, y + 16, { align: 'right' });
  doc.text(inv.paidAt ? 'Paid' : 'Unpaid', pageW - margin, y + 30, { align: 'right' });
  y += 44;
  doc.setDrawColor(20); doc.line(margin, y, pageW - margin, y); y += 18;

  doc.setTextColor(90); doc.setFontSize(10);
  doc.text(`Billed to: ${forName}`, margin, y); y += 20;

  // Full-price line items (discount lines are summarized separately below).
  doc.setFontSize(10.5);
  for (const i of inv.items.filter((it) => it.kind !== 'discount')) {
    ensure(16);
    doc.setTextColor(30);
    const label = `${i.label}${i.refunded ? ' (refunded)' : ''}`;
    const lines = doc.splitTextToSize(label, width - 90);
    doc.text(lines, margin, y);
    doc.text(fmtMoney(i.refunded ? 0 : i.amount), pageW - margin, y, { align: 'right' });
    y += Math.max(16, lines.length * 13);
  }

  const discount = invoiceDiscount(inv);
  if (discount > 0) {
    // Subtotal, then the promo line, then the discounted total.
    y += 4; ensure(16); doc.setTextColor(90); doc.setFontSize(10.5);
    doc.text('Subtotal', margin, y);
    doc.text(fmtMoney(invoiceSubtotal(inv)), pageW - margin, y, { align: 'right' }); y += 16;
    ensure(16); doc.setTextColor(120);
    doc.text(`Promo code${inv.couponCode ? ` (${inv.couponCode})` : ''}`, margin, y);
    doc.text(`−${fmtMoney(discount)}`, pageW - margin, y, { align: 'right' }); y += 16;
  } else if (inv.couponCode) {
    ensure(16); doc.setTextColor(120);
    doc.text('Promo code applied', margin, y);
    doc.text(inv.couponCode, pageW - margin, y, { align: 'right' }); y += 16;
  }
  y += 6; ensure(24);
  doc.setDrawColor(20); doc.line(margin, y, pageW - margin, y); y += 18;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(20);
  doc.text('Total', margin, y);
  doc.text(fmtMoney(invoiceTotal(inv)), pageW - margin, y, { align: 'right' });

  doc.save(`receipt-${inv.number}.pdf`);
}

/** Generate and download a PRE-PAYMENT PDF for a set of cart items — an estimate
 *  for approval purposes only. Mirrors `downloadReceipt`'s layout (header, item
 *  loop, subtotal/total) but deliberately does NOT claim payment happened: no
 *  "Paid" stamp, and an explicit note that it does not process any payment. */
export function downloadCartInvoice(items: CartItem[], forName: string, title: string): void {
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const margin = 56;
  const pageW = doc.internal.pageSize.getWidth();
  const width = pageW - margin * 2;
  const bottom = doc.internal.pageSize.getHeight() - margin;
  let y = margin;
  const ensure = (h: number) => { if (y + h > bottom) { doc.addPage(); y = margin; } };

  doc.setFont('helvetica', 'bold'); doc.setFontSize(17); doc.setTextColor(20);
  doc.text('United Club Gymnastics', margin, y);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(120);
  doc.text(`Cart estimate — ${title}`, margin, y + 16);
  const now = new Date();
  const dateStr = now.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  doc.text(dateStr, pageW - margin, y, { align: 'right' });
  doc.text('Not paid', pageW - margin, y + 16, { align: 'right' });
  y += 44;
  doc.setDrawColor(20); doc.line(margin, y, pageW - margin, y); y += 18;

  doc.setTextColor(90); doc.setFontSize(10);
  doc.text(`Prepared for: ${forName}`, margin, y); y += 20;

  doc.setFont('helvetica', 'italic'); doc.setFontSize(9.5); doc.setTextColor(140);
  const disclaimerLines = doc.splitTextToSize(
    'This is an estimate of items currently in the cart, for review/approval purposes only. It is not a receipt and does not process any payment.',
    width,
  );
  doc.text(disclaimerLines, margin, y);
  y += disclaimerLines.length * 12 + 10;
  doc.setFont('helvetica', 'normal');

  doc.setFontSize(10.5);
  const subtotal = items.reduce((sum, i) => sum + i.amount, 0);
  for (const i of items) {
    ensure(16);
    doc.setTextColor(30);
    const lines = doc.splitTextToSize(i.label, width - 90);
    doc.text(lines, margin, y);
    doc.text(fmtMoney(i.amount), pageW - margin, y, { align: 'right' });
    y += Math.max(16, lines.length * 13);
  }

  // Service fee: same formula the real checkout charges (processingFee, 3% +
  // $0.30 of the subtotal, rounded UP), so this estimate matches what the
  // member actually sees at checkout instead of just gesturing at "calculated
  // at checkout." No coupon is applied here (coupons are entered AT checkout,
  // not on this pre-checkout estimate) — matches create-checkout-session,
  // which computes the real fee off the POST-discount subtotal.
  const fee = subtotal > 0 ? processingFee(Math.round(subtotal * 100)) / 100 : 0;
  const total = subtotal + fee;

  y += 4; ensure(16); doc.setTextColor(90); doc.setFontSize(10.5);
  doc.text('Subtotal', margin, y);
  doc.text(fmtMoney(subtotal), pageW - margin, y, { align: 'right' }); y += 16;
  ensure(16);
  doc.text('Service fee (card processing)', margin, y);
  doc.text(fmtMoney(fee), pageW - margin, y, { align: 'right' }); y += 16;

  y += 6; ensure(24);
  doc.setDrawColor(20); doc.line(margin, y, pageW - margin, y); y += 18;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(20);
  doc.text('Estimated total', margin, y);
  doc.text(fmtMoney(total), pageW - margin, y, { align: 'right' });
  y += 28;

  doc.setFont('helvetica', 'italic'); doc.setFontSize(9); doc.setTextColor(140);
  ensure(14);
  const disclaimer2 = doc.splitTextToSize(
    'This estimate includes the service fee at the rate charged today; a promo code applied at checkout is not reflected here.',
    width,
  );
  doc.text(disclaimer2, margin, y);

  const filenameSafe = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'cart';
  doc.save(`cart-estimate-${filenameSafe}.pdf`);
}
