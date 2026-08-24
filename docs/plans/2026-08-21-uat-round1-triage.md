# UAT round 1 — triage and fix plan (lanes A, M, Z)

**Source:** the [UCG Preflight Feedback Sheet](https://docs.google.com/spreadsheets/d/1tBHmut8OCmJXrcH3zaY0g0_GcHvj0T44DDfu1YAIcq0/edit)
— Nate: lanes A + Z (20 steps); Julia: lanes A + M + Z (43 steps). Read 2026-08-21.
**Plan:** [2026-08-19-uat-stress-test-plan.md](2026-08-19-uat-stress-test-plan.md).

**Totals:** 33 distinct findings — **12 × S1**, 5 × S2, 12 × S3, 4 × D (design decisions that
need a spec). Zero S1s were false alarms; three were partly caused by the plan's own wording.

Status key: ☐ not started · 🔧 in progress · ✅ shipped · ❓ blocked on a question below.

---

## ✅ SHIPPED 2026-08-23 — everything below is LIVE (staging + prod)

Migrations applied + verified with RLS probes and a post_score conflict smoke on staging;
9 functions deployed to both projects (webhook trio confirmed verify_jwt=false); frontend
build `b9d4464` live. Only Batch 5 (capacity) remains — at the prototype stage.

### The original pre-ship snapshot (kept for the record)

Every batch below is **implemented, tested, and reviewer-tier-reviewed on branch `fix/uat-round1`**
(31 commits; build ✓, eslint ✓ across all 81 changed files, **1268/1268 vitest**, responsive sweep
375/768/1280 with evidence, admin-MFA gate verified live on staging). Batch 5's clickable
capacity prototype is published for Julia. NOT yet shipped: the PreToolUse guard's confirmation
on `supabase db push` can't be answered in an unattended session, so the 5 migrations —
`20260821140000` invoice counters · `20260821150000` refund groups · `20260822010000`
registrations unique slot · `20260822020000` score compare-and-set · `20260822030000`
problem_reports — are drafted but unapplied, and everything downstream (function deploys,
merge to main) is correctly parked behind them.

**Morning runbook (order matters):**
1. Nate approves the staging push; controller verifies + runs the RLS probes (notes file has them).
2. Nate approves the prod push (pre-checks already ran clean: no dup registrations, no dup
   invoice numbers, max invoice `UCG-2026-0056` seeds the counter).
3. Controller deploys: `create-checkout-session`, `stripe-webhook`, `request-refund`,
   `process-refund`, `judge-entry`, `report-problem`, `request-guardian-waiver`,
   `send-membership-welcome`, `invite-account` (verify_jwt confirmations per hook).
4. Controller merges `fix/uat-round1` → main and pushes (frontend deploy). Frontend MUST NOT
   ship before the migrations (score posting + refunds call the new RPCs/columns).
5. Live smoke: score post + conflict dialog, one $0 checkout, one refund request/approve, a
   problem report appearing in Errors & Problems.


---

## Batch 1 — Money correctness (S1, first)

Money path per CLAUDE.md routing: sonnet drafts, reviewer-tier (Fable) reviews every diff.

| ID | Sev | Finding | Root cause (verified / suspected) | Fix | Status |
|---|---|---|---|---|---|
| M-10-01 | S1 | Change fee $15 per event settings; the cart's "today's rates" repricing turned it into **$90** | Suspected: server preview prices the add-a-discipline edit as a NEW registration (entry $60 + 2nd-discipline $30) instead of 2nd-discipline $30 + change fee $15 = $45. Julia's Z-04-01 confirms the expected arithmetic | Trace `create-checkout-session` preview for `updatedPending` lines; add a vitest for "add discipline to paid reg" = extra-discipline fee + change fee | ☐ |
| M-11-01 | S1 | EARLYBIRD (10% off event entries) discounted add-ons and the change fee too; service fee should be computed on the post-discount subtotal | Confirmed: Q1 answered (EARLYBIRD is `appliesTo: 'meet-entry'`) — change-fee AND add-on lines were mis-tagged `meet-entry` (confirmed, not just add-ons); the service fee was already correctly computed on the post-discount subtotal (no bug there) | 🔧 drafted 2026-08-22 — `CouponScope` gained `'change-fee'`/`'addon'`, retagged the affected `pushLine` calls (incl. the defense-in-depth MIXED line), eligibility extracted to a tested `couponEligibleLine`. Not yet applied/reviewed | 🔧 |
| M-11-02 | S1 | Coupon invisible on the confirmation email and receipt detail (shows undiscounted items + total); PDF names the code but not the amount or the discounted total | Receipts/emails render invoice lines without the discount line | 🔧 drafted 2026-08-22 — `fulfillPayment` now persists a `kind:'discount'` invoice_item and the email renders it before the fee; the three in-app renderers (receipt.ts / Cart.tsx / PurchaseHistory.tsx) already had correct-but-dead `kind==='discount'` handling that now activates. Not yet applied/reviewed | 🔧 |
| M-20-01 | S1 | `#/me/purchases` shows pre-promo total; "view details" shows only the viewer's athlete, not the whole purchase; "Billed to Julia Sharpe" for club-cart purchases should be "Billed to MIT" | Purchase history filters invoice items to the viewer's person instead of rendering the invoice | **Part 1 (pre-promo total) fixed by M-11-02's drafted change** (`invoiceTotal()` is already post-discount once the discount row exists). "View details" scoping + "Billed to" naming are still open — part of the cart/purchase-history restructure (Batch 3) | 🔧 (part 1 only) |
| M-12-02 | S1→S3 | 100%-coupon checkout: banquet ticket marked purchased, registration still "Pending Purchase" — **hard reload fixed it** | Data is right; the client doesn't apply fulfillment to local registrations after the $0 path (no Stripe redirect → no reload) | After a free checkout, refetch regs/invoices before returning to the cart | ☐ |
| M-12-01 | S3 | 100% coupon checks out instantly; wants a $0 total + explicit Confirm | Free path short-circuits | Show the $0 summary and a "Confirm (no charge)" button | ☐ |
| Z-02-01 | S1 | Admin + manager register the **same athlete for the same event simultaneously** → two invoices, two Stripe charges, two emails, one visible registration | No uniqueness guard on (event, athlete, discipline); each checkout fulfilled its own lines | (1) DB: partial unique index on live registrations (event_id, athlete_id, discipline) where not refunded; (2) `create-checkout-session` refuses a line whose reg is already paid by another invoice; (3) webhook: if fulfillment hits the unique violation, auto-refund that charge and email "already registered" | ☐ |
| Z-01 (Nate's note) | — | Invoice numbers from a row COUNT are not concurrency-safe; make it safe now rather than hoping | Known (whats-next §3.1) | DB sequence per year → `UCG-YYYY-XXXX` (Julia's D-4 format). Promote from "go-live gate" to this batch | ☐ |
| Z-04-01 | S1 | Refund requests are generated **per invoice line**, so a registration paid across two invoices (original + change) produces two requests; rejecting one and approving the other refunded $0 | `RefundRequestDialog` and `process-refund` are keyed on `invoice_item_id` | Rework to **one request per registration** aggregating all paid lines for it; refundable base = entry + extra-discipline fees; change fees never refundable (Q2 confirmed the rule set) | 🔧 drafted 2026-08-21 (`20260821150000_refund_request_groups.sql`, `request-refund`/`process-refund` rewritten) — not yet applied/reviewed |
| Z-04-02 | S1 | "Processing fees were refunded" | `process-refund` explicitly caps at `amount_subtotal` and never refunds the service fee — so either the screenshot shows the Stripe fee reversal (Stripe returns its own fee on refunds; that's not UCG's service fee), or the per-line `paid_cents` includes a fee share | Q3 confirmed: Stripe's own fee reversal, not UCG's service fee — no code defect here beyond Z-04-01's change-fee-line bug, which this rework fixes | ✅ resolved via Z-04-01's rework — no separate change needed |
| Z-04-03 | S3 | Rejecting a refund should take a free-text reason that goes into the email | Not built | Reason textarea on reject → stored + rendered in the rejection email | 🔧 drafted 2026-08-21 (`rejection_reason` column + required `RejectDialog` textarea + rejection email) — not yet applied/reviewed |
| Z-04-01 (Nate) | S3 | Second approver of an already-approved request gets "already reviewed" but the row stays Pending until refresh; if the outcome matches, just move it to history silently | Client doesn't refetch after the 409 | On "already reviewed": refetch the queue; suppress the toast when outcomes match | 🔧 drafted 2026-08-21 (`decideAfterConflict` pure helper + `RefundReview.tsx` refetch-on-409) — not yet applied/reviewed |

## Batch 2 — Auth, invites, emails (S2/S3)

| ID | Sev | Finding | Fix | Status |
|---|---|---|---|---|
| A-11-01 | S2 | Admin-MFA prompt is dismissable once per tab-session and never returns; Julia wants admins **blocked from admin actions** until enrolled, re-prompted on every sign-in | `AdminMfaNag` dismissal is `sessionStorage`, which survives sign-out in the same tab. Fix: clear on sign-out; AND gate admin routes (`RequireAdmin`) on an enrolled factor — athlete-side pages stay usable (Q4: **agreed**, admin pages only) | ✅ 2026-08-22 — `RequireAdmin` hard-blocks on `useAdminMfaSatisfied`; `AdminMfaNag` deleted (not kept as a banner). Notes: `docs/plans/notes/2026-08-21-uat-round1-notes.md` |
| A-07-02 | S2 | Invite link lands on the signed-out home page | Root-caused 2026-08-22 to a real ordering bug (Supabase's own `hash=''` bounce racing `SetPasswordRedirect`'s cleanup), not a missing type=invite handler — see `.claude/rules/auth-and-mfa.md` → "HashRouter vs Supabase implicit flow" | ✅ 2026-08-22 — module-load-captured `?setpw=invite`/`?setpw=reset` marker; lands on `/set-password` reliably, then `/membership` for invite |
| A-07-01 (Julia) | S3 | Invite email is plain text | Move it to the branded HTML template the other transactional emails use | ✅ already done — confirmed 2026-08-22 that `invite-account/index.ts` already renders via the shared `renderEmail` branded layout; no plain-text path found |
| A-07-01 (Nate) | S2→S3 | "+ New Person" doesn't invite | Partly plan wording (fixed in the step). Add a "Send account invite now" checkbox to the New Person dialog so the obvious path works too | ✅ 2026-08-22 — checkbox wired to the existing `createAccountInvite` (signup-link) flow, not the branded `invite-account` edge function — see notes file |
| A-01-01 | S3 | Emails reference the wrong website and "NAIGC" in the legal footer — Julia: "I think this is in all emails" | Sweep every template + the shared footer in `_shared/resend.ts` and `supabase/templates` | ✅ 2026-08-22 — `WaiverSign.tsx`, `request-guardian-waiver`, `send-membership-welcome` fixed; `supabase/templates/*`/`config.toml`/`_shared/email-layout.ts` already clean. Live "wrong website" report is most likely an un-pushed prod config, not code — flagged for a `config-push-dryrun` |
| A-06-01 | S3 | After password reset, lands on the membership-purchase page instead of Home | Post-recovery redirect → Home (the membership nudge stays a Home card, not a destination) | ✅ 2026-08-22 — `?setpw=reset` routes `SetPassword.tsx`'s post-success navigate to `/` |
| M-07-01 | S3 | 3-D Secure page says NAIGC | Not in code — it's the Stripe account's public business name. 👤 **Nate:** Stripe Dashboard → Settings → Public details → rename to UCG (test AND live) | 👤 |

## Batch 3 — Cart & purchase history restructure (Z-01-02 design + 6 bugs)

Julia's Z-01-02 is a concrete enough design to build directly (no prototype needed): separate
pages with their own URLs and nav entries — **My Cart**, **Club Cart(s)** (club dropdown, like
Roster/Registrations), **My Purchase History**, **Club Purchase History**; a "Club Cart" button
beside the top-nav 🛒 for managers/admins. Bugs it absorbs:

| ID | Sev | Finding | Status |
|---|---|---|---|
| M-01-04 | S1 | Club carts page shows MIT's cart but not Jurassic's, though Home shows Jurassic has items — the page only renders one managed club | ☐ |
| M-19-01 | S1 | Purchase history shows only purchases where I'm the athlete; should show everything my account paid for (❓ **Q5** on scoping) | ☐ |
| M-20-01 | S1 | "Billed to" + whole-invoice detail (see Batch 1) | ☐ |
| M-02-02 / M-03-01 | S3 | Cart opens scrolled to a random invoice; after payment, scrolls to an old invoice and the success is a small toast — wants an explicit "Payment complete" state in the emptied cart, newest receipt first | ☐ |
| M-08-01 | S3 | Hold-countdown clock missing when returning to an abandoned checkout on desktop (fine on mobile; hard reload fixed it) — stale cart state on tab return; refresh on `visibilitychange` | ☐ |
| M-01-02 | S3 | Adding a registration gives no cart affordance — wants a toast with "View cart" and a badge count on the 🛒 | ☐ |
| Z-01-02 (note) | S3 | Left-nav active highlight missing on the Club Cart page | ☐ |
| M-01-01 / M-02-01 | S3 / Q | Club cart showed line + subtotal only, no service fee/total; M-02 blocked on it. Verify the server-preview fee line renders for club carts | ☐ |

## Batch 4 — Registration entry points (M-01-03, S3 but high-leverage UX)

Julia's ask: Events list gets **Register yourself / Register your club** buttons when
registration is open and **Edit registration** when already registered; My Registrations also
lists registrable events; admin event pages show event details first, then Event Admins /
Waitlist / Competition Order, then the owner checklist. Build as described; discipline icons
stay on wide screens and hide below 860px rather than being removed (responsive-sweep applies).

## Batch 5 — Capacity rework (Z-03, design → prototype → build)

Decisions already made by both of you: **remove "Max total participants"**; per discipline choose
**per-discipline OR per-level** caps, with an explicit **No cap** option; by-session mode shows
sessions + routine caps only (no discipline/level caps); inputs enforce **positive whole
numbers on entry**; **refuse lowering a cap below current registrations** with the count in the
message; event summary shows **progress toward caps** (paid only), and in by-session mode a
per-session progress bar with a detail overlay (per-apparatus spots + waitlist size).

Per CLAUDE.md ("prototype before spec" for prose requirements), I'll put up a clickable
mock-data prototype of the cap editor + summary before writing the spec. Lane P stays on hold
until this ships. Z-03-01 (the actual concurrency test) runs after.

## Batch 6 — Judging & results

| ID | Sev | Finding | Fix | Status |
|---|---|---|---|---|
| Z-06-01 (Nate, results) | S1 | Public Results said "1 score is posted but not assigned to a session" although the host dashboard shows the athlete assigned to that session | Root cause: `pushEvent`/`pushEventSessions` deleted-and-reinserted `event_sessions` on every save (`remoteReplace`), and `registrations.session_id references event_sessions(id) on delete set null` fires on the delete regardless of what gets reinserted — so ANY sessions-editor save (even a same-id round trip) nulled/orphaned every registration's session, while the host dashboard kept showing a cached session name. Fixed: stable session ids preserved across edits (`EventWizard.tsx`), upsert-by-id + prune-only-removed write path (`diffSessions`, `events-core.ts`), editor blocks removing a session with live registrations, and `sessionResults`/`unplacedScoreCount` fall back to a score's own `sessionId` and render an "Unassigned" group instead of hiding anything still unresolved | ✅ done 2026-08-22 — see `docs/plans/notes/2026-08-21-uat-round1-notes.md` and [findings §4.4](../specs/2026-07-31-review-and-cleanup-findings.md) |
| Z-06-01 (Julia) | S1 | Second judge's score silently overwrote the first; wants a confirm showing the existing score | Optimistic concurrency: client sends the score it last saw; server rejects on mismatch; client shows "X is already posted — replace with Y?" | 🔧 drafted 2026-08-22 (`20260822020000_score_compare_and_set.sql` — `scores.updated_at` + `post_score` RPC; both `pushScore` and `judge-entry`'s `submit` now call it; `Judge.tsx` Modal-based Replace/Keep-existing dialog) — not yet applied/reviewed, see `docs/plans/notes/2026-08-21-uat-round1-notes.md` |
| Z-06-01 (Nate, phone) | S3 | Judge entry in iPhone portrait: the score button sits off-screen right with no horizontal scroll; landscape works | Responsive fix + J-16 now tests portrait explicitly | 🔧 drafted 2026-08-22 — `.judge-roster-wrap` (overflow-x: auto) replaces the card's clipping `overflow:hidden`; needs a controller `responsive-sweep` pass at 375px that specifically taps the roster row's Score/Edit button (see notes — a plain page-overflow check would have passed even with the bug) |

