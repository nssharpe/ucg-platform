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
3. 🟡 **Data-layer scale path — Phase 0-3 DONE (Phase 3 drafted, not yet merged),
  Phases 4-5 OPEN**
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
  `perf/6-3-phase3-registrations-slice`, NOT YET merged) did the same for
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
  Untouched by the Phase 3 diff (Phase 3 doesn't read either table) — a real,
  separate finding worth a follow-up investigation before a real nationals
  approaches 10k+ memberships/invoices, but out of scope for Phase 3 itself.
  Phase 4 (slim the `people` directory projection) and Phase 5 (restrict
  localStorage persistence to Tier 1+2) are the next actual fixes; controller
  still owns reviewing + merging Phase 3 and running Phases 4-5, plus
  investigating the new memberships/invoices RLS-timeout finding.

## 7. 🐛 Expensive RLS on `memberships` / `invoices` / `invoice_items` (found 2026-07-26)

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

Worth doing before a real season accumulates that volume: `EXPLAIN ANALYZE` the
policies on all three as `authenticated`, and check whether they can be rewritten with
the `my_person_id()` / `manages_club()` SECURITY DEFINER helper pattern (which exists
precisely to avoid per-row cross-table subqueries in policies — see CLAUDE.md's
42P17 recursion note for the related trap).

Not urgent at current prod volume (invoices 43, invoice_items 69, memberships 39).

## Architecture watch-list

Not gaps yet — trigger conditions live in
[`production-readiness.md`](production-readiness.md#architecture-watch-list-not-gaps-yet--written-down-so-they-dont-surprise-us):
`loadAll` scaling cliff, realtime-only-on-scores staleness (→ proposal 6.1 above),
the `record-waiver-signature` stale-hold wart (→ quality pass 3.7).
