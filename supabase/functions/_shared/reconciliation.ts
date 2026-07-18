// _shared/reconciliation.ts — MIRROR of src/lib/reconciliation.ts (Edge
// Functions bundle only their own dir + this `_shared/` folder, not `src/` —
// same reason `_shared/stripe.ts` re-implements pricing.ts rather than
// importing it). Keep the two files in sync; the semantics/doc comments live
// on the src/ copy, this one stays terse.
export type ReconVerdict =
  | 'consistent'
  | 'dashboard-refund-drift-partial'
  | 'dashboard-refund-drift-full'
  | 'record-ahead-of-stripe';

export interface ReconDriftInput {
  totalChargedCents: number;
  ourApprovedRefundedCents: number;
  stripeRefundedCents: number;
}

export function classifyPaymentDrift(input: ReconDriftInput): ReconVerdict {
  const { totalChargedCents, ourApprovedRefundedCents, stripeRefundedCents } = input;
  if (stripeRefundedCents === ourApprovedRefundedCents) return 'consistent';
  if (stripeRefundedCents > ourApprovedRefundedCents) {
    return stripeRefundedCents >= totalChargedCents ? 'dashboard-refund-drift-full' : 'dashboard-refund-drift-partial';
  }
  return 'record-ahead-of-stripe';
}

export function isStuckPending(status: string, createdAtISO: string, nowMs: number, cutoffMs = 60 * 60 * 1000): boolean {
  if (status !== 'pending') return false;
  return nowMs - Date.parse(createdAtISO) >= cutoffMs;
}

export function isActionableDrift(verdict: ReconVerdict): boolean {
  return verdict === 'dashboard-refund-drift-full' || verdict === 'dashboard-refund-drift-partial';
}
