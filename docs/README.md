# docs/

Project documentation. The top-level [`README.md`](../README.md) is the overview;
this folder holds design **specs**, implementation **plans**, and **research** notes.
Live build/tooling notes live in [`../CLAUDE.md`](../CLAUDE.md); open work is
[**`whats-next.md`**](whats-next.md) — the single authoritative list.

> **Status legend:** ✅ shipped to `main` (live) · 🟡 partial / on a branch ·
> 📘 reference (ongoing) · 📓 research (informational, not a commitment).
> Last reconciled with the codebase: **2026-07-31**.

## Reference docs
- [`whats-next.md`](whats-next.md) — **the authoritative open-work list** (Nate
  actions, launch blockers, quality passes, emv2 residuals, feature roadmap,
  proposed additions); reconciled 2026-07-31. Update it there, not rival copies.
- [`production-readiness.md`](production-readiness.md) — **gap analysis by dimension**
  (UX, security, reliability, observability, legal) with steps split between Nate and
  Claude. The ordered list of what to do next is [`whats-next.md`](whats-next.md).
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
| [feedback-batch-decomposition (6/24)](specs/2026-06-24-feedback-batch-decomposition.md) | Decomposition of the 6/24 feedback batch into phases | ✅ shipped |
| [dev-test-auth](specs/2026-06-25-dev-test-auth.md) | Dev-only real auto-login of a seeded Supabase test user (`.env.local`-gated) so authenticated UI is exercisable locally | ✅ shipped |
| [stripe-integration](specs/2026-06-25-stripe-integration.md) | Stripe Embedded Checkout architecture (S1–S5) | ✅ shipped |
| [events-rename-and-registration-flow](specs/2026-06-26-events-rename-and-registration-flow.md) | The Meet→Event / event→apparatus rename + registration-flow rework | ✅ shipped |
| [stripe-s4-decomposition](specs/2026-06-26-stripe-s4-decomposition.md) | S4 build decomposition (webhook fulfillment, invoices, receipts) | ✅ shipped |
| [security-review-findings (7/02)](specs/2026-07-02-security-review-findings.md) | Deep review of the money paths: RLS, edge functions, cart state machine — verified findings by severity | ✅ fixes shipped — hardening Phases 1–3 all complete (Phase 3 LOW items to staging+prod 2026-07-26) |
| [money-story-ux](specs/2026-07-04-money-story-ux.md) | The O1 "money story": one authoritative price from cart through checkout, via a side-effect-free `mode:'preview'` on `create-checkout-session` | ✅ shipped |
| [event-management-v2-requirements](specs/2026-07-06-event-management-v2-requirements.md) | Julia's full event-management requirements (7/06) digested + gap-mapped: host dashboard, refunds, capacity/waitlists, add-ons v2, nationals ops, finance dashboards — phasing V2-P0…P6 | ✅ **shipped in full** (P0–P6 all live; P6 finance dashboards closed it 2026-07-16). Deliberate residuals (§L.2 session-assignment tool, server-PDF receipts, camp-popup simplification, payout formula) tracked in [whats-next](whats-next.md) §4 |
| [ucg-rebrand](specs/2026-07-08-ucg-rebrand.md) | 2026 brand toolkit application: palette/tokens, approved fg/bg pairings, licensed fonts, logos/icons | ✅ applied (authoritative brand rules — 📘 ongoing reference) |
| [session-queue-e2e-ci-tests-freshness-recon-export-seasons](specs/2026-07-18-session-queue-e2e-ci-tests-freshness-recon-export-seasons.md) | Batch design: session queue, E2E in CI, data freshness, payments reconciliation (F4), person export/delete (F5), seasons | ✅ shipped |
| [season-card-ucg-events-and-cleanups](specs/2026-07-20-season-card-ucg-events-and-cleanups.md) | Season card, UCG-hosted events, and the P3 retirement of the automatic July-1 `current` rollover (season state now derives from dates) | ✅ shipped |
| [data-layer-scale](specs/2026-07-24-data-layer-scale.md) | The Tier 1/2/3 hydration model and the slice layer: Phases 0–5 moving `scores`/`registrations`/`people` off global hydration + the localStorage allowlist + Tier-2 query scoping | ✅ shipped (Phases 0–5); 📘 authoritative reference for the slice CONTRACT. Residual: `payments` still unscoped ([whats-next](whats-next.md) §7) |
| [context-and-steering-refactor](specs/2026-07-29-context-and-steering-refactor.md) | Split the 667-line `CLAUDE.md` into a lean core + path-scoped `.claude/rules/` + `.claude/skills/`; converted three prose "always do X" rules into enforcement hooks; defined the reviewer-tier model indirection; scoped the advisor tool | ✅ shipped (📘 rationale reference for how steering is organized) |
| [review-and-cleanup-findings](specs/2026-07-31-review-and-cleanup-findings.md) | General review + security pass over everything shipped since the 7/19 reconciliation: environment/migration reconciliation, `npm audit` triage, the anonymous write surfaces, a live exercise of the anon paths, and a next-features recommendation | 📘 findings — 2 open (Results hides null-session scores; `judge-entry` unlock unthrottled), tracked in [whats-next](whats-next.md) §3 |

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
| [sms-next-session-handoff](plans/2026-06-23-sms-next-session-handoff.md) | Session handoff notes for the SMS build | ✅ superseded (SMS shipped) |
| [topbar-responsive-and-mobile-nav](plans/2026-06-24-topbar-responsive-and-mobile-nav.md) | Topbar one-line badges + measurement degradation + mobile drawer nav | ✅ shipped |
| [feedback-batch-phase-kickoffs](plans/2026-06-24-feedback-batch-phase-kickoffs.md) | Per-phase kickoff prompts for the 6/24 feedback batch | ✅ shipped (all phases done) |
| [phase1-profile-roles](plans/2026-06-24-phase1-profile-roles.md) | Phase 1 of the 6/24 batch: profile + roles work | ✅ shipped |
| [playwright-responsive-tests](plans/2026-06-24-playwright-responsive-tests.md) | Proposed (not built) Playwright responsive screenshot tests in CI | 📓 proposed |
| [events-rename-and-registration-flow](plans/2026-06-26-events-rename-and-registration-flow.md) | Implementation record of the Meet→Event rename | ✅ shipped |
| [unified-cart-b2](plans/2026-07-02-unified-cart-b2.md) | Unified personal + managed-club `/cart` + cart-registration mutation sync | ✅ shipped |
| [welcome-email-stripe-path](plans/2026-07-02-welcome-email-stripe-path.md) | Fire the first-membership welcome email from `stripe-webhook` fulfillment | ✅ shipped |
| [security-hardening](plans/2026-07-02-security-hardening.md) | Fixes for the 7/02 security findings: RLS guard triggers, token exposure, checkout ref validation, retryable fulfillment | 🟡 Phase 1 + 2 shipped & deployed (verified live); **Phase 3 TODO** ([whats-next](whats-next.md) §2.1) |
| [cart-state-fixes](plans/2026-07-02-cart-state-fixes.md) | Fixes for the 7/02 client cart/registration state-machine findings (C5, H5–H8, M6–M9) | ✅ shipped (2 minor residuals noted) |
| [uiux-review-fixes](plans/2026-07-04-uiux-review-fixes.md) | Task briefs (by model class) from the 2026-07-04 live UI/UX review — money-story reconciliation, contrast, status badges, polish batch | 🟡 **partial** — S1–S3 shipped; O1/S4–S6/H1–H7 all implemented, each on its own unmerged branch pending review (`money/s4-cart-price-agreement`, `ui/s5-s6-reg-money-display`, `ui/h1-h4-display-polish`, `ui/h5-h7-cart-route-a11y`) ([whats-next](whats-next.md) §3) |
| [feedback-tracker](plans/2026-06-28-feedback-tracker.md) | 6/27 Gemini-organized feedback batch, cohorted A + B1–B8 | ✅ **complete** — A + B1–B8 all shipped (B5 finance dashboards landed via emv2 P6, 2026-07-16) |

