// Pure invoice arithmetic — NO jsPDF import. Kept separate from receipt.ts so
// always-loaded modules (Layout's cart badges via purchases.ts) don't drag the
// PDF library into the main chunk (caught 2026-08-22: main bundle grew
// ~400KB when purchases.ts imported invoiceTotal from receipt.ts).
import type { Invoice } from './types';

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
