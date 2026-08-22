import { describe, it, expect } from 'vitest';
import {
  itemKeyFor,
  KNOWN_ITEM_KEYS,
  itemKeyLabel,
  buildFinanceTxns,
  txnInRange,
  defaultLeagueRange,
  defaultEventRange,
  buildFinanceSummary,
  hostPayoutOwedCents,
  type FinanceTxn,
} from '../src/lib/finance';
import type { AccountingCode, Event, HostPayout, Invoice, Payment, RefundRequest } from '../src/lib/types';

describe('itemKeyFor', () => {
  it('maps meet-entry kinds', () => {
    expect(itemKeyFor('meet-entry', 'entry')).toBe('meet-entry:entry');
    expect(itemKeyFor('meet-entry', 'change')).toBe('meet-entry:change');
    expect(itemKeyFor('meet-entry', undefined)).toBe('meet-entry:entry');
    expect(itemKeyFor('meet-entry', 'bogus')).toBe('meet-entry:entry');
  });

  it('maps addon kinds', () => {
    expect(itemKeyFor('addon', 'tshirt')).toBe('addon:tshirt');
    expect(itemKeyFor('addon', 'leo')).toBe('addon:leo');
    expect(itemKeyFor('addon', 'banner')).toBe('addon:banner');
    expect(itemKeyFor('addon', 'banquet')).toBe('addon:banquet');
    expect(itemKeyFor('addon', undefined)).toBe('addon');
    expect(itemKeyFor('addon', 'bogus')).toBe('addon');
  });

  it('passes through everything else as the bare kind', () => {
    expect(itemKeyFor('membership')).toBe('membership');
    expect(itemKeyFor('banquet')).toBe('banquet');
    expect(itemKeyFor('donation')).toBe('donation');
    expect(itemKeyFor('discount')).toBe('discount');
    expect(itemKeyFor('fee')).toBe('fee');
  });

  it('KNOWN_ITEM_KEYS covers every mapped key + itemKeyLabel resolves them', () => {
    for (const key of KNOWN_ITEM_KEYS) {
      expect(itemKeyLabel(key)).not.toBe(key); // every known key has a real label, not a raw fallback
    }
    expect(itemKeyLabel('something-unrecognized')).toBe('something-unrecognized');
  });
});

// --- Fixtures --------------------------------------------------------------

const mkPayment = (overrides: Partial<Payment> = {}): Payment => ({
  id: 'pay1',
  stripeSessionId: 'sess_1',
  stripePaymentIntentId: 'pi_1',
  personId: 'person1',
  status: 'paid',
  amountSubtotal: 10000,
  serviceFee: 130,
  stripeFee: 90,
  currency: 'usd',
  cartItemIds: [],
  refRegIds: [],
  refSeasonId: null,
  refType: null,
  invoiceId: null,
  stripeEventId: null,
  createdAt: '2026-06-10T12:00:00.000Z',
  fulfilledAt: '2026-06-10T12:05:00.000Z',
  ...overrides,
});

const mkInvoice = (overrides: Partial<Invoice> = {}): Invoice => ({
  id: 'inv1',
  number: 'INV-0001',
  clubId: null,
  athleteId: 'person1',
  createdAt: '2026-06-10T12:00:00.000Z',
  paidAt: '2026-06-10T12:05:00.000Z',
  items: [],
  ...overrides,
});

