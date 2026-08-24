// Pure withdrawal-plan logic for athlete self-serve withdrawal (product
// owners' spec 2026-08-23) — server-side mirror of src/lib/withdrawal.ts.
// KEEP IN LOCKSTEP — both sides take the same camelCase args (the caller on
// this side maps snake_case DB columns onto them before calling in).

/** Before `lastDateToEdit` (or when the event has none): the registration is
 *  fully REMOVED — the same full-removal shape an on-time refund approval
 *  uses (process-refund, ~L393-450); `scores` cascades via its `reg_id` FK.
 *  At/after it: the registration is KEPT with every apparatus scratched —
 *  never `refunded: true`, since no money moved
 *  (`registrations.withdrawn_at` is what marks this case). */
export type WithdrawalPlan = 'remove' | 'scratch';

export function withdrawalPlan(args: { now: Date; lastDateToEdit: string | null }): WithdrawalPlan {
  if (!args.lastDateToEdit) return 'remove';
  return args.now.getTime() <= new Date(args.lastDateToEdit).getTime() ? 'remove' : 'scratch';
}

/** Which refund-mention variant the athlete's withdrawal confirmation email
 *  uses (rule 6, owners' spec 2026-08-23):
 *   - 'plain': `ucgHosted` is true — really "this event offers the in-app
 *     Request-a-refund flow at all" (`eventIsRefundEligible`'s flag, passed
 *     in under this name to match the spec's literal contract). A
 *     WITHDRAWABLE registration on such an event is, by construction, the
 *     $0 case — a paid>$0 registration there uses "Request a refund"
 *     instead of withdrawal (rule 2) — so there is never anything to
 *     mention refunding.
 *   - 'refund-contact': a non-refund-eligible event (refunds for it are
 *     handled entirely outside this system by the host club), and the
 *     athlete does NOT compete for the host club — direct them to the host
 *     club's contact email.
 *   - 'host-club': same non-refund-eligible event, but the athlete DOES
 *     compete for the host club — omit the refund sentence (their own club
 *     already has them). */
export type WithdrawalEmailVariant = 'plain' | 'refund-contact' | 'host-club';

export function withdrawalEmailVariant(args: {
  ucgHosted: boolean;
  athleteClubId: string | null;
  hostClubId: string | null;
}): WithdrawalEmailVariant {
  if (args.ucgHosted) return 'plain';
  if (args.athleteClubId && args.hostClubId && args.athleteClubId === args.hostClubId) return 'host-club';
  return 'refund-contact';
}
