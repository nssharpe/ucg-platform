// Browser-only: generate and directly download a PDF receipt for an invoice.
import { jsPDF } from 'jspdf';
// Small (<4KB) rasterized navy mark — plain import (no `?inline`/`?url` query)
// so Vite's default `assetsInlineLimit` (4096 bytes) auto-inlines it as a
// base64 data URI at build time. jsPDF's `addImage` needs raster pixel data
// (base64/Uint8Array/HTMLImageElement) — it has no SVG support without the
// separate `svg2pdf.js` plugin (not installed) — so the brand mark had to be
// rasterized once (via Playwright, offline) from `mark.svg` rather than
// embedded as-is. Licensed brand FONTS still never ship in the repo (EULA);
// this is the vector mark artwork, a different asset class, already
// public/committed as an SVG in this same directory.
import markPng from '../assets/brand/mark.png';
import type { CartItem, Invoice } from './types';
import { fmtMoney } from './scoring';
import { processingFee } from './pricing';

/** Data a refund receipt is built from — deliberately a plain data shape (not
 *  `RefundRequest` directly) so `refundReceiptNumber`/`downloadRefundReceipt`
 *  stay easy to unit test without constructing a full DB. */
export interface RefundReceiptData {
  requestId: string;
  /** When the refund was approved (ISO timestamp). */
  reviewedAt: string;
  itemLabel: string;
  eventName?: string | null;
  refundAmountCents: number;
  /** The original purchase's receipt number, when resolvable from the invoice
   *  the refunded item lived on. */
  originalInvoiceNumber?: string | null;
}

/** Pure: the refund receipt number shown on the PDF, derived from the
 *  `refund_requests` row id so it's stable and traceable back to the request. */
export function refundReceiptNumber(requestId: string): string {
  return `RF-${requestId}`;
}

// Pure invoice math lives in invoice-math.ts (no jsPDF) — re-exported here so
// existing importers keep working.
export { invoiceTotal, invoiceSubtotal, invoiceDiscount } from './invoice-math';
import { invoiceTotal, invoiceSubtotal, invoiceDiscount } from './invoice-math';

// ---------------------------------------------------------------------------
// Brand constants (2026-07-08 rebrand spec) — jsPDF ships Helvetica only, so
// this is color/layout branding, never the licensed Greed Condensed/Suisse
// Intl faces (those must never be embedded in the repo — see
// ui-brand-and-layout.md). ALL CAPS + a little `charSpace` tracking on
// Helvetica Bold stands in for the display face's "feel" without the font.
// ---------------------------------------------------------------------------
const NAVY: [number, number, number] = [30, 43, 56]; // #1E2B38 — headings/rules
const BODY: [number, number, number] = [26, 26, 26]; // near-black — line-item text
const MUTED: [number, number, number] = [90, 90, 90]; // secondary/meta text (~4.7:1 on white)
const SITE_URL = 'unitedgymnastics.org';
const FOOTER_NOTE = `Service fees are non-refundable. Questions: ${SITE_URL}`;

/** A negative amount (a discount row, or a refund's item/total line) renders
 *  as an ASCII hyphen-minus + the absolute value. NOTE: the pre-existing code
 *  this replaces used a real minus glyph (U+2212, "−") here — verified by
 *  actually rendering a sample PDF (jsPDF has no visual-preview test harness,
 *  so this was checked with a throwaway render script, not caught by any
 *  existing test) that jsPDF's standard Helvetica/WinAnsi encoding does NOT
 *  map that glyph correctly: it printed as a stray `"` with broken digit
 *  spacing ("$ 1 0" instead of "$10"). Plain "-" is in WinAnsi and renders
 *  correctly. */
function fmtAmount(n: number): string {
  return n < 0 ? `-${fmtMoney(Math.abs(n))}` : fmtMoney(n);
}

/** One row of a receipt/invoice's line-item table (pure — no jsPDF calls). */
export interface PdfLine {
  label: string;
  /** Dollars; negative for a discount/refund row. */
  amount: number;
  kind: 'item' | 'subtotal' | 'discount' | 'fee' | 'total';
}

