# docs/

Project documentation. The top-level [`README.md`](../README.md) is the overview;
this folder holds design **specs**, implementation **plans**, and **research** notes.
Repo-wide layout is mapped in [`../../PROJECT_STRUCTURE.md`](../../PROJECT_STRUCTURE.md)
(at the outer project folder). Live build/tooling notes + the deferred-work list live
in [`../CLAUDE.md`](../CLAUDE.md).

> **Status legend:** ✅ shipped to `main` (live) · 🟡 partial / on a branch ·
> 📘 reference (ongoing) · 📓 research (informational, not a commitment).
> Last reconciled with the codebase: **2026-06-23**.

## Reference docs
- [`production-readiness.md`](production-readiness.md) — **gap analysis + phased plan**
  to reach production gold standards (UX, security, reliability, observability, legal),
  with steps split between Nate and Claude. Start here for "what's left to launch."
- [`hosting-and-launch.md`](hosting-and-launch.md) — hosting model, production target
  (`registration.unitedgymnastics.org`), pre-launch hardening checklist.
- [`../supabase/README.md`](../supabase/README.md) — backend schema, RLS model, and
  migration / project-standup steps.
- [`../CLAUDE.md`](../CLAUDE.md) — build/tooling gotchas, test command, deferred work
  (operative rules only since 2026-07-02; the full historical version is archived at
  [`archive/CLAUDE-md-as-of-2026-07-02.md`](archive/CLAUDE-md-as-of-2026-07-02.md)).
- [`model-routing-log.md`](model-routing-log.md) — observational log of which model
  tier handled which task (feeds the CLAUDE.md "Model routing" rules).

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
| [welcome-email-stripe-path](plans/2026-07-02-welcome-email-stripe-path.md) | Fire the first-membership welcome email from `stripe-webhook` fulfillment | 📋 ready to implement |
| [security-hardening](plans/2026-07-02-security-hardening.md) | Fixes for the 7/02 security findings: RLS guard triggers, token exposure, checkout ref validation, retryable fulfillment | 🟡 Phase 1 + 2 shipped & deployed (verified live); Phase 3 TODO |
| [cart-state-fixes](plans/2026-07-02-cart-state-fixes.md) | Fixes for the 7/02 client cart/registration state-machine findings (C5, H5–H8, M6–M9) | ✅ shipped (2 minor residuals noted) |

## Research (`research/`) — informational, not commitments

| Note | Subject | Status |
|------|---------|--------|
| [sms-providers](research/2026-06-18-sms-providers.md) | Bulk-SMS provider options for the Communicate tool | 📓 research (Telnyx shipped) |
| [stripe-plan](research/2026-06-18-stripe-plan.md) | Real payments: membership/meet/banquet, card-on-file, club cart | 📓 research → **shipped (S1–S5; see [stripe-integration spec](specs/2026-06-25-stripe-integration.md) + [go-live checklist](stripe-go-live-checklist.md))** |
| [auth-2fa-passkeys](research/2026-06-22-auth-2fa-passkeys.md) | 2FA/passkey options (Supabase MFA: TOTP/SMS/WebAuthn) + phased recommendation | 📓 research |
| [password-policy](research/2026-06-22-password-policy.md) | Password best practice (NIST) + Supabase policy settings | 📓 research |
| [error-logging-observability](research/2026-06-22-error-logging-observability.md) | Error-log strategy (DB + admin search; Sentry optional) | 📓 research → **shipped (error_logs)** |
| [admin-refresh-flash](research/2026-06-22-admin-refresh-flash.md) | Diagnosis + fix for the admin-page "access denied" flash on refresh | 📓 research → **shipped (rolesLoaded)** |

## Roadmap (sub-projects)

A ✅ accounts & roles → **Stripe payments** (✅ S1–S5 built & deployed — all payment
paths (membership, meet-entry, club cart, change fees, coupons) go through Embedded
Checkout with server-authoritative fulfillment; remaining = the
[go-live checklist](stripe-go-live-checklist.md) for live keys, in-app refunds, and the
[security-hardening plan](plans/2026-07-02-security-hardening.md)) →
B typed memberships + per-season waiver → C club-based registration multi-club picker →
D codeless judge access (URL / 6-digit / QR) → E meet scoring config (1-vs-2 panels,
calculator vs. simple entry). Further out: PDF certs, banquet tickets, finals rosters,
external API. Live status is tracked in [`../CLAUDE.md`](../CLAUDE.md).

## Branches
All feature work is merged to `main` — there are no outstanding feature branches. (The
6/18 event-management and feedback branches were fully merged and have been deleted.)
