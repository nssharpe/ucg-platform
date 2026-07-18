import { describe, it, expect } from 'vitest';
import { classifyPaymentDrift, isStuckPending, isActionableDrift } from '../src/lib/reconciliation';

describe('classifyPaymentDrift', () => {
  it('is consistent when nothing was refunded on either side', () => {
    const v = classifyPaymentDrift({ totalChargedCents: 10000, ourApprovedRefundedCents: 0, stripeRefundedCents: 0 });
    expect(v).toBe('consistent');
  });

  it('is consistent when an in-app refund matches Stripe exactly (partial)', () => {
    const v = classifyPaymentDrift({ totalChargedCents: 10000, ourApprovedRefundedCents: 3000, stripeRefundedCents: 3000 });
    expect(v).toBe('consistent');
  });

  it('is consistent when an in-app refund matches Stripe exactly (full)', () => {
    const v = classifyPaymentDrift({ totalChargedCents: 10000, ourApprovedRefundedCents: 10000, stripeRefundedCents: 10000 });
    expect(v).toBe('consistent');
  });

  it('flags a full dashboard refund drift when Stripe refunded the entire charge and we recorded nothing', () => {
    const v = classifyPaymentDrift({ totalChargedCents: 10000, ourApprovedRefundedCents: 0, stripeRefundedCents: 10000 });
    expect(v).toBe('dashboard-refund-drift-full');
  });

  it('flags a partial dashboard refund drift when Stripe refunded less than the full charge', () => {
    const v = classifyPaymentDrift({ totalChargedCents: 10000, ourApprovedRefundedCents: 0, stripeRefundedCents: 2500 });
    expect(v).toBe('dashboard-refund-drift-partial');
  });

  it('flags a partial dashboard refund drift on TOP of a prior in-app partial refund', () => {
    // We recorded a $30 in-app refund; Stripe shows $50 refunded total (an
    // extra $20 was refunded from the Dashboard, still short of the full $100).
    const v = classifyPaymentDrift({ totalChargedCents: 10000, ourApprovedRefundedCents: 3000, stripeRefundedCents: 5000 });
    expect(v).toBe('dashboard-refund-drift-partial');
  });

  it('treats a Stripe total that EXCEEDS the charge as full (defensive — should never happen)', () => {
    const v = classifyPaymentDrift({ totalChargedCents: 10000, ourApprovedRefundedCents: 0, stripeRefundedCents: 11000 });
    expect(v).toBe('dashboard-refund-drift-full');
  });

  it('flags record-ahead-of-stripe when our records show MORE refunded than Stripe does', () => {
    const v = classifyPaymentDrift({ totalChargedCents: 10000, ourApprovedRefundedCents: 5000, stripeRefundedCents: 3000 });
    expect(v).toBe('record-ahead-of-stripe');
  });

  it('flags record-ahead-of-stripe when we recorded a refund but Stripe shows none (e.g. a silently-failed Stripe call)', () => {
    const v = classifyPaymentDrift({ totalChargedCents: 10000, ourApprovedRefundedCents: 2500, stripeRefundedCents: 0 });
    expect(v).toBe('record-ahead-of-stripe');
  });
});

describe('isActionableDrift', () => {
  it('is actionable for full and partial dashboard drift', () => {
    expect(isActionableDrift('dashboard-refund-drift-full')).toBe(true);
    expect(isActionableDrift('dashboard-refund-drift-partial')).toBe(true);
  });
  it('is NOT actionable for consistent or record-ahead-of-stripe', () => {
    expect(isActionableDrift('consistent')).toBe(false);
    expect(isActionableDrift('record-ahead-of-stripe')).toBe(false);
  });
});

describe('isStuckPending', () => {
  const now = Date.parse('2026-07-18T12:00:00Z');

  it('is false for a non-pending status regardless of age', () => {
    expect(isStuckPending('paid', '2026-07-18T00:00:00Z', now)).toBe(false);
    expect(isStuckPending('failed', '2026-01-01T00:00:00Z', now)).toBe(false);
  });

  it('is false for a pending payment younger than the 1h cutoff', () => {
    expect(isStuckPending('pending', '2026-07-18T11:30:00Z', now)).toBe(false);
  });

  it('is true for a pending payment exactly at the 1h cutoff', () => {
    expect(isStuckPending('pending', '2026-07-18T11:00:00Z', now)).toBe(true);
  });

  it('is true for a pending payment older than the 1h cutoff', () => {
    expect(isStuckPending('pending', '2026-07-18T09:00:00Z', now)).toBe(true);
  });

  it('honors a custom cutoff', () => {
    expect(isStuckPending('pending', '2026-07-18T11:50:00Z', now, 5 * 60 * 1000)).toBe(true);
    expect(isStuckPending('pending', '2026-07-18T11:56:00Z', now, 5 * 60 * 1000)).toBe(false);
  });
});
