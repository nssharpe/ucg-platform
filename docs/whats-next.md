# What's next — the authoritative open-work list

**This is the single source of truth for open work.** Reconciled with the codebase
**2026-07-19**. It replaces the
"What's next" section that used to live in [`README.md`](README.md) — update THIS file
when priorities change, not rival copies. [`production-readiness.md`](production-readiness.md)
is the per-dimension gap analysis; [`../CLAUDE.md`](../CLAUDE.md) keeps only a pointer here.

Legend: 👤 = only Nate can do it · 🤖 = Claude can build it · 💬 = needs a decision first.

---

## 1. Nate-only action items (👤 — quick, unblock others)

1. **Verify the P3 refund prerequisites landed:** "UCG - Main" flagged
   `clubs.is_league_host` + `refund_manager` granted to whoever reviews refunds.
2. **Supabase Pro upgrade** (backups/PITR) — deliberately deferred 2026-07-04; a hard
   pre-flight gate in the [go-live checklist](stripe-go-live-checklist.md). Interim
   insurance: daily dumps via `scripts/backup-db.mjs` (runbook in
   [supabase/README](../supabase/README.md)).
3. **Stripe go-live** — [stripe-go-live-checklist.md](stripe-go-live-checklist.md)
   (account activation, live keys, $1 smoke + refund).
4. **Legal (longest lead time — start early):** engage counsel on waiver wording,
   privacy policy, ToS, minors/COPPA. 🤖 drafts the documents (item 2.4 below).
5. **Add a failure alert to the daily DB backup.** The "UCG DB Backup" scheduled
   task fails *silently* — proven 2026-07-24, when Supabase made the direct DB
   host IPv6-only and every run after 2026-07-23 01:00 died on `ENOTFOUND` with
   no notification. The script is fixed (IPv4 pooler fallback, re-verified live),
   but a backup job that can fail unnoticed is the one job that must not — and
   these dumps are the stated stand-in until Supabase Pro/PITR (item 2 above).
6. **Security-review option + timing** — options brief at
   [research/2026-07-17-security-review-options.md](research/2026-07-17-security-review-options.md);
   👤 Nate picks an option + timing (gates live keys).

## 2. Launch blockers (🤖 buildable now)

0. ✅ **Security hardening Phase 3 — COMPLETE 2026-07-26** ([plan](plans/2026-07-02-security-hardening.md)).
   Every item applied to staging AND prod and verified live. ✅ M2 (`cart_member_clubpush` now membership-only),
   ✅ M4 (`people` self-insert-by-email branch dropped, + the companion `auth.ts`
   fix it needed), ✅ **invoice write lockdown** (not originally in the plan — any
   member could forge a paid invoice via PostgREST; writes on `invoices`/
   `invoice_items` are now admin-only). **Applied to staging AND prod 2026-07-24**,
   live-probed 7/7 as a non-admin against both.
   ✅ **M1 (coupon reservation at session-create) — APPLIED staging + prod
   2026-07-26**, migration `20260726130005`. Concurrent checkout sessions could
   each collect the same single-use discount, because the code was only validated
   at session-create and `used_count` was only bumped at fulfillment. Now a
   time-bounded row in `coupon_reservations` is claimed inside `reserve_coupon`,
   which takes `SELECT ... FOR UPDATE` on the coupon row (the lock IS the fix) and
   counts `used_count + live reservations`. Deliberately NOT a decrement-on-failure
   scheme: a release that never runs would burn a use permanently, whereas an
   expired reservation simply stops counting. Released on
   `checkout.session.expired`/`async_payment_failed`, converted to a redemption by
   `redeem_coupon`, and — critically — never claimed on the `mode: 'preview'` path.
   **Proven on staging:** 10 concurrent `reserve_coupon` calls against a
   `max_uses: 1` coupon → exactly 1 winner; release frees the slot; an expired
   reservation stops blocking. Prod smoke after deploy: cart preview still reprices
   ($1 → $45) and created 0 reservations. `create-checkout-session` +
   `stripe-webhook` redeployed to both projects, `verify_jwt` trio re-verified.
   ✅ **LOW items shipped 2026-07-26** (staging + prod): `club_managers`/`app_settings`
   SELECT scoped to `authenticated`; `error_logs` rate-limited to 20 inserts/minute per
   caller (verified live: 20 accepted, rest rejected, on both envs); 256-bit tokens in
   the 3 no-login token generators (redeployed both envs). **Phase 3 is complete.**

