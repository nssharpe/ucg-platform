// membership-signing — what a `pending-waiver` membership becomes once the
// waiver is signed.
//
// This is the server-side mirror of `membershipHolds` (src/lib/capabilities-core.ts).
// Keep the two in lockstep: the client derives the BADGES from `membershipHolds`,
// this derives the STATUS the badges read. If they disagree, a member sees a hold
// the data doesn't justify — which is exactly the bug this module exists to fix.
//
// WHY THIS ISN'T KEYED ON `paid_via`
// ----------------------------------
// `record-waiver-signature` used to split on `paid_via = 'club'`, which conflates
// two different questions:
//
//   "who is going to pay for this?"   → paid_via
//   "is a payment still OUTSTANDING?" → club_cart_pending
//
// Those come apart the moment the club pays BEFORE the guardian signs, which is
// the common order for a minor: the manager checks out the same day, the parent
// signs whenever they get to the email. `fulfill.ts` writes that state as
// `status:'pending-waiver', paid_via:'club', club_cart_pending:false` — paid, but
// still waiting on the waiver. Signing then re-stamped `pending-club-payment` off
// the stale `paid_via` tag, re-asserting a payment hold on an already-paid
// membership AND stranding it: the old `.neq('paid_via','club')` arm meant a
// club-paid row could never reach `active` through this function at all.
//
// It also closes a latent hole. `.neq('paid_via','club')` is SQL `paid_via <>
// 'club'`, which is NULL — not true — when `paid_via IS NULL`. Such a row matched
// NEITHER arm and stuck at `pending-waiver` permanently, with no recovery path,
// since this function is the only pending-waiver → active transition there is.
// `club_cart_pending` is `not null default false` (migration 20260625000509), so
// keying on it has no three-valued-logic trap.

/** The membership fields this decision actually depends on. */
export interface SigningInput {
  /** The explicit "a club still owes this fee" flag, set when a member pushes
   *  the fee to a club cart and cleared server-side by `fulfill.ts` on payment. */
  clubCartPending: boolean;
}

export type SignedStatus = 'active' | 'pending-club-payment';

/** What a `pending-waiver` row becomes when the waiver is signed.
 *
 *  A payment is outstanding ONLY while `club_cart_pending` is true. Everything
 *  else — card, comp, an unset `paid_via`, and a club membership the club has
 *  already paid for — goes straight to `active`, because the waiver was the last
 *  thing holding it.
 *
 *  Note the asymmetry with removal: cancelling an unpaid club-cart line DELETES
 *  the membership row rather than clearing the flag (see `clear-membership-hold`
 *  in src/lib/cart-sync.ts), precisely so "no holds" can never mean "free
 *  membership". That invariant is what makes it safe to treat
 *  `club_cart_pending = false` as "nothing is owed" here. */
export function statusAfterSigning(m: SigningInput): SignedStatus {
  return m.clubCartPending ? 'pending-club-payment' : 'active';
}

/** Whether newly-activating this row should be allowed to trigger the
 *  "first membership" welcome email.
 *
 *  Club-paid memberships are excluded, mirroring `fulfill.ts`'s own
 *  `if (signed && !clubId)` gate. `send-membership-welcome` re-checks server-side
 *  that the person has no club and would reject these anyway — but relying on that
 *  would couple two unrelated questions ("who paid?" vs "do they belong to a
 *  club?"), so the gate is stated explicitly here instead. */
export function welcomeEligible(m: { paidVia: string | null }): boolean {
  return m.paidVia !== 'club';
}
