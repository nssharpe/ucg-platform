# UCG Registration & Scoring Platform — agent instructions

**`CLAUDE.md` in this same directory is the authoritative instruction file. Read it first.**

This file exists so coding agents that look for `AGENTS.md` by convention find their way to the
real instructions instead of guessing. It deliberately contains no rules of its own — a second
copy of the rules drifts out of sync with the first, which is exactly what happened here before
2026-07-29.

## Where the instructions actually live

| What you need | Read |
| --- | --- |
| Facts true in every session — working style, model routing, verification gate, standing authorizations | `CLAUDE.md` |
| Constraints for a specific area of the code | `.claude/rules/*.md` |
| Multi-step procedures (verify before commit, responsive sweep, migration push, config push) | `.claude/skills/*/SKILL.md` |
| Backend schema, RLS model, migration table, runbooks | `supabase/README.md` |
| Open work | `docs/whats-next.md` |
| Design specs and implementation plans | `docs/specs/`, `docs/plans/` |

The `.claude/rules/` files carry `paths:` frontmatter so Claude Code loads each one only when a
matching file is read. **If your agent does not implement that mechanism, read the relevant rule
files directly** — they hold the schema, money, auth, registration, data-layer, edge-function,
UI, and test constraints, and several of them encode traps that have broken production.

Start with these two regardless of what you're doing:

- `.claude/skills/verify-before-commit/SKILL.md` — the verification protocol that must pass
  before any commit, merge, or push.
- `.claude/rules/money-invariants.md` — if the change touches money, carts, checkout, or refunds.

## Non-negotiables, in brief

These are stated fully in `CLAUDE.md`; they're repeated here only because an agent that reads
nothing else must still know them:

- **Verify with `npm run build`, never `tsc --noEmit`.** Lint the touched files with
  `npx eslint`, including anything under `supabase/functions/**`. Run `npx vitest run`. Report the
  commands and their output — evidence, not claims.
- **Never commit, push, `supabase db push`, or deploy a function unless explicitly asked.**
  Side effects belong to the human or the orchestrating session.
- **Money, auth, and RLS changes require an adversarial review by the strongest available model
  before they merge.** Don't self-certify them.

## Why this file is a pointer

Until 2026-07-29 `AGENTS.md` was a 449-line duplicate of an older `CLAUDE.md`. It had drifted into
citing directories that don't exist and describing completed work as outstanding, so anything
reading it got a confidently wrong picture of the project. Rationale for the current structure:
`docs/specs/2026-07-29-context-and-steering-refactor.md`.

**If you are tempted to add a rule here, add it to `CLAUDE.md` or a file under `.claude/rules/`
instead.**
