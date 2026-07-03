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

**B2 — Cart architecture (large, structural):** ✅ **DONE** (2026-07-02, commits
8e1b799/63dadca/40cacd1). Full write-up in CLAUDE.md under "Unified cart + cart-
registration mutation sync". Summary per sub-item:
- Unified cart (merge individual + club cart) — ✅ DONE, full single-page merge (per
  Nate's explicit direction over the lower-risk "keep separate but consistent" option):
  `/cart` renders the person's own cart + a section per club in `caps.managedClubIds`,
  each with its own checkout/receipts. `ClubCart` retired; `/club/:id/cart` redirects.
  Cross-entity "checkout everything" spanning personal + multiple clubs in one Stripe
  session is explicitly out of scope (billing-model constraint) — flagged, not built. §4
- Membership cart isolation + `Checkout Memberships` redirect — ✅ DONE (commit b13943b).
- Meet cards w/ edit+×, action buttons, Print Invoice, Checkout All — ✅ ALL DONE: × was
  already done; edit is a "Return to registration"/"Browse" link per card (same idiom
  used elsewhere in the app, not a new inline-edit modal); Print Invoice is a new
  pre-payment jsPDF export (`downloadCartInvoice`); Checkout-All is duplicated at the
  top AND bottom of every scope. §4
- Cart mutation sync — ✅ DONE: `cart_items.prior_reg_snapshot` (new nullable jsonb
  column, migration `20260702033412`) + `removeCartItemWithSync`/`classifyCartRemoval`
  now delete an unpaid new-entry registration entirely (restoring eligibility) or revert
  a change-fee line's registration(s) to their pre-change snapshot on cart-item removal,
  instead of leaving them mutated/orphaned. Legacy rows with no snapshot fall back to a
  removal-only + an honest "couldn't revert" toast. §4
- Club-cart pricing transparency (subtotal/fees) — ✅ already resolved earlier alongside
  the promo-code work (honest "Subtotal" + "fees shown at checkout" note, no more
  misleading pre-fee "Total"). §4

**Verification note:** live-tested in the dev preview — unified page renders a managed
club's section + receipts; `/club/:id/cart` redirects to `/cart`; Print Invoice
downloads without error; deleting a club-cart line removes the underlying `cart_items`
row (confirmed via direct DB query). Did not destructively test the
delete-registration/revert-registration paths against Nate's real dev-test
registrations — covered by code review + the 9 new `classifyCartRemoval` unit tests
instead.

**Live-test findings (2026-07-02, not from the original feedback doc):**
- ✅ **FIXED — critical regression, real money involved:** `stripe-webhook` was
  unreachable for ~a day (redeployed without `--no-verify-jwt`, which is NOT sticky
  across redeploys — silently reset to requiring auth Stripe can't provide). A real
  test-mode Stripe charge succeeded but the membership/registration never activated,
  with zero errors anywhere. Root-caused via `supabase functions list` showing
  `verify_jwt: true`; fixed + documented prominently in CLAUDE.md (this WILL bite again
  on any future redeploy of `stripe-webhook`/`sms-webhook`/`notify-manager-access-denied`
  without the flag — check `verify_jwt` after every touch). See memory
  `stripe-webhook-verify-jwt-regression`.
- ✅ **FIXED** — Purchase History showed dates in the wrong timezone (raw UTC date
  string vs. the viewer's local day). Now uses the existing `useFmtDate()` hook.

**B3 — Promo codes (money + backend validation):** ✅ **DONE** (commit 52a9ff7, migration
`20260702012205`, both edge functions redeployed). Root cause of "codes vanish at checkout":
`create-checkout-session` never accepted or applied a coupon at all — `Club.tsx`'s own UI
admitted it ("Coupon codes aren't applied to card checkout yet."). Fixed: coupon code
validated + applied entirely server-side, scoped to the matching cart line(s) via the
expanded `Coupon.appliesTo` (`any`/`athlete-membership`/`club-membership`/`coach-membership`/
`meet-entry`); `meet-entry` pairs with a new `appliesToEventId` — the "dynamic list of all
future events" ask — and hard-expires the day after that event ends regardless of the
coupon's own expiration date. `payments.coupon_code` carries the applied code to
`stripe-webhook`, which writes `invoices.coupon_code` (ledger/receipt — already existed, just
never got populated from the Stripe path) and redeems it via the existing `redeem_coupon` RPC.
`CartCheckout.tsx` has the real promo input + Subtotal/Coupon/Fee/Total breakdown; `Admin.tsx`'s
promo-code dropdown + event picker match; `Club.tsx`'s old decorative pre-checkout coupon
preview (never wired to real payment) removed. Verified live end-to-end: created a 10%-off
coupon, applied it during a real membership checkout — subtotal $55 → coupon −$5.50 → fee
recomputed off the discounted amount ($1.79) → total $51.29, confirmed on the actual Stripe
payment form. Build/lint/197 tests pass (3 new coupon hard-expiry tests added). §5

**B4 — Meet management (RLS/roles/money):** Draft/Live-only + timestamp-driven open/close; `Last date to edit` field + role-gated lockout (migration + RLS); club-transfer change-fee dispatch + roster move + pending flag (money/data); synchronized-trampoline same-level backend check. §6

**B5 — Finance dashboards (whole epic):** event + org tiers, date defaults, Summary/Invoices tabs, account codes. Likely defer given budget. §7

**B6 — Email/state regressions (server logic):** waiver-checkout "email sent" but none sent; in-cart membership labeled paid but bubble conflicts (state); admin-access requests routing to League instead of Club Managers; denial-email not firing (notify-manager-access-denied exists — likely a wiring regression); under-18 welcome email AND receipt suppressed until waiver signed + membership active (even when club pays); memberships-checkout completion should email owner confirmation + PDF receipt. §2/§3/§8 / orig L6,72,77

**B8 — Smaller items (review-light):**
- Login: unknown email → immediate alert "No account exists for that email" instead of
  offering reset/magic-link (needs an existence check — `people`-by-email lookup or RPC;
  account-enumeration is accepted per Nate). §2 / orig L73. *(Out of auto-batch: the
  existence check has a right/wrong implementation.)* ✅ **DONE** (2026-07-03): added
  `email_has_account` RPC (migration `20260703035157`, checks `auth.users` not `people`
  — "has an account" means "can sign in") and wired it into `Gate.tsx`'s sign-in failure
  path — a failed sign-in now shows "No account exists for that email." for an unknown
  email and the original Supabase message (e.g. "Invalid login credentials") otherwise.
  Verified live in the browser for both cases.
- Club-membership edit screen must expose: Club name, Short name, State, Club Email,
  Membership Eligibility, "Athletes may push fees to club cart" toggle. orig L78–79.
- Profile Refresh Glitch: refresh after club-cart push / waiting-on-waiver reverts to
  Confirm Profile and allows duplicate club-cart submits (state + double-submit guard). §1 / orig L75.
  ✅ **DONE** (2026-07-03): root cause was `Membership.tsx`'s `allOwned`/initial-`step`
  computation only treating `status === 'active'` as "already done" — a
  `pending-club-payment`/`pending-waiver` row still counted as purchasable, so a remount
  (browser refresh) always re-initialized `step` to `'info'` ("Step 1 of 3 — Confirm your
  info"), even though the member had already completed the flow. Fixed by broadening the
  "already submitted" check to `status !== 'none'` for the `allOwned`/step-init decision
  only (pricing/default-selection logic elsewhere in the file is unchanged). Also hardened
  the actual double-submit path: the club-cart-push `cart_items` id is now deterministic
  (`ci-membership-<club>-<person>-<season>-<type>` instead of `Date.now()`-based) so a
  repeat submit safely upserts onto the same cart line instead of adding a duplicate
  charge line, with the local in-memory cart replaced-in-place to match. Verified live by
  temporarily setting a dev-seed membership to `pending-club-payment` and reloading — the
  page correctly showed the "Pending Payment by club" summary instead of reverting to
  Step 1; DB state restored after.
- Save-vs-Add-to-Cart: no-fee changes (e.g. add/remove T&T apparatus) show `Save`
  (commit immediately) instead of `Add to Cart`. §6 / orig L84,89. ✅ **DONE** (2026-07-03):
  the Save button on an EXISTING registration was previously disabled outright whenever
  the edit wasn't "eligible" for a change fee (a pure apparatus tweak or discipline
  removal) — there was no way to commit those free edits at all. Added
  `regChangeHasDiff` (pricing.ts) to separately gate enablement (any real change) from
  `changeIsEligible` (chargeable change); button now reads "Save" and commits instantly
  when the edit is free. Also had to close a real gap this surfaced: `Club.tsx`/
  `MyRegistrations.tsx`'s change-fee computation didn't consult `changeIsEligible` at
  all (any edit to an existing non-host reg was charged the flat fee whenever the change
  window was open) — now gated so only genuinely eligible edits are charged. Live testing
  surfaced a SEPARATE pre-existing DB bug this exposed: `guard_registration_paid`
  (security hardening 182711) trusted `tg_op`/`OLD`, which are unreliable for the app's
  upsert write pattern — fixed in migration `20260703034325` (see supabase/README.md).

**B7 — Verify-by-eye (no UI tests, hard to auto-verify):** Confirm-My-Account nav flash; hard-refresh flash; transactional-email styling polish. §2

## Clarifications — RESOLVED (2026-06-28)
- §8 FK item: now two concrete DB bugs (see B1).
- Login: "No account exists for that email" wording confirmed; enumeration accepted (B8).

## Suggested sequence
1. Run Cohort A (self-driving). 2. Claude: B1 (critical payments) with review.
3. B6 (cheap server-logic regressions). 4. B2/B3/B4 as budget allows. 5. Defer B5/B7.
