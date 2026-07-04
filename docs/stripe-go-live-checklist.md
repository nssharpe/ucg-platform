# Stripe Go-Live Checklist (Phase S5)

Date: 2026-06-26. Status: **not yet executed** — this is the runbook for flipping the
UCG Stripe integration from **test** mode to **live** money. Everything below S1–S4 is
already built, deployed, and proven in **test** mode (account `acct_1TjNQ73b3Mn88V15`
"UCG"). This checklist is the final go-live gate.

> Trust model recap (do not weaken): the browser only *starts* a payment. The verified
> `stripe-webhook` is the **sole** source of truth that completes it — it recomputes every
> amount server-side from `pricing.ts`, never trusts a client-sent dollar amount, and is
> idempotent on the Stripe event id. Swapping test→live keys does not change any of this.

## 0. Pre-flight (account readiness)

- [ ] **Supabase Pro upgrade (backups, optionally PITR).** Deliberately deferred during
      development (decided 2026-07-04) — **hard gate before taking live money**: do not
      run the §2 smoke test until the production project has automated backups.
      Dashboard → NAIGC org → project `wkyerxlgricfphopocoz` → Settings → Billing → Pro.
- [ ] **Stripe account activated for live payments.** In the Stripe Dashboard, complete
      business profile / activation (legal entity, statement descriptor = "UNITED CLUB
      GYMNASTICS" or similar, support email, website).
- [ ] **Payout bank account connected + verified.** Dashboard → Settings → Payouts. Confirm
      the bank account is verified and the **payout schedule** is set (default: daily
      automatic, 2-day rolling). Note the first-payout delay (often 7–14 days for a new
      account).
- [ ] **Tax / 1099-K awareness.** Confirm the business TIN is on file so Stripe can issue
      year-end forms; this is a UCG/NAIGC finance task, not a code change.
- [ ] **Statement descriptor** reviewed so members recognize the charge on their card.

## 1. Swap test → live keys + webhook

All four values below have **live** counterparts in the Stripe Dashboard (toggle "test
mode" OFF before copying). Live keys differ only by prefix; **no code change** is needed.

1. [ ] **Register the LIVE webhook endpoint.** Dashboard (live mode) → Developers →
       Webhooks → Add endpoint:
       `https://wkyerxlgricfphopocoz.supabase.co/functions/v1/stripe-webhook`
       Subscribe exactly these events:
       - `checkout.session.completed`
       - `checkout.session.async_payment_succeeded`
       - `checkout.session.async_payment_failed`
       - `checkout.session.expired`
       Copy the new endpoint's **signing secret** (`whsec_…`, live).
2. [ ] **Set the live secrets on Supabase** (sandbox disabled):
       ```sh
       supabase secrets set STRIPE_SECRET_KEY="sk_live_…" --project-ref wkyerxlgricfphopocoz
       supabase secrets set STRIPE_WEBHOOK_SECRET="whsec_…(live)" --project-ref wkyerxlgricfphopocoz
       ```
       (Fail-closed: if `STRIPE_WEBHOOK_SECRET` is ever unset, the webhook rejects every
       request — so set it before announcing go-live.)
3. [ ] **Build the front end with the live publishable key.** Set in CI / `.env`:
       `VITE_STRIPE_PUBLISHABLE_KEY="pk_live_…"`. This is **build-time** (baked into the
       bundle), so a rebuild + redeploy is required, not just a secret change. Update the
       GitHub Actions deploy env (or repository secret) used by the Pages build.
4. [ ] **Redeploy the two functions** so they pick up the live secrets (secrets are read at
       runtime, but redeploy to be certain the latest code is live):
       ```sh
       supabase functions deploy create-checkout-session --project-ref wkyerxlgricfphopocoz
       supabase functions deploy stripe-webhook --no-verify-jwt --project-ref wkyerxlgricfphopocoz
       ```
       (`stripe-webhook` MUST keep `--no-verify-jwt` — Stripe is the caller and cannot send
       a Supabase JWT; its authenticity is the signature check.)
5. [ ] **Push the live-key front-end build to production** (merge → Pages deploy). Confirm
       `dist/assets` carries the `pk_live_…` value and **no** `VITE_DEV_AUTH_*` literal
       (the dev-auth firewall — grep `dist/assets` for both).

## 2. Real ~$1 smoke test (live mode)

Do this with a **real personal card** on the live site, smallest possible real charge.

- [ ] Pick the cheapest real purchasable line (e.g. a $1 test coupon-reduced item, or the
      lowest real membership). If nothing is ~$1, use the lowest real amount and accept it.
- [ ] Complete checkout end-to-end on production: cart → Embedded Checkout → real card →
      on-page "confirming…" → **Registered/active**.
- [ ] **Verify the webhook fired and fulfilled:** Stripe Dashboard → the event →
      `pending_webhooks: 0` (every endpoint returned 2xx). In Supabase, confirm:
      - the `payments` row flipped to `status='paid'` with `fulfilled_at` set,
      - the `invoices` row was written with a **non-null** `stripe_fee` (real cents) and
        `stripe_payment_intent_id`,
      - the membership/registration was actually activated/flipped paid,
      - the receipt email arrived (real payer).
- [ ] **Confirm the charge in the Stripe Dashboard** (live Payments) and that the balance
      reflects amount − Stripe fee.

## 3. Refund the smoke test

- [ ] **Refund the smoke charge from the Stripe Dashboard** (Payments → the charge →
      Refund → full). This is the manual path — see "Admin refund path (deferred)" below for
      why the in-app refund isn't built yet.
- [ ] Confirm the refund settles. **Known gap:** refunding in the Dashboard does **not**
      currently update our `payments.status` to `refunded` or reverse the fulfillment
      (membership/registration stay active, invoice stays). For the one smoke test, manually
      reconcile (or just leave it — it was your own $1). Track the real fix in the deferred
      refund work below.

## 4. Post-go-live verification

- [ ] First real member purchase watched end-to-end (event 2xx, invoice fee recorded,
      receipt delivered).
- [ ] **First payout lands** in the connected bank account (Dashboard → Payouts) — confirms
      the money actually reaches UCG/NAIGC.
- [ ] Finance dashboards (Phase 5, when built) read `invoices.stripe_fee` and show **real**
      processing cost, not the placeholder rate.

## Rollback

If something is wrong in live mode, re-set the **test** secrets + redeploy + rebuild the FE
with the test `pk_…` to immediately stop taking real money. The webhook fail-closes if the
secret is unset, so clearing `STRIPE_WEBHOOK_SECRET` is an emergency "stop fulfilling" lever.

---

## Admin refund path (DEFERRED — sketch)

Not built in S5 (the user gave discretion; the spec marks it "may defer to the Phase 5
finance work"). Today refunds are issued **manually in the Stripe Dashboard**. The gap: a
Dashboard refund does not reflect back into our data model. When built (recommended
alongside the Phase 5 finance dashboards), the shape is:

1. **`create-refund` Edge Function** (admin / `finance_admin` gated, `edgeErrorMessage`
   unwrap pattern): takes a `paymentId`, looks up the `payments` row's
   `stripe_payment_intent_id`, calls `stripe.refunds.create({ payment_intent })` (full or
   partial), and on success sets `payments.status='refunded'`. Idempotent on the Stripe
   refund id.
2. **Reverse fulfillment** in the same routine (mirror, in reverse, what `stripe-webhook`'s
   `fulfill()` does): deactivate the membership(s)/club membership, flip the linked
   `registrations.paid` back to `false`, mark the invoice/`invoice_items.refunded=true`.
   This is the careful part — reuse the same `cart_item_ids` / `ref_reg_ids` / `ref_type`
   links the payment row already carries.
3. **`charge.refunded` webhook handler** (alternatively/additionally) so refunds initiated
   in the **Dashboard** also flow back: subscribe `charge.refunded`, resolve the payment by
   `stripe_payment_intent_id`, run the same reversal. This closes the §3 manual-reconcile
   gap above.
4. **Admin UI**: a Refund button in the Finance/Payments view → confirm dialog → calls the
   invoker. Contrast-check (AA) any new text/bg.

Until then: **refund in the Stripe Dashboard and reconcile by hand.**
