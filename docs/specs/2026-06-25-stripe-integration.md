# Stripe Integration — Design & Phase Plan

Date: 2026-06-25. Status: design approved (brainstormed w/ Nate), not yet built.
Cross-phase source of truth — dispatch subagents from this doc (per CLAUDE.md execution rules).

## Decisions (confirmed by Nate)
- **Integration approach:** Stripe **Embedded Checkout** (`ui_mode: 'embedded'`) — Stripe renders
  the payment form in-page; lowest PCI scope, wallets + SCA for free, least first-integration risk.
  (Not Payment Element, not hosted redirect.)
- **Money routing:** single **UCG Stripe account**; host-club amounts owed are *calculated &
  recorded* and paid **manually** (no Stripe Connect — deferred indefinitely).
- **Processing fee:** passed to the payer as a **service fee** line = **3% + $0.30** of the order
  subtotal (a flat service fee, NOT a card "surcharge" — sidesteps state surcharge law + card-network
  debit rules). Shown as its own cart line.
- **Rollout:** **pilot membership checkout first**, prove the loop, then reuse for meet entries,
  club cart, change fees.
- **Testing:** Stripe **test mode** (free, fake cards) for ~all dev; a small **real ~$1 smoke test**
  on live keys only as the final go-live check. Test cards: `4242…` success, Stripe's decline/3DS
  test cards for failure paths.

## The core architectural shift
Today `completePurchase` (`Cart.tsx:16`) and `Club.tsx` `payClubItems` flip `registrations.paid`
and write invoices **client-side** — unsafe with real money (a client could self-mark paid). After
Stripe, the browser only *starts* a payment; a **verified Stripe webhook** is the sole source of
truth that completes it. Fulfillment moves **server-side**.

### Flow (per checkout)
1. User clicks a cart card's **Proceed to checkout** → FE calls `create-checkout-session` with the
   cart-item ids to pay.
