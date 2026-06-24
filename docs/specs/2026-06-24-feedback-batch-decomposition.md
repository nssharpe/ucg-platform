# Feedback Batch 2026-06-24 — Decomposition & Phase Plan

Source: Nate's feedback dump (2026-06-24). Delivery decisions (confirmed by Nate):
- **Phased delivery**, merging each phase to `main` and pushing live as it passes.
- **Finance dashboard built now** against the stubbed/simulated purchase data (merchant-fee
  & payout calcs use placeholder rates until Stripe lands).
- **Regional-rep CC addresses** use corrected plus-addresses (Northeast/Midwest were mistyped).

Each item below is tagged `[done]` / `[wip]` / `[ ]` and mapped to the file(s) it touches.
This doc is the cross-phase source of truth; per-phase detail plans go in `docs/plans/`.

---

## Phase 1 — Profile / new-account / roles foundation & blocking bugs

Central files: `src/pages/Profile.tsx`, `src/components/PersonForm.tsx`,
`src/lib/types.ts`, `src/lib/capabilities-core.ts`, `src/lib/capabilities.ts`,
`src/lib/auth.ts`, `src/App.tsx`, `src/pages/Admin.tsx` (role assignment UI),
migrations for new roles + the people RLS fix.

- [ ] **1a. New-athlete defaults — Student status** unfilled by default; require input.
  `studentStatus` currently defaults `'Student'`. Add an empty sentinel (`''`) and make it
  a required field for new athletes. `PersonForm.tsx:33`, `Profile.tsx:55,287`, `types.ts`.
- [ ] **1b. Undergrad grad year** defaults N/A **unchecked** and year blank — user must act.
  Today `gradYear:0` = unset (good) but verify the N/A checkbox is unchecked on new and that
  validation forces a choice. `PersonForm.tsx:51-53,116-121`, `Profile.tsx:51,275-284`.
- [ ] **1c. Main club** defaults to "No club" **unchecked** — user must choose a club or check
  No-club. `independent` already defaults false for new (PersonForm.tsx:48); ensure validation
  blocks save until `clubChosen` (club picked OR No-club checked). `PersonForm.tsx:53,158-164`.
- [ ] **1d. Training state → add "Outside US" checkbox** (International). When checked: state
  field not required, Region resolves to "Outside US". Checkbox defaults unchecked.
  `PersonForm.tsx` (state field ~158), `Profile.tsx` (state/region), region derivation in
  `capabilities-core.ts`/wherever region is computed. Add `outsideUs`/country handling to
  `Athlete` in `types.ts`.
- [ ] **1e. Coach-only accounts:** hide + un-require Undergrad grad year and Student status;
  relabel "Training state" → "Coaching state". Gate on `roles.coach && !roles.athlete`.
  `PersonForm.tsx`, `Profile.tsx`.
- [ ] **1f. New user role: Regional Representative** — name + email + **region dropdown**
  (multiple users per region allowed). Add role + per-user region storage; admin UI in
  `Admin.tsx`. Region list = the 7 NAIGC regions. New migration. `types.ts`,
  `capabilities-core.ts`, `Admin.tsx`.
- [ ] **1g. New user role: Finance Admin** — needed by Phase 5 dashboards. Add role + admin
  assignment UI. `types.ts`, `capabilities-core.ts`, `Admin.tsx`, migration.
- [ ] **1h. BUG: new athlete save → "new row violates RLS policy for people".** Reproduce,
  inspect the `people` INSERT RLS policy; a self-insert path for a brand-new person is being
  blocked. New migration to fix the policy. Verify Test Athlete5 save succeeds.
- [ ] **1i. "Confirm my account" flashes a page before settling on Home.** Route to Home
  first. Likely `App.tsx` setpw/confirm boot routing or `SetPassword.tsx`.
- [ ] **1j. Logout→login flashes "Person not found" before loading.** Wait for load before
  rendering; if new account lacks access to the current route, go Home instead. Guard on
  `rolesLoaded`/person-loaded. `App.tsx`, `Profile.tsx`, route guards.
- [ ] **1k. Forgot password + magic sign-in link.** Add "Forgot my password" on `Gate.tsx`
  (Supabase `resetPasswordForEmail`) AND passwordless magic link (`signInWithOtp`, email link
  → auto-login). Reuse `?setpw=1`-style hash workaround for HashRouter. `Gate.tsx`, `auth.ts`,
  `App.tsx`, Supabase redirect config.

## Phase 2 — Membership flows

Central files: `src/pages/Membership.tsx`, `src/pages/Club.tsx`,
`src/lib/waiver-proof.ts`, `src/lib/pricing.ts`/`receipt.ts`,
`supabase/functions/request-guardian-waiver`, `create-waiver-link`,
`request-manager-access`, new edge function for the no-club welcome email.

- [ ] **2a. Admin-override grant waiver routing:** send **athlete** self-waiver if ≥18,
  **guardian** waiver if <18 (currently always guardian). Compute age from DOB at grant time.
  `Membership.tsx`/admin grant path + `create-waiver-link`/`request-guardian-waiver`.
