# Context & steering refactor (2026-07-29)

Restructures how this project steers Claude Code, applying four Anthropic sources:

- [A field guide to Claude Fable 5: finding your unknowns](https://claude.com/blog/a-field-guide-to-claude-fable-finding-your-unknowns)
- [The new rules of context engineering for Claude 5 generation models](https://claude.com/blog/the-new-rules-of-context-engineering-for-claude-5-generation-models)
- [Steering Claude Code: skills, hooks, rules, subagents and more](https://claude.com/blog/steering-claude-code-skills-hooks-rules-subagents-and-more)
- [Escalate hard decisions with the advisor tool](https://code.claude.com/docs/en/advisor)

## Problem

`CLAUDE.md` had grown to **667 lines / 45,336 bytes (~11.3k tokens)** and loaded into every
session *and* every subagent. A phase dispatching 8 implementers paid ~100k tokens of preamble
before any work happened. There were zero project rules and zero project skills, so 100% of
operative knowledge lived in one always-on blob.

Three further problems came from that shape:

1. **Duplication drifted into contradiction.** The `verify_jwt` trio appeared twice, camp rules
   twice, and migration-applied status lived in `CLAUDE.md` + `supabase/README.md` + memory —
   which drifted, producing a stale "prod-pending" note for migrations already in prod.
2. **Enforcement depended on memory.** Rules of the form "every time X, always do Y" were prose.
   Two of them had already failed in production (see below).
3. **Narrative crowded out operative content.** Incident stories consumed a large share of the
   bytes while the extractable rule was one sentence.

## Approach: route by kind of content, not by topic

| Kind | Home | Loads |
| --- | --- | --- |
| Facts true in every session | `CLAUDE.md` | always |
| Constraints tied to file paths | `.claude/rules/*.md` with `paths:` | when a matching file is read |
| Multi-step procedures | `.claude/skills/*/SKILL.md` | on invocation |
| "Always/never do X" | hooks | at the lifecycle event, regardless of model judgment |
| Narrative and history | `docs/specs/`, git | on demand |

### Result

| | Before | After |
| --- | --- | --- |
| `CLAUDE.md` | 667 lines / 45,336 B | **190 lines / 11,952 B** |
| Project rules | none | 8 files, 40,198 B, all path-scoped |
| Project skills | none | 4 files, 10,696 B |
| Enforcement hooks | 2 | 4 checks across 2 hooks |

The rules bytes are larger than the removed `CLAUDE.md` bytes because content moved rather than
being deleted, and some was expanded for clarity. The win is that ~40 KB now loads
*conditionally* — a UI session never pays for migration traps, and a migration session never
pays for brand tokens.

**Verified nothing was lost:** an audit grepped the new corpus (`CLAUDE.md` + rules + skills) for
61 load-bearing identifiers and trap names from the old file. All 61 present.

## Rules created

`supabase-migrations`, `money-invariants`, `auth-and-mfa`, `registrations-and-camps`,
`data-layer`, `edge-functions`, `ui-brand-and-layout`, `tests`.

### Design constraint discovered

**A path-scoped rule fires when Claude *reads* a matching file.** So anything that must be known
*before* opening a file cannot live only in a rule. Two things were kept in `CLAUDE.md` for
exactly this reason:

- the reviewer-tier review gate for money/auth/RLS diffs (needed at planning time)
- the `verify-before-commit` requirement (needed before touching anything)

## Skills created

`verify-before-commit`, `responsive-sweep`, `migration-push`, `config-push-dryrun`.

`verify-before-commit` doubles as the reusable subagent brief. The standing rule "rigor lives in
the brief, not the model" previously meant re-typing the protocol into every dispatch; the skill
is that protocol, named once.

## Hooks: three prose rules converted to enforcement

Each corresponds to a real incident.

1. **`verify_jwt` after `functions deploy`** — `--no-verify-jwt` is not sticky; a bare redeploy
   resets it to `true` and Supabase's gateway then rejects callers *before* the function runs,
   with no logs. A real customer charge sat unfulfilled 2026-07-02. Now:
   `scripts/hooks/post-bash-checks.mjs` runs `supabase functions list` after any deploy that
   could have touched the trio and reports if any shows `verify_jwt: true`.
2. **dev-auth firewall after a build** — greps `dist/assets` for `VITE_DEV_AUTH`/`initDevAuth`.
3. **`supabase config push`** → `ask`, because the command auto-confirms under agent detection and
   pushes defaults for undeclared `[auth]` keys. It sent `min-password-length 6` and
   `secure_password_change false` to prod during a supposed dry run on 2026-07-18.

Plus **`supabase db push`** → `ask`, prompting reconciliation of `supabase migration list` first
(a parallel session once pushed a competing migration to staging).

Both scripts carry `--self-test` batteries: 34 cases for the guard, 8 for the post-Bash checks.
The hooks fail **open** — a bug in a check must never break a Bash call. A check that reports it
could not run is not a pass.

## Model tiering: "reviewer tier" indirection

Nate is on Pro (no Fable 5) and plans a Max month late in the project for a full review sweep.
Rather than hardcoding a model name, `CLAUDE.md` defines **reviewer tier** = *Fable if the plan
has it, otherwise the top Opus*, resolved in one place. Everything else says "reviewer-tier".

Claude Code's `advisorModel` aliases (`opus`, `fable`) already resolve to the current default for
that family and advance with releases, so the setting needs no version pinning.

## Advisor tool: adopted as a subagent supplement, not a review replacement

Three facts decided the scope:

- **Fable 5 is not currently selectable as an advisor** (dimmed in the picker; `--advisor fable`
  rejected), and a Fable 5 *main* model accepts only a Fable advisor — so a Fable session runs
  without one.
- **Timing is model-driven with no override** — there is no setting to force or cap calls. The
  money/auth review gate requires a *guaranteed* review at a *specific* gate, so the advisor
  cannot implement it.
- **Advisor reads are never cached.** Each call reprocesses the full transcript. That inverts the
  intuition about where it pays: expensive from a long controller session, cheap from a
  small-context implementer subagent — which is exactly where `docs/model-routing-log.md` records
  cheaper models under-delivering.

Decision: set `advisorModel: "opus"`, expect the benefit on sonnet/haiku implementers, keep the
reviewer-tier diff review unchanged. Revisit from the routing log.

## Deliberately not adopted

- **Output styles.** A custom style *replaces* defaults including scope discipline, security
  handling, and verification habits — all of which this project depends on. Nothing wanted from a
  style that a rule cannot do more safely.
- **`--append-system-prompt`.** Diminishing adherence in long sessions, and sessions here are
  long.
- **Post-merge quizzes/explainers** (from the unknowns post). The equivalent already exists and is
  stronger: the mandatory reviewer-tier review of any money/auth/RLS diff before merge.

## Adopted from the unknowns post

Folded into `CLAUDE.md` → "Finding the unknowns": blind-spot pass at phase kickoff, prototype
before spec when requirements arrive as prose, prefer code references to descriptions, and a
per-phase implementation-notes file so deviations survive past the subagent that found them.

Motivating case: camps shipped 2026-07-22 and had their discipline/session UI stripped
2026-07-23 — an "unknown known" Nate would have flagged instantly if asked, and prose
requirements never surfaced.
