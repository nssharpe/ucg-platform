# UCG Registration & Scoring Platform

React + TypeScript + Vite. Live: https://nssharpe.github.io/ucg-platform/
Supabase backend (env-gated). Deploys via GitHub Actions on push to `main`.

<!-- Restructured 2026-07-29 per Anthropic's context-engineering + steering guidance:
     facts here, path-scoped constraints in .claude/rules/, procedures in .claude/skills/,
     enforcement in hooks. Target for this file is UNDER 200 LINES. If you're about to
     append a paragraph, ask first whether it belongs in a rule, a skill, or a spec. -->

## Where knowledge lives

**This file holds only what must be true in every session.** Everything else is routed:

| Need | Location |
| --- | --- |
| Constraints for a specific area of the code | `.claude/rules/*.md` — path-scoped, load when you read a matching file |
| Multi-step procedures | `.claude/skills/*/SKILL.md` — invoke by name |
| Enforcement that must not depend on memory | hooks (`.claude/settings.json` + `scripts/`) |
| The security traps this repo has actually hit | `.claude/claude-security-guidance.md` + `.claude/security-patterns.json` — fed to the `security-guidance` plugin (**installed + enabled 2026-07-31**); also readable standalone |
| Backend schema, RLS model, migration table, runbooks | `supabase/README.md` |
| Open work | `docs/whats-next.md` (authoritative) |
| Design specs / implementation plans | `docs/specs/`, `docs/plans/` |
| Feature history and narratives | git log and the specs — **not this file** |

Rules cover: `supabase-migrations`, `money-invariants`, `auth-and-mfa`,
`registrations-and-camps`, `data-layer`, `edge-functions`, `ui-brand-and-layout`, `tests`.
Skills: `verify-before-commit`, `responsive-sweep`, `migration-push`, `config-push-dryrun`.

⚠ A path-scoped rule loads when a matching file is **read**. Anything you must know *before*
opening a file belongs here or in a hook — that's why the review gate and the verification
requirement are stated below rather than only in rules.

## Working style (Nate = PM, not hands-on)

Do as much as possible directly. When a step is blocked only on a one-time setup or permission
grant, ask for *just that unblock*, then execute the step yourself.

