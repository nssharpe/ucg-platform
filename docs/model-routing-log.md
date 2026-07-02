# Model routing log

Observational log feeding the "Model routing" rules in `CLAUDE.md`. After each routed
task (subagent dispatch or notable inline task), append a row. Periodically (every ~15-20
rows) distill patterns back into the CLAUDE.md rules and prune distilled rows.

**Outcome codes:** `pass` = accepted first try; `rework` = needed a correction round;
`fail` = redone at a higher tier. Tokens = output tokens if known (from
`node scripts/usage-report.mjs`), else blank.

| Date | Task (short) | Type | Model / effort | Outcome | Tokens | Notes |
|------|--------------|------|----------------|---------|--------|-------|
| 2026-07-02 | Money-path review (3 parallel read-only reviewers: edge fns, RLS, client state) | review | fable / default | pass | ~360k (subagents) | 5 CRITICAL + 8 HIGH real findings; every controller spot-check confirmed; ~1 false-positive-risk finding (H4 retry) needed call-site verification. Fable-tier review of money code: worth it. |
| 2026-07-02 | Security hardening Phase 1 (6 DB migrations + verify script) | implement | sonnet / default | rework | ~184k (subagent) | Enumeration + SQL was strong, BUT controller review caught 2 real defects before push: a 2-step staging bypass of the reg-paid trigger (both signal columns client-writable) and a PUBLIC-grant no-op in the coupon revoke. Lesson: money/auth DB triggers WRITTEN by sonnet still need fable-tier review of the SQL before applying — the enumeration is delegable, the invariant-adversarial check is not. |
| 2026-07-02 | Cart-state fixes (8 tasks: C5/H5–H8/M6–M9, client) | implement | sonnet / default | rework | ~248k (subagent) | Structure/tests strong (20-case pure-fn suite), but controller review caught 2 real MONEY bugs in the draft: H6 "clear the hold" mirrored the payment-SUCCESS path → marked an unpaid membership ACTIVE (free membership) because membershipHolds derives active from holds; and H7 charged full entry within a $0-change window (over-charge). Same lesson as Phase 1: Sonnet is good at the mechanical/structural fix + tests; the money-invariant adversarial read is the controller's job. Pattern holding across 2 tasks — bake into routing: money/auth/cart implement → sonnet draft, ALWAYS fable-review the diff before merge. |

## Current priors (mirror of CLAUDE.md rules)
- haiku: mechanical + explicit verify checklist (renames, plumbing recipe, doc sweeps).
- sonnet: default implementer for well-specified tasks.
- opus/fable: design, decomposition, money/auth/RLS review, gnarly debugging.
- Subagent vs inline: subagent when the task reads many files the controller doesn't
  need; inline when spawn overhead (~full context re-read per agent) exceeds the work.