## 3. Quality passes (pre- or just post-launch)

1. ✅ **UI/UX review fixes — COMPLETE 2026-07-26** ([task briefs](plans/2026-07-04-uiux-review-fixes.md),
  from the 2026-07-04 live review). All 14 tasks (O1, S1–S6, H1–H7) shipped to `main` and
  deployed; per-task detail and evidence live in the plan doc, not here. Headlines:
  **S1** primary-CTA/active-nav contrast (white-on-coral 2.94:1 → navy-on-coral 4.78:1,
  plus a new `--coral-400` hover step since dark text needs the hover to LIGHTEN);
  **S2/S3** Profile save bar (AA bar text + real dirty-tracking); **O1→S4** the money
  story — `create-checkout-session` gained a side-effect-free `mode:'preview'` so the
  cart shows the server's own prices and cart/checkout can no longer disagree;
  **S5/S6** live fee estimate + payment-status badges; **H1–H7** empty states,
  date/timezone formatting, Copy-link buttons, a 7-item microcopy sweep, cart CTA
  collapse, a NotFound route, and keyboard-accessible Details/Hide toggles.

  Residuals deliberately left open:
   - **Invoice numbering** (O1 spec §3) — two formats coexist; deferred to the
     pre-launch data sweep per Nate, since all current rows are test data. The
     generators derive the sequence from a row COUNT, which is not concurrency-safe;
     revisit when real invoices exist.
   - **Pre-existing 375px overflow on the admin Communicate compose-editor card** —
     found during H5–H7, proven pre-existing via `git stash`, out of scope there.
   - **Keyboard verification of the H7 toggles was click+DOM-based**, not real key
     events: the Browser pane could not deliver OS-level keystrokes this session.
     They are real `<button>`s with default `tabIndex`, so Enter/Space is spec-
     guaranteed, but a manual tab-through is worth doing once.

2. **Accessibility audit** to WCAG 2.1 AA (axe + manual keyboard/focus/ARIA pass) +
  loading/empty/error-state consistency across pages.
3. **New-club-request email** to `newclubinquiries@naigc.org` (transport exists, not wired).
4. **PWA production update path** — verify deploys reach users promptly; add a "new
  version available, reload" prompt if not.
5. **`npm audit` + Dependabot** in CI.
6. **Fix the `record-waiver-signature` stale-hold wart** — it can re-assert a
  club-payment hold if the club paid before the guardian signed (documented in
  CLAUDE.md; small, known fix).

## 4. Event-management v2 residuals (deferred by design)

emv2 P0–P6 is complete ([spec](specs/2026-07-06-event-management-v2-requirements.md));
these were explicitly deferred, not dropped:

- **§L.2 session-assignment tool** + the per-team session-timed finals reminders that
  depend on it ("5 min after session ends" / Fri-10am) — Julia marked her section
  incomplete; only the admin-set `finals_lineup_deadline_at` nag + 10pm lock shipped.
- **Server-rendered receipt PDF attached** to the confirmation email (§I/§N4) —
  receipts today are client-side jsPDF on demand.
- **Camp registration popup simplification** (§G) — camp events still reuse the full
  per-discipline `RegistrationEditor`; spec wants no discipline/level/apparatus step.
- **Host-payout formula** — see Nate item 1.3.

## 5. Feature roadmap

~~B, C, D, E~~ — ✅ **ALL SHIPPED 2026-07-19** (merged to main; migrations
`20260719120000_judge_access_codes` + `20260719130000_event_scoring_config`
applied staging + prod; `judge-entry` deployed both): **B** athlete-gated
registration + per-type admin grant/revoke (single General waiver confirmed
final); **C** was already complete; **D** codeless judge access (one code per
event, URL/6-digit/QR, host "Judge access" card, public unlock page, anonymous
score writes via `judge-entry`); **E** per-event scoring config (1-or-2 judge
panels with averaged execution + calculator-vs-simple default entry mode).
Residual 👤: happy-path smoke of D on staging (generate a code on a live
event, unlock on a second device, enter a score).

**Further out:**
- PDF certificates, external API.

**Residual from shipped work:**
- ~~Enroll TOTP factors~~ ✅ **done 2026-07-19** — Nate + Julia both enrolled; admin
  accounts now get the aal2 protection.