describe('buildFinanceTxns', () => {
  it('uses paidCents from the snapshot when a coupon discounted the line', () => {
    const payment = mkPayment({
      linesSnapshot: [
        { id: 'ci1', kind: 'meet-entry', label: 'Event entry', amountCents: 10000, paidCents: 7000, refEventId: 'ev1', refLineType: 'entry' },
      ],
    });
    const txns = buildFinanceTxns({ payments: [payment], invoices: [], refundRequests: [], events: [] });
    expect(txns).toHaveLength(1);
    expect(txns[0].lines).toEqual([{ itemKey: 'meet-entry:entry', label: 'Event entry', amountCents: 7000, refEventId: 'ev1' }]);
    expect(txns[0].subtotalCents).toBe(7000);
    expect(txns[0].serviceFeeCents).toBe(130);
    expect(txns[0].totalCents).toBe(7130);
  });

  it('falls back to invoice items (dollars -> cents) when there is no snapshot', () => {
    const invoice = mkInvoice({
      items: [
        { id: 'ii1', label: 'Athlete membership', amount: 35, kind: 'membership' },
        { id: 'ii2', label: 'Event entry', amount: 100.5, kind: 'meet-entry', refLineType: 'entry', refEventId: 'ev1' },
      ],
    });
    const payment = mkPayment({ invoiceId: 'inv1', amountSubtotal: 13550 });
    const txns = buildFinanceTxns({ payments: [payment], invoices: [invoice], refundRequests: [], events: [] });
    expect(txns).toHaveLength(1);
    expect(txns[0].lines).toEqual([
      { itemKey: 'membership', label: 'Athlete membership', amountCents: 3500, refEventId: undefined },
      { itemKey: 'meet-entry:entry', label: 'Event entry', amountCents: 10050, refEventId: 'ev1' },
    ]);
    expect(txns[0].subtotalCents).toBe(13550);
    expect(txns[0].invoiceNumber).toBe('INV-0001');
  });

  // UAT M-11-02 / M-20-01: fulfillPayment now persists a `kind: 'discount'`
  // invoice_items row (negative amount) alongside the list-price lines.
  // `buildFinanceTxns` prefers `linesSnapshot` (paidCents, already net of any
  // coupon) whenever it's present — a real payment never hits this fallback
  // AND carries a discount, since every snapshot since T6 has paidCents. But
  // this fallback path (very old pre-snapshot payments) sums `invoice.items`
  // directly, so a discount row must net out there too, not double-count as
  // extra revenue.
  it('nets a persisted discount row via the invoice-items fallback (never double-counts it)', () => {
    const invoice = mkInvoice({
      couponCode: 'EARLYBIRD',
      items: [
        { id: 'ii1', label: 'Event entry', amount: 60, kind: 'meet-entry', refLineType: 'entry', refEventId: 'ev1' },
        { id: 'ii2', label: 'Promo code EARLYBIRD', amount: -10, kind: 'discount' },
      ],
    });
    const payment = mkPayment({ invoiceId: 'inv1', amountSubtotal: 5000 });
    const txns = buildFinanceTxns({ payments: [payment], invoices: [invoice], refundRequests: [], events: [] });
    expect(txns).toHaveLength(1);
    expect(txns[0].lines).toEqual([
      { itemKey: 'meet-entry:entry', label: 'Event entry', amountCents: 6000, refEventId: 'ev1' },
      { itemKey: 'discount', label: 'Promo code EARLYBIRD', amountCents: -1000, refEventId: undefined },
    ]);
    // Gross entry revenue stays the full 6000 (the discount is its own line,
    // not netted into the entry's own gross)...
    const summary = buildFinanceSummary(txns, {});
    const entryLine = summary.lines.find((l) => l.itemKey === 'meet-entry:entry')!;
    const discountLine = summary.lines.find((l) => l.itemKey === 'discount')!;
    expect(entryLine.grossCents).toBe(6000);
    expect(discountLine.grossCents).toBe(-1000);
    // ...but the TOTAL nets it out, matching what was actually collected.
    expect(summary.grossCents).toBe(5000);
    expect(txns[0].subtotalCents).toBe(5000);
  });

  it('excludes pending and failed payments', () => {
    const pending = mkPayment({ id: 'p2', status: 'pending' });
    const failed = mkPayment({ id: 'p3', status: 'failed' });
    const txns = buildFinanceTxns({ payments: [pending, failed], invoices: [], refundRequests: [], events: [] });
    expect(txns).toHaveLength(0);
  });

  it('still produces a payment txn for a refunded-status payment', () => {
    const payment = mkPayment({ status: 'refunded' });
    const txns = buildFinanceTxns({ payments: [payment], invoices: [], refundRequests: [], events: [] });
    expect(txns).toHaveLength(1);
    expect(txns[0].type).toBe('payment');
  });

  it('produces a negative refund txn dated reviewedAt for an approved refund', () => {
    const rr: RefundRequest = {
      id: 'rr1',
      requestGroupId: 'rr1',
      createdAt: '2026-06-01T00:00:00.000Z',
      requesterPersonId: 'person1',
      eventId: 'ev1',
      kind: 'registration',
      status: 'approved',
      reason: 'injury',
      reviewedAt: '2026-06-15T00:00:00.000Z',
      refundAmountCents: 5000,
    };
    const txns = buildFinanceTxns({ payments: [], invoices: [], refundRequests: [rr], events: [] });
    expect(txns).toHaveLength(1);
    expect(txns[0]).toMatchObject({
      id: 'refund:rr1', type: 'refund', date: '2026-06-15T00:00:00.000Z',
      eventIds: ['ev1'], subtotalCents: -5000, serviceFeeCents: 0, stripeFeeCents: 0, totalCents: -5000,
    });
    expect(txns[0].lines).toEqual([{ itemKey: 'meet-entry:entry', label: 'Registration refund', amountCents: -5000, refEventId: 'ev1' }]);
  });

  it('resolves an addon refund itemKey from the linked invoice item', () => {
    const invoice = mkInvoice({
      items: [{ id: 'ii-shirt', label: 'T-shirt', amount: 20, kind: 'addon', refLineType: 'tshirt', refEventId: 'ev1' }],
    });
    const payment = mkPayment({ id: 'payA', invoiceId: 'inv1' });
    const rr: RefundRequest = {
      id: 'rr2', requestGroupId: 'rr2', createdAt: '2026-06-01T00:00:00.000Z', requesterPersonId: 'person1', eventId: 'ev1',
      kind: 'addon', invoiceItemId: 'ii-shirt', paymentId: 'payA', reason: 'other', status: 'approved',
      reviewedAt: '2026-06-16T00:00:00.000Z', refundAmountCents: 2000,
    };
    const txns = buildFinanceTxns({ payments: [payment], invoices: [invoice], refundRequests: [rr], events: [] });
    const refundTxn = txns.find((t) => t.type === 'refund')!;
    expect(refundTxn.lines[0].itemKey).toBe('addon:tshirt');
    expect(refundTxn.invoiceNumber).toBe('INV-0001');
  });

  it('excludes rejected and pending refund requests', () => {
    const base: Omit<RefundRequest, 'id' | 'status' | 'requestGroupId'> = {
      createdAt: '2026-06-01T00:00:00.000Z', requesterPersonId: 'person1', eventId: 'ev1',
      kind: 'registration', reason: 'other', refundAmountCents: 1000,
    };
    const rejected: RefundRequest = { ...base, id: 'rr3', requestGroupId: 'rr3', status: 'rejected' };
    const pendingRr: RefundRequest = { ...base, id: 'rr4', requestGroupId: 'rr4', status: 'pending' };
    const txns = buildFinanceTxns({ payments: [], invoices: [], refundRequests: [rejected, pendingRr], events: [] });
    expect(txns).toHaveLength(0);
  });

  it('sorts transactions date descending', () => {
    const p1 = mkPayment({ id: 'p1', fulfilledAt: '2026-06-01T00:00:00.000Z' });
    const p2 = mkPayment({ id: 'p2', fulfilledAt: '2026-06-20T00:00:00.000Z' });
    const p3 = mkPayment({ id: 'p3', fulfilledAt: '2026-06-10T00:00:00.000Z' });
    const txns = buildFinanceTxns({ payments: [p1, p2, p3], invoices: [], refundRequests: [], events: [] });
    expect(txns.map((t) => t.id)).toEqual(['p2', 'p3', 'p1']);
  });
});

