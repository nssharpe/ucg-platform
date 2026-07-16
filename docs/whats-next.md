# What's next — the authoritative open-work list

**This is the single source of truth for open work.** Reconciled with the codebase
**2026-07-16**, the day event-management v2 (P0–P6) shipped in full. It replaces the
"What's next" section that used to live in [`README.md`](README.md) — update THIS file
when priorities change, not rival copies. [`production-readiness.md`](production-readiness.md)
is the per-dimension gap analysis; [`../CLAUDE.md`](../CLAUDE.md) keeps only a pointer here.

Legend: 👤 = only Nate can do it · 🤖 = Claude can build it · 💬 = needs a decision first.

---

## 1. Nate-only action items (👤 — quick, unblock others)

1. **Grant `finance_admin`** in `user_roles` to Julia / the bookkeeper — the
   `#/admin/finance` page is live but only admins see it today (emv2 P6).
2. **Verify the P3 refund prerequisites landed:** "UCG - Main" flagged
   `clubs.is_league_host` + `refund_manager` granted to whoever reviews refunds.
3. **Confirm the host-payout "owed" formula with Julia** — the P6 payout card
   provisionally uses *event net revenue*; adjust `src/lib/finance.ts` when she answers.
4. **Supabase Pro upgrade** (backups/PITR) — deliberately deferred 2026-07-04; a hard
   pre-flight gate in the [go-live checklist](stripe-go-live-checklist.md). Interim
   insurance: daily dumps via `scripts/backup-db.mjs` (runbook in
   [supabase/README](../supabase/README.md)).
5. **Stripe go-live** — [stripe-go-live-checklist.md](stripe-go-live-checklist.md)
   (account activation, live keys, $1 smoke + refund).
6. **Legal (longest lead time — start early):** engage counsel on waiver wording,
   privacy policy, ToS, minors/COPPA. 🤖 drafts the documents (item 2.4 below).
7. 💬 **Open decisions** (from production-readiness): offline stance (recommend
   read-only offline), admin MFA (recommend require), where bug reports land,
   security-review budget before live keys.

## 2. Launch blockers (🤖 buildable now)

1. **Security hardening Phase 3** ([plan](plans/2026-07-02-security-hardening.md)):
   M1 coupon reservation at session-create, M2 tighter `cart_member_clubpush`
   WITH CHECK, M4 route the `people` self-insert-by-email branch through
   `link_or_create_person`, plus the LOW items (scoped reads, `error_logs`
   insert rate-limit, token entropy check).
2. **Rate limiting / CAPTCHA** on sign-up and the public email-sending functions
   (`request-guardian-waiver`, `notify-club-cart`, `request-manager-access`) —
   these can spam from the verified naigc.org domain today.
3. **Daily "anything wrong?" digest** — new `error_logs` rows + `payments` stuck
   `pending` > 1h → email via Resend. Cheap now: `scheduled-dispatch` (pg_cron,
   15-min) already exists; this is one more dispatch kind.
4. **Privacy policy + ToS drafts** for counsel review, plus sign-up consent capture.
5. **Run the Playwright E2E suite in CI** (staging project + specs exist; the deploy
   workflow doesn't run them yet).
6. **Hosting move** ([hosting-and-launch.md](hosting-and-launch.md)): Cloudflare Pages
   + custom domain (`registration.unitedgymnastics.org`) + `BrowserRouter` (retires the
   HashRouter auth-callback workarounds) + security headers (CSP/HSTS/…). 🤖 code;
   👤 accounts + DNS.

## 3. Quality passes (pre- or just post-launch)

- **UI/UX review fixes** ([task briefs](plans/2026-07-04-uiux-review-fixes.md), from the
  2026-07-04 live review — **none started**). Highest-value first: O1 "money story"
  reconciliation (cart vs. checkout vs. Purchase-History amounts + unpaid-invoice path
  + invoice numbering), coral-CTA contrast (AA fail), Profile save-bar overlap,
  payment-status badges on My Registrations.
- **Accessibility audit** to WCAG 2.1 AA (axe + manual keyboard/focus/ARIA pass) +
  loading/empty/error-state consistency across pages.
- **In-app "Report a problem" widget** + visible version/build stamp (`error_logs` is
  passive today).
- **New-club-request email** to `newclubinquiries@naigc.org` (transport exists, not wired).
- **PWA production update path** — verify deploys reach users promptly; add a "new
  version available, reload" prompt if not.
- **`npm audit` + Dependabot** in CI.
- **Fix the `record-waiver-signature` stale-hold wart** — it can re-assert a
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

## 5. Feature roadmap (as previously prioritized)

- **B** typed memberships + per-season waiver →
- **C** multi-club registration picker →
- **D** codeless judge access (URL / 6-digit code / QR) →
- **E** scoring config (1-vs-2 panels, calculator vs. simple entry).
- Further out: MFA/passkeys ([research](research/2026-06-22-auth-2fa-passkeys.md)),
  PDF certificates, external API.

## 6. Proposed additions (Claude, 2026-07-16 — NOT yet committed; Nate to triage)

Suggested from a post-emv2 read of the platform; none of these are in a spec yet:

- **Multi-manager freshness.** Realtime covers only `scores`; two managers editing one
  club (or admin + manager) don't see each other's changes until reload. A
  refetch-on-focus (or realtime) for `registrations`/`cart_items`/`memberships` heads
  off "my change disappeared" reports — the watch-list trigger effectively fires the
  moment clubs have two active managers, which club invites already enable.
- **Payments reconciliation admin view.** Two known drifts have no surface: `payments`
  rows stuck `pending` (webhook missed/failed) and Stripe-Dashboard-issued refunds that
  never reflect into `payments.status`. A small admin card (and/or the daily digest
  above) that lists both would close the loop between Stripe and the DB.
- **Season rollover runbook/tooling.** Memberships, club memberships, and waivers are
  per-season; the first season boundary will otherwise be an ad-hoc manual scramble
  (what expires, what re-gates, what carries over). Decide + script it before it happens.
- **User data export + delete.** Pairs with the legal/retention work (§2.4) — we hold
  minors' PII; counsel will likely require it anyway.
- **Component tests** (Vitest + jsdom + Testing Library) for the money-adjacent UI
  semantics that are hand-verified today: cart-sync removal/revert, RegistrationEditor
  change-fee derivation, membership-hold rendering.
- **In-app help / host & manager guides.** The feature surface is now large (hosting,
  waitlists, add-ons, refunds, finance). Short task-oriented docs (or contextual help
  links) reduce Julia-as-support and make fall-season onboarding of hosts cheaper.
- **Privacy-friendly analytics + Web Vitals** (Plausible/PostHog) once real users
  arrive; optional Sentry for stack traces with releases.
- **Data-layer scale path** — no action yet; act on the documented triggers (boot
  payload > ~2MB, admin boot > 3s mid-tier mobile, first localStorage quota error):
  per-page queries for `scores`/`registrations` first.

## Architecture watch-list

Not gaps yet — trigger conditions live in
[`production-readiness.md`](production-readiness.md#architecture-watch-list-not-gaps-yet--written-down-so-they-dont-surprise-us):
`loadAll` scaling cliff, realtime-only-on-scores staleness (→ proposal 6.1 above),
the `record-waiver-signature` stale-hold wart (→ quality pass 3.7).