/** Pure: the ordered line rows for a paid/pending INVOICE's receipt table —
 *  every non-discount item (a refunded one shown at $0, labeled, never
 *  dropped, so the printed document still shows what was originally on it),
 *  then a Subtotal + discount row pair when a coupon actually discounted
 *  something, then the Total. Extracted from what was inline duplicate logic
 *  across the header rendering so it's independently testable (UAT M-05-01) —
 *  no jsPDF import, no DOM/canvas work, just data in, rows out. */
export function receiptLines(inv: Invoice): PdfLine[] {
  const lines: PdfLine[] = [];
  for (const it of inv.items.filter((i) => i.kind !== 'discount')) {
    lines.push({
      label: `${it.label}${it.refunded ? ' (refunded)' : ''}`,
      amount: it.refunded ? 0 : it.amount,
      kind: 'item',
    });
  }
  const discount = invoiceDiscount(inv);
  if (discount > 0) {
    lines.push({ label: 'Subtotal', amount: invoiceSubtotal(inv), kind: 'subtotal' });
    lines.push({ label: `Promo code${inv.couponCode ? ` (${inv.couponCode})` : ''}`, amount: -discount, kind: 'discount' });
  } else if (inv.couponCode) {
    // A coupon was applied but happened to discount nothing on this invoice
    // (e.g. every eligible line was already $0) — say so rather than silently
    // dropping the promo code off the printed document.
    lines.push({ label: 'Promo code applied', amount: 0, kind: 'discount' });
  }
  lines.push({ label: 'Total', amount: invoiceTotal(inv), kind: 'total' });
  return lines;
}

/** Shared jsPDF plumbing for all three documents below: brand header (logo,
 *  org name + site URL, ALL-CAPS document title + meta lines), a clean
 *  right-aligned line-item table, and the "Service fees are non-refundable"
 *  footer. Kept in one place so the three documents can't visually drift. */
function newDoc() {
  const doc = new jsPDF({ unit: 'pt', format: 'letter' });
  const margin = 56;
  const pageW = doc.internal.pageSize.getWidth();
  const width = pageW - margin * 2;
  const bottom = doc.internal.pageSize.getHeight() - margin;
  // Pure function of (current y, needed height) → the y to actually draw at:
  // unchanged if it fits, or `margin` on a fresh page if it doesn't. Callers
  // thread the RETURNED y through their own local variable rather than
  // reading back a mutated field — a shared hidden "current y" caused a real
  // bug here in an earlier draft: a caller's own `y` went stale the moment
  // `ensure` silently reset the page, so text kept being written far below
  // the new page's actual top.
  const ensure = (y: number, h: number): number => {
    if (y + h > bottom) { doc.addPage(); return margin; }
    return y;
  };
  return { doc, margin, pageW, width, bottom, ensure };
}

/** Draws the logo + org name/site + right-aligned ALL-CAPS title/meta block,
 *  then the navy header rule. Returns the y position to start body content at. */
function drawHeader(
  ctx: ReturnType<typeof newDoc>,
  title: string,
  metaRight: string[],
): number {
  const { doc, margin, pageW } = ctx;
  const logoSize = 30;
  const logoX = margin;
  const logoY = margin - 6;
  doc.addImage(markPng, 'PNG', logoX, logoY, logoSize, logoSize);

  const textX = logoX + logoSize + 10;
  doc.setFont('helvetica', 'bold'); doc.setFontSize(12.5); doc.setTextColor(...NAVY);
  doc.text('UNITED CLUB GYMNASTICS', textX, margin, { charSpace: 0.5 });
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...MUTED);
  doc.text(SITE_URL, textX, margin + 14);

  doc.setFont('helvetica', 'bold'); doc.setFontSize(19); doc.setTextColor(...NAVY);
  doc.text(title, pageW - margin, margin + 2, { align: 'right', charSpace: 0.8 });
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(...MUTED);
  let metaY = margin + 18;
  for (const line of metaRight) {
    doc.text(line, pageW - margin, metaY, { align: 'right' });
    metaY += 13;
  }

  const headerBottom = Math.max(logoY + logoSize + 8, metaY + 2);
  doc.setDrawColor(...NAVY); doc.setLineWidth(1.4);
  doc.line(margin, headerBottom, pageW - margin, headerBottom);
  doc.setLineWidth(0.6);
  return headerBottom + 20;
}

