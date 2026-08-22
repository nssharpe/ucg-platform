---
paths:
  - "src/lib/pricing.ts"
  - "src/lib/cart-sync.ts"
  - "src/lib/finance.ts"
  - "src/lib/receipt.ts"
  - "src/pages/Cart.tsx"
  - "src/components/CartCheckout.tsx"
  - "src/components/StripeCheckout.tsx"
  - "supabase/functions/create-checkout-session/**"
  - "supabase/functions/stripe-webhook/**"
  - "supabase/functions/request-refund/**"
  - "supabase/functions/process-refund/**"
  - "supabase/functions/reconcile-payments/**"
  - "supabase/functions/_shared/stripe.ts"
  - "supabase/functions/_shared/fulfill.ts"
---

# Money invariants

Design story: `docs/specs/2026-06-25-stripe-integration.md`,
`docs/specs/2026-06-26-stripe-s4-decomposition.md`. All money flows through **Stripe Embedded
Checkout** via two Edge Functions sharing `_shared/stripe.ts`.

**Any diff touching a file in this rule's scope requires a reviewer-tier adversarial review
before merge, push, or apply. That review is not delegable — see `CLAUDE.md` → Model routing.**

## The core invariant

**The server recomputes every line. Client-sent `amount`s are display-only and NEVER trusted.**
UI never sums client amounts as authoritative — `CartCheckout.tsx` renders the
server-returned Subtotal/Coupon/Fee/Total.

Service fee = 3% + $0.30 rounded UP (`Math.ceil`), mirrored in `src/lib/pricing.ts`.

## `create-checkout-session`

Auth'd; the caller must own the cart items or manage the club.

- **Entry-vs-change is derived from the referenced registrations' STATE** (`paid` /
  `updated_pending`), **NOT** the client `ref_line_type` tag (C4 fix — otherwise a brand-new
  reg can be tagged 'change' to pay a cheap change fee). Three-way split (UAT M-10-01,
  2026-08-21): a line is a pure **change** only when EVERY referenced reg is already
  purchased/re-pended; a pure **entry** only when NONE are; a **MIXED** line (some purchased/
  re-pended, some brand-new — e.g. adding a discipline to an already-paid registration) prices
  as the added disciplines' entry-total PLUS the change fee, as one combined amount
  (`addedDisciplineChangeTotal`/`addedDisciplineChangeTotalDollars`) — never the change fee
  alone, which would undercharge exactly like the original C4 exploit.
- **Ownership (H4):** every `ref_reg_ids` reg must belong to the payer (self cart) or the club
  (club cart); membership `ref_user_id` must be the payer or a club-affiliated person — else 403.
- Inserts a `pending` `payments` row with **`lines_snapshot`**: the validated, server-priced
  line set frozen onto the row so the webhook fulfills from it, not from re-read
  (client-writable) `cart_items`. This closes the TOCTOU where a line's refs could be mutated
  post-create.
- Coupons: the client sends only a code; the server validates and reduces eligible lines per
  `appliesTo` scope (floor 0).
- **$0-total free-order path:** when a coupon fully covers the cart, skip Stripe entirely —
  insert the `payments` row with `stripe_session_id: null` and call the fulfillment core
  directly (inline retry-once + `error_logs` on failure, so a failure never strands the order
  pending forever). FE polls a `'free'` stage instead of mounting Stripe Embedded.

### `PREVIEW BRANCH POINT` — read this before adding any logic

`mode: 'preview'` runs the same auth + H4 ownership + capacity/survey validation + pricing
recompute, then **RETURNS BEFORE ANY WRITE**: no `payments` insert, no `lines_snapshot`, no
Stripe call, no coupon redemption, no coupon reservation.

Search **`PREVIEW BRANCH POINT`** in the function. Everything below it writes, so **new write
logic goes BELOW it**. The one write above it (the capacity hold-refresh) is individually
`if (!isPreview)` guarded.

