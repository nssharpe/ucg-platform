# Feedback batch tracker (2026-06-28)

Source: `2026-06-27 Gemini Organized Feedback.md` (+ the pre-organization original for
detail). **agy (Google Antigravity CLI) offload pipeline was tried and abandoned**
2026-06-28: it ignored workspace scoping (edited an unrelated Dropbox checkout for
several tasks) and self-drove git (committed to main, claimed a push that never
happened), so it wasn't trustworthy unattended. Reverted to direct Claude
implementation for everything below. See memory `agy-offload-pipeline` for the
post-mortem if this is ever revisited.

## Cohort A — small/mechanical, direct-Claude
| # | Item | Status |
|---|------|--------|
| 01 | Profile/account-creation form fixes: Student Status defaults blank; grad-year "N/A" not pre-checked & required-until-checked; first/last name port to profile (not "New Member"); coaches not blocked by hidden Student Status | ✅ DONE (commit 6aec018, already on origin/main before this batch — done earlier in-session) |
| 01b | **T-shirt size defaults to no-entry + required** (Nate, 2026-06-28) | ✅ DONE (commit 87cb1c7 — PersonForm.tsx; Profile.tsx already required it) |
| 02 | Remove redundant "add an Athlete membership… Add athlete membership →" text block + separator | ✅ DONE + deployed (commit ae28c25) |
| 03 | Render BOTH membership holds as two distinct bubbles when waiver + club-payment holds co-exist (use existing `membershipHolds`) | ✅ DONE (commit 87cb1c7 — Club.tsx roster; Membership.tsx already did this correctly) |
| 04 | T&T: allow removing disciplines while ≥1 remains; block removing the last one with the specified notification | ✅ DONE (commit 87cb1c7 — RegistrationEditor.tsx; verified live incl. exact toast text) |
| 05 | Waiver name enforcement: over-18 direct-link signing must force the same athlete-name match as the inline purchase flow | ✅ DONE + deployed (commit 4214a74, incl. migration `20260628125200_waiver_sign_request_names.sql`) |

**Deployed 2026-06-28** — pushed `6aec018..87cb1c7` to `origin/main` (frontend live via GitHub Actions), migration `20260628125200_waiver_sign_request_names.sql` applied via `supabase db push`, and Edge Functions `record-waiver-signature` + `send-membership-welcome` redeployed. Everything in Cohort A is fully live.

## Cohort B — Reviewed / individual (Claude review required)
Reason each is NOT in the auto-batch in parentheses.

**B1 — Critical broken flows (highest ROI, do first):**
- ✅ **FIXED** (branch `agy/fix-squad-fk`, commit ac559ff) — editing a registration
  from My Registrations → `registrations_squad_id_fkey`. Root cause: `MyRegistrations`
  `saveRegs` passed `old.sessionId` into `pushRegistration`'s `squadId` param. Fixed by
  passing null. §8 / orig L80.
- ✅ **ALREADY FIXED + DEPLOYED** — Meets → Register myself → Add to cart →
  `invoice_items_pkey`. The Events.tsx invoice-stub removal (commit 90c24e8, on
  `origin/main`) already resolved it; `pushCart` writes only `cart_items`. Feedback was
  against an older build — re-test live to confirm. §8 / orig L95.
- ⚠️ **INVESTIGATED, NOT REPRODUCIBLE AS DESCRIBED** — Stripe checkout missing CC
  inputs. Live-tested in the dev preview (real embedded session, real iframe from
  js.stripe.com, correct publishable key from the GH Actions repo variable): the card
  form **renders correctly** with Email/Card/Card-information fields. Could not
  reproduce "no place to enter card information." Possible explanations: fixed by
  earlier session work, or an environment-specific issue on Nate's original test
  (ad-blocker/privacy extension commonly strips Stripe iframes — worth trying an
  incognito window or disabling extensions if it recurs). §4
