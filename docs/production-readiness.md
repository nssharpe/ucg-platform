# Production readiness — gap analysis & plan

**Purpose:** what it takes to move UCG from a strong, deployed *prototype* to a
production platform that meets industry gold standards across UX, security,
reliability, observability, and compliance — with concrete steps split between
**👤 You (Nate)** and **🤖 Me (Claude)**.

**How to read this:** the [scorecard](#readiness-scorecard) is the one-screen summary.
Each dimension below has *Where we are → The gap → Steps*. The
[phased sequence](#recommended-sequence) orders the work; the
[decisions I need](#decisions-i-need-from-you) is your action list for the morning.

This doc is the *non-hosting* half of launch readiness; the infrastructure/hosting
slice lives in [`hosting-and-launch.md`](hosting-and-launch.md) and is referenced, not
duplicated. Status date: **2026-06-21**.

---

## Readiness scorecard

| Dimension | Now | Target | Biggest gap |
|---|---|---|---|
| Core functionality | 🟢 Strong | Gold | Payments not started |
| Payments / money | 🔴 None | PCI-safe Stripe | Entire flow (the launch blocker for revenue) |
| Auth & access control | 🟡 Good base | Audited | RLS never formally audited; no rate limiting / MFA |
| UI / UX polish | 🟡 Good proto | WCAG AA, mobile-first | No a11y audit; inconsistent loading/error/empty states |
| Reliability / fallback | 🔴 Weak | Self-healing | No error boundary; **writes fail silently**; no offline UX |
| Observability / monitoring | 🔴 None | Full | No error tracking, uptime, or analytics |
| Bug reporting | 🔴 None | In-app + triage | No way for users to report; no issue pipeline |
| Testing / CI | 🟡 Partial | Gated + E2E | CI doesn't run tests; no component/E2E; no staging |
| Email / notifications | 🟡 Test-grade | Production ESP | Personal Gmail SMTP with send caps |
| Hosting / infra | 🟡 Dev-only | Prod stack | GitHub Pages, free Supabase, no staging, no backups/PITR |
| Legal / compliance | 🔴 Gap | Counsel-blessed | No privacy policy / ToS; waiver unblessed; minors → COPPA |
| Data integrity / DR | 🔴 Free tier | Backups + drills | No PITR; migrations untested pre-prod; no restore drill |

🟢 ready · 🟡 partial · 🔴 not started. "Gold" = matches what a mature SaaS in this space ships.

---

## 1. Reliability & graceful fallback  🔴

**Where we are.** One uncaught render error white-screens the whole app (no React
error boundary). The write-through layer (`src/lib/supabase.ts` `push*` helpers) is
**fire-and-forget** — if a save to Supabase fails, the UI still shows success and the
change is lost on the next reload. PWA caches the shell, but mutations made offline
aren't queued. Optimistic updates have no rollback.

**The gap.** A production app degrades gracefully: it catches crashes, tells the user
when a save didn't stick, retries transient failures, and never silently loses data.

**Steps**
- 🤖 Add a top-level **React error boundary** with a branded fallback ("something
  broke — reload / report") that also reports to monitoring (§3).
- 🤖 Make write-through **failure-aware**: surface failed `push*` writes (toast +
  retry), and add a small outbound queue so a dropped write retries instead of
  vanishing. This is the highest-risk reliability gap — silent data loss.
- 🤖 Add per-route error boundaries so one broken page doesn't kill navigation.
- 🤖 Define and implement **offline behavior** (block mutations with a clear message,
  or queue them) rather than failing opaquely.
- 🤖 Audit optimistic updates for rollback on server rejection.
- 👤 Decide the offline stance: *read-only when offline* (simplest, recommended) vs.
  *queue-and-sync* (more work). I recommend read-only for v1.

## 2. Security hardening  🟡

**Where we are.** RLS is the real boundary and is in place; secrets (service-role,
Gmail password) live only in Edge Functions / Actions vars; waiver HTML is sanitized
(DOMPurify); email confirmation is on. But: RLS has never had a **deliberate audit**,
there's **no rate limiting or CAPTCHA** (sign-up and the guardian-email function can be
abused to send spam on our domain), no MFA for admins, no dependency scanning, no
security headers (GitHub Pages can't set them), and the shared Gmail app password is a
broad credential.

**The gap.** Gold standard: every policy proven, abuse paths throttled, admins MFA'd,
dependencies watched, headers enforced, secrets scoped and rotatable.

**Steps**
- 🤖 **RLS audit** — enumerate every table + policy; write a test script that asserts,
  per role (anon/member/manager/admin), exactly what's readable/writable; fix anything
  world-writable. Enable Supabase leaked-password protection.
- 🤖 **Rate limiting / abuse control** — throttle sign-up, guardian-waiver, and
  notify-club-cart per IP/user; add CAPTCHA (hCaptcha/Turnstile) to sign-up and any
  email-sending public action.
- 🤖 Add `npm audit` + **Dependabot** to CI; fix advisories.
- 🤖 Security headers (CSP, HSTS, X-Frame-Options, Referrer-Policy) once on a host that
  supports them (Cloudflare/Netlify — see hosting doc).
- 🤖 Draft a **data-minimization + retention** policy for the PII we hold (DOB, phone,
  emergency contacts, dietary/health notes) and implement user data export + delete.
- 👤 Decide **admin MFA** (recommended: require it for the `admin` role).
- 👤 Move email off the personal Gmail app password to a provider with scoped,
  rotatable API keys (§8) — a security *and* deliverability win.
- 👤 Budget a lightweight **third-party security review / pen test** before handling
  payments (a few hundred $ or a security-minded volunteer).

## 3. Observability & monitoring  🔴

**Where we are.** Nothing. No frontend error tracking, no uptime check, no analytics,
no alerting. When something breaks in production we find out only if a user tells us.

**The gap.** We should see errors, outages, and usage *before* users report them.

**Steps**
- 🤖 Wire **Sentry** (frontend + Edge Functions): captures exceptions, release tagging,
  source maps, user/route context. Feeds the error boundary and write-failure paths.
- 🤖 Add structured logging + request IDs to all Edge Functions (currently ad-hoc).
- 🤖 Add a **health-check** endpoint/page and hook up **uptime monitoring**
  (Better Uptime / UptimeRobot) with alerts to you.
- 🤖 Add **privacy-friendly analytics** (Plausible or PostHog) + Web Vitals RUM so we
  see real funnels (sign-up → membership → registration) and real performance.
- 👤 Pick the destinations for alerts (email/SMS/Slack) and create the Sentry +
  uptime + analytics accounts (all have free tiers).
- 👤 Confirm analytics choice is privacy-compliant for the privacy policy (§10).

## 4. Bug reporting & support  🔴

**Where we are.** No in-app way to report a problem; no triage pipeline.

**The gap.** Users (coaches, judges, athletes) need a one-click "report a problem" that
captures context, and we need a place those land and get triaged.

**Steps**
- 🤖 Add an in-app **"Report a problem"** widget that captures route, user, app version,
  recent console errors, and a screenshot/description → files a GitHub issue (or emails
  a support inbox) via an Edge Function.
- 🤖 Add a visible app **version/build stamp** so reports are traceable to a deploy.
- 👤 Decide where reports land (a `support@` inbox and/or GitHub issues) and who
  triages. Set a simple SLA expectation for meet-day issues (these are time-critical).
- 👤 Consider a lightweight **status page** for posting outages during meets.

## 5. UI / UX to gold standard  🟡

**Where we are.** Cohesive brand and a working design-token system; decent prototype
screens. Not yet audited for accessibility, mobile, or state coverage — and the app is
used **courtside on phones/tablets** by judges and coaches, so mobile is not optional.

**The gap.** WCAG 2.1 AA, mobile-first, and consistent loading/empty/error states
everywhere.

**Steps**
- 🤖 **Accessibility audit** (axe + manual): keyboard nav, focus management, ARIA labels,
  form-error association, and a full **color-contrast** pass (a recurring trap here —
  see CLAUDE.md). Fix to AA.
- 🤖 **Responsive/mobile audit** of every critical flow (membership, waiver, score entry,
  registration grid, results) at phone/tablet widths.
- 🤖 Standardize **loading / empty / error** states across pages (today they're uneven).
- 🤖 Document the design system (tokens, components, states) so it stays consistent.
- 🤖 Microcopy / error-message review (plain, actionable, on-brand).
- 👤 A short **real-user test** at a club/meet (5 people, the core flows) — the highest-
  value UX signal we can get. I'll turn findings into fixes.
- 👤 Decide whether judges/coaches need a true installable mobile experience (PWA is
  already installable; may be enough).

## 6. Testing, QA & CI  🟡

**Where we are.** Solid **unit tests** for the pure logic (scoring engines, capability
derivation, nationals) — but **CI doesn't run them** (it only builds + deploys), there
are **no component or end-to-end tests**, and there's **no staging environment**, so
schema/feature changes hit prod first.

**The gap.** Tests gate every deploy; critical user journeys have E2E coverage; changes
prove out on staging before prod.

**Steps**
- 🤖 Gate CI on **`tsc` + `lint` + `test`** before the deploy job (cheap, high value —
  do this first).
- 🤖 Add **component tests** (Vitest + jsdom + Testing Library) for money/safety-critical
  flows: membership purchase, waiver signing, score entry, registration.
- 🤖 Add **Playwright E2E** for the handful of can't-break journeys, run against staging.
- 🤖 Stand up a **staging** Supabase project + preview deploys so migrations and releases
  are tested before prod (also unblocks safe payment testing).
- 🤖 Write a per-release **manual QA checklist** (esp. meet-day flows).
- 👤 Approve the staging project (a second free Supabase project) — small monthly effort,
  big safety gain.

## 7. Functionality remaining  🟢/🟡

Feature status lives in [`README.md`](README.md) (the index) and the roadmap in
[`docs/README.md`](README.md). The production-relevant headlines:

- 🔴 **Payments (Stripe)** — *the* gating feature for real revenue: memberships, meet
  entries, banquet, **settling the club cart**, coupons reconciliation, refunds, and
  emailed receipts. Plan exists in [`research/2026-06-18-stripe-plan.md`](research/2026-06-18-stripe-plan.md).
- 🟡 Codeless judge access (URL / 6-digit / QR), meet scoring config (1-vs-2 panel,
  calculator vs. simple), club-based multi-club registration picker.
- 🟡 PDF certificates, banquet tickets, finals rosters, nationals status dashboard.
- 🟢 Small: fire the **new-club-request email** (transport now exists — see CLAUDE.md).

🤖 I implement these; 👤 you prioritize order and approve scope per feature.

## 8. Email / notifications  🟡

**Where we are.** Working but **test-grade**: Gmail SMTP via Edge Functions with
recipient caps and a shared app password. Fine for testing, not for production volume,
deliverability, or security.

**Steps**
- 🤖 Swap the transport to **Resend** (or Postmark/SES) behind the same function
  interface — minimal code change, big reliability/deliverability gain.
- 🤖 Add SPF/DKIM/DMARC for the sending domain; templated, branded emails; unsubscribe
  where required.
- 👤 Create the ESP account and verify a `@unitedgymnastics.org` (or `@naigc.org`)
  sending domain with DNS records.

## 9. Hosting / infra  🟡

Covered in detail in [`hosting-and-launch.md`](hosting-and-launch.md). Headlines:
**Cloudflare Pages** (custom domain, security headers, WAF) + **`BrowserRouter`**,
**Supabase Pro** (daily backups + PITR, no idle-pausing), custom domain on
`registration.unitedgymnastics.org`. 🤖 code/migration; 👤 accounts + DNS + the Pro
upgrade.

## 10. Legal & compliance  🔴

**Where we are.** Waiver wording is in place but **not blessed by counsel**; there's no
**privacy policy** or **terms of service**; we collect PII including data on **minors**
(the guardian-waiver path exists), which raises **COPPA** (and possibly GDPR/CCPA)
obligations once we take payments and store data at scale.

**The gap.** Counsel-reviewed waiver + privacy policy + ToS, a clear stance on minor
data, and user rights (export/delete).

**Steps**
- 🤖 Draft a **privacy policy** and **terms of service** (what we collect, why, retention,
  third parties: Supabase/Stripe/ESP/analytics) for counsel to review.
- 🤖 Implement **consent capture** (ToS/privacy at sign-up) and user **data export +
  delete** (also supports §2 retention).
- 👤 Have **counsel review** the waiver wording, the privacy policy/ToS, and the
  **minor-data handling** (COPPA). This is the one item only you can drive.
- 👤 Confirm UCG/NAIGC **insurance/liability** posture for online registration + payments.

---

## Recommended sequence

The ordering principle: **don't handle real money or real users while blind.** Build the
safety net first, then payments, then polish, then the rest.

| Phase | Theme | Contents | Gate to exit |
|---|---|---|---|
| **0** | Safety net & foundation | Error boundary · write-failure surfacing · Sentry + uptime · CI test gate · staging env · RLS audit · hosting move + headers · Supabase Pro | We can see/catch failures and test before prod |
| **1** | Payments | Stripe (memberships, entries, banquet, club-cart settle, refunds, receipts) on staging → prod | Real money flows safely, reconciled, receipted |
| **2** | Hardening & polish | Accessibility + mobile audit · loading/error states · bug-reporting widget · production ESP · rate limiting/CAPTCHA · legal docs (waiver/privacy/ToS) · E2E for critical paths | Meets gold-standard UX + security + compliance |
| **3** | Remaining features | Codeless judge access · meet scoring config · multi-club registration · certs/tickets/rosters · new-club email | Feature-complete for the full season |
| **4** | Scale & ongoing | Analytics-driven iteration · status page · external API · SSO (per hosting doc) | Continuous improvement |

Phase 0 items are mostly independent and several are quick (the CI test gate is an
afternoon); they can run in parallel with the start of Phase 1.

---

## Decisions I need from you

These unblock me to execute; most are accounts, money, or product calls only you can make.

1. **Go/no-go + order** on the phased sequence above (esp. confirming Phase 0 before payments).
2. **Stripe**: approve creating the Stripe account (you own it; I wire it).
3. **Supabase Pro** upgrade ($25/mo) — the one infra item to commit before real data.
4. **Staging environment**: approve a second (free) Supabase project + preview deploys.
5. **Hosting move** to Cloudflare Pages + custom domain (DNS is yours; I do the code).
6. **Email provider** (recommend Resend) — create account + verify sending domain.
7. **Monitoring stack**: approve Sentry + an uptime monitor + analytics (Plausible/PostHog);
   pick where alerts go.
8. **Bug reports**: where they land (support inbox vs. GitHub) and who triages.
9. **Legal**: engage counsel for waiver + privacy policy + ToS + minor-data (COPPA) review.
10. **Offline + admin-MFA** stances (my recommendations: read-only offline; require MFA for admins).
11. **Security review** budget before payments launch.

Tell me which of these are yes and I'll start on Phase 0 (the safety net) immediately —
the error boundary, write-failure surfacing, and CI test gate need no accounts and are
the highest-leverage first moves.
