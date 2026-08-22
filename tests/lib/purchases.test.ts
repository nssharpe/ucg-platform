import { describe, it, expect } from 'vitest';
import { isPersonalInvoice, payerLabel, clubCartBadgeCount, matchesClubPurchaseSearch, type PayerPerson } from '../../src/lib/purchases';
import type { Invoice, InvoiceItem, Payment } from '../../src/lib/types';

const mkItem = (overrides: Partial<InvoiceItem> = {}): InvoiceItem => ({
  id: 'ii1', label: 'Event entry', amount: 65, kind: 'meet-entry', ...overrides,
});

const mkInvoice = (overrides: Partial<Invoice> = {}): Invoice => ({
  id: 'inv1', number: 'UCG-2026-0001', clubId: null, athleteId: 'person1',
  createdAt: '2026-06-10T12:00:00.000Z', paidAt: '2026-06-10T12:05:00.000Z',
  items: [mkItem()], ...overrides,
});

const mkPayment = (overrides: Partial<Payment> = {}): Payment => ({
  id: 'pay1', stripeSessionId: 'sess_1', stripePaymentIntentId: 'pi_1', personId: 'person1',
  status: 'paid', amountSubtotal: 6500, serviceFee: 225, stripeFee: 200, currency: 'usd',
  cartItemIds: [], refRegIds: [], refSeasonId: null, refType: null, invoiceId: 'inv1',
  stripeEventId: null, createdAt: '2026-06-10T12:00:00.000Z', fulfilledAt: '2026-06-10T12:05:00.000Z',
  ...overrides,
});

const person1: PayerPerson = { id: 'person1', firstName: 'Jamie', lastName: 'Rivera', email: 'jamie@example.com' };
const person2: PayerPerson = { id: 'person2', firstName: 'Alex', lastName: 'Nguyen' };

describe('isPersonalInvoice (UAT Z-01-02: split My Purchase History from Club Purchase History)', () => {
  it('a personal invoice billed to the viewer is personal', () => {
    expect(isPersonalInvoice(mkInvoice({ athleteId: 'person1' }), 'person1')).toBe(true);
  });

  it('a personal invoice whose line item is for the viewer is personal', () => {
    const inv = mkInvoice({ athleteId: null, items: [mkItem({ refUserId: 'person1' })] });
    expect(isPersonalInvoice(inv, 'person1')).toBe(true);
  });

  it('any invoice with a clubId is NEVER personal, even if the viewer paid it', () => {
    const inv = mkInvoice({ clubId: 'club-a', athleteId: null, items: [mkItem({ refUserId: 'person1' })] });
    expect(isPersonalInvoice(inv, 'person1')).toBe(false);
  });

  it('a personal invoice belonging to someone else is not personal for this viewer', () => {
    expect(isPersonalInvoice(mkInvoice({ athleteId: 'person1' }), 'person2')).toBe(false);
  });
});

describe('payerLabel', () => {
  it('resolves the payer from the matching payment row', () => {
    const inv = mkInvoice({ clubId: 'club-a', athleteId: null });
    const payment = mkPayment({ invoiceId: 'inv1', personId: 'person2' });
    expect(payerLabel(inv, [payment], [person1, person2])).toBe('Alex Nguyen');
  });

  it('falls back to inv.athleteId when no payment row is loaded (personal invoice, e.g. admin-comp)', () => {
    const inv = mkInvoice({ athleteId: 'person1' });
    expect(payerLabel(inv, [], [person1])).toBe('Jamie Rivera');
  });

  it('falls back to email when the person has no name on file', () => {
    const noName: PayerPerson = { id: 'person3', firstName: '', lastName: '', email: 'p3@example.com' };
    const inv = mkInvoice({ athleteId: 'person3' });
    expect(payerLabel(inv, [], [noName])).toBe('p3@example.com');
  });

  it('reads "A club manager" for a club invoice whose payer is not visible to this viewer (RLS)', () => {
    const inv = mkInvoice({ clubId: 'club-a', athleteId: null });
    expect(payerLabel(inv, [], [person1])).toBe('A club manager');
  });

  it('reads "Unknown" for a personal invoice with no resolvable payer at all', () => {
    const inv = mkInvoice({ athleteId: null, items: [mkItem()] });
    expect(payerLabel(inv, [], [person1])).toBe('Unknown');
  });
});

describe('clubCartBadgeCount', () => {
  it('sums cart lines across every managed club', () => {
    const carts = { 'club-a': [mkItem(), mkItem()], 'club-b': [mkItem()], 'club-c': [] };
    expect(clubCartBadgeCount(carts, ['club-a', 'club-b'])).toBe(3);
  });

  it('ignores clubs the viewer does not manage', () => {
    const carts = { 'club-a': [mkItem()], 'club-x': [mkItem(), mkItem()] };
    expect(clubCartBadgeCount(carts, ['club-a'])).toBe(1);
  });

  it('is zero for no managed clubs or empty carts', () => {
    expect(clubCartBadgeCount({}, [])).toBe(0);
    expect(clubCartBadgeCount({ 'club-a': [] }, ['club-a'])).toBe(0);
  });
});

describe('matchesClubPurchaseSearch', () => {
  const inv = mkInvoice({ number: 'UCG-2026-0042', items: [mkItem({ label: 'Regionals entry' })] });

  it('empty query matches everything', () => {
    expect(matchesClubPurchaseSearch(inv, '', 'Alex Nguyen')).toBe(true);
  });

  it('matches the receipt number', () => {
    expect(matchesClubPurchaseSearch(inv, '0042', 'Alex Nguyen')).toBe(true);
  });

  it('matches the payer name (the reason this helper exists separately from ReceiptsSection\'s)', () => {
    expect(matchesClubPurchaseSearch(inv, 'nguyen', 'Alex Nguyen')).toBe(true);
    expect(matchesClubPurchaseSearch(inv, 'nguyen', 'Jamie Rivera')).toBe(false);
  });

  it('matches a line label', () => {
    expect(matchesClubPurchaseSearch(inv, 'regionals', 'Alex Nguyen')).toBe(true);
  });

  it('matches none of the above', () => {
    expect(matchesClubPurchaseSearch(inv, 'zzz-nomatch', 'Alex Nguyen')).toBe(false);
  });
});