- ✅ **ROOT-CAUSED + FIXED** (commit 4a4d6e0) — "$0 charge, nothing in Stripe."
  Found the actual smoking-gun artifact live in the DB: invoice `UCG-2026-0028` has a
  REAL `stripe_payment_intent_id` (money was captured) but ZERO `invoice_items`, so its
  receipt showed $0 despite a genuine charge. Root cause: the webhook's idempotency
  guard only *checked* `fulfilled_at`/`status`/`stripe_event_id` without atomically
  *claiming* the payment row — a race window let a duplicate/redelivered webhook event
  read `cart_items` AFTER the winning delivery had already deleted them, so it
  fulfilled with zero line items. Fixed with an atomic `UPDATE ... WHERE fulfilled_at
  IS NULL` claim before any side effect, plus a defensive fallback: if items still come
  back empty despite a captured `amount_subtotal`, write one fallback `invoice_items`
  row from the payment's own authoritative amount so a real charge can never render as
  $0. Deployed (`stripe-webhook`, `create-checkout-session`). **Verification gap:**
  could not complete a full live test purchase — the preview tooling cannot script into
  Stripe's cross-origin embedded-checkout iframe (see memory `stripe-checkout-verification-limit`).
  Build/lint/194 tests pass and the fix deployed cleanly; a manual 4242 test-card
  purchase would fully close the loop. Historical `UCG-2026-0028` was left as-is (dev
  test data) — say the word if you want it backfilled with the same fallback logic. §4
- ✅ **FIXED** (commit 4a4d6e0) — service fee $0.01 under Stripe's fee. `processingFee`
  (both `src/lib/pricing.ts` and `supabase/functions/_shared/stripe.ts`) now rounds the
  3%+$0.30 fee UP (`Math.ceil`) instead of to-nearest, so it never falls a cent short.
  Test updated (`tests/processing-fee.test.ts`). Deployed. §4

**B2 — Cart architecture (large, structural):**
- Unified cart (merge individual + club cart) (architecture). §4
- Membership cart isolation + `Checkout Memberships` redirect; remove `Return to membership purchasing →` (routing/checkout). §4
- Meet cards w/ edit+×, action buttons, Print Invoice, Checkout All (architecture + PDF). §4
- Cart mutation sync — removal/undo reverts My Registrations / restores eligibility / reverts change (state integrity). §4
- Club-cart pricing transparency (subtotal/fees) (part of cart redesign). §4

**B3 — Promo codes (money + backend validation):** Applies-to dropdown incl dynamic events; hard expiration on event-date pass; line-item backend mapping; `Promo code used` ledger column + receipt mapping. §5

**B4 — Meet management (RLS/roles/money):** Draft/Live-only + timestamp-driven open/close; `Last date to edit` field + role-gated lockout (migration + RLS); club-transfer change-fee dispatch + roster move + pending flag (money/data); synchronized-trampoline same-level backend check. §6

**B5 — Finance dashboards (whole epic):** event + org tiers, date defaults, Summary/Invoices tabs, account codes. Likely defer given budget. §7

**B6 — Email/state regressions (server logic):** waiver-checkout "email sent" but none sent; in-cart membership labeled paid but bubble conflicts (state); admin-access requests routing to League instead of Club Managers; denial-email not firing (notify-manager-access-denied exists — likely a wiring regression); under-18 welcome email AND receipt suppressed until waiver signed + membership active (even when club pays); memberships-checkout completion should email owner confirmation + PDF receipt. §2/§3/§8 / orig L6,72,77

**B8 — Smaller items (review-light):**
- Login: unknown email → immediate alert "No account exists for that email" instead of
  offering reset/magic-link (needs an existence check — `people`-by-email lookup or RPC;
  account-enumeration is accepted per Nate). §2 / orig L73. *(Out of auto-batch: the
  existence check has a right/wrong implementation.)*
- Club-membership edit screen must expose: Club name, Short name, State, Club Email,
  Membership Eligibility, "Athletes may push fees to club cart" toggle. orig L78–79.
- Profile Refresh Glitch: refresh after club-cart push / waiting-on-waiver reverts to
  Confirm Profile and allows duplicate club-cart submits (state + double-submit guard). §1 / orig L75.
- Save-vs-Add-to-Cart: no-fee changes (e.g. add/remove T&T apparatus) show `Save`
  (commit immediately) instead of `Add to Cart`. §6 / orig L84,89.

**B7 — Verify-by-eye (no UI tests, hard to auto-verify):** Confirm-My-Account nav flash; hard-refresh flash; transactional-email styling polish. §2

## Clarifications — RESOLVED (2026-06-28)
- §8 FK item: now two concrete DB bugs (see B1).
- Login: "No account exists for that email" wording confirmed; enumeration accepted (B8).

## Suggested sequence
1. Run Cohort A (self-driving). 2. Claude: B1 (critical payments) with review.
3. B6 (cheap server-logic regressions). 4. B2/B3/B4 as budget allows. 5. Defer B5/B7.
