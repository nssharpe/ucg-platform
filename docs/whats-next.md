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

**In progress (2026-07-19):**

- **B** Typed-membership residuals: athlete-gate registration (canRegister requires an
  athlete-type membership) + per-type admin grant/revoke; single General waiver per
  season CONFIRMED as final.
- **D** Codeless judge access: ONE access code per event (URL / 6-digit / QR forms of
  the same token), no per-judge identity — an unlocked device can enter scores for any
  discipline/apparatus at that event. **Implemented 2026-07-19 on branch
  `feat/judge-access-codes`** (migration `20260719120000_judge_access_codes.sql`,
  edge fn `judge-entry`, host "Judge access" card on the event host page,
  `/judge/access/:token` public unlock page) — build/lint/vitest all green;
  awaiting the adversarial money/auth/RLS-flavored review before merge + the
  migration/function deploy (neither has run yet).
- **E** Scoring config: per-EVENT setting — 1-or-2 judge panels (2 = average the two
  execution scores) + default entry mode calculator-vs-simple.

**Further out:**
- PDF certificates, external API.

**Residual from shipped work:**
- 👤 **Enroll your own TOTP factor** (and Julia's) so admin accounts actually get the
  aal2 protection (shipped MFA feature, 2026-07-17).

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
