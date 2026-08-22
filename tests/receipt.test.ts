import { describe, it, expect } from 'vitest';
import { invoiceSubtotal, invoiceDiscount, invoiceTotal } from '../src/lib/receipt';
import type { Invoice, InvoiceItem } from '../src/lib/types';

// UAT M-11-02 / M-20-01: these three derive the receipt's Subtotal / Coupon /
// Total from an invoice's items, including the persisted `kind: 'discount'`
// row `fulfillPayment` now writes (`supabase/functions/_shared/fulfill.ts`) —
// a negative `amount` line that used to never exist, so these paths were
// dormant. Fixture note: `Invoice`/`InvoiceItem` require only a few fields
// for these pure functions, so fixtures below are intentionally minimal.

const mkInvoice = (items: InvoiceItem[], couponCode?: string): Invoice => ({
  id: 'inv1', number: 'INV-0001', clubId: null, athleteId: 'person1',
  createdAt: '2026-08-01T00:00:00.000Z', paidAt: '2026-08-01T00:05:00.000Z',
  items, couponCode,
});

describe('invoiceSubtotal / invoiceDiscount / invoiceTotal (UAT M-11-02 / M-20-01)', () => {
  it('with no discount row: subtotal === total, discount 0', () => {
    const inv = mkInvoice([
      { id: 'ii1', label: 'Event entry', amount: 60, kind: 'meet-entry' },
      { id: 'ii2', label: 'Service fee (card processing)', amount: 2.1, kind: 'fee' },
    ]);
    expect(invoiceSubtotal(inv)).toBe(62.1);
    expect(invoiceDiscount(inv)).toBeCloseTo(0, 5);
    expect(invoiceTotal(inv)).toBe(62.1);
  });

  it('with a discount row: subtotal excludes it, discount is positive, total nets it out', () => {
    const inv = mkInvoice([
      { id: 'ii1', label: 'Event entry', amount: 60, kind: 'meet-entry' },
      { id: 'ii2', label: 'Promo code EARLYBIRD', amount: -10, kind: 'discount' },
      { id: 'ii3', label: 'Service fee (card processing)', amount: 1.8, kind: 'fee' },
    ], 'EARLYBIRD');
    // Subtotal = items EXCLUDING the discount line (60 entry + 1.8 fee).
    expect(invoiceSubtotal(inv)).toBeCloseTo(61.8, 5);
    // Discount is reported as a positive number.
    expect(invoiceDiscount(inv)).toBe(10);
    // Total = subtotal - discount = what was actually paid.
    expect(invoiceTotal(inv)).toBeCloseTo(51.8, 5);
    // Total also equals summing every line's signed amount directly (the
    // discount row's own negative amount nets itself in).
    const directTotal = inv.items.reduce((s, i) => s + i.amount, 0);
    expect(invoiceTotal(inv)).toBeCloseTo(directTotal, 5);
  });

  it('a refunded (non-discount) line does not count toward subtotal or total', () => {
    const inv = mkInvoice([
      { id: 'ii1', label: 'Event entry', amount: 60, kind: 'meet-entry' },
      { id: 'ii2', label: 'T-shirt', amount: 20, kind: 'addon', refunded: true },
    ]);
    expect(invoiceSubtotal(inv)).toBe(60);
    expect(invoiceTotal(inv)).toBe(60);
  });

  it('a refunded discount line does not count toward invoiceDiscount either', () => {
    const inv = mkInvoice([
      { id: 'ii1', label: 'Event entry', amount: 60, kind: 'meet-entry' },
      { id: 'ii2', label: 'Promo code X', amount: -10, kind: 'discount', refunded: true },
    ]);
    expect(invoiceDiscount(inv)).toBeCloseTo(0, 5);
    expect(invoiceTotal(inv)).toBe(60);
  });

  it('multiple discount-eligible lines are all excluded from subtotal, summed for discount', () => {
    const inv = mkInvoice([
      { id: 'ii1', label: 'Event entry', amount: 60, kind: 'meet-entry' },
      { id: 'ii2', label: 'T-shirt', amount: 20, kind: 'addon' },
      { id: 'ii3', label: 'Promo code X', amount: -8, kind: 'discount' },
    ]);
    expect(invoiceSubtotal(inv)).toBe(80);
    expect(invoiceDiscount(inv)).toBe(8);
    expect(invoiceTotal(inv)).toBe(72);
  });
});