describe('txnInRange', () => {
  const txn: FinanceTxn = {
    id: 't1', type: 'payment', date: '2026-06-15T12:00:00.000Z', eventIds: [],
    description: '', lines: [], subtotalCents: 0, serviceFeeCents: 0, stripeFeeCents: 0, totalCents: 0,
  };

  it('is inclusive of both bounds', () => {
    expect(txnInRange(txn, '2026-06-15T12:00:00.000Z', '2026-06-15T12:00:00.000Z')).toBe(true);
    expect(txnInRange({ ...txn, date: '2026-06-15T11:59:59.999Z' }, '2026-06-15T12:00:00.000Z')).toBe(false);
    expect(txnInRange({ ...txn, date: '2026-06-15T12:00:00.001Z' }, undefined, '2026-06-15T12:00:00.000Z')).toBe(false);
  });

  it('treats missing bounds as open', () => {
    expect(txnInRange(txn)).toBe(true);
    expect(txnInRange(txn, '2099-01-01T00:00:00.000Z')).toBe(false);
    expect(txnInRange(txn, undefined, '2000-01-01T00:00:00.000Z')).toBe(false);
  });
});

describe('defaultLeagueRange', () => {
  it('returns the previous calendar month for a mid-month today', () => {
    expect(defaultLeagueRange('2026-07-16')).toEqual({
      from: '2026-06-01T00:00:00.000Z',
      to: '2026-06-30T23:59:59.999Z',
    });
  });

  it('rolls back across a year boundary', () => {
    expect(defaultLeagueRange('2026-01-10')).toEqual({
      from: '2025-12-01T00:00:00.000Z',
      to: '2025-12-31T23:59:59.999Z',
    });
  });
});

