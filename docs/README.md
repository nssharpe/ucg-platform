# docs/

Project documentation. The top-level [`README.md`](../README.md) is the overview;
this folder holds design **specs**, implementation **plans**, and **research** notes.
Live build/tooling notes live in [`../CLAUDE.md`](../CLAUDE.md); open work is the
[What's next](#whats-next--the-authoritative-list) list below.

> **Status legend:** ✅ shipped to `main` (live) · 🟡 partial / on a branch ·
> 📘 reference (ongoing) · 📓 research (informational, not a commitment).
> Last reconciled with the codebase: **2026-07-04**.

## Reference docs
- [`production-readiness.md`](production-readiness.md) — **gap analysis by dimension**
  (UX, security, reliability, observability, legal) with steps split between Nate and
  Claude; refreshed 2026-07-04. The ordered list of what to do next is the
  [What's next](#whats-next--the-authoritative-list) section below.
- [`hosting-and-launch.md`](hosting-and-launch.md) — hosting model, production target
  (`registration.unitedgymnastics.org`), pre-launch hardening checklist.
- [`../supabase/README.md`](../supabase/README.md) — backend schema, RLS model, and
  migration / project-standup steps.
- [`../CLAUDE.md`](../CLAUDE.md) — build/tooling gotchas, test command, deferred work
  (operative rules only since 2026-07-02; the full historical version is archived at
  [`archive/CLAUDE-md-as-of-2026-07-02.md`](archive/CLAUDE-md-as-of-2026-07-02.md)).
- [`model-routing-log.md`](model-routing-log.md) — observational log of which model
  tier handled which task (feeds the CLAUDE.md "Model routing" rules).
- [`reference/`](reference/README.md) — **source materials from Julia** (received
  2026-07-06): her event-management requirements spec + the legacy Apps-Script
  Nationals reg/check-in tools and their xlsx sheet backends. Digested into
  [`specs/2026-07-06-event-management-v2-requirements.md`](specs/2026-07-06-event-management-v2-requirements.md).

## Specs (`specs/`) — validated designs, written before implementation

| Spec | Subject | Status |
|------|---------|--------|
| [account-role-foundation-design](specs/2026-06-12-account-role-foundation-design.md) | Sub-project A: capability-driven auth, account↔person claim, club management | ✅ shipped |
| [nationals-qual-awards](specs/2026-06-13-nationals-qual-awards.md) | Authoritative finals-qualification & awards ruleset for the TS port | 📘 reference |
| [auth-email-setup](specs/2026-06-16-auth-email-setup.md) | Supabase Auth + email dashboard configuration steps | 📘 ops runbook (auth live) |
| [event-management](specs/2026-06-18-event-management.md) | Net-new event/sanctioning subsystem (Wave 4 of the 6/18 batch) | ✅ shipped (merged to `main`) |
| [feedback-batch-decomposition](specs/2026-06-18-feedback-batch-decomposition.md) | Decomposition of the 6/18 feedback batch into waves | ✅ shipped (all waves merged) |
| [digital-waiver-esign-design](specs/2026-06-20-digital-waiver-esign-design.md) | Clickwrap e-signature: versioned text, signature evidence, guardian path | ✅ shipped |
| [resend-email-transport-design](specs/2026-06-22-resend-email-transport-design.md) | Swap email transport from Gmail SMTP to Resend | ✅ shipped |
| [feedback-batch-decomposition (6/22)](specs/2026-06-22-feedback-batch-decomposition.md) | Master decomposition of the 6/22–6/23 feedback batch (10 phases + decisions) | ✅ shipped (all phases live) |
| [topbar-responsive-and-mobile-nav-design](specs/2026-06-24-topbar-responsive-and-mobile-nav-design.md) | One-line topbar badges, measurement-driven degradation, mobile drawer nav, mobile dev pipeline | ✅ shipped |
| [dev-test-auth](specs/2026-06-25-dev-test-auth.md) | Dev-only real auto-login of a seeded Supabase test user (`.env.local`-gated) so authenticated UI is exercisable locally | ✅ shipped |
| [stripe-integration](specs/2026-06-25-stripe-integration.md) | Stripe Embedded Checkout architecture (S1–S5) | ✅ shipped |
| [security-review-findings (7/02)](specs/2026-07-02-security-review-findings.md) | Deep review of the money paths: RLS, edge functions, cart state machine — verified findings by severity | 🟡 findings logged; fixes planned |
| [event-management-v2-requirements](specs/2026-07-06-event-management-v2-requirements.md) | Julia's full event-management requirements (7/06) digested + gap-mapped: host dashboard, refunds, capacity/waitlists, add-ons v2, nationals ops, finance dashboards — phasing V2-P0…P6 | 🟡 validated (phasing approved, §N7 answered); **P0 build started** — scheduler infra (Task 1) shipped |

## Plans (`plans/`) — step-by-step implementation records

| Plan | Subject | Status |
|------|---------|--------|
| [supabase-wiring](plans/2026-06-11-supabase-wiring.md) | Make the live Supabase project the real data layer (write-through + realtime) | ✅ shipped |
| [native-score-entry](plans/2026-06-12-native-score-entry.md) | Replace iframe calculators with native TS scoring engines | ✅ shipped |
| [account-role-foundation](plans/2026-06-12-account-role-foundation.md) | Sub-project A implementation | ✅ shipped (merged) |
| [nationals-qual-awards-implementation](plans/2026-06-13-nationals-qual-awards-implementation.md) | Build the nationals engine (Phases 0–5 + adapter) | ✅ engine built & test-verified; end-user UI surfacing ongoing |
| [digital-waiver-esign](plans/2026-06-20-digital-waiver-esign.md) | Build the clickwrap e-signature system | ✅ shipped |
| [resend-email-and-stubs](plans/2026-06-22-resend-email-and-stubs.md) | Resend transport swap + stub fixes | ✅ shipped |
| [sms-telnyx-implementation](plans/2026-06-22-sms-telnyx-implementation.md) | Communicate text channel via Telnyx | ✅ shipped |
| [club-invites-and-roster](plans/2026-06-23-club-invites-and-roster.md) | Admin-create invites + set-password, Add-athlete, roster club switcher (Phase 3) | ✅ shipped |
| [topbar-responsive-and-mobile-nav](plans/2026-06-24-topbar-responsive-and-mobile-nav.md) | Topbar one-line badges + measurement degradation + mobile drawer nav | ✅ shipped |
| [playwright-responsive-tests](plans/2026-06-24-playwright-responsive-tests.md) | Proposed (not built) Playwright responsive screenshot tests in CI | 📓 proposed |
| [unified-cart-b2](plans/2026-07-02-unified-cart-b2.md) | Unified personal + managed-club `/cart` + cart-registration mutation sync | ✅ shipped |
| [welcome-email-stripe-path](plans/2026-07-02-welcome-email-stripe-path.md) | Fire the first-membership welcome email from `stripe-webhook` fulfillment | ✅ shipped |
| [security-hardening](plans/2026-07-02-security-hardening.md) | Fixes for the 7/02 security findings: RLS guard triggers, token exposure, checkout ref validation, retryable fulfillment | 🟡 Phase 1 + 2 shipped & deployed (verified live); Phase 3 TODO |
| [cart-state-fixes](plans/2026-07-02-cart-state-fixes.md) | Fixes for the 7/02 client cart/registration state-machine findings (C5, H5–H8, M6–M9) | ✅ shipped (2 minor residuals noted) |
| [feedback-tracker](plans/2026-06-28-feedback-tracker.md) | 6/27 Gemini-organized feedback batch, cohorted A + B1–B8 | 🟡 Cohort A + B1–B4 + B6 + B7 + B8 shipped; **B5 open** (see [CLAUDE.md](../CLAUDE.md) Deferred/TODO) |

## Research (`research/`) — informational, not commitments

| Note | Subject | Status |
|------|---------|--------|
| [sms-providers](research/2026-06-18-sms-providers.md) | Bulk-SMS provider options for the Communicate tool | 📓 research (Telnyx shipped) |
| [stripe-plan](research/2026-06-18-stripe-plan.md) | Real payments: membership/meet/banquet, card-on-file, club cart | 📓 research → **shipped (S1–S5; see [stripe-integration spec](specs/2026-06-25-stripe-integration.md) + [go-live checklist](stripe-go-live-checklist.md))** |
| [auth-2fa-passkeys](research/2026-06-22-auth-2fa-passkeys.md) | 2FA/passkey options (Supabase MFA: TOTP/SMS/WebAuthn) + phased recommendation | 📓 research |
| [password-policy](research/2026-06-22-password-policy.md) | Password best practice (NIST) + Supabase policy settings | 📓 research |
| [error-logging-observability](research/2026-06-22-error-logging-observability.md) | Error-log strategy (DB + admin search; Sentry optional) | 📓 research → **shipped (error_logs)** |
| [admin-refresh-flash](research/2026-06-22-admin-refresh-flash.md) | Diagnosis + fix for the admin-page "access denied" flash on refresh | 📓 research → **shipped (rolesLoaded)** |

## What's next — the authoritative list

**This is the single source of truth for open work** (reconciled 2026-07-04).
[`production-readiness.md`](production-readiness.md) is the per-dimension gap
analysis, [`plans/2026-06-28-feedback-tracker.md`](plans/2026-06-28-feedback-tracker.md)
the feedback-item history, and [`../CLAUDE.md`](../CLAUDE.md) keeps only a pointer
here — update THIS list when priorities change, not rival copies.

### Launch blockers (ordered by leverage; 👤 = only Nate can do it)
1. 👤 **Supabase Pro + backups/PITR** — **DEFERRED (decided 2026-07-04)** to later in
   development; recorded as a hard pre-flight gate in the
   [go-live checklist](stripe-go-live-checklist.md) so it can't be missed before real money.
2. 👤 ~~Uptime monitor + alerting~~ **done 2026-07-04** (UptimeRobot, 5-min checks,
   email alerts: live site + Supabase auth health) · 🤖 still open: a daily digest
   of new `error_logs` / stuck `pending` payments (scheduled function).
3. 👤 **Stripe go-live** — [stripe-go-live-checklist.md](stripe-go-live-checklist.md)
   (live keys, $1 smoke + refund).
4. 👤 **Legal** (longest lead time — start early): counsel review of waiver,
   privacy policy, ToS, minors/COPPA. 🤖 drafts the policy docs.
5. ~~Staging Supabase project + Playwright smoke E2E~~ **done 2026-07-04**
   (`ucg-staging` fully stood up + seeded, 5 smoke specs green incl. live
   checkout-session → Stripe render; runbook in
   [supabase/README](../supabase/README.md)). Still open: run E2E in CI.
6. 🤖 **Security hardening Phase 3** ([plan](plans/2026-07-02-security-hardening.md))
   + **rate limiting/CAPTCHA** on sign-up and the public email-sending functions.

### Quality passes (pre- or just post-launch)
- 🤖 **UI/UX review fixes** ([task briefs by model class](plans/2026-07-04-uiux-review-fixes.md),
  from the 2026-07-04 live review) — coral-CTA contrast (AA fail), Profile save-bar
  overlap, cart-vs-checkout price mismatch, payment-status badges, plus a polish batch.
- 🤖 Accessibility audit to WCAG AA + loading/empty/error state consistency.
- 🤖 In-app "Report a problem" widget + version stamp (`error_logs` is passive today).
- 🤖 In-app admin refunds (Dashboard-only today; sketch in the go-live checklist —
  full requirements now in the [event-management v2 spec §H](specs/2026-07-06-event-management-v2-requirements.md)).
- 🤖 New-club-request email to `newclubinquiries@naigc.org` (transport exists, not wired).
- 🤖 Verify the PWA production update path (stale service-worker bundle → add an
  update prompt if needed).

### Feature roadmap (as prioritized)
- **Event management v2** — Julia's 2026-07-06 requirements, digested + gap-mapped in
  [specs/2026-07-06-event-management-v2-requirements.md](specs/2026-07-06-event-management-v2-requirements.md).
  **Phasing approved by Nate 2026-07-06:** V2-P0 foundations/scheduler →
  P1 host experience → P2 add-ons & camps → P3 refunds → P4 capacity/waitlists &
  by-session reg → P5 nationals ops/check-in → P6 finance dashboards.
  **P0 Task 1 shipped:** pg_cron/pg_net scheduler infra (`notification_log` +
  `scheduled-dispatch-15min` job + `scheduled-dispatch` Edge Function, service-role-only
  auth) with its first consumer — 3d/1d/closed sanction-vote reminder emails, idempotent
  via `notification_log`. Runbook in `supabase/README.md` → "Scheduled dispatch (pg_cron)"
  (the two Vault secrets still need manual per-environment setup before the cron job can
  actually fire).
  **P0 Task 2 shipped:** event entity field extensions (spec §A) — venue/street/country/
  hotel-block link, age-calc date, late registration (fee on top of entry fee, not yet
  charged at checkout), a general (not camp-only) director contact, capacity config
  (stored, not enforced yet), and a confirmation-email override with an HTML preview in
  EventWizard. Migration backfilled `camp_config`'s director/age-calc keys onto the new
  event-level fields. Sanction.tsx's approval mapping carries venue/street/country/
  late-reg into the created event.
  §N7 open questions **all answered by Julia 2026-07-06** (recorded in the spec;
  every phase is unblocked — only the §F partial-fit capacity design wants a
  confirm at P4 kickoff). This absorbs several
  older roadmap items: **B5 finance dashboards** (now fully spec'd, §M), in-app
  refunds (§H), banquet tickets/add-ons v2 (§E3), finals rosters (§L),
  server-emailed PDF receipts (§I/§N4). Naming: every "NAIGC" in Julia's raw
  doc reads as UCG (confirmed by Nate).
- B typed memberships + per-season waiver → C multi-club registration picker →
  D codeless judge access (URL / 6-digit / QR) → E scoring config (1-vs-2 panels,
  calculator vs. simple entry).
- Further out: MFA/passkeys, PDF certs, external API.

### Architecture watch-list
Not gaps yet — trigger conditions and known warts are written down in
[`production-readiness.md`](production-readiness.md#architecture-watch-list-not-gaps-yet--written-down-so-they-dont-surprise-us):
data-layer `loadAll` scaling cliff, realtime-only-on-scores staleness, the
`record-waiver-signature` stale-hold wart.

## Branches
All feature work is merged to `main` — there are no outstanding feature branches. (The
6/18 event-management and feedback branches were fully merged and have been deleted.)