## 6. Proposed additions (Claude, 2026-07-16 — NOT yet committed; Nate to triage)

Suggested from a post-emv2 read of the platform; some have shipped, others are pending:

1. **In-app help / host & manager guides.** The feature surface is now large (hosting,
  waitlists, add-ons, refunds, finance). Short task-oriented docs (or contextual help
  links) reduce Julia-as-support and make fall-season onboarding of hosts cheaper.
2. **Privacy-friendly analytics + Web Vitals** (Plausible/PostHog) once real users
  arrive; optional Sentry for stack traces with releases.
3. ✅ **Data-layer scale path — Phases 0-5 ALL DONE**
  ([spec](specs/2026-07-24-data-layer-scale.md)). Phase 0 fixed the silent
  1000-row truncation (shipped). Phase 1 (2026-07-26) built the staging-only
  `scripts/seed-scale.mjs` harness + boot instrumentation, then MEASURED: at 50k
  registrations / 52k scores the app takes **21.1 s to cold-boot** and writes a
  **28.95 MB** localStorage snapshot — and the localStorage quota error we were
  relying on as the alarm **never fired** (Chromium accepted it). Phase 2
  (merged 2026-07-26) moved `scores` off global hydration onto a new
  scoped-slice layer (`src/lib/slice-cache.ts` + `src/lib/scores-slice.ts`) —
  measured directly against scale-seeded staging, the full `scores` fetch this
  removes from boot cost **14.46 s / ~21.7 MB**; the replacement per-event
  fetch (nationals-scale, ~2,400 rows) costs **~0.78 s / ~695 KB** and is paid
  only when that event's page is opened. Phase 3 (2026-07-27, branch
  merged 2026-07-26) did the same for
  `registrations` (`src/lib/registrations-slice.ts`, reusing Phase 2's
  slice-cache.ts as-is, implementing all six CONTRACT shapes) across all ~61
  consumers (Club.tsx's roster classification was the highest-risk read —
  see the spec's COMPLETENESS section), then removed `registrations` from
  `loadAll` entirely. Measured directly: the full `registrations` fetch this
  removes cost **22.9 s / ~24.7 MB** at 50k rows; the replacement per-event
  fetch (the largest scale-seeded event, 674 rows) costs **~0.4 s / ~200 KB**.
  A full live before/after `loadAll()` boot comparison was blocked again, this
  time by a genuinely NEW, pre-existing finding surfaced by scale-seeding:
  `memberships`/`invoices`/`invoice_items` queries time out ("canceling
  statement due to statement timeout") under the ANON/AUTHENTICATED role once
  those tables hold 10k+ rows — confirmed NOT an RLS-grant gap (a
  service-role client queries them fine), so this reads like an expensive RLS
  policy (a per-row subquery/join) that was never exercised at scale before.
  Untouched by the Phase 3 diff (Phase 3 doesn't read either table) — see §7
  below, RESOLVED 2026-07-28 by scoping the query (not the RLS policy).
  **Phase 4 (2026-07-28) was REWRITTEN from "slim the `people` projection"
  to "scope which people load"** — a 2026-07-26 recon found the originally-
  proposed slim/full field split wrong in both directions and its danger
  list ran through membership pricing, synchro eligibility, and nationals
  categorization; scoping which ROWS load (mirroring the Tier 2 pattern
  above) sidesteps all of it, since every row returned is still complete.
  loadAll's boot people read is now self + managed-club rosters only; five
  on-demand shapes (arbitrary person, by-club, league-wide-admin, by-ids
  full, by-ids thin via a newly-wired-up `public_competitors` view) cover
  every other consumer across ~36 files. Building the thin by-ids shape
  surfaced and fixed a real pre-existing bug: anonymous visitors to the
  public, no-login Results page saw blank athlete names (verified live
  against prod, then confirmed fixed against scale-seeded staging as a true
  anon session). **Phase 5 (2026-07-28)** restricts localStorage persistence
  to Tier 1 + small Tier 2 (`seasons/levels/clubs/events/coupons/
  waiverDocuments/accountingCodes/regionOverrides/people/invoices/carts`) —
  measured 28.95 MB → ~53 KB on 0.5×-scale staging, persisted `people` down
  to 1 row (self) vs. 3,000 seeded. Full writeup, danger-list verification,
  and measurements: `docs/specs/2026-07-24-data-layer-scale.md`'s Phase 4/5
  sections.

## 7. ✅ RESOLVED 2026-07-28 — expensive Tier-2 reads on `memberships` / `invoices` / `invoice_items`

**Fixed by scoping the QUERY, not the policy.** `loadAll` now resolves the caller's
person id + managed-club ids first, then reads these three tables filtered to that
scope. Measured on 0.5×-scale staging as a real club-manager JWT:

| table | before (unfiltered) | after (caller-scoped) |
|---|---|---|
| `memberships` | ~5.3 s | **455 ms** |
| `invoices` | ~5.5 s | **277 ms** |
| `invoice_items` | ~7.4 s | **365 ms** |

10–20×, comfortably clear of the statement timeout. Authorization is unchanged: every
predicate is a strict subset of what RLS already permitted that caller, and anon skips
these fetches entirely. League-wide consumers (Finance, RefundReview, AdminClubs,
Communicate's audience, Home's admin dashboard, AdminMembers' merge, Club's roster for
admins, the GDPR export) moved to on-demand admin slices that gate every computed total
on `status === 'ready'`.

**A policy-shape rewrite was tried first and REJECTED — do not retry it.** Wrapping the
cross-table RLS subqueries in SECURITY DEFINER helpers made `invoice_items` *worse*
(7.4 s → 11.4 s): Postgres can hash-materialize a raw correlated `EXISTS` into a single
semi-join scan, whereas a function call is opaque to the planner and pays ~0.9 ms per
outer row. The apparent `memberships` gain was inside measurement noise. Migration
`20260728015930` kept only the unambiguous hygiene win (one SELECT policy instead of two
identical ones, and explicit insert/update/delete replacing a `for all` that silently
granted DELETE) — shipped staging + prod, justified as correctness, NOT performance.

Original finding, kept for context:

Surfaced by 6.3's scale-seeding, and **architecturally more significant than it first
reads**. Under the ANON/AUTHENTICATED role these three tables start failing with
`canceling statement due to statement timeout` once they hold ~10k+ rows. A
service-role client queries them fine, so it is not a grant gap — it reads like an
expensive RLS policy (a per-row subquery/join) that nothing has ever exercised at
volume.

**Why it matters beyond a slow query:** these are **Tier 2** tables in the
[data-layer scale spec](specs/2026-07-24-data-layer-scale.md) — the tier that
deliberately STAYS globally hydrated because it's "bounded per user". Phases 2 and 3
moved `scores` and `registrations` off global hydration; Phases 4–5 address `people`
and localStorage. **None of them touch these three.** So this is a hole in the tiering
assumption, not something the remaining phases will incidentally fix: the projection
has ~18k invoices / ~25k invoice_items / ~11k memberships within two years, which is
past where the timeout was observed.

**2026-07-28 (branch `perf/tier2-rls-policy-cost`, staging only, NOT prod) — policy-shape
fix tried and MEASURED-REJECTED; controller made the call.** First attempt wrapped
`memberships_write`'s and `invoice_items_read`'s raw cross-table subqueries in
SECURITY DEFINER helpers (`manages_club_of_person`/`invoice_owner_or_manager`). At
0.5×-scale that made `memberships` statistically unchanged (~5.0–5.3s either way,
inside the measurement's own noise band) and `invoice_items` measurably **worse**
(7.4s → 11.4s) — a fresh anon `loadAll`-shaped read at that scale still hit
`statement timeout` on all three tables, i.e. signed-out boot was still broken. Root
cause: Postgres can hash-materialize a raw correlated `EXISTS` subquery into a single
semi-join pass over the referenced table (one scan total, confirmed via a
`hashed SubPlan` plan node) — a SECURITY DEFINER function call is opaque to the
planner and can never be hashed that way, so it pays its own per-call cost (~0.9ms
measured) on every row of `loadAll`'s unfiltered scan, which loses to the
hashed-subquery plan once the referenced table's own policy stack isn't already the
dominant cost. **The controller rejected shipping that trade** (an 11.4s regression on
`invoice_items` in exchange for architectural tidiness) and this is the second time in
this repo a "clearly correct" RLS-predicate-shape theory didn't pan out on measurement
(see `20260711023234`) — **don't retry a policy-rewrite fix for this without a fresh
measurement; the planner-hashing behavior above is why it's a dead end.**

What shipped instead, kept because it's a scale-independent correctness/hygiene win
and does NOT claim a performance improvement: `memberships_read` and `memberships_write`
(a `for all` policy) carried byte-identical predicates, evaluated and OR'd on every
SELECT for zero semantic difference — collapsed to one `memberships_read` SELECT
policy plus explicit `memberships_insert`/`memberships_update`/`memberships_delete`
policies (retiring the `for all`, which silently granted DELETE too — the trap
CLAUDE.md calls out, and the same shape already retired from `invoices`/`invoice_items`
in the 2026-07-24 write lockdown). `invoice_items_read` and the two SECURITY DEFINER
functions from the rejected attempt were fully reverted. Semantics re-verified via a
rolled-back-transaction A/B against the true pristine original policies — byte-identical
row sets for a club manager and an athlete — and anon boot re-confirmed clean at
baseline volume. Full narrative + both attempts' data: `supabase/README.md`'s entry for
`20260728015930_tier2_rls_policy_cost.sql`.

**BUILT (branch `perf/tier2-scoped-loadall`, drafted 2026-07-28) — Tier-2 QUERY scoping
in `loadAll`.** `loadAll` now resolves the caller's person id + managed-club ids first,
then scopes memberships/invoices/invoice_items to exactly what RLS already permits that
caller (self rows + managed-club rosters/invoices) instead of an unfiltered `select('*')`
— no authorization change, only the query narrows. Privileged league-wide consumers
(Finance, RefundReview, AdminClubs, Communicate's audience filter, Home's admin
dashboard, AdminMembers' merge modal, Profile's adminView, Club.tsx's roster/event-reg
grid, person-data.ts's export) were converted to on-demand fetches (new
`invoices-admin-slice.ts` / `memberships-admin-slice.ts`, routed through the existing
slice-cache infra) so they still see everything they need without that data riding along
on every boot. Money surfaces gate every computed total on `status === 'ready'`.
**Measured** (scale-seeded staging at 0.5×, real club-manager JWT, non-trivial result
set — 188 memberships / 95 invoices / 115 invoice_items): `memberships` 455ms,
`invoices` 277ms, `invoice_items` 365ms, vs. this section's own ~5.3s/~5.5s/~7.4s
baseline for the old unfiltered read at the same table sizes — a 10–20× improvement,
comfortably clear of the `statement timeout` the unfiltered reads hit at this scale.
Full narrative + the exact query shapes: `docs/specs/2026-07-24-data-layer-scale.md`'s
Tier 2 section. Controller still owns reviewing/merging the branch.

Not urgent at current prod volume (invoices 43, invoice_items 69, memberships 39), but
the fix is done rather than deferred.

**Addendum (2026-07-28, Phase 5 boot measurement): `payments` likely carries the same
risk, unscoped.** Cold-boot `syncFromSupabase()` against 0.5×-scale staging (9,000
payments, alongside the now-fast-scoped memberships/invoices/invoice_items) took
2.4–7.9 s — `payments` is fetched via a plain unscoped `fetchAllRows` in `loadAll`, the
same shape memberships/invoices/invoice_items had before this section's fix. Not
re-measured in isolation (out of scope for the Phase 4/5 session that found it), but
worth the same query-scoping treatment (self + managed-club, mirroring §7's fix) before
a real season pushes it past 10k rows.

**Also 2026-07-28: the scale-seed harness found staging's row counts were already 0
across every scaled table (`memberships`/`invoices`/`invoice_items`/`people`/
`registrations`/`scores`/`events`/`clubs`) *before* seeding** — the documented Playwright
E2E fixture baseline (memberships 70, invoices 14, invoice_items 14, people 84,
registrations 130, scores 248, events 4, clubs 9) is not currently present on staging.
👤 Nate: reseed the E2E fixture before the next person relies on `npm run test:e2e`
against staging having that baseline.

## Architecture watch-list

Not gaps yet — trigger conditions live in
[`production-readiness.md`](production-readiness.md#architecture-watch-list-not-gaps-yet--written-down-so-they-dont-surprise-us):
`loadAll` scaling cliff, realtime-only-on-scores staleness (→ proposal 6.1 above),
the `record-waiver-signature` stale-hold wart (→ quality pass 3.7).
