// Pure payments-reconciliation logic (F4, spec
// docs/specs/2026-07-18-session-queue-e2e-ci-tests-freshness-recon-export-seasons.md
// §F4) — no React/store/Supabase imports. Unit-tested in
// tests/reconciliation.test.ts. Mirrored (NOT imported — Edge Functions
// bundle only their own dir + supabase/functions/_shared, not src/) in
// supabase/functions/_shared/reconciliation.ts; keep the two in sync,
// same convention as _shared/stripe.ts mirroring pricing.ts.
//
// Scope: classify the drift between what OUR records say was refunded on a
// payment (approved `refund_requests` rows) and what Stripe's own
// PaymentIntent/Charge actually shows refunded. A Stripe-Dashboard-issued
// refund never touches `refund_requests` (it bypasses our in-app flow
// entirely), so it always shows up here as an "our side owes more" drift —
// that's the case this whole feature exists to surface.

export type ReconVerdict =
  | 'consistent'
  | 'dashboard-refund-drift-partial'
  | 'dashboard-refund-drift-full'
  | 'record-ahead-of-stripe';

export interface ReconDriftInput {
  /** What the customer was actually charged via Stripe (payment.amount_subtotal
   *  + payment.service_fee), in CENTS. Used only to tell partial vs. full. */
  totalChargedCents: number;
  /** Sum of `refund_requests.refund_amount_cents` for `status='approved'` rows
   *  against this payment — what OUR records believe was refunded. */
  ourApprovedRefundedCents: number;
  /** Stripe's own total refunded amount for the charge, in CENTS (sum of
   *  `charge.refunds.data[].amount`, or `charge.amount_refunded`). */
  stripeRefundedCents: number;
}

/**
 * Classify the drift between our records and Stripe's for one payment.
 *  - 'consistent': the two totals match exactly (both commonly 0 — no
 *    refund on either side — but also matches an in-app refund that was
 *    processed correctly, since `process-refund` always calls Stripe for a
 *    non-zero amount, so the two sides stay in lockstep by construction).
 *  - 'dashboard-refund-drift-{partial,full}': Stripe shows MORE refunded
 *    than our records account for — a Dashboard refund we haven't
 *    reflected. "Full" means Stripe refunded the entire charge amount
 *    (>= totalChargedCents); "partial" means some money remains charged.
 *    The distinction matters because `payments.status` has no
 *    partial-refunded value — only a full drift is eligible to flip
 *    `status` to 'refunded'; a partial drift is bookkeeping-note-only.
 *  - 'record-ahead-of-stripe': OUR records show more refunded than Stripe
 *    does — always a genuine anomaly (e.g. an approved `refund_requests`
 *    row whose Stripe call actually failed silently, or manual DB editing)
 *    and should be surfaced for manual investigation; never auto-resolved
 *    by `mark-refunded` (that op only writes when Stripe shows an
 *    ADDITIONAL refund, i.e. verdicts above).
 */
export function classifyPaymentDrift(input: ReconDriftInput): ReconVerdict {
  const { totalChargedCents, ourApprovedRefundedCents, stripeRefundedCents } = input;
  if (stripeRefundedCents === ourApprovedRefundedCents) return 'consistent';
  if (stripeRefundedCents > ourApprovedRefundedCents) {
    return stripeRefundedCents >= totalChargedCents ? 'dashboard-refund-drift-full' : 'dashboard-refund-drift-partial';
  }
  return 'record-ahead-of-stripe';
}

/** Whether a payment counts as "stuck pending" for Panel A — status still
 *  'pending' and older than the given cutoff. `nowMs`/`createdAtISO` kept as
 *  plain params (no Date-object coupling) so this stays trivially testable. */
export function isStuckPending(status: string, createdAtISO: string, nowMs: number, cutoffMs = 60 * 60 * 1000): boolean {
  if (status !== 'pending') return false;
  return nowMs - Date.parse(createdAtISO) >= cutoffMs;
}

/** Whether a drift verdict is one `mark-refunded` may act on (write a
 *  bookkeeping alignment). `record-ahead-of-stripe` is deliberately NOT
 *  actionable here — see the verdict doc above. */
export function isActionableDrift(verdict: ReconVerdict): boolean {
  return verdict === 'dashboard-refund-drift-full' || verdict === 'dashboard-refund-drift-partial';
}