The client requires a `preview: true` marker in the response, because a deployed function
predating preview mode ignores `mode` and runs a REAL checkout — this produced 7 stray pending
payments during development. **ALWAYS deploy this function before shipping a client that calls
preview.**

## Coupon reservation (M1)

An applied coupon is CLAIMED at session-create via `reserve_coupon` (row-locks the coupon with
`SELECT ... FOR UPDATE`; capacity = `used_count` + live `coupon_reservations`), released on
`checkout.session.expired` / `async_payment_failed`, and converted to a redemption by
`redeem_coupon(code, person, payment_id)`.

Reservations are TIME-BOUNDED (60 min) and self-heal. **Never "fix" a stuck hold by
decrementing `used_count`** — that burns a use permanently when a release doesn't run.
`coupon_reservations` is server-only (RLS on, zero policies); all three RPCs are
service_role-only. Reserving happens strictly BELOW the preview branch point.

## `stripe-webhook`

Deploy `--no-verify-jwt`. Signature via `constructEventAsync`, fail-closed.

- Fulfills **from `payments.lines_snapshot`**, falling back to live `cart_items` only for
  pre-2026-07-02 pending payments with no snapshot.
- Because fulfillment no longer depends on `cart_items`, the **atomic idempotency claim is at
  the END**. All writes (membership activate, `registrations.paid` flip via `ref_reg_ids`,
  invoice + `invoice_items` from snapshot amounts, `cart_items` delete) are idempotent
  deterministic-id upserts, so a mid-fulfillment failure leaves `fulfilled_at` NULL and
  Stripe's retry re-runs cleanly (H1 — no permanently-stuck partial fulfillment). A losing
  concurrent delivery redoes the same idempotent rows; only the claim WINNER redeems the coupon
  and emails the receipt.
- **M5:** before fulfilling, asserts `session.amount_total === amount_subtotal + service_fee`.
  On mismatch it logs to `error_logs` and does NOT fulfill, leaving the payment pending for
  review.
- Club-billed for club carts (`invoices.club_id`), else payer. Real `stripe_fee` from the
  balance txn. Trusts the server-written `payments`/snapshot amounts, never the client.
- Fulfillment logic lives in shared `_shared/fulfill.ts` (`fulfillPayment`) — the same core the
  free-order path calls.

## Cart

`/cart` renders the person's own cart PLUS a section per managed club (shared
`groupCartItems`/`CartCard`/`CartScope`/`ReceiptsSection`). **One payer entity per Stripe
session** (self OR one club) — no cross-entity mega-checkout.

Each line has a ✕ (`removeCartItemWithSync`, `src/lib/cart-sync.ts`):
- unpaid **entry** line → delete the linked reg(s)
- **change** line with `prior_reg_snapshot` → revert them
- change line without snapshot (legacy) → remove line only + honest toast
- anything else → remove line only

Classifier is pure: `classifyCartRemoval` (`pricing.ts`). Its no-`refRegIds` ⇒ remove-only
guard is the legacy-row safety net. `downloadCartInvoice` (`receipt.ts`) is the pre-payment
jsPDF **estimate**, NOT a receipt.

## Refunds

Eligible only for events hosted by an `is_league_host`-flagged club, OR any UCG-hosted event
(`events.ucg_hosted` — these need NO host club; `eventIsRefundEligible` and the `request-refund`
mirror check `ucgHosted` first, and `ucg_hosted` is admin-only writable via guard trigger
`20260722220449` precisely because it grants eligibility).

**Grouped per registration, not per invoice line (UAT Z-04, `20260821150000`).** A refund
REQUEST is one per registration, covering every paid line across every payment that funded it —
a reg paid by an original invoice plus a later "add discipline" invoice has TWO Stripe payments,
and both get refunded under one request. `refund_requests.request_group_id` ties together every
per-(payment, invoice_item) row belonging to one such request (an add-on request is a one-row
group, `request_group_id = id`). `request-refund` enumerates every refundable line and inserts
the whole group in one call; `process-refund` approves/rejects the WHOLE GROUP — reject is one
UPDATE of every pending row (with a required `rejection_reason`, emailed); approve computes a
per-payment allocation (`allocateRegistrationRefund`, `pricing.ts` / mirrored
`_shared/refund-allocation.ts`) and calls `claim_refund_approval` **once per distinct payment**,
continuing to the next payment on a Stripe failure so one payment's failure never blocks the
others (idempotent retry: a later approve on the same group only ever touches rows still
`pending`).