## Batch 7 — Polish

| ID | Sev | Finding | Fix |
|---|---|---|---|
| M-05-01 | S3 | Receipt PDF is plain text | Branded PDF (logo, display type, tokens) — after the discount-line work so it renders once |

---

## Questions — ✅ all answered 2026-08-21 (late evening)

| # | Answer | Consequence |
|---|---|---|
| Q1 | EARLYBIRD is **Event entries** | M-11-01 is a line-scope bug in checkout, not config |
| Q2 | **Confirmed** rule set | Refund rework proceeds as specified (per-registration request; change fees never; service fee never; 75% after deadline on the refundable base; add-ons per D-5) |
| Q3 | Screenshot reviewed: Stripe's **−$6.43 processing fee is Stripe's own, charged on the original payment and never returned** (Stripe policy since 2017; no option to reverse it). UCG's $6.45 service fee was **not** refunded. Net: only the $90 line was refunded | Policy (A) stands: refund the item base only, keep the service fee, which covers Stripe's unrecoverable fee. Refund emails/receipts will state "service fees are non-refundable". The real defect was refunding a change-fee line at all (→ Z-04-01) |
| Q4 | **Agreed:** block admin pages only; prompt every sign-in | A-11 design fixed |
| Q5 | **My Purchases = personal only.** Club Purchases = all of that club's invoices incl. ones the viewer paid; club receipts show **"Paid by <account>"** and the list filters/searches by payer | Batch 3 scoping fixed (supersedes my proposal) |
| Q6 | Screenshots received (M-10, M-11 ×4, Z-04-02, Z-06). **New ask:** user-submitted problem reports need an admin view — an "Errors & Problems" page: Error Log tab (existing; it appears capped at 200) + Problem Reports tab with search/sort/filter and a Resolve state | Added as **Batch 2b** |

