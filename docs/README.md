# docs/

Project documentation. The top-level [`README.md`](../README.md) is the overview;
this folder holds design **specs**, implementation **plans**, and **research** notes.
Repo-wide layout is mapped in [`../../PROJECT_STRUCTURE.md`](../../PROJECT_STRUCTURE.md)
(at the outer project folder). Live build/tooling notes + the deferred-work list live
in [`../CLAUDE.md`](../CLAUDE.md).

> **Status legend:** ✅ shipped to `main` (live) · 🟡 partial / on a branch ·
> 📘 reference (ongoing) · 📓 research (informational, not a commitment).
> Last reconciled with the codebase: **2026-06-21**.

## Reference docs
- [`hosting-and-launch.md`](hosting-and-launch.md) — hosting model, production target
  (`registration.unitedgymnastics.org`), pre-launch hardening checklist.
- [`../supabase/README.md`](../supabase/README.md) — backend schema, RLS model, and
  migration / project-standup steps.
- [`../CLAUDE.md`](../CLAUDE.md) — build/tooling gotchas, test command, deferred work.

## Specs (`specs/`) — validated designs, written before implementation

| Spec | Subject | Status |
|------|---------|--------|
| [account-role-foundation-design](specs/2026-06-12-account-role-foundation-design.md) | Sub-project A: capability-driven auth, account↔person claim, club management | ✅ shipped |
| [nationals-qual-awards](specs/2026-06-13-nationals-qual-awards.md) | Authoritative finals-qualification & awards ruleset for the TS port | 📘 reference |
| [auth-email-setup](specs/2026-06-16-auth-email-setup.md) | Supabase Auth + email dashboard configuration steps | 📘 ops runbook (auth live) |
| [event-management](specs/2026-06-18-event-management.md) | Net-new event/sanctioning subsystem (Wave 4 of the 6/18 batch) | ✅ shipped (merged to `main`) |
| [feedback-batch-decomposition](specs/2026-06-18-feedback-batch-decomposition.md) | Decomposition of the 6/18 feedback batch into waves | ✅ shipped (all waves merged) |
| [digital-waiver-esign-design](specs/2026-06-20-digital-waiver-esign-design.md) | Clickwrap e-signature: versioned text, signature evidence, guardian path | ✅ shipped |

## Plans (`plans/`) — step-by-step implementation records

| Plan | Subject | Status |
|------|---------|--------|
| [supabase-wiring](plans/2026-06-11-supabase-wiring.md) | Make the live Supabase project the real data layer (write-through + realtime) | ✅ shipped |
| [native-score-entry](plans/2026-06-12-native-score-entry.md) | Replace iframe calculators with native TS scoring engines | ✅ shipped |
| [account-role-foundation](plans/2026-06-12-account-role-foundation.md) | Sub-project A implementation | ✅ shipped (merged) |
| [nationals-qual-awards-implementation](plans/2026-06-13-nationals-qual-awards-implementation.md) | Build the nationals engine (Phases 0–5 + adapter) | ✅ engine built & test-verified; end-user UI surfacing ongoing |
| [digital-waiver-esign](plans/2026-06-20-digital-waiver-esign.md) | Build the clickwrap e-signature system | ✅ shipped |

## Research (`research/`) — informational, not commitments

| Note | Subject | Status |
|------|---------|--------|
| [sms-providers](research/2026-06-18-sms-providers.md) | Bulk-SMS provider options for the Communicate tool | 📓 research |
| [stripe-plan](research/2026-06-18-stripe-plan.md) | Real payments: membership/meet/banquet, card-on-file, club cart | 📓 research → **next major build** |

## Roadmap (sub-projects)

A ✅ accounts & roles → **Stripe payments** (next; see the research note) →
B typed memberships + per-season waiver → C club-based registration multi-club picker →
D codeless judge access (URL / 6-digit / QR) → E meet scoring config (1-vs-2 panels,
calculator vs. simple entry). Further out: PDF certs, banquet tickets, finals rosters,
external API. Live status is tracked in [`../CLAUDE.md`](../CLAUDE.md).

## Branches
All feature work is merged to `main` — there are no outstanding feature branches. (The
6/18 event-management and feedback branches were fully merged and have been deleted.)
