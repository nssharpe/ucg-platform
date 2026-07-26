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

0. **Security hardening Phase 3** ([plan](plans/2026-07-02-security-hardening.md)) —
   🟡 **PARTIAL, 2026-07-24.** ✅ M2 (`cart_member_clubpush` now membership-only),
   ✅ M4 (`people` self-insert-by-email branch dropped, + the companion `auth.ts`
   fix it needed), ✅ **invoice write lockdown** (not originally in the plan — any
   member could forge a paid invoice via PostgREST; writes on `invoices`/
   `invoice_items` are now admin-only). **Applied to staging AND prod 2026-07-24**,
   live-probed 7/7 as a non-admin against both.
   🟡 **M1 (coupon reservation at session-create) DRAFTED 2026-07-26, not yet
   applied** — branch `sec/m1-coupon-reservation`, migration `20260726130005`;
   correctly does not reserve on the `mode: 'preview'` path (see
   [money-story spec](specs/2026-07-04-money-story-ux.md)). 🤖 build/eslint/vitest
   green; needs the controller's `supabase db push` (staging then prod) + the
   staging concurrency proof before it actually closes the gap and this can be
   marked done.
   ❌ Still open after that: the LOW items (scoped `club_managers`/`app_settings`
   reads, `error_logs` insert rate-limit; token entropy was checked and is sound,
   a 256-bit bump is optional polish).
5. ✅ **FIXED 2026-07-24 — `loadAll` silently truncated at 1000 rows.** Every table
   read now paginates AND sorts deterministically (an unordered `.range()` can
   duplicate/skip rows — a second latent bug found on the way). Proven on staging:
   the old fetch returned exactly 1000 of 1,748 `scores`; the new one returns all
   1,748 with no dupes. Original report, kept for context: `fetchAllRows` paged past
   PostgREST's cap for `people` only; **`scores` and `registrations` use a bare
   `.select()`**, so past 1000 rows they return the first 1000 with NO error. A
   single nationals produces ~4–8k score rows, so this breaks at the first
   nationals, with partial Results pages and Finance totals computed off a
   truncated set. Phase 0 of the
   [data-layer scale spec](specs/2026-07-24-data-layer-scale.md) — small,
   self-contained, ship before the rest of 6.3.
1. **Rate limiting / CAPTCHA** on sign-up and the public email-sending functions
   (`request-guardian-waiver`, `notify-club-cart`, `request-manager-access`) —
   these can spam from the verified naigc.org domain today. **DEFERRED to
   just-before-launch (Nate, 2026-07-18):** CAPTCHA interferes with dev/E2E
   testing paths; keep it on the go-live checklist rather than building now.
2. **Privacy policy + ToS drafts** for counsel review, plus sign-up consent capture.
3. **Playwright E2E CI gate** — the `e2e` job shipped non-blocking 2026-07-18;
   flip to a blocking gate in the deploy workflow once it's proven stable on CI.
4. **Hosting move** ([hosting-and-launch.md](hosting-and-launch.md)): Cloudflare Pages
   + custom domain (`registration.unitedgymnastics.org`) + `BrowserRouter` (retires the
   HashRouter auth-callback workarounds) + security headers (CSP/HSTS/…). 🤖 code;
   👤 accounts + DNS.

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
3. **Data-layer scale path** — no action yet; act on the documented triggers (boot
  payload > ~2MB, admin boot > 3s mid-tier mobile, first localStorage quota error):
  per-page queries for `scores`/`registrations` first.

## Architecture watch-list

Not gaps yet — trigger conditions live in
[`production-readiness.md`](production-readiness.md#architecture-watch-list-not-gaps-yet--written-down-so-they-dont-surprise-us):
`loadAll` scaling cliff, realtime-only-on-scores staleness (→ proposal 6.1 above),
the `record-waiver-signature` stale-hold wart (→ quality pass 3.7).