describe('defaultEventRange', () => {
  it('spans regOpens to endDate + 7 days end-of-day', () => {
    const event: Pick<Event, 'regOpens' | 'startDate' | 'endDate'> = {
      regOpens: '2026-05-01T00:00:00.000Z', startDate: '2026-06-10T00:00:00.000Z', endDate: '2026-06-12T00:00:00.000Z',
    };
    expect(defaultEventRange(event)).toEqual({
      from: '2026-05-01T00:00:00.000Z',
      to: '2026-06-19T23:59:59.999Z',
    });
  });

  it('falls back to startDate when endDate is missing, and tolerates a missing regOpens', () => {
    const event: Pick<Event, 'regOpens' | 'startDate' | 'endDate'> = {
      regOpens: '', startDate: '2026-06-10T00:00:00.000Z', endDate: '',
    };
    const result = defaultEventRange(event);
    expect(result.from).toBeUndefined();
    expect(result.to).toBe('2026-06-17T23:59:59.999Z');
  });
});

describe('buildFinanceSummary', () => {
  it('aggregates gross/refunds/net per item key', () => {
    const payment = mkPayment({
      linesSnapshot: [
        { id: 'ci1', kind: 'membership', label: 'Membership', amountCents: 3500, refEventId: undefined },
      ],
      serviceFee: 130, stripeFee: 90,
    });
    const rr: RefundRequest = {
      id: 'rrX', requestGroupId: 'rrX', createdAt: '2026-06-05T00:00:00.000Z', requesterPersonId: 'person1', eventId: 'ev1',
      kind: 'registration', reason: 'injury', status: 'approved', reviewedAt: '2026-06-15T00:00:00.000Z', refundAmountCents: 500,
    };
    const txns = buildFinanceTxns({ payments: [payment], invoices: [], refundRequests: [rr], events: [] });
    const summary = buildFinanceSummary(txns, {});
    const membership = summary.lines.find((l) => l.itemKey === 'membership')!;
    expect(membership.grossCents).toBe(3500);
    expect(membership.netCents).toBe(3500);
    const entry = summary.lines.find((l) => l.itemKey === 'meet-entry:entry')!;
    expect(entry.refundsCents).toBe(500);
    expect(entry.netCents).toBe(-500);
    expect(summary.grossCents).toBe(3500);
    expect(summary.refundsCents).toBe(500);
    expect(summary.netCents).toBe(3000);
    expect(summary.feesCollectedCents).toBe(130);
    expect(summary.feesPaidCents).toBe(90);
    expect(summary.feeProfitCents).toBe(40);
  });

  it('drops a mixed cart line outside the scoped event and prorates fees by line share', () => {
    const payment = mkPayment({
      linesSnapshot: [
        { id: 'ci1', kind: 'meet-entry', label: 'Event entry', amountCents: 3000, refEventId: 'evA', refLineType: 'entry' },
        { id: 'ci2', kind: 'membership', label: 'Membership', amountCents: 1000 },
      ],
      serviceFee: 130, stripeFee: 0,
    });
    const txns = buildFinanceTxns({ payments: [payment], invoices: [], refundRequests: [], events: [] });
    const summary = buildFinanceSummary(txns, { eventId: 'evA' });
    // Only the evA line counts toward gross -- the membership line must not leak in.
    expect(summary.grossCents).toBe(3000);
    expect(summary.lines.find((l) => l.itemKey === 'membership')).toBeUndefined();
    // 130 * 3000/4000 = 97.5 -> rounds to 98
    expect(summary.feesCollectedCents).toBe(98);
  });

  it('does not scope by event when eventId is omitted', () => {
    const payment = mkPayment({
      linesSnapshot: [
        { id: 'ci1', kind: 'meet-entry', label: 'Event entry', amountCents: 3000, refEventId: 'evA', refLineType: 'entry' },
        { id: 'ci2', kind: 'membership', label: 'Membership', amountCents: 1000 },
      ],
      serviceFee: 130, stripeFee: 0,
    });
    const txns = buildFinanceTxns({ payments: [payment], invoices: [], refundRequests: [], events: [] });
    const summary = buildFinanceSummary(txns, {});
    expect(summary.grossCents).toBe(4000);
    expect(summary.feesCollectedCents).toBe(130);
  });

  it('attaches accounting codes by item key', () => {
    const payment = mkPayment({
      linesSnapshot: [{ id: 'ci1', kind: 'membership', label: 'Membership', amountCents: 3500 }],
    });
    const txns = buildFinanceTxns({ payments: [payment], invoices: [], refundRequests: [], events: [] });
    const codes: AccountingCode[] = [{ id: 'ac1', itemKey: 'membership', code: 'QB-100' }];
    const summary = buildFinanceSummary(txns, { accountingCodes: codes });
    expect(summary.lines.find((l) => l.itemKey === 'membership')?.code).toBe('QB-100');
  });

  it('filters host payouts by event and date range', () => {
    const payouts: HostPayout[] = [
      { id: 'hp1', eventId: 'evA', amountCents: 10000, method: 'check', paidOn: '2026-06-15' },
      { id: 'hp2', eventId: 'evB', amountCents: 5000, method: 'ach', paidOn: '2026-06-15' },
      { id: 'hp3', eventId: 'evA', amountCents: 2000, method: 'check', paidOn: '2026-07-15' },
    ];
    const summary = buildFinanceSummary([], {
      eventId: 'evA', from: '2026-06-01T00:00:00.000Z', to: '2026-06-30T23:59:59.999Z', hostPayouts: payouts,
    });
    expect(summary.hostPayoutsCents).toBe(10000);
  });
});

