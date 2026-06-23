// Pure helpers for the SMS send path (Phase 3): cost estimation and consent
// filtering. Kept free of React/runtime deps so they get Vitest coverage like
// the scoring engines (see tests/sms-send.test.ts).

/**
 * Approximate all-in cost of one Telnyx US 10DLC outbound segment, in USD:
 * ~$0.0045 Telnyx base + ~$0.003 carrier (AT&T/T-Mobile) pass-through. This is
 * a display estimate for the Communicate confirmation/log, not a billing figure
 * — tune if Telnyx pricing changes.
 */
export const SMS_COST_PER_SEGMENT_USD = 0.0075;

/** Estimated cost of a blast = segments × recipients × per-segment rate (USD). */
export function estimateSmsCost(segments: number, recipientCount: number): number {
  const raw = segments * recipientCount * SMS_COST_PER_SEGMENT_USD;
  return Math.round(raw * 10000) / 10000;
}

export interface ConsentPartition<T> {
  eligible: T[];
  excluded: T[];
}

/**
 * Split recipients into those who have opted in to SMS (`smsConsent === true`)
 * and those who have not. Only strict `true` counts as consent — `false` and
 * `undefined` are both excluded. Order is preserved within each bucket.
 */
export function partitionByConsent<T extends { smsConsent?: boolean }>(
  recipients: T[],
): ConsentPartition<T> {
  const eligible: T[] = [];
  const excluded: T[] = [];
  for (const r of recipients) {
    if (r.smsConsent === true) eligible.push(r);
    else excluded.push(r);
  }
  return { eligible, excluded };
}