**Standing authorizations** (don't hand these back as instructions): `supabase db push` against
prod, applying migrations, deploying functions, editing `.env.local` (2026-06-18, extended to
prod `db push` 2026-07-24); testing directly against the live production site (2026-07-02 — no
real users besides Nate and Julia yet); temporary admin grants in STAGING `user_roles` for
testing gated UI (staging only, announce first, revert same session).

Still confirm genuinely destructive prod actions and show what will apply first.

**After finishing dev work, always merge the feature branch back to `main` and push (which
deploys live) — don't stop to ask** (2026-06-24): branch → implement → verify → merge → push.

**Never spawn background task chips.** One once ran as its own session in `.claude/worktrees/`
and pushed a competing migration to staging. Keep findings explicit in the core session.

When executing a written implementation plan, default to subagent-driven execution
(`superpowers:subagent-driven-development`) — fresh subagent per task, review between tasks.
Don't ask which execution mode to use (2026-06-24).

### Context/usage-optimized execution

- **Keep the controller out of the editor.** Delegate reading/editing; the controller reads only
  what it needs to write a precise brief.
- **One implementer subagent per task; never run implementers in parallel** (working-tree
  conflicts). Read-only reviewers MAY run in parallel.
- **Dispatch straight from the spec** — skip redundant per-phase plan docs.
- **Review subagent reports inline**; don't spin up reviewers for routine work.
- **Send rework back to the SAME subagent** (SendMessage — its context persists) rather than
  briefing a fresh implementer for review fixes on the same task.
- **Controller owns side-effects, batched at phase end:** one `db push` per phase's migrations,
  one loop deploying touched functions. Subagents write migrations/edge-fn code but never
  push/deploy.
- **Front-load clarifying questions per phase.** Ask the ones whose answers would change the
  data model, an interface, or a UX flow — not everything you're unsure about.
- **Delegation has fixed overhead.** The plan-big/execute-small split pays off on token-HEAVY
  work — reading many files, mechanical edits, sweeps — not on narrow reasoning. A trivial,
  precisely-known edit the controller can state exactly is cheaper done directly.
- **Don't reach for Workflow/`ultracode` to save usage** — one implementer per task is cheaper.
- **Rigor lives in the brief, not the model.** A cheaper model matches frontier rigor on
  mechanical work only when the brief spells out the verification protocol and demands evidence
  (commands run + output), not claims. Never assume a subagent self-imposes rigor.

### Finding the unknowns (adopted 2026-07-29)

Nate is a PM directing a codebase he doesn't hand-write, so the expensive failures are the ones
neither of us thought to ask about.

- **Blind-spot pass at phase kickoff:** before planning, state what would surprise Nate here and
  what isn't being asked about. Camps shipped 2026-07-22 and had their discipline/session UI
  stripped 2026-07-23 — he'd have said "camps don't have levels" instantly if asked.
- **Prototype before spec** when requirements arrive as prose (especially Julia's). A throwaway
  clickable prototype with mock data surfaces the "actually, no —" that prose never does.
- **Prefer references to descriptions:** point at existing code implementing similar behavior
  ("`pushCampSurvey` is the pattern") over describing the shape in words.
- **Implementation notes during execution:** each implementer appends deviations from the plan to
  a per-phase notes file, so the next subagent and the reviewer get the pivots without
  re-deriving them.

## Model routing

**Reviewer tier** = the strongest model currently available on Nate's plan: **Fable if the plan
has it, otherwise the top Opus.** Nate is on Pro (no Fable) and plans to take a Max month late in
the project for a full sweep. Resolve "reviewer-tier" through this line only — don't hardcode a
model name anywhere else.

- **haiku:** mechanical work with an explicit verify checklist — renames, DB plumbing, doc
  sweeps, comment/label fixes.
- **sonnet (default implementer):** well-specified feature tasks, UI work, test writing.
- **reviewer tier:** design/decomposition, review of anything touching money/auth/RLS, migration
  design, debugging weird failures. Effort: low for mechanical, default otherwise, high only for
  review/debug/design.
- **Money/auth/RLS/cart implementation → sonnet DRAFTS, controller ALWAYS reviewer-tier-reviews
  the diff before merge/push/apply** (learned 2026-07-02 across 2 tasks). Sonnet is reliably good
  at the mechanical fix + enumeration + tests, but missed a real defect each time on the
  money-invariant: a 2-step trigger-staging bypass, a PUBLIC-grant no-op, a free-membership
  "clear the hold", an over-charge edge. **The adversarial invariant read is not delegable;
  budget for it.**
- **Advisor tool** (`advisorModel` in settings, `/advisor` to change): pays off most on
  sonnet/haiku implementer subagents, where the context is small. Advisor reads are never cached,
  so a call from a long controller session re-processes the whole transcript. It is a supplement
  to the review gate above, never a replacement — its timing is model-driven and can't be forced.
- After each routed task, append a row to `docs/model-routing-log.md` (task type, model,
  first-try outcome, tokens if known). Periodically distill the log back into these rules.
- `node scripts/usage-report.mjs [--days N] [--json]` reports per-session token use by model from
  local transcripts. Remaining plan quota is NOT visible locally — only `/usage` in the app.

## Verification (non-negotiable)

**Before any commit, merge, or push: the `verify-before-commit` skill.** Short form —
`npm run build` (never `tsc --noEmit`), `npx eslint <touched files>` including
`supabase/functions/**`, `npx vitest run`, plus a vitest test for any new pure logic. Evidence
before assertions: report the commands and their output, not a claim that they passed.

`npm run build` does NOT run eslint, and CI fails the deploy on any lint **error** — so a clean
build can still break the deploy.

## Hooks (enforcement, not reminders)

`.claude/settings.json` wires two Bash hooks. They exist because prose instructions failed:

- **PreToolUse** `scripts/destructive-command-guard.mjs` — denies catastrophic commands
  (recursive delete of roots/repo/.git, remote `supabase db reset`, force-push to main) and asks
  on other destructive ones, including `supabase db push` (reconcile first) and
  `supabase config push` (auto-confirm trap). Pattern-based, so a quoted "rm -rf" in a commit
  message can false-positive as "ask" — rephrase rather than fighting it. `--self-test` runs its
  case battery.
- **PostToolUse** `scripts/hooks/post-bash-checks.mjs` — doc-sweep reminder after `git commit`;
  `verify_jwt` confirmation after `functions deploy`; dev-auth firewall grep of `dist/assets`
  after a build. `--self-test` runs its case battery. **If a check reports it could not run,
  verify manually** — don't read a skipped check as a pass.

Daily DB backups: `scripts/backup-db.mjs` + the "UCG DB Backup" scheduled task (runbook:
`supabase/README.md` → "Data backups").

## Environment gotchas

- Keep the working copy at `C:\dev\ucg-platform` — short, space-free, outside Dropbox. The old
  Dropbox path broke npm shims and locked `dist/`. **Never move it back.**
- Supabase project refs: prod `wkyerxlgricfphopocoz`, staging `xogpiksqtkayxwmczlbx`. The CLI
  stays linked to PROD — target staging explicitly.
- Ids are app-generated **text**, not uuids. `payments.id` is the lone uuid PK.
- Naming: "Meet" → **Event**; gymnastics apparatus → **apparatus**. Several identifiers were
  deliberately NOT renamed — see `.claude/rules/registrations-and-camps.md` before grepping.

## Docs

`README.md` overview; `docs/README.md` index; **`docs/whats-next.md` = the authoritative open-work
list**; `supabase/README.md` backend schema/RLS/migration table; `docs/specs/` design specs;
`docs/plans/` implementation plans (do NOT recreate `docs/superpowers/`);
`docs/stripe-go-live-checklist.md`. Pre-trim version of this file:
`docs/archive/CLAUDE-md-as-of-2026-07-02.md`.

**Keep docs current after every commit** — a PostToolUse hook reminds you. For this file that
means UPDATE-IN-PLACE and push detail into rules/skills/specs; never append changelog paragraphs.

## Open work — operative residuals only

The single authoritative list is `docs/whats-next.md`.

- **Event management v2 is COMPLETE** (P0–P6 shipped, last 2026-07-16). Spec:
  `docs/specs/2026-07-06-event-management-v2-requirements.md`. Residual: **§L.2 DEFERRED per
  Julia** — the session-assignment tool + per-team session-timed finals reminders; only the
  admin-set `finals_lineup_deadline_at` nag + 10pm hard lock shipped. All P5 UI is gated on
  `event.kind === 'nationals'`.
- **Security hardening Phases 1–3 are COMPLETE** (Phase 3 LOW items shipped to staging+prod
  2026-07-26). Plan: `docs/plans/2026-07-02-security-hardening.md`.
- **Data-layer scale (6.3) COMPLETE**, Phases 0–5. Known remaining gap: `payments` is still an
  unscoped `fetchAllRows` in `loadAll` (`docs/whats-next.md` §7).
- **UI/UX review fixes COMPLETE** 2026-07-26 — all 14 tasks
  (`docs/plans/2026-07-04-uiux-review-fixes.md`). Residuals: invoice numbering (two formats;
  the generators derive the sequence from a row COUNT, which is not concurrency-safe), a
  pre-existing 375px overflow on admin Communicate's compose card.
- **Two live findings from the 2026-07-31 review** (`docs/specs/2026-07-31-review-and-cleanup-findings.md`):
  the public Results page hides posted scores when registrations carry no `session_id`, and
  `judge-entry`'s 6-digit unlock has no real rate limit. Both in `docs/whats-next.md` §3.
- 👤 **Nate's actions:** grant `refund_manager` to whoever reviews refunds. (Done 2026-08-19:
  Julia's `finance_admin` ✅; "UCG - Main" `is_league_host` ✅ — and that club is now hidden
  from the member-facing Club Directory/Profile pickers.)
