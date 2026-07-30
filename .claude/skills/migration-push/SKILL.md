---
name: migration-push
description: Create and apply a Supabase migration for UCG — staging first, then prod — including the pre-push reconciliation, the IPv6/pooler workaround, and the mandatory post-apply non-admin write-path probe. Use when writing, applying, or troubleshooting a migration.
---

# Create and apply a migration

Nate has standing authorization for `supabase db push` against prod (2026-07-24) — do it
directly, don't hand it back. Still show what will apply first.

Schema/RLS traps that determine what the migration should *contain* are in
`.claude/rules/supabase-migrations.md`. This skill is the mechanics.

## 1. Create the file

```bash
supabase migration new <name>
```

The timestamp filename format is required — don't hand-name the file. Each
`ALTER TYPE ... ADD VALUE` goes in its OWN migration file.

## 2. Reconcile before pushing — every time

```bash
supabase migration list
```

A remote version with no local file means **another session touched the DB**. A background task
chip once spawned as its own session in `.claude/worktrees/`, wrote a competing migration for the
same finding, and pushed it to staging (2026-07-24). Reconcile before you push, not after.

A `PreToolUse` hook asks for confirmation on `supabase db push` for exactly this reason. When it
prompts, the expected answer is "yes, I've reconciled and here's what will apply" — not a reflex
approval.

## 3. Staging first

The CLI stays linked to PROD, so staging must be targeted explicitly:

```bash
supabase db push --project-ref xogpiksqtkayxwmczlbx
```

Staging creds are under `STAGING_*` in `.env.local`. Full runbook: `supabase/README.md`.

## 4. Then prod

```bash
supabase db push
```

Network is sandbox-blocked — run with the sandbox disabled.

## 5. Probe the WRITE path as a non-admin — mandatory after any column-privilege change

Reads passing proves nothing. A column-scoped SELECT revoke breaks every whole-row upsert that
writes that column, and the error names the TABLE, not the column, so it looks like a missing base
grant. `registrations.camp_survey` did this and every client registration upsert failed 42501 for
six days.

Probe with the app's explicit column list, not `select('*')`.

## ⚠ IPv6-only direct connections

`db.<ref>.supabase.co` has been **IPv6-only since ~2026-07-23** — every direct-connection command
(`db push --db-url`, `scripts/backup-db.mjs`) fails `ENOTFOUND` without IPv6 egress. Use the
Supavisor **session** pooler instead:

- user `postgres.<ref>`
- host `aws-1-us-west-2.pooler.supabase.com`
- port **5432** (not 6543; not `aws-0-`)

This silently killed the daily backup for a day before it was caught. Full incident + the fixed
fallback: `supabase/README.md` → "Data backups".

## 6. Update the docs

`supabase/README.md` holds the authoritative migration table + per-migration narrative. Add the
row in the same session.
