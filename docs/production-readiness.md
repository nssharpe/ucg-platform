# Production readiness — gap analysis & plan

**Purpose:** what it takes to move UCG from a strong, deployed *prototype* to a
production platform that meets industry gold standards across UX, security,
reliability, observability, and compliance — with concrete steps split between
**👤 You (Nate)** and **🤖 Me (Claude)**.

**How to read this:** the [scorecard](#readiness-scorecard) is the one-screen summary.
Each dimension below has *Where we are → The gap → Steps*. This doc is the
*dimension view* of readiness; the single authoritative **ordered "what's next"
list lives in [`whats-next.md`](whats-next.md)** — when
the two disagree, that list wins and this doc needs a refresh.

This doc is the *non-hosting* half of launch readiness; the infrastructure/hosting
slice lives in [`hosting-and-launch.md`](hosting-and-launch.md) and is referenced, not
duplicated. Status date: **2026-07-16** (partial refresh at emv2 completion — staging +
Playwright E2E, in-app refunds, finance dashboards (B5), and the scheduled-dispatch
infra all shipped since the 2026-07-04 full refresh; per-section text below may still
read as of 7/04 where noted).

---

## Readiness scorecard

| Dimension | Now | Target | Biggest gap |
|---|---|---|---|
| Core functionality | 🟢 Strong | Gold | emv2 complete (incl. B5 finance dashboards); minor items only |
| Payments / money | 🟡 Built (test mode) | Live + refundable | Go-live checklist (live keys); hardening Phase 3 (in-app refunds ✅ shipped emv2 P3) |
| Auth & access control | 🟡 Audited once | Continuously safe | No rate limiting / CAPTCHA; no admin MFA |
| UI / UX polish | 🟡 Good, mobile-verified | WCAG AA | No a11y audit; loading/empty/error states uneven |
| Reliability / fallback | 🟢 Failure-aware | Self-healing | Offline stance undecided (queue survives reload; no offline UX) |
| Observability / monitoring | 🟡 Errors logged | Alerted | Nothing *notifies* us — no uptime check, no alerts, no analytics |
| Bug reporting | 🔴 Passive only | In-app + triage | `error_logs` captures crashes; users still can't report problems |
| Testing / CI | 🟡 Gated | Gated + E2E + staging | Staging + Playwright smoke E2E exist (2026-07-04); E2E not run in CI; no component tests |
| Email / notifications | 🟢 Production ESP | — | Resend on verified naigc.org; branded template shipped (B7 done) |
| Hosting / infra | 🟡 Dev-grade | Prod stack | GitHub Pages + HashRouter; free Supabase; **no backups/PITR** |
| Legal / compliance | 🔴 Gap | Counsel-blessed | No privacy policy / ToS; waiver unblessed; minors → COPPA |
| Data integrity / DR | 🔴 Free tier | Backups + drills | No PITR; migrations untested pre-prod; no restore drill |

🟢 ready · 🟡 partial · 🔴 not started. "Gold" = matches what a mature SaaS in this space ships.

**Status of the two cheapest, highest-leverage moves (2026-07-04):** the uptime
check is DONE (UptimeRobot, email alerts); Supabase Pro (backups/PITR) is
**deliberately deferred** to later in development — it's recorded as a hard
pre-flight gate in the go-live checklist so real money never flows without backups.

---

## 1. Reliability & graceful fallback  🟢

**Where we are.** Largely closed since 6/21. A top-level **ErrorBoundary** plus
per-route boundaries (`RouteErrorBoundary` in `App.tsx`) catch render crashes and
report to `error_logs`. The write-through layer is **failure-aware**: every remote
write goes through the outbound **write queue** (`src/lib/write-queue.ts` —
retry with backoff, persisted to localStorage so it survives reload, surfaced via
`WriteStatus.tsx` with manual retry; unit-tested). Front-end errors sink to
`error_logs` via `report-error.ts` + window handlers.

**Remaining**
- 👤 Decide the **offline stance**: *read-only when offline* (simplest, recommended)
  vs. *queue-and-sync*. Today mutations made offline sit in the queue and retry —
  workable but unannounced to the user.
- 🤖 (Watch-list) Audit optimistic updates for rollback when the server rejects a
  write the queue can't retry past (RLS denial vs. transient network).

## 2. Security hardening  🟡

**Where we are.** Much stronger than 6/21. The money paths got a **deliberate
adversarial review** (`specs/2026-07-02-security-review-findings.md`) and the fixes
shipped: DB guard triggers + policy lockdowns (hardening Phase 1), the fulfillment
`lines_snapshot` + retryable webhook (Phase 2) — both applied and verified live.
Checkout recomputes every amount server-side; the webhook is signature-verified and
fail-closed. Email moved off Gmail to Resend with scoped keys. Waiver HTML is
sanitized (DOMPurify).

**The gap.** Abuse paths are unthrottled, admins have no MFA, dependencies aren't
watched, and security headers wait on the hosting move.

**Steps**
- 🤖 **Hardening Phase 3** (`plans/2026-07-02-security-hardening.md`): coupon
  reservation at session-create, tighter `cart_member_clubpush` WITH CHECK.
- 🤖 **Rate limiting / abuse control** — throttle sign-up and the public
  email-sending functions (`request-guardian-waiver`, `notify-club-cart`,
  `request-manager-access`) per IP/user; CAPTCHA (Turnstile/hCaptcha) on sign-up.
  These can spam from our verified naigc.org domain today.
- 🤖 Add `npm audit` + **Dependabot** to CI; fix advisories.
- 🤖 Security headers (CSP, HSTS, X-Frame-Options, Referrer-Policy) once on a host
  that supports them (see hosting doc).
- 🤖 Draft a **data-minimization + retention** policy for the PII we hold (DOB,
  phone, emergency contacts) and implement user data export + delete.
- 👤 Decide **admin MFA** (recommended: require for the `admin` role;
  research in `research/2026-06-22-auth-2fa-passkeys.md`).
- 👤 Budget a lightweight **third-party security review / pen test** before live keys.

## 3. Observability & monitoring  🟡

**Where we are.** Half-built. `error_logs` (front-end exceptions, searchable admin
Error Log page) and `comm_log` (every email/SMS send) exist. But **nothing
notifies us**: no uptime check, no alerting on new errors or stuck payments, no
analytics, and Edge Function logs are ad-hoc (Supabase has no remote function-log
CLI, so webhook failures are visible only via the Stripe dashboard).

**Steps**
- 👤 ~~Uptime monitor~~ **done 2026-07-04**: UptimeRobot, 5-min HTTP checks on the
  live site + Supabase auth health (`?apikey=<anon>` — the bare endpoint 401s),
  email alerts to Nate. Monitor-specific read-only API keys are in `.env.local`.
- 🤖 Add a daily **"anything wrong?" digest**: new `error_logs` rows + `payments`
  stuck `pending` > 1h + webhook `error_logs` entries → email via Resend
  (scheduled Edge Function).
- 🤖 Optional next tier: Sentry (frontend + functions) for stack traces/releases;
  privacy-friendly analytics (Plausible/PostHog) + Web Vitals once real users arrive.

## 4. Bug reporting & support  🔴

**Where we are.** `error_logs` captures *crashes* automatically, but users
(coaches, judges, athletes) still have no way to *report* a problem, and there's
no triage pipeline.

**Steps**
- 🤖 In-app **"Report a problem"** widget: captures route, user, app version,
  recent console errors + description → Edge Function → email/GitHub issue.
- 🤖 Visible app **version/build stamp** so reports trace to a deploy.
- 👤 Decide where reports land (a `support@` inbox and/or GitHub issues) and who
  triages; set an SLA expectation for meet-day issues.

## 5. UI / UX to gold standard  🟡

**Where we are.** Cohesive brand + design-token system. **Mobile is now
systematically verified** — the topbar/mobile-nav rework shipped (6/24 spec) and
every layout change is checked at 375/768/1280px as a standing rule. Contrast is a
standing hard requirement. Not yet done: an accessibility audit, and
loading/empty/error-state consistency across pages.

**Steps**
- 🤖 **Accessibility audit** (axe + manual): keyboard nav, focus management, ARIA,
  form-error association, full contrast pass. Fix to WCAG 2.1 AA.
- 🤖 Standardize **loading / empty / error** states across pages.
- 🤖 Microcopy / error-message review (plain, actionable, on-brand).
- 🤖 Verify the **PWA update path** in production: the service worker's
  stale-bundle behavior is documented as a dev trap, but the same mechanism
  governs how real users receive deploys — add a "new version available, reload"
  prompt if updates don't land promptly.
- 👤 A short **real-user test** at a club/meet (5 people, core flows) — the
  highest-value UX signal available.

## 6. Testing, QA & CI  🟡

**Where we are.** CI now **gates every deploy on typecheck + lint + unit tests**
(`.github/workflows/deploy.yml`). 250 unit tests cover the pure logic (scoring
engines with ground-truth values, pricing, capabilities, write-queue, SMS). But
there are **no component or E2E tests** — the money UI paths (cart sync, checkout,
RegistrationEditor) are verified by hand — and **no staging environment**, so
schema/feature changes hit prod first.

**Steps**
- ~~👤 staging Supabase project~~ **done 2026-07-04** (`ucg-staging`, seeded; runbook
  in `supabase/README.md`) — migrations now apply to staging FIRST, then prod.
- ~~🤖 Playwright smoke E2E~~ **done 2026-07-04** (5 specs vs. staging: Gate sign-in,
  seeded cart, live checkout-session → Stripe render, events pages). Still open:
  **run E2E in CI** (deploy workflow runs lint/unit only).
- 🤖 Component tests (Vitest + jsdom + Testing Library) for cart-sync /
  RegistrationEditor semantics.
- 🤖 Per-release **manual QA checklist** (esp. event-day flows).

## 7. Functionality remaining  🟢

Feature status lives in [`whats-next.md`](whats-next.md) (single open-work list). The
production-relevant headlines: **payments are built** (Stripe Embedded Checkout
S1–S5, all line kinds, server-authoritative, deployed in test mode), **in-app refunds
shipped** (emv2 P3, 2026-07-11), **event management v2 complete** (P0–P6 incl. B5
finance dashboards, 2026-07-16) — remaining is the
[go-live checklist](stripe-go-live-checklist.md) (👤 live keys, smoke test) and the
deferred feature roadmap (codeless judge access, scoring config, certs/tickets).

## 8. Email / notifications  🟢

**Done.** Transport is **Resend** on the verified `naigc.org` domain with scoped
API keys, via the shared `_shared/resend.ts` helper; receipts, waivers, invites,
and notify-flows all use it. Every transactional email now shares a branded
template (`_shared/email-layout.ts` — navy header, white card, orange CTA, muted
footer, matching the Supabase sign-in-link email) — feedback tracker **B7 done**
2026-07-04.

## 9. Hosting / infra  🟡

Covered in [`hosting-and-launch.md`](hosting-and-launch.md). Headlines unchanged:
**Cloudflare Pages** (custom domain, security headers, WAF) + **`BrowserRouter`**
(retires the HashRouter auth-callback workarounds), **Supabase Pro** (daily
backups + PITR, no idle-pausing — *the* single cheapest risk reducer now that real
people + payment records exist), custom domain. 🤖 code/migration; 👤 accounts +
DNS + the Pro upgrade.

## 10. Legal & compliance  🔴

**Where we are.** Unchanged — and now the longest lead-time launch blocker. Waiver
wording is live but **not counsel-blessed**; no **privacy policy** or **ToS**; we
hold PII including **minors'** data (guardian-waiver path), raising **COPPA** (and
possibly state-privacy) obligations once real payments flow.