Refundable base = entry-fee + extra-discipline-fee lines only (`invoice_items.kind='meet-entry'`
and `ref_line_type` distinct from `'change'`) — **a change-fee line is never refundable**, full
stop, even for an M-10-01 "mixed" line that also carries an added discipline's entry-total
(that combined line is tagged `ref_line_type:'change'`, so it is entirely excluded — a known,
flagged consequence). Base amount per line is post-coupon `paid_cents` from
`payments.lines_snapshot` (legacy fallback: invoice_item list price). Registrations: 100%
at-or-before `lastDateToEdit`, else 75% — scaled PER PAYMENT, not on the combined total
(`allocateRegistrationRefund`). **Add-ons are a separate, binary rule (D-5):** full refund while
`now <= that add-on type's lastPurchaseAt` (`addonLastPurchaseAt`/`addonPurchaseOpen`,
`_shared/stripe.ts`), refused OUTRIGHT at request time after — no 75% add-on refund exists.
**The service fee is never refunded** in either case. $0-capped approvals skip Stripe.

**The cap and the claim are ONE atomic step per payment — `claim_refund_approval`
(`20260731210000`), UNCHANGED by the grouping rework.** It takes `SELECT … FOR UPDATE` on the
`payments` row, then sums approved refunds, caps, and claims ONE row inside that transaction.
**Never recompute availability in TS and then claim, and never batch multiple payments into one
claim call** — the original two-step shape was the actual 2026-07-31 bug: the per-request claim
keys on the request's own id, so two DIFFERENT pending requests on the SAME payment both read
the same stale baseline. Stripe's ceiling hid it, because Stripe's ceiling is the CHARGE
(`subtotal + fee`) while ours is `subtotal` — so a concurrent pair landing in that gap refunded
part of the service fee. Serialization is per-payment. When a group has more than one pending
row on the SAME payment (e.g. two invoice_items in one invoice), one row is the "carrier" claimed
via the RPC for the full amount; any sibling is flipped to `approved`/`refund_amount_cents:0`
alongside it by a plain UPDATE — never a second RPC call against the same payment.
`revertClaim` deliberately stays outside the lock; a concurrent caller counting a not-yet-reverted
claim gets UNDER-refunded, which self-resolves and errs in the safe direction.

On-time approval deletes the registration; post-deadline keeps it `refunded` + `keep_listed`
with apparatus blanked — applied ONCE per group, only once every payment in that approve call
succeeded (a partial failure leaves the registration untouched and the failed payments' rows
`pending` for retry). A Dashboard-issued refund (bypassing this flow) does NOT reflect back into
`payments.status`.

Host-payout "owed" (confirmed by Julia 2026-07-17): event gross collected (registrations +
add-ons, before service/admin fees); refunds NOT deducted, since hosts handle their own.
Implemented in `src/lib/finance.ts`.

## Stripe CLI

Logged in, account "UCG", test mode. `stripe trigger <event>` fires a signed test event; verify
via `stripe events list` (`pending_webhooks: 0` ⇒ all 2xx — but wait ~20s after triggering;
checking immediately is a false-positive trap). Stuck event:
`stripe events resend <event-id> --webhook-endpoint <id> --confirm`. Supabase has NO remote
function-logs CLI — use the Stripe dashboard side or temp logs. Look up API syntax with
`stripe docs search|api|events ... -N --format=compact` instead of guessing.

Automation limit: typing a test card into Stripe's iframe cannot be automated — the 4242 /
decline pass is a manual step.
