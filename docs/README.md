# docs/

Project documentation. The top-level [`README.md`](../README.md) is the overview;
this folder holds design specs, implementation plans, and reference notes.

## Reference
- [`hosting-and-launch.md`](hosting-and-launch.md) — how the app is hosted, the
  production target (`registration.unitedgymnastics.org`), and the pre-launch
  hardening checklist.
- [`../CLAUDE.md`](../CLAUDE.md) — build/tooling gotchas, test command, and the
  running list of deferred work.
- [`../supabase/README.md`](../supabase/README.md) — backend schema, RLS model,
  and migration/standup steps.

## Specs (`specs/`)
Validated designs, written before implementation.
- [`specs/2026-06-12-account-role-foundation-design.md`](specs/2026-06-12-account-role-foundation-design.md)
  — sub-project A: capability-driven auth, account↔person claim, club management.

## Plans (`plans/`)
Step-by-step implementation plans (mostly historical records of completed work).
- [`plans/2026-06-11-supabase-wiring.md`](plans/2026-06-11-supabase-wiring.md) —
  wiring the Supabase backend into the prototype (done).
- [`plans/2026-06-12-native-score-entry.md`](plans/2026-06-12-native-score-entry.md) —
  replacing the iframe calculators with native TS scoring engines (done).
- [`plans/2026-06-12-account-role-foundation.md`](plans/2026-06-12-account-role-foundation.md) —
  sub-project A implementation (done, merged).

## Roadmap (sub-projects)
A ✅ accounts & roles → **Stripe setup** → B typed memberships + waiver →
C club-based registration → D codeless judge access → E meet scoring config
(1-vs-2 panels, calculator vs. simple entry). See CLAUDE.md for the live status.
