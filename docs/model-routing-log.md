# Model routing log

Observational log feeding the "Model routing" rules in `CLAUDE.md`. After each routed
task (subagent dispatch or notable inline task), append a row. Periodically (every ~15-20
rows) distill patterns back into the CLAUDE.md rules and prune distilled rows.

**Outcome codes:** `pass` = accepted first try; `rework` = needed a correction round;
`fail` = redone at a higher tier. Tokens = output tokens if known (from
`node scripts/usage-report.mjs`), else blank.

| Date | Task (short) | Type | Model / effort | Outcome | Tokens | Notes |
|------|--------------|------|----------------|---------|--------|-------|
| 2026-07-02 | Money-path review (3 parallel read-only reviewers: edge fns, RLS, client state) | review | fable / default | — | — | Fable-week centerpiece; results in docs/plans |

## Current priors (mirror of CLAUDE.md rules)
- haiku: mechanical + explicit verify checklist (renames, plumbing recipe, doc sweeps).
- sonnet: default implementer for well-specified tasks.
- opus/fable: design, decomposition, money/auth/RLS review, gnarly debugging.
- Subagent vs inline: subagent when the task reads many files the controller doesn't
  need; inline when spawn overhead (~full context re-read per agent) exceeds the work.