## Research (`research/`) — informational, not commitments

| Note | Subject | Status |
|------|---------|--------|
| [sms-providers](research/2026-06-18-sms-providers.md) | Bulk-SMS provider options for the Communicate tool | 📓 research (Telnyx shipped) |
| [stripe-plan](research/2026-06-18-stripe-plan.md) | Real payments: membership/meet/banquet, card-on-file, club cart | 📓 research → **shipped (S1–S5; see [stripe-integration spec](specs/2026-06-25-stripe-integration.md) + [go-live checklist](stripe-go-live-checklist.md))** |
| [auth-2fa-passkeys](research/2026-06-22-auth-2fa-passkeys.md) | 2FA/passkey options (Supabase MFA: TOTP/SMS/WebAuthn) + phased recommendation | 📓 research → **shipped (TOTP + passkey login option)** |
| [password-policy](research/2026-06-22-password-policy.md) | Password best practice (NIST) + Supabase policy settings | 📓 research → **shipped**|
| [error-logging-observability](research/2026-06-22-error-logging-observability.md) | Error-log strategy (DB + admin search; Sentry optional) | 📓 research → **shipped (error_logs) + "Report a Problem" widget** |
| [admin-refresh-flash](research/2026-06-22-admin-refresh-flash.md) | Diagnosis + fix for the admin-page "access denied" flash on refresh | 📓 research → **shipped (rolesLoaded)** |
| [security-review-options](research/2026-07-17-security-review-options.md) | Third-party security review market scan + scoped recommendation (~$5k ± $2k, 2-layer plan) | 📓 research — 👤 Nate chose Supabomb + internal review for now (gap accepted in go-live checklist) |
| [supabomb-scan-results](research/2026-07-17-supabomb-scan-results.md) | First automated Supabase scan + manual anon-read RLS probe (prod+staging) | 📓 research → **shipped** |

## What's next

**Moved (2026-07-16):** the single authoritative open-work list now lives in
[`whats-next.md`](whats-next.md) — Nate action items, launch blockers, quality
passes, emv2 residuals, the feature roadmap, and proposed additions. Update it
there; don't grow rival lists here or in CLAUDE.md.

**Archived (2026-07-19):** completed items have been moved to
[`archive/whats-next-completed-2026-07.md`](archive/whats-next-completed-2026-07.md).

## Branches
All feature work is merged to `main` — there are no outstanding feature branches. (The
6/18 event-management and feedback branches were fully merged and have been deleted.)