- [ ] **2b. Proof-of-waiver PDF lost HTML formatting** — render the waiver with the same HTML
  formatting used elsewhere (sanitized HTML → styled PDF). `src/lib/waiver-proof.ts`,
  `sanitize-html.ts`, `waiver-default.ts`.
- [ ] **2c. No-club first membership-only purchase → welcome email** with regional team CC'd
  (skip if Outside US). Names from Regional Rep role (1f); CC = corrected plus-addresses per
  region. Email body per spec (Welcome to UCG, hyperlinks). New edge function
  `send-membership-welcome` (or extend an existing notify fn) + invoker in `supabase.ts`.
  Fire once, on first membership-only purchase for a no-club account.
- [ ] **2d. Club-cart push link fix:** remove "Return to membership purchasing →" (goes to
  owner's membership page). Replace with **"Checkout Memberships →"** → a memberships-only
  checkout page. On completion: account owner gets confirmation email + receipt PDF.
  `Cart.tsx`/`Club.tsx` memberships card, new checkout route, `receipt.ts`.
- [ ] **2e. BUG: "Confirmation emailed" but no email sent** (club-cart pay). Wire the real
  send (now that 2d adds a real checkout + receipt). `Club.tsx`/`Membership.tsx` pay buttons.
- [ ] **2f. BUG: membership paid in cart but user still shows "Athlete membership — pending
  payment by your club".** Status not refreshing after club-cart payment. Fix status
  derivation. `Membership.tsx`, membership status logic, `capabilities-core.ts`.
- [ ] **2g. Status bubble on club-cart push:** "Pending Payment by [Club Name] (Athlete)".
  If also under-18 waiver hold → **two** bubbles: "Pending guardian waiver (Athlete)" +
  "Pending Payment by [Club Name] (Athlete)". Currently one bubble. `Membership.tsx` status
  rendering.
- [ ] **2h. Club membership purchase → review/edit club info screen first**, confirm button,
  then **add to Memberships cart** (not instant purchase) and land on cart. Active only after
  payment. `Club.tsx`, `ClubForm.tsx`, cart.
- [ ] **2i. Request-club-admin email → only that club's managers** (not league admins).
  On **denial**, email the requester that access was denied.
  `supabase/functions/request-manager-access`, `decide_manager_access` RPC / migration,
  `ManagerAccessReview.tsx`.

## Phase 3 — Roster & Meet Registration

Central files: `src/pages/Club.tsx`, `src/pages/Meets.tsx`, `src/components/Layout.tsx`,
`src/components/RegistrationEditor.tsx`, `src/lib/capabilities-core.ts`, `src/lib/pricing.ts`.

- [ ] **3a. Coaches listed on club page** — a coach who selected coach + affiliated with the
  club shows in the club whether or not they have active membership, with a membership-status
  line (like athletes) and an "invite to purchase membership" email option. `Club.tsx`.
- [ ] **3b. "Add coach" button** (right of "Add athlete") — first/last/email → creates account,
  sends set-password → membership-purchase page; their profile pre-checks coach-only + this
  club as main. Replace the "invite a new coach" line in Club Managers. `Club.tsx`,
  `invite-account` edge fn (`kind:'coach'`).
- [ ] **3c. Split "Roster & Meet Reg" into "Club Roster" + "Club Registrations"** — two nav
  links, two pages/views. `Layout.tsx` nav, `Club.tsx` (split or route param), `navHistory.ts`.
- [ ] **3d. Already-registered-with-another-club:** such a member is NOT selectable to register
  again; show note "Already registered with [Club]". `Meets.tsx`/registration picker,
  cross-club registration lookup.
- [ ] **3e. Synchro-partner reassignment on swap:** swapping athlete2 for athlete1, if athlete1
  is athlete3's synchro partner, athlete2 becomes athlete3's partner. `RegistrationEditor.tsx`
  / swap logic.
- [ ] **3f. Added members go to "Pending Purchase", not straight to "Registered".** Paid edits
  → "Updated pending purchase". Keep them in the registered section but clearly mark
  paid-vs-pending. `Meets.tsx`/`Club.tsx` registration status, pricing.
- [ ] **3g. Registration fee always $0 for host club.** `pricing.ts` + registration fee calc,
  host-club detection.
- [ ] **3h. Edit registration "Add change to cart" disabled until an ELIGIBLE change.** Eligible
  = add discipline, change level (discipline or T&T events), change club, swap athlete. NOT
  eligible = add/remove apparatus within an existing discipline. Diff logic + button enabled
  state. `RegistrationEditor.tsx`, `pricing.ts` (change-fee eligibility — pure logic, unit-test).
- [ ] **3i. Clearer EDITING vs new registration** (UI affordance). `RegistrationEditor.tsx`,
  `Meets.tsx`.

## Phase 4 — Carts & Invoices rework + Purchase History + Promo codes

Central files: `src/pages/Cart.tsx`, `src/pages/PurchaseHistory.tsx`, `src/lib/receipt.ts`,
`src/lib/pricing.ts`, `src/pages/Admin.tsx` (promo editor), `types.ts`/`database.types.ts`.

- [ ] **4a. Cart model re-spec:** per-meet cards (line items w/ full reg detail, x to remove,
  edit individual reg); memberships single card; each card has **Proceed to checkout** +
  **Print Invoice**; **Checkout All** at top and bottom combines all cards into one checkout.
  Club Cart & Invoices = same cart + past receipts/invoices, admin-gated. `Cart.tsx`.
- [ ] **4b. Receipts show per-line-item value** (pre-promo), then subtotal-before-promo, promo
  code + resulting subtotal, final total. Promo applied **by line item** (single line of the
  correct type), receipt shows "Originally $5, Promo: UCG26 applied". `receipt.ts`, `pricing.ts`.
- [ ] **4c. Purchase History "Click for details" shows ALL line items** (currently one), with
  pre-promo values + promo breakdown. `PurchaseHistory.tsx`, `receipt.ts`.
- [ ] **4d. Club Cart & Invoices: newest-first sort** + date-range filter (default = all).
  Per-item PDF download = that item's detail (not the whole-page print). `Cart.tsx`.
- [ ] **4e. Promo code overhaul:** "Applies to" = Any purchase, Athlete Membership, Club
  Membership, Coach Membership, + each **future** event (past events drop out regardless of
  expiry). Apply **per line item**. Add "Promo code used" accounting column to financial
  records. `Admin.tsx` promo editor, `pricing.ts`, `types.ts`, migration (coupon scope +
  promo-used column).
- [ ] **4f. Confirmation email + receipt PDF on checkout completion** (cart + memberships).
  Ties to 2d/2e. `receipt.ts`, send path.

## Phase 5 — Finance Dashboard (net-new)

Central files: new `src/pages/FinanceDashboard.tsx` (or per-event + org variants),
`src/lib/finance.ts` (pure aggregation — unit-test), `Admin.tsx`/event page wiring,
`capabilities-core.ts` (finance-admin + host-club-admin viewing), `types.ts`, migration for
accounting codes + meet-host payment records.

- [ ] **5a. Per-event finance dashboard** — viewable by league admins, sanctioning admins,
  finance admins, and host-club admins. Org-level dashboard — league + finance admins.
- [ ] **5b. Date-range filter** with smart defaults: events → reg-open date to 1 week after
  meet date; aggregate → previous month.
- [ ] **5c. Summary tab:** per-revenue-type line w/ accounting code; total net/gross revenue,
  refunds, merchant fees collected, merchant fees charged/paid. Meet-host financials (amount
  owed = fees collected − transaction fees; only for non-"UCG – Main" hosts; calc details +
  payment-info input). Aggregate adds totals paid to hosts, merchant fee collected/paid/profit.
  Filterable + exportable (all columns).
- [ ] **5d. Transactions tab:** all transactions by **line item** (payments, refunds) with full
  detail (date, name, email, club, txn ID, invoice/refund #, item desc, item note e.g. promo,
  amount after promo). Summary line items deep-link into this tab. Filterable + exportable.
- [ ] **5e. Financial league management:** set accounting codes per purchase-item type; codes
  show as a column on summary tabs. `Admin.tsx` / settings + migration.

## Phase 6 — My Registrations

Central files: `src/pages/MyRegistrations.tsx`, `src/components/RegistrationEditor.tsx`.

- [ ] **6a. Edit ALL registration details** (not just club) — reuse the full registration
  editor. `MyRegistrations.tsx`.
- [ ] **6b. Clear EDITING vs new** affordance (shares 3i). `MyRegistrations.tsx`.

---

## Cross-cutting verification (every phase)
- `npm test` (vitest) green; new pure logic (region derivation, change-fee eligibility,
  promo-per-line-item, finance aggregation) gets unit tests under `tests/`.
- `npx eslint <touched files>` clean (CI fails deploy on lint error).
- Build: `npm run build`, confirm `dist/index.html` script refs resolve under `dist/assets`.
- Responsive sweep on any layout/nav/topbar change: 375 / 768 / 1280 (spot 1440); no
  horizontal overflow; drawer opens/closes < 860px.
- Contrast check on any new text/background pair (AA).
- Update docs (`CLAUDE.md`, `README.md`, `docs/README.md`, `supabase/README.md`) per touched area.
- Per standing instruction: branch → implement → verify → merge to `main` → push (deploys live).

## Regional-rep CC addresses (corrected, all route to Julia for testing)
- South Central — julia.sharpe+south-central-regions-team@naigc.org
- West — julia.sharpe+west-coast-regions-team@naigc.org
- Mid-Atlantic — julia.sharpe+mid-atlantic-regions-team@naigc.org
- Southeast — julia.sharpe+southeast-regions-team@naigc.org
- Mideast — julia.sharpe+mideast-regions-team@naigc.org
- Northeast — julia.sharpe+northeast-regions-team@naigc.org  *(corrected: was missing "+")*
- Midwest — julia.sharpe+midwest-regions-team@naigc.org  *(corrected: was a mailto link)*
