---
name: verify-before-commit
description: The UCG verification protocol that must pass before any commit, merge, or push. Use when finishing an implementation task, before committing, before merging a branch, or when briefing a subagent on how to verify its work. Demands evidence (commands run + output), not claims.
---

# Verify before commit

Evidence before assertions, always. "It should work" and "the build is clean" are not
verification — the command output is. If you did not run it, say so plainly rather than implying
you did.

## The protocol

Run all four. None is optional.

### 1. Build — `npm run build`, never `tsc --noEmit`

```bash
npm run build
```

`tsc -b` (what the build runs) catches errors `--noEmit` misses. This has caused real rework.

**Verifying the build actually succeeded** — do NOT trust the piped exit code alone:
- grep the output for `files generated`
- confirm `dist/index.html`'s script refs exist under `dist/assets`

A PostToolUse hook also greps `dist/assets` for `VITE_DEV_AUTH`/`initDevAuth` after every build.
If it reports a hit, the dev-auth firewall is broken — do not deploy that build.

### 2. Lint the touched files

```bash
npx eslint <touched files>
```

Include anything under `supabase/functions/**` — ESLint covers those too.

**Why per-file and not just the build:** `npm run build` does NOT run eslint, so a clean build can
still break the deploy. The CI deploy workflow runs `npm run lint` and fails on any lint
**error** (pre-existing warnings are tolerated). `npm run lint` was fully clean project-wide as of
2026-07-03 — keep it that way, but don't rely on that staying true implicitly.

### 3. Tests

```bash
npx vitest run
```

**Any new PURE logic requires a new vitest test.** Pure logic means it takes rows/values as
parameters and imports no runtime deps — that's the whole reason `capabilities-core.ts` and
`pricing.ts` are split out.

### 4. Scope-specific verification

| If the change touched… | Also do this |
| --- | --- |
| layout, CSS, topbar, or nav | the `responsive-sweep` skill |
| a migration | the `migration-push` skill, incl. the post-apply non-admin WRITE-path probe |
| `supabase/config.toml` or auth templates | the `config-push-dryrun` skill |
| an edge function in the no-verify-jwt trio | confirm `verify_jwt: false` after deploying |
| money, auth, RLS, or cart | a reviewer-tier adversarial review of the diff (see `CLAUDE.md`) |

## Reporting

Report what you ran and what it printed. For each of the four: the command, and either the
pass line or the actual failure output.

If something failed and you fixed it, show the re-run. If something is still failing, say so
explicitly and do not describe the task as complete — a partially-verified change reported as
done is worse than an honest failure, because it burns the next session's trust in every prior
claim.

If a step was skipped, name the step and the reason. "Not applicable" needs the reason attached
(e.g. "no pure logic added").

## When briefing a subagent

Name this skill in the brief and require evidence. Rigor lives in the brief, not the model — a
cheaper model matches frontier rigor on mechanical work only when the verification protocol is
spelled out and output is demanded. Never assume a subagent self-imposes any of this.
