# Feedback Batch 2026-06-24 — Phase kickoff prompts

Copy ONE block below into a fresh session per phase (keeps context lean — see CLAUDE.md
"Context/usage-optimized execution"). The standing workflow rules (subagent-driven, one
implementer per task, delegate reading to subagents, review inline, `npm run build` is the
real gate, batch migrations/deploys, dev-server-has-no-`me` caveat, merge→push when green)
all live in CLAUDE.md and apply automatically — these prompts intentionally DON'T repeat them.

Source of truth for requirements: `docs/specs/2026-06-24-feedback-batch-decomposition.md`.
Run roughly in order: Phase 4 builds on Phase 2's cart work; Phase 6 reuses Phase 3's
"editing vs new" affordance. Phases 3 and 5 are otherwise independent.
Status so far: **Phase 1 & Phase 2 shipped live** (see memory `feedback-batch-2026-06-24`).

---

## Phase 3 — Roster & Meet Registration

```
Execute Phase 3 of the 2026-06-24 feedback batch per CLAUDE.md's standing execution rules.
Requirements: docs/specs/2026-06-24-feedback-batch-decomposition.md, Phase 3 (items 3a–3i).
Branch: feedback-2026-06-24-phase3-roster-reg.

Phase-specific notes:
- 3g (host-club registration fee = $0) and 3h (change-fee eligibility: eligible = add discipline /
  change level (discipline or T&T events) / change club / swap athlete; NOT eligible = add/remove
  apparatus within a discipline already registered) are PURE pricing logic — unit-test in tests/.
- 3h also: the "Add change to cart" button stays disabled until an ELIGIBLE change is detected.
- 3e (synchro-partner reassignment on athlete swap) and 3d (block re-registering a member already
  registered with another club, with an "Already registered with [Club]" note) need cross-
  registration lookups — have the subagent trace these carefully.
- 3c (split "Roster & Meet Reg" into "Club Roster" + "Club Registrations" nav links) touches
  Layout.tsx nav → DO the responsive sweep (375/768/1280 + drawer < 860px).
- 3f: added members land in "Pending Purchase" (not straight to "Registered"); paid edits →
  "Updated pending purchase".
Ask me any clarifying questions before dispatching.
```

---

## Phase 4 — Carts & Invoices rework + Purchase History + Promo codes

```
Execute Phase 4 of the 2026-06-24 feedback batch per CLAUDE.md's standing execution rules.
Requirements: docs/specs/2026-06-24-feedback-batch-decomposition.md, Phase 4 (items 4a–4f),
AND Nate's original "Carts and Invoices" + "Purchase History" + "Promo code" feedback (the
authoritative cart-model re-explanation — ask me to paste it if it's not in the spec).
Branch: feedback-2026-06-24-phase4-carts-promo.

Build ON Phase 2's existing work — don't duplicate: /cart/memberships checkout, the
send-receipt edge function, and cart-item refSeasonId/refType already exist.

Phase-specific notes:
- Promo codes apply BY LINE ITEM, not whole-cart (this matters for accounting). "Applies to" =
  Any purchase / Athlete Membership / Club Membership / Coach Membership / each FUTURE event
  (past events drop out regardless of expiry). Add a "Promo code used" accounting column.
- Receipts show per-line PRE-promo value, subtotal-before-promo, promo applied (e.g. "Originally
  $5, Promo: UCG26 applied"), then final total. Purchase History "details" must show ALL line
  items (currently shows one). Promo-per-line math + receipt totals are pure logic → tests/.
- Club Cart & Invoices: newest-first sort + date-range filter (default all) + per-ITEM PDF
  download (currently it prints the whole page view).
- The full cart model (per-meet cards w/ edit/remove, single memberships card, Proceed-to-
  checkout + Print-Invoice per card, Checkout-All) is in Nate's "Carts and Invoices" section.
Ask me clarifying questions first (esp. how aggressively to restructure the existing cart toward
the new model vs. incremental).
```

---

## Phase 5 — Finance Dashboards (net-new)

```
Execute Phase 5 of the 2026-06-24 feedback batch per CLAUDE.md's standing execution rules.
Requirements: docs/specs/2026-06-24-feedback-batch-decomposition.md, Phase 5 (items 5a–5e),
AND Nate's original "Finance Dashboard" feedback (the detailed spec — ask me to paste it if not
in the decomposition doc). Branch: feedback-2026-06-24-phase5-finance.

Decided with Nate: BUILD NOW against the existing stubbed/simulated purchase data; merchant-fee +
meet-host payout calcs use a PLACEHOLDER fee rate until Stripe lands. The Finance Admin role
already exists (Phase 1; capabilities-core `isFinanceAdmin`).

This is the largest, most net-new phase — ASK ME CLARIFYING QUESTIONS FIRST, especially:
the placeholder merchant-fee rate to use; default accounting codes; and whether the per-event
dashboard lives on the existing meet/event page or a new route.

Phase-specific notes:
- Put ALL pure aggregation in a new src/lib/finance.ts with thorough vitest tests (net/gross
  revenue, refunds, merchant fees collected vs charged, meet-host owed = fees collected − txn
  fees for non-"UCG – Main" hosts, date-range filtering w/ smart defaults: events → reg-open to
  1 week after meet date; aggregate → previous month). UI consumes finance.ts.
- Two tabs: Summary (per-revenue-type line + accounting code; host financials + payment-info
  input) and Transactions (by LINE ITEM: date, name, email, club, txn id, invoice/refund #, item
  desc, item note e.g. promo, amount-after-promo). Summary lines deep-link into Transactions.
- Everything FILTERABLE and fully EXPORTABLE (export includes ALL columns).
- Gating: per-event dashboard = league + sanctioning + finance admins + host-club admins;
  org-level = league + finance admins. Use capabilities-core.ts.
- Migrations: accounting codes per purchase-item type; meet-host payment records.
```

---

## Phase 6 — My Registrations

```
Execute Phase 6 of the 2026-06-24 feedback batch per CLAUDE.md's standing execution rules
(final, small phase). Requirements: docs/specs/2026-06-24-feedback-batch-decomposition.md,
Phase 6 (items 6a–6b). Branch: feedback-2026-06-24-phase6-my-registrations.
Files: src/pages/MyRegistrations.tsx, src/components/RegistrationEditor.tsx.

Goal: let a member edit ALL registration details (not just club — reuse the full registration
editor), and make EDITING vs new registration visually clear (reuse whatever Phase 3's 3i built
for the "editing vs new" affordance). Ask me any clarifying questions before dispatching.
```