**Steps**
- 🤖 Draft a **privacy policy** + **terms of service** (what we collect, why,
  retention, third parties: Supabase/Stripe/Resend/Telnyx) for counsel review.
- 🤖 Implement **consent capture** (ToS/privacy at sign-up) + user data
  export/delete (pairs with §2 retention).
- 👤 Engage **counsel**: waiver wording, privacy/ToS, minor-data handling (COPPA).
  Start this early — it gates go-live and only you can drive it.
- 👤 Confirm UCG/NAIGC **insurance/liability** posture for online registration + payments.

---

## Architecture watch-list (not gaps yet — written down so they don't surprise us)

- **Data-layer scaling cliff.** `loadAll()` hydrates the entire DB (~50 tables)
  into memory + localStorage on boot; every page reads `db.*`. Fine today; will
  degrade as registrations/scores grow (payload size, phone boot time,
  localStorage ~5MB cap). *Triggers to act:* boot payload > ~2MB, admin boot >
  3s on mid-tier mobile, or the first localStorage quota error in `error_logs`.
  *Path:* per-page queries for the heavy tables (scores, registrations) first.
- **Multi-user staleness.** Realtime covers only `scores`; all other concurrent
  edits (two managers on one club, admin + manager) are invisible until a manual
  `syncFromSupabase()`/reload. Expect "my change disappeared" reports once clubs
  have multiple active managers; consider realtime or refetch-on-focus for
  `registrations`/`cart_items` then.