### Original questions (kept for the record)

1. **Q1 · EARLYBIRD scope.** In `#/admin/league → Promos`, what is EARLYBIRD's "Applies to"? If it's **Any**, the add-on/change-fee discount was as configured and only the service-fee base is the bug. If it's **Event entries**, line tagging is wrong.
2. **Q2 · Refund rule set — confirm:** one request per registration; refundable = entry fee + extra-discipline fees; **change fees never refundable**; **service fee never refunded**; the after-deadline 75% applies to that refundable base; add-ons per your D-5 (full until order deadline, none after).
3. **Q3 · Z-04-02 numbers.** What was charged (incl. fee) vs. what Stripe refunded? A screenshot of the Stripe refund row would settle whether the service fee was refunded or it was Stripe's own fee reversal (Stripe returns its processing fee on refunds — that's not UCG money).
4. **Q4 · MFA gate scope.** Block only **admin pages** until enrolled (the person can still use athlete/club features), prompting on every sign-in — or the whole app?
5. **Q5 · Purchase-history scoping.** Proposal: **My Purchase History** = every invoice my account paid (personal + any club cart I paid), with a "Paid for" column; **Club Purchase History** = that club's invoices regardless of who paid. Matches M-19-01 + Z-01-02 together — confirm.
6. **Screenshots.** Send the two screenshot folders (Appendix D) — M-10, M-11, Z-04-02 and Z-06 each have one I need to see.

