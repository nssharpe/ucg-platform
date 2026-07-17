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
- [ ] **Passkey Relying Party = the real domain.** WebAuthn/passkey MFA (enabled
      2026-07-17) is configured with Relying Party ID `nssharpe.github.io` /
      origin `https://nssharpe.github.io`. Passkeys are **domain-bound**: when the
      app moves to `registration.unitedgymnastics.org` (or similar), update
      Dashboard → Auth → Passkeys (Relying Party ID + Origins) to the new domain —
      and note any passkeys enrolled against the old domain will stop working and
      must be re-enrolled (TOTP factors are unaffected; users keep 2FA via code).
- [ ] **Auth Attack Protection** (Dashboard → Auth → Attack Protection):
      - "Prevent use of leaked passwords" — enable (may require the Pro upgrade
        that's already a pre-flight gate above; flip it when upgrading).
      - "Enable Captcha protection" — do NOT flip until the CAPTCHA frontend work
        ships (whats-next §2.2): the toggle enforces a captcha token on ALL auth
        calls, so enabling it early breaks every sign-in/sign-up, including dev
        auto-login and the E2E suite.
- [ ] **Bug-report / support routing emails** — the in-app "Report a problem" widget
      currently routes the "event/rule/policy question" category to the interim
      `jzsharpe+ucghelp@gmail.com` / `nssharpe+ucghelp@gmail.com` aliases (decided
      2026-07-16). Before go-live, replace with the real support address (e.g.
      `info@unitedgymnastics.com`) — the addresses live in the `report-problem`
      Edge Function's routing map.

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
      Refund → full). (In-app refunds shipped emv2 P3, but they only cover
      league-hosted event registrations — a Dashboard refund is the right tool for
      an arbitrary smoke charge.)
- [ ] Confirm the refund settles. **Known gap:** refunding in the Dashboard does **not**
      update our `payments.status` or reverse fulfillment (no `charge.refunded`
      handler yet — see the shipped-refunds note below). For the one smoke test,
      manually reconcile (or just leave it — it was your own $1).

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

## Admin refund path — ✅ SHIPPED (emv2 P3, 2026-07-11)

The sketch that used to live here was superseded by the real implementation:
in-app refunds via `request-refund` / `process-refund` + `#/admin/refunds`
(see CLAUDE.md "Payments → Refunds"). One piece of the sketch is still open and
tracked in whats-next §6 (payments-reconciliation view): a `charge.refunded`
webhook handler, so refunds issued directly in the Stripe **Dashboard** reflect
back into `payments.status` — today those still need manual reconciliation.

## Known gap at go-live: no third-party security review (accepted 2026-07-17)

**Decision (Nate):** go live on automated scanning (Supabomb + similar
Supabase-specific scanners) plus Claude's internal adversarial reviews — defer
the paid third-party engagement (options: `docs/research/2026-07-17-security-review-options.md`).

**What that leaves on the table — the two review layers we DO have are
correlated.** The internal reviews (2026-07-02 money-path review, hardening
1–2, the 2026-07-17 MFA/AAL work) are thorough but share one author-mindset;
scanners only find *known misconfiguration patterns* (missing RLS, exposed
buckets, anon-key probes). Neither reliably finds novel business-logic flaws —
the class an independent human tester is paid to hunt.

Residual risks, honestly stated:

| Risk | Probability | Severity | Worst realistic outcome |
|---|---|---|---|
| **Business-logic money flaw** (a pricing/refund/coupon path we both reasoned about the same wrong way) | Low–moderate — this class survives author review precisely because it's a shared blind spot; we've already caught 5+ internally, which cuts both ways | High | Under- or over-charging real cards; fraudulent free registrations; refund over-payment. Bounded by Stripe volume (small league, low $ per event) and reversibility (refunds), but real money + trust damage with clubs |
| **RLS gap on a PII table** scanners miss (policy exists but predicate is subtly wrong for one role path) | Low — the RLS test scripts + scanners cover the obvious; cross-role edge paths are the residue | **Very high** | Exposure of minors' DOB/contact/emergency data → parental trust collapse, possible state-privacy/COPPA exposure, reportable breach. This is the single scariest cell in this table |
| **Auth/token-flow flaw** (no-login waiver/manager-access links, recovery flows) | Low — token entropy checked, flows reviewed | High | Account takeover of a manager/admin → pivots to the two rows above |
| **Abuse/spam of public functions** (known gap until rate limiting ships) | **High** (it's trivially doable today) | Low–moderate | naigc.org domain reputation damage, Resend suspension, nuisance costs. Mitigated by shipping whats-next §2.2 BEFORE go-live |

**Mitigations bundled with this acceptance:** run Supabomb/scanner sweeps
against staging on every schema-touching release; keep the standing fable-tier
adversarial review on every money/auth/RLS diff; ship rate limiting (§2.2)
before live keys; Supabase Pro backups (§0) bound the blast radius of any
data-mutation exploit; revisit the paid review (~$5k) once real revenue exists —
the calculus flips quickly when weekly volume is no longer trivial.
