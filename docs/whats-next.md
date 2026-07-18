# What's next — the authoritative open-work list

**This is the single source of truth for open work.** Reconciled with the codebase
**2026-07-16**, the day event-management v2 (P0–P6) shipped in full. It replaces the
"What's next" section that used to live in [`README.md`](README.md) — update THIS file
when priorities change, not rival copies. [`production-readiness.md`](production-readiness.md)
is the per-dimension gap analysis; [`../CLAUDE.md`](../CLAUDE.md) keeps only a pointer here.

Legend: 👤 = only Nate can do it · 🤖 = Claude can build it · 💬 = needs a decision first.

---

## 1. Nate-only action items (👤 — quick, unblock others)

1. ~~Grant `finance_admin`~~ **done 2026-07-16** (Nate granted all relevant users).
2. **Verify the P3 refund prerequisites landed:** "UCG - Main" flagged
   `clubs.is_league_host` + `refund_manager` granted to whoever reviews refunds.
3. ~~Confirm the host-payout "owed" formula with Julia~~ **answered + shipped
   2026-07-17**: owed = event gross collected (registrations + add-ons, before
   service/admin fees), refunds NOT deducted (hosts handle their own refunds;
   league-hosted events get no payout). `src/lib/finance.ts` updated.
4. **Supabase Pro upgrade** (backups/PITR) — deliberately deferred 2026-07-04; a hard
   pre-flight gate in the [go-live checklist](stripe-go-live-checklist.md). Interim
   insurance: daily dumps via `scripts/backup-db.mjs` (runbook in
   [supabase/README](../supabase/README.md)).
5. **Stripe go-live** — [stripe-go-live-checklist.md](stripe-go-live-checklist.md)
   (account activation, live keys, $1 smoke + refund).
6. **Legal (longest lead time — start early):** engage counsel on waiver wording,
   privacy policy, ToS, minors/COPPA. 🤖 drafts the documents (item 2.4 below).
7. 💬 **Open decisions** — resolved by Nate 2026-07-16 and SHIPPED 2026-07-17:
   - Offline stance: **read-only when offline** — ✅ shipped (write-queue
     hardening: permanent-failure rollback + toast, `mutate()` offline gate,
     offline banner).
   - Admin MFA: ✅ **shipped in full** (merged + deployed 2026-07-17) — see
     item 5's MFA entry for the two remaining 👤 toggles.
   - Bug reports: ✅ **shipped** — in-app "Report a problem" (category-routed
     email: site broken → nssharpe@gmail.com + jzsharpe@gmail.com;
     event/rule/policy → the `+ucghelp` aliases; unsure → both) + version
     stamp. Swap-to-real-emails is on the go-live checklist.
   - Security-review budget: ✅ researched — options brief at
     [research/2026-07-17-security-review-options.md](research/2026-07-17-security-review-options.md);
     👤 Nate picks an option + timing (gates live keys).

## 2. Launch blockers (🤖 buildable now)

0. ~~Fix `camp_survey` world-readability~~ **FIXED 2026-07-17** (migrations
   `20260717205348` + `20260717211754`, applied staging + prod, anon-probe
   verified on both; fix record in
   [results](research/2026-07-17-supabomb-scan-results.md)).
1. **Security hardening Phase 3** ([plan](plans/2026-07-02-security-hardening.md)):
   M1 coupon reservation at session-create, M2 tighter `cart_member_clubpush`
   WITH CHECK, M4 route the `people` self-insert-by-email branch through
   `link_or_create_person`, plus the LOW items (scoped reads, `error_logs`
   insert rate-limit, token entropy check).
2. **Rate limiting / CAPTCHA** on sign-up and the public email-sending functions
   (`request-guardian-waiver`, `notify-club-cart`, `request-manager-access`) —
   these can spam from the verified naigc.org domain today. **DEFERRED to
   just-before-launch (Nate, 2026-07-18):** CAPTCHA interferes with dev/E2E
   testing paths; keep it on the go-live checklist rather than building now.
3. **Daily "anything wrong?" digest** — SHIPPED 2026-07-17: `daily-digest` kind
   in `scheduled-dispatch` (new `error_logs` rows since the last digest +
   every `payments` row stuck `pending` > 1h → email via Resend, at most once
   per UTC day). Runbook in `supabase/README.md` "Scheduled dispatch (pg_cron)".
   Deployed to prod + staging 2026-07-17.