## Batch 2b — Problem-reports admin view (new, from Q6)

Where "Report a problem" submissions live today is being verified (email-only vs. table). Target:
`#/admin/errors` becomes **Errors & Problems** with two tabs — **Error Log** (existing; add
"load more" past the 200-row cap) and **Problem Reports** (description, page, build, reporter,
screenshots, open/resolved; search/sort/filter; Resolve toggle).

## Policy calls answered 2026-08-23 (follow-ups from the refund/pricing rework)

| # | Question | Answer | Status |
|---|---|---|---|
| P-1 | 100%/75% refund cutoff judged at request time or review time? | **Request time** — a slow review must not cost the athlete 25% | ✅ shipped (`8ced289`, process-refund redeployed) |
| P-2 | $0 / non-UCG registrations need a self-serve exit? | **Yes — a Withdraw flow**: before `lastDateToEdit` = removed from the event (athlete confirmation + host notification); after = remains registered with all apparatus scratched (late-withdrawal email incl. freebies note). Non-UCG events: withdraw always offered, refund sentence points at the host club's email — omitted when the athlete competes for the host club. UCG-hosted paid regs keep the refund flow; UCG-hosted $0 regs get Withdraw instead | 🔧 `feat/athlete-withdrawal` in progress |
| P-3 | Change fee on never-paid edits? | **No fee** — editing something never purchased is editing a cart; the new paid-state-filtered behavior stands | ✅ nothing to do |

## 👤 Nate actions

- Stripe Dashboard public business name → UCG (M-07-01), test and live. **Deliberately deferred to 2026-09-20** (rebrand announcement day — Stripe requires a live site and unitedclubgymnastics.org is empty until then). Not a bug; don't re-file.
- Send the screenshot folders.