- **Known wart:** `record-waiver-signature` can re-assert a stale club-payment
  hold if the club paid before the guardian signed (see CLAUDE.md).

---

## Recommended sequence

The ordering principle: **don't handle real money or real users while blind.**
Phase 0 (the safety net) is now mostly DONE — what's left of it is accounts-and-money
items only Nate can do.

| Phase | Theme | Contents | Status |
|---|---|---|---|
| **0** | Safety net & foundation | ~~Error boundary~~ · ~~write-failure surfacing~~ · ~~CI test gate~~ · ~~RLS audit~~ · ~~production ESP~~ · ~~uptime/alerting~~ · ~~staging env~~ · **Supabase Pro + backups** | 🟡 done except 👤 Supabase Pro |
| **1** | Payments | ~~Build (S1–S5)~~ · ~~server-authoritative fulfillment~~ · ~~security hardening P1+P2~~ · ~~in-app refunds~~ (emv2 P3) · **go-live checklist (live keys)** · **hardening P3** | 🟡 built + hardened; go-live is 👤 |
| **2** | Hardening & polish | Rate limiting/CAPTCHA · a11y audit · loading/error states · bug-report widget · E2E in CI · UI/UX fix batch · **legal docs (waiver/privacy/ToS/COPPA)** · hosting move + headers | 🔴 next up |
| **3** | Remaining features | Codeless judge access · scoring config · multi-club picker · typed memberships · certs/tickets (~~B5 finance~~ shipped emv2 P6) | 🔴 as prioritized |
| **4** | Scale & ongoing | Analytics-driven iteration · status page · external API · data-layer scale path (watch-list above) | — |

---

## Decisions I need from you (updated 2026-07-04)

Resolved since 6/21: Stripe account ✅ (built, test mode) · Resend ✅ (naigc.org
verified) · CI test gate ✅ · error boundary/write-queue ✅ · RLS audit ✅ (7/02
review + hardening). Still open, in order of leverage:

1. **Supabase Pro** upgrade ($25/mo) — DEFERRED 2026-07-04; hard pre-flight gate in
   the go-live checklist.
2. ~~Uptime monitor~~ — done 2026-07-04 (UptimeRobot, email alerts).
3. ~~Staging environment~~ — approved 2026-07-04.
4. **Legal**: engage counsel (waiver, privacy/ToS, COPPA) — longest lead time.
5. **Bug reports**: where they land (support inbox vs. GitHub) and who triages.
6. **Offline stance** (recommend: read-only offline) and **admin MFA** (recommend: require).
7. **Security review budget** before live keys.
