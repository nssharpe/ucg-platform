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
5. **Security-review option + timing** — options brief at
   [research/2026-07-17-security-review-options.md](research/2026-07-17-security-review-options.md);
   👤 Nate picks an option + timing (gates live keys).

## 2. Launch blockers (🤖 buildable now)

0. **Security hardening Phase 3** ([plan](plans/2026-07-02-security-hardening.md)):
   M1 coupon reservation at session-create, M2 tighter `cart_member_clubpush`
   WITH CHECK, M4 route the `people` self-insert-by-email branch through
   `link_or_create_person`, plus the LOW items (scoped reads, `error_logs`
   insert rate-limit, token entropy check).
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

- **UI/UX review fixes** ([task briefs](plans/2026-07-04-uiux-review-fixes.md), from the
  2026-07-04 live review — **none started**). Highest-value first: O1 "money story"
  reconciliation (cart vs. checkout vs. Purchase-History amounts + unpaid-invoice path
  + invoice numbering), coral-CTA contrast (AA fail), Profile save-bar overlap,
  payment-status badges on My Registrations.
- **Accessibility audit** to WCAG 2.1 AA (axe + manual keyboard/focus/ARIA pass) +
  loading/empty/error-state consistency across pages.
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
