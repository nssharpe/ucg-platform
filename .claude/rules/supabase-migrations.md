---
paths:
  - "supabase/migrations/**"
  - "supabase/README.md"
  - "src/lib/supabase.ts"
  - "src/lib/store.ts"
---

# Supabase schema, RLS, and migration traps

Project ref `wkyerxlgricfphopocoz` (org NAIGC); CLI stays linked to PROD. Staging project
`xogpiksqtkayxwmczlbx` (`ucg-staging`) — target it explicitly via `--project-ref`/`--db-url`
(creds under `STAGING_*` in `.env.local`). **Apply new migrations to staging FIRST, then prod.**

**The authoritative migration list + per-migration narrative + schema/RLS model is
`supabase/README.md`** — keep its table updated with every migration. Detail goes THERE.

Procedure for creating and applying migrations: the `migration-push` skill.

## Id and type facts

- Ids are app-generated **text**, not uuids — including FK columns (`payments.person_id`).
- `payments.id` is the lone **uuid** PK in the schema. Every other id, including FK columns
  referencing it (`refund_requests.payment_id`), is app-generated text.
- Money columns on `payments` are **CENTS**.

## Enum gotcha

`ALTER TYPE ... ADD VALUE` cannot be referenced in the same transaction. Put each enum
addition in its **OWN** migration file.

## Upsert-trigger trap

The app writes whole-row upserts (`INSERT ... ON CONFLICT DO UPDATE`), so BEFORE INSERT
triggers fire with `tg_op='INSERT'`/`OLD=NULL` **even when the row already exists**. A guard
trigger must re-SELECT the pre-write row by `id` — never trust `tg_op`/`OLD`.
(Bit us live: `20260703034325`.)

## RLS upsert trap

An upsert must pass an INSERT policy's WITH CHECK even on the conflict-update path, so a
manager-editable table needs BOTH insert and update policies. Prefer separate insert/update
policies over `for all`, which silently grants DELETE.

## Column-revoke × whole-row-upsert trap (broke prod 2026-07-17 → 23)

A column-scoped SELECT lockdown (`revoke select on <table>` + `grant select (<cols>)`) breaks
EVERY whole-row upsert that writes the revoked column. PostgREST compiles upserts to
`ON CONFLICT DO UPDATE SET col = EXCLUDED.col`, and Postgres requires SELECT privilege on
columns referenced via EXCLUDED. `return=minimal` does NOT save you.

**The error wording LIES:** a revoked COLUMN surfaces as
`42501: permission denied for table <table>` — naming the TABLE, not the column — so it reads
like a missing base grant and has been misdiagnosed as exactly that (cost a false "Nate must
re-grant SELECT on staging" action item, 2026-07-26).

Before concluding an environment is broken, retry with the app's explicit column list:
`select('*')` on `registrations` fails while `REGISTRATION_COLUMNS_NO_SURVEY` succeeds.

**Rules that follow:**
- A column with revoked SELECT must NEVER appear in a `*ToRow` upsert mapping. Write it via a
  targeted column UPDATE — `pushCampSurvey` is the pattern.
- After ANY column-privilege migration, live-probe the affected table's WRITE path as a
  non-admin, not just reads.
- Never client-side delete-then-insert rows the caller's own permission derives from (e.g.
  `club_managers`) — the delete revokes the actor's right to re-insert. Use a security-definer
  RPC that authorizes ONCE up front (`replace_club_managers` is the pattern; write-queue op
  kind `'rpc'`).

## Fail-closed SQL

In SECURITY DEFINER functions, wrap auth predicates in `coalesce(..., false)` — for an anon
caller an OR-chain over NULL evaluates to NULL and `if not NULL` does NOT raise (bit us:
`20260704133502`). Also revoke the default PUBLIC execute grant on new functions, and revoke
from `anon` explicitly.

## RLS policy recursion (42P17)

A new policy on table A whose subquery reads table B recurses — and breaks ALL reads of A for
every caller — when any of B's policies read back into A. Postgres detects the cycle and errors
regardless of role. Use SECURITY DEFINER helper functions (the `my_person_id()` /
`manages_club()` pattern) instead of raw cross-table subqueries in policies.
(Bit us live: `20260710230000` broke every `invoice_items` read until hotfixed by
`20260711023234`.)

## RLS predicate vs grant revoke

A restrictive SELECT *policy* filters rows silently — anon gets `200 []`. Only a
`revoke select` produces a 403. Don't add client-side error tolerance for the former; it costs
a fail-fast signal for real outages.

## New DB collection plumbing

Add to `types.ts` (`DB.<x>`), `rowTo<X>` + `push<X>`/`delete<X>` in `supabase.ts`, and the
`loadAll` Promise.all + map + conditional spread. `from('<new_table>')` typechecks even if
absent from `database.types`.

**Read it via `fetchAllRows` like every other table** — a bare `.select()` silently truncates
at PostgREST's 1000-row cap (fixed repo-wide 2026-07-24). If the table has no `id` column,
register its sort key in `COMPOSITE_SORT_KEYS` (`src/lib/pagination.ts`) — pagination without a
deterministic ORDER BY duplicates and skips rows.

## Known gap

`payments` is still an unscoped `fetchAllRows` in `loadAll` — the same statement-timeout risk
`memberships`/`invoices`/`invoice_items` had before their 2026-07-28 fix. Worth the same
query-scoping treatment before a real season pushes it past 10k rows (`docs/whats-next.md` §7).