2. `create-checkout-session` (auth'd) **recomputes every amount server-side from `pricing.ts`**
   (client-sent dollars are display-only), adds the service-fee line, creates an Embedded Checkout
   Session, inserts a `pending` `payments` row linking session → person → exact cart items / `refRegIds`
   / `refSeasonId+refType`, returns the session `client_secret`.
3. FE renders Stripe **Embedded Checkout** with that secret; user pays with a test card. Keep the user
   **on-page** (`onComplete`, no `return_url` redirect — avoids HashRouter/GitHub-Pages redirect pain)
   → show a "confirming…" state.
4. Stripe fires `checkout.session.completed` → `stripe-webhook` **verifies the signature** (fail
   closed; same pattern as `sms-webhook`'s Telnyx Ed25519 check) then runs **server-side fulfillment**
   (shared routine): write the invoice, flip the linked `registrations.paid` (clear `updatedPending`),
   activate memberships, record Stripe's **actual fee** from the balance transaction, clear the paid
   cart lines, send the receipt to the **real payer**. **Idempotent** on the Stripe event id.
5. FE "confirming…" state **polls the `payments` row** (self-read RLS) until `status='paid'`, then
   shows Registered/active.

This also fixes existing debt: receipts now fire from the webhook (real payer, only on real payment —
kills the over-claiming "Confirmation emailed" toasts), and the client-side `paid` trust gap closes.

## Data model (one migration in Phase S1)
- New table **`payments`**: `id`, `stripe_session_id` (unique), `stripe_payment_intent_id`,
  `person_id`, `status` (`pending|paid|failed|refunded`), `amount_subtotal`, `service_fee`,
  `stripe_fee` (nullable; filled from balance txn on fulfillment), `currency`, item refs
  (`cart_item_ids text[]`, `ref_reg_ids text[]`, `ref_season_id`, `ref_type`), `invoice_id` (nullable;
  set on fulfillment), `stripe_event_id` (nullable; idempotency), `created_at`, `fulfilled_at`.
  RLS: service-role writes everything; signed-in person may **read own** rows (`person_id` = their
  linked person) for the confirming/polling UI.
- **`invoices`**: add nullable `stripe_payment_intent_id` + `stripe_fee` so **Phase 5 finance** reads
  real fees instead of placeholder rates.
- Idempotency: unique `stripe_session_id`; also short-circuit if `fulfilled_at` already set.

## Trust boundary (non-negotiable)
`create-checkout-session` and `stripe-webhook` recompute all amounts from `pricing.ts` against the
referenced regs/memberships (incl. host-club $0 via existing `registrationEntryFee`, and the new
`processingFee`). Never trust a client-sent amount.

## Edge-function gotchas (bake in to avoid rework)
- Use the Stripe SDK's **`constructEventAsync`** for webhook signature verification (Deno/SubtleCrypto
  is async; the sync `constructEvent` throws in Edge Functions).
- Deploy `stripe-webhook` with **`--no-verify-jwt`** (Stripe is the caller); authenticity is the
  signature check against `STRIPE_WEBHOOK_SECRET`, fail-closed if the secret is unset.
- Secrets (Supabase): `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (set **test** values first).
  Client build-time: `VITE_STRIPE_PUBLISHABLE_KEY` (test pk). Live keys swap in with no code change.
- Deps: `@stripe/stripe-js` + `@stripe/react-stripe-js` (FE); Stripe SDK via `npm:stripe` in functions.

---

## Phases (bite-size, one implementer subagent each; controller stays out of the editor)

> Prereq **S0 — Dev test-auth (Option C)**: see `2026-06-25-dev-test-auth.md`. Build & merge FIRST;
> S3+ verification depends on a signed-in dev `me`. (S1–S2 are backend/pure and don't strictly need it.)

### S1 — Foundations: service fee + data model + deps/config
Pure logic + migration + plumbing. No Stripe calls yet.
- `pricing.ts`: pure `processingFee(subtotalCents)` = `round(subtotal*0.03) + 30`, unit-tested in `tests/`.
- Migration (`supabase migration new payments_and_invoice_stripe_fields`): `payments` table + RLS;
  add `invoices.stripe_payment_intent_id` + `invoices.stripe_fee`.
- `types.ts` (`DB.payments`, `Payment`), `supabase.ts` (`rowToPayment`, `pushPayment`, `loadAll` wiring).
- Add deps: `@stripe/stripe-js`, `@stripe/react-stripe-js`. Add `VITE_STRIPE_PUBLISHABLE_KEY` to
  `vite-env.d.ts` + `.env.example`.
- Files: `src/lib/pricing.ts`, `tests/`, `src/lib/types.ts`, `src/lib/supabase.ts`, migration,
  `package.json`, `src/vite-env.d.ts`, `.env.example`.
- **Controller** pushes the migration at phase end.

### S2 — Backend payment loop (membership scope)
The two Edge Functions + shared fulfillment. Verifiable **without the no-`me` problem** (drive via
Stripe test events / CLI), so it can land before S0 if desired.
- `supabase/functions/_shared/stripe.ts` — Stripe client + helpers (mirror `_shared/resend.ts`).
- `create-checkout-session` — auth'd; recompute membership amounts server-side + service fee; create
  Embedded Checkout Session; insert `pending` `payments` row; return `client_secret`.
- `stripe-webhook` — `constructEventAsync` signature verify; on `checkout.session.completed`
  (+ `async_payment_succeeded`) run shared fulfillment (membership: write invoice, activate
  membership via the existing `membershipHolds`/club-pay logic moved server-side, record `stripe_fee`,
  clear cart lines, `sendReceipt` to payer); idempotent on event id; on `expired`/failed → mark
  `failed`, leave regs pending.
- `supabase.ts` invoker `createCheckoutSession` (+ `edgeErrorMessage` unwrap).
- Files: `supabase/functions/{create-checkout-session,stripe-webhook,_shared/stripe.ts}/…`,
  `src/lib/supabase.ts`.
- **Controller** sets the Stripe secrets (test) + deploys both functions (webhook `--no-verify-jwt`)
  at phase end; registers the webhook endpoint URL in the Stripe **test** dashboard.

### S3 — Front-end membership checkout (needs S0) — ✅ BUILT & DEPLOYED 2026-06-26
> `StripeCheckout.tsx` (Embedded Checkout + confirming→poll `payments` row→paid/failed state
> machine) + `Cart.tsx` `MembershipsCheckout` rewired to launch checkout instead of fulfilling
> (service-fee line shown via `processingFee`; receipt now from the webhook). New
> `fetchPaymentStatus` poll helper. Verified live except the literal test-card submission into
> Stripe's cross-origin iframe (not automatable with the preview/Chrome tooling; webhook
> fulfillment proven in S2) — a manual `4242`/decline pass is still outstanding.
- `StripeCheckout` component using `EmbeddedCheckoutProvider`/`EmbeddedCheckout`, fed `client_secret`
  from `createCheckoutSession`; keep user on-page; "confirming…" state polls the `payments` row until
  `paid`. Contrast-check any new text/bg pair (AA).
- Rewire the memberships checkout (`Cart.tsx` `MembershipsCheckout`) so `completePurchase` **stops
  fulfilling** and instead launches checkout; show the service-fee line in the cart card.
- Verify end-to-end on `ucg-preview` as the seeded user: cart → embedded form → `4242` → webhook →
  "Registered"/active; plus a decline-card path. Responsive sweep (375/768/1280) on the checkout UI.
- Files: `src/pages/Cart.tsx`, new `src/components/StripeCheckout.tsx`, `pricing.ts` (fee line in UI).

### S4 — Extend to meet entries, club cart, change fees — ✅ BUILT 2026-06-26 (not yet deployed)
> Both Edge Functions are now **general**: they recompute EVERY cart-line kind server-side
> (membership / club-membership / member-membership / meet entry / change fee / addon) for BOTH
> self carts and manager-paid club carts. All remaining client-side fulfillment is gone —
> `Cart.tsx` `completePurchase` and `Club.tsx` `payClubItems`/`emailClubReceipt` are **deleted**;
> both now launch the shared `src/components/CartCheckout.tsx` (Embedded Checkout). New migration
> `20260626144305_s4_cart_line_tags.sql` adds `ref_meet_id` + `ref_line_type` to `cart_items` AND
> `invoice_items` (server prices addons + distinguishes entry vs change deterministically) — **applied**.
> The webhook emails the **payer** (the paying manager for club carts) and bills the **club**
> (`invoices.club_id`) for club carts, the payer for self carts. **Deferral:** coupons are NOT applied
> at Stripe checkout (server is the amount source-of-truth) — surfaced honestly in the club-cart UI;
> revisit in S5. **Edge Functions await deploy** (Nate deploys at phase end; the new columns are live).

Reuse S2's two functions; generalize `create-checkout-session` to the other item kinds and move the
remaining client-side fulfillment server-side.
- Generalize amount recomputation to meet-entry + change-fee + club-membership line types (honor
  host-club $0 + `changeIsEligible`).
- Move `Cart.tsx` meet-entry fulfillment and `Club.tsx` `payClubItems` into the shared server
  fulfillment; FE launches Embedded Checkout for the per-meet cards and **Checkout All**.
- Club-cart payer is the **manager** (receipt → manager) — preserve current semantics.
- Files: `supabase/functions/{create-checkout-session,stripe-webhook}/…`, `src/pages/Cart.tsx`,
  `src/pages/Club.tsx`. *(May split per surface if the diff gets large.)*

### S5 — Finance wiring + cleanup + go-live checklist
- Ensure every fulfilled invoice carries the real `stripe_fee` + `stripe_payment_intent_id` (feeds
  Phase 5 finance). Remove now-dead client-side fulfillment paths.
- Optional: admin **refund** path (`create-refund` function + `payments.status='refunded'`); may
  defer to the Phase 5 finance work.
- Go-live checklist (doc): swap test→live keys + webhook secret, register the **live** webhook
  endpoint, do the small real ~$1 smoke test + refund, confirm payout/bank setup.
- Update `CLAUDE.md` (payments now real; `completePurchase` no longer fulfills), `supabase/README.md`
  (payments table + RLS + the two functions), `docs/README.md` roadmap (Stripe ↓ from TODO).

## Cross-cutting verification (every phase)
Per CLAUDE.md: `npm run build`, `npx eslint <touched files incl. supabase/functions/**>`,
`npx vitest run` (+ a vitest test for any new pure logic). Responsive sweep on any checkout UI
(375/768/1280; no overflow; drawer <860px). Contrast (AA) on new text/bg. Subagents create migration
files + edge-fn code but **never** push/deploy — the controller batches `supabase db push` + function
deploys at phase end. Standing finish: branch → verify → merge to `main` → push (deploys live).