describe('hostPayoutOwedCents', () => {
  it('equals the event summary gross (before fees)', () => {
    const payment = mkPayment({
      linesSnapshot: [{ id: 'ci1', kind: 'meet-entry', label: 'Event entry', amountCents: 3000, refEventId: 'evA', refLineType: 'entry' }],
      serviceFee: 120, stripeFee: 95,
    });
    const txns = buildFinanceTxns({ payments: [payment], invoices: [], refundRequests: [], events: [] });
    const summary = buildFinanceSummary(txns, { eventId: 'evA' });
    const owed = hostPayoutOwedCents(summary);
    expect(owed.owedCents).toBe(summary.grossCents);
    expect(owed.owedCents).toBe(3000); // service/Stripe fees never touch the payout
    expect(owed.parts.find((p) => p.label === 'Total')?.cents).toBe(3000);
  });

  it('does not deduct refunds (per Julia 2026-07-17: hosts handle their own refunds)', () => {
    const payment = mkPayment({
      linesSnapshot: [{ id: 'ci1', kind: 'meet-entry', label: 'Event entry', amountCents: 3000, refEventId: 'evA', refLineType: 'entry' }],
    });
    const rr: RefundRequest = {
      id: 'rr1', createdAt: '2026-06-01T00:00:00.000Z', requesterPersonId: 'person1', eventId: 'evA',
      kind: 'registration', reason: 'injury', status: 'approved', reviewedAt: '2026-06-15T00:00:00.000Z', refundAmountCents: 3000,
    };
    const txns = buildFinanceTxns({ payments: [payment], invoices: [], refundRequests: [rr], events: [] });
    const summary = buildFinanceSummary(txns, { eventId: 'evA' });
    expect(summary.netCents).toBe(0); // the summary itself still nets refunds out…
    const owed = hostPayoutOwedCents(summary);
    expect(owed.owedCents).toBe(3000); // …but the payout owes the full amount collected
  });
});