/** Draws a "Billed to" / "Paid by" meta block. Returns the y position after it. */
function drawBilledTo(ctx: ReturnType<typeof newDoc>, y: number, lines: string[]): number {
  const { doc, margin } = ctx;
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(...MUTED);
  let cy = y;
  for (const line of lines) { doc.text(line, margin, cy); cy += 15; }
  return cy + 8;
}

/** Draws the line-item table (column headers, rows, Total emphasis) starting
 *  at `y`. Returns the y position after the table. */
function drawLines(ctx: ReturnType<typeof newDoc>, startY: number, rows: PdfLine[]): number {
  const { doc, margin, pageW, width, ensure } = ctx;
  let y = ensure(startY, 20);

  doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(...MUTED);
  doc.text('DESCRIPTION', margin, y, { charSpace: 0.4 });
  doc.text('AMOUNT', pageW - margin, y, { align: 'right', charSpace: 0.4 });
  y += 6;
  doc.setDrawColor(...NAVY); doc.setLineWidth(0.8);
  doc.line(margin, y, pageW - margin, y);
  y += 16;

  for (const row of rows) {
    if (row.kind === 'total') {
      y = ensure(y + 4, 24);
      doc.setDrawColor(...NAVY); doc.setLineWidth(1.2);
      doc.line(margin, y, pageW - margin, y);
      y += 18;
      doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.setTextColor(...NAVY);
      doc.text(row.label, margin, y, { charSpace: 0.3 });
      doc.text(fmtAmount(row.amount), pageW - margin, y, { align: 'right' });
      y += 22;
      continue;
    }
    y = ensure(y, 16);
    const isMuted = row.kind === 'subtotal' || row.kind === 'discount' || row.kind === 'fee';
    doc.setFont('helvetica', 'normal'); doc.setFontSize(isMuted ? 10 : 10.5);
    doc.setTextColor(...(isMuted ? MUTED : BODY));
    const lines = doc.splitTextToSize(row.label, width - 90);
    doc.text(lines, margin, y);
    doc.text(fmtAmount(row.amount), pageW - margin, y, { align: 'right' });
    y += Math.max(16, lines.length * 13);
  }
  return y;
}

/** Draws the standard "Service fees are non-refundable" footer note a bit
 *  below whatever content came before it. */
function drawFooter(ctx: ReturnType<typeof newDoc>, y: number, extraLine?: string): void {
  const { doc, margin, width, ensure } = ctx;
  let cy = ensure(y + 14, 28);
  doc.setFont('helvetica', 'italic'); doc.setFontSize(8.5); doc.setTextColor(...MUTED);
  const lines = doc.splitTextToSize(FOOTER_NOTE, width);
  doc.text(lines, margin, cy);
  cy += lines.length * 11;
  if (extraLine) {
    cy = ensure(cy, 14);
    const extra = doc.splitTextToSize(extraLine, width);
    doc.text(extra, margin, cy);
  }
}

/** Generate and download a PDF receipt for an invoice. `paidBy` is set for a
 *  club invoice (event-mgmt v2 spec / UAT M-05-01) — the manager who actually
 *  triggered the club-cart payment, when resolvable (`payerLabel`,
 *  `src/lib/purchases.ts`); omitted for a personal invoice, where the payer
 *  and the "billed to" name are always the same person. */
export function downloadReceipt(inv: Invoice, forName: string, opts?: { paidBy?: string }): void {
  const ctx = newDoc();
  const created = new Date(inv.createdAt);
  const dateStr = Number.isNaN(created.getTime()) ? inv.createdAt
    : created.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const title = inv.paidAt ? 'RECEIPT' : 'INVOICE';
  let y = drawHeader(ctx, title, [`No. ${inv.number}`, dateStr, inv.paidAt ? 'Paid' : 'Unpaid']);

  const billedToLines = [`Billed to: ${forName}`];
  if (opts?.paidBy) billedToLines.push(`Paid by: ${opts.paidBy}`);
  y = drawBilledTo(ctx, y, billedToLines);

  y = drawLines(ctx, y, receiptLines(inv));
  drawFooter(ctx, y);

  ctx.doc.save(`receipt-${inv.number}.pdf`);
}

