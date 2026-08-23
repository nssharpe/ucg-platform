// _shared/refund-allocation.ts — mirror of `allocateRegistrationRefund` in
// src/lib/pricing.ts (UAT Z-04, rules 1/2/4). Deno can't import `src/lib`
// code, so this is a byte-for-byte port kept in lockstep — see the source
// function's doc comment in pricing.ts for the full rationale (a registration
// can be paid across MULTIPLE Stripe payments, each must be refunded, change
// lines are never refundable, and the 75%-after-deadline scale applies PER
// PAYMENT so rounding never leaks between payments).

export interface RefundAllocationLine {
  paymentId: string;
  /** `invoice_items.ref_line_type` — a `'change'` line is excluded entirely. */
  refLineType: string | null;
  /** Post-coupon `paid_cents` for this line. */
  paidCents: number;
}

export function allocateRegistrationRefund(
  lines: RefundAllocationLine[],
  opts: { afterDeadline: boolean },
): { paymentId: string; cents: number }[] {
  const byPayment = new Map<string, number>();
  for (const line of lines) {
    if (line.refLineType === 'change') continue;
    byPayment.set(line.paymentId, (byPayment.get(line.paymentId) ?? 0) + line.paidCents);
  }
  return Array.from(byPayment.entries()).map(([paymentId, sumCents]) => ({
    paymentId,
    cents: opts.afterDeadline ? Math.round(sumCents * 0.75) : sumCents,
  }));
}
