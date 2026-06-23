// Browser-only: generate and directly download a PDF receipt for an invoice.
import { jsPDF } from 'jspdf';
import type { Invoice } from './types';
import { fmtMoney } from './scoring';

/** Net total of an invoice (refunded items don't count). */
export function invoiceTotal(inv: Invoice): number {
  return inv.items.reduce((sum, i) => sum + (i.refunded ? 0 : i.amount), 0);
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

  doc.setFontSize(10.5);
  for (const i of inv.items) {
    ensure(16);
    doc.setTextColor(30);
    const label = `${i.label}${i.refunded ? ' (refunded)' : ''}`;
    const lines = doc.splitTextToSize(label, width - 90);
    doc.text(lines, margin, y);
    doc.text(fmtMoney(i.refunded ? 0 : i.amount), pageW - margin, y, { align: 'right' });
    y += Math.max(16, lines.length * 13);
  }
  if (inv.couponCode) {
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