4. **Privacy policy + ToS drafts** for counsel review, plus sign-up consent capture.
5. ~~Run the Playwright E2E suite in CI~~ ✅ **shipped 2026-07-18** — non-blocking
   `e2e` job in the deploy workflow (staging backend, `STAGING_ENV_FILE` secret,
   HTML report artifact on failure). Deliberately outside `deploy`'s needs chain;
   **flip to a blocking gate once it's proven stable on CI** (tracked here).
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
- ~~In-app "Report a problem" widget + version/build stamp~~ ✅ **shipped 2026-07-17**
  (nav-drawer entry, 3-category email routing via the `report-problem` edge fn,
  console-error ring buffer, git-SHA build stamp, **image attachments** — up to 3
  screenshots, client-compressed + magic-byte-validated; all live-smoke-tested).
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
- ~~MFA/passkeys~~ ✅ **shipped 2026-07-17** (merged to main; migration applied
  staging+prod; 9 guarded edge functions deployed): TOTP opt-in (Profile),
  aal2-required admins (hardened `is_admin()` + step-up challenge at sign-in +
  the edge-function AAL guard on every privileged function), admin break-glass
  reset (`admin-reset-mfa`; dashboard = last-admin fallback).
- ~~Passkey sign-in (free feature)~~ ✅ **shipped 2026-07-18** — `Gate.tsx`
  "Sign in with a passkey" + a Profile "Passkeys" management card
  (`src/pages/ProfilePasskeys.tsx`), using Supabase's free Passkeys sign-in API
  (distinct from the paid "Advanced MFA - WebAuthn" add-on, which stays
  declined — its dead Profile "Add a passkey" MFA-enroll UI was removed in the
  same change). 👤 remainder: **enroll your own TOTP factor** (and Julia's) so
  admin accounts actually get the aal2 protection.
- Further out: PDF certificates, external API.

## 6. Proposed additions (Claude, 2026-07-16 — NOT yet committed; Nate to triage)

Suggested from a post-emv2 read of the platform; none of these are in a spec yet:

1. **Multi-manager freshness.** Realtime covers only `scores`; two managers editing one
  club (or admin + manager) don't see each other's changes until reload. A
  refetch-on-focus (or realtime) for `registrations`/`cart_items`/`memberships` heads
  off "my change disappeared" reports — the watch-list trigger effectively fires the
  moment clubs have two active managers, which club invites already enable.
2. **Payments reconciliation admin view.** Two known drifts have no surface: `payments`
  rows stuck `pending` (webhook missed/failed) and Stripe-Dashboard-issued refunds that
  never reflect into `payments.status`. A small admin card (and/or the daily digest
  above) that lists both would close the loop between Stripe and the DB.
3. **Season rollover runbook/tooling.** Memberships, club memberships, and waivers are
  per-season; the first season boundary will otherwise be an ad-hoc manual scramble
  (what expires, what re-gates, what carries over). Decide + script it before it happens.
4. **User data export + delete.** Pairs with the legal/retention work (§2.4) — we hold
  minors' PII; counsel will likely require it anyway.
5. ~~Component tests~~ ✅ **shipped 2026-07-18** — jsdom + Testing Library in
  `tests/components/` (17 tests): cart-sync removal/revert semantics (real
  `removeCartItemWithSync` + shared `CART_REMOVAL_MESSAGE`), RegistrationEditor
  change-fee derivation (real component), membership-hold badge rendering.
6. **In-app help / host & manager guides.** The feature surface is now large (hosting,
  waitlists, add-ons, refunds, finance). Short task-oriented docs (or contextual help
  links) reduce Julia-as-support and make fall-season onboarding of hosts cheaper.
7. **Privacy-friendly analytics + Web Vitals** (Plausible/PostHog) once real users
  arrive; optional Sentry for stack traces with releases.
8. **Data-layer scale path** — no action yet; act on the documented triggers (boot
  payload > ~2MB, admin boot > 3s mid-tier mobile, first localStorage quota error):
  per-page queries for `scores`/`registrations` first.

## Architecture watch-list

Not gaps yet — trigger conditions live in
[`production-readiness.md`](production-readiness.md#architecture-watch-list-not-gaps-yet--written-down-so-they-dont-surprise-us):
`loadAll` scaling cliff, realtime-only-on-scores staleness (→ proposal 6.1 above),
the `record-waiver-signature` stale-hold wart (→ quality pass 3.7).
