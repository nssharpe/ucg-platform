# Feedback batch — agy offload tracker (2026-06-28)

Source: `2026-06-27 Gemini Organized Feedback.md`. Pipeline: agy implements, Claude
reviews. **Hybrid mode:** mechanical cohort self-drives onto a branch (gate-gated
auto-commit), Claude reviews the branch once at the end; reviewed cohort handled
individually with Claude review. Ordered by ROI within each cohort.

## Cohort A — Mechanical (self-driving batch, `batch-mechanical/`)
Low blast radius, well-specified, a correct fix is visible in the diff + caught by the
verify gate. Auto-committed to a branch; Claude reviews the whole branch at the end.

| # | Item | Source |
|---|------|--------|
| 01 | Profile/account-creation form fixes: Student Status defaults blank; grad-year "N/A" not pre-checked & required-until-checked; first/last name port to profile (not "New Member"); coaches not blocked by hidden Student Status | §1 |
| 02 | Remove redundant "add an Athlete membership… Add athlete membership →" text block + separator | §3 |
| 03 | Render BOTH membership holds as two distinct bubbles when waiver + club-payment holds co-exist (use existing `membershipHolds`) | §3 |
| 04 | T&T: allow removing disciplines while ≥1 remains; block removing the last one with the specified notification | §6 |
| 05 | Waiver name enforcement: over-18 direct-link signing must force the same athlete-name match as the inline purchase flow | §3 |

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
- Stripe checkout missing CC inputs / payment fields (payments). §4
- Test payments charge $0, don't log in Stripe, wipe promo codes (payments). §4
- Service-fee margin: currently $0.01 under Stripe's fee → systemic loss (money/pricing). §4

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