/** Generate and download a PRE-PAYMENT PDF for a set of cart items — an estimate
 *  for approval purposes only. Mirrors `downloadReceipt`'s branded layout but
 *  deliberately does NOT claim payment happened: an "INVOICE" (not "RECEIPT")
 *  title, "Not paid" in the meta block, and the existing estimate disclaimers. */
export function downloadCartInvoice(items: CartItem[], forName: string, title: string): void {
  const ctx = newDoc();
  const now = new Date();
  const dateStr = now.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  let y = drawHeader(ctx, 'INVOICE', [`Estimate — ${title}`, dateStr, 'Not paid']);

  y = drawBilledTo(ctx, y, [`Prepared for: ${forName}`]);

  ctx.doc.setFont('helvetica', 'italic'); ctx.doc.setFontSize(9); ctx.doc.setTextColor(...MUTED);
  const disclaimerLines = ctx.doc.splitTextToSize(
    'This is an estimate of items currently in the cart, for review/approval purposes only. It is not a receipt and does not process any payment.',
    ctx.width,
  );
  y = ctx.ensure(y, disclaimerLines.length * 12 + 10);
  ctx.doc.text(disclaimerLines, ctx.margin, y);
  y += disclaimerLines.length * 12 + 10;

  const subtotal = items.reduce((sum, i) => sum + i.amount, 0);
  // Service fee: same formula the real checkout charges (processingFee, 3% +
  // $0.30 of the subtotal, rounded UP), so this estimate matches what the
  // member actually sees at checkout instead of just gesturing at "calculated
  // at checkout." No coupon is applied here (coupons are entered AT checkout,
  // not on this pre-checkout estimate) — matches create-checkout-session,
  // which computes the real fee off the POST-discount subtotal.
  const fee = subtotal > 0 ? processingFee(Math.round(subtotal * 100)) / 100 : 0;
  const rows: PdfLine[] = [
    ...items.map((i): PdfLine => ({ label: i.label, amount: i.amount, kind: 'item' })),
    { label: 'Subtotal', amount: subtotal, kind: 'subtotal' },
    { label: 'Service fee (card processing)', amount: fee, kind: 'fee' },
    { label: 'Estimated total', amount: subtotal + fee, kind: 'total' },
  ];
  y = drawLines(ctx, y, rows);

  drawFooter(ctx, y, 'This estimate includes the service fee at the rate charged today; a promo code applied at checkout is not reflected here.');

  const filenameSafe = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'cart';
  ctx.doc.save(`cart-estimate-${filenameSafe}.pdf`);
}

/** Generate and download a PDF refund receipt for one APPROVED refund request
 *  (event-mgmt v2 Phase 3, spec §H). Mirrors the other two documents'
 *  branding/layout but is deliberately a SEPARATE document — refunding an
 *  item must never rewrite the original purchase receipt (spec: "individual
 *  item refunds don't disturb the original receipt"), so this never touches
 *  `downloadReceipt`/`invoiceTotal`. */
export function downloadRefundReceipt(data: RefundReceiptData, forName: string): void {
  const ctx = newDoc();
  const receiptNumber = refundReceiptNumber(data.requestId);
  const reviewed = new Date(data.reviewedAt);
  const dateStr = Number.isNaN(reviewed.getTime()) ? data.reviewedAt
    : reviewed.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  let y = drawHeader(ctx, 'REFUND RECEIPT', [`No. ${receiptNumber}`, dateStr, 'Refunded']);

  const billedToLines = [`Refunded to: ${forName}`];
  if (data.originalInvoiceNumber) billedToLines.push(`Original receipt: ${data.originalInvoiceNumber}`);
  y = drawBilledTo(ctx, y, billedToLines);

  const label = data.eventName ? `${data.itemLabel} — ${data.eventName}` : data.itemLabel;
  const amount = -(data.refundAmountCents / 100);
  const rows: PdfLine[] = [
    { label, amount, kind: 'item' },
    { label: 'Total refunded', amount, kind: 'total' },
  ];
  y = drawLines(ctx, y, rows);

  drawFooter(ctx, y, 'Refunded to the original payment method.');

  ctx.doc.save(`refund-receipt-${receiptNumber}.pdf`);
}
