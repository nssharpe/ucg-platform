# Error logging / observability — recommendation

> Research note, 2026-06-22. Answers: "What is the best practice in terms of logging
> errors to aid in bug fixing? It would be great if when someone emailed with an issue,
> we don't have to rely on them providing good details and screenshots, but can instead
> look at some sort of error log database, search for their username, and see a list of
> all errors generated when that person was logged in."

## What we already have

`src/lib/report-error.ts` is already the right shape: a single `reportError(original,
context, detail)` entry point with a swappable **sink** (`setErrorReporter`) and a
25-entry in-memory ring buffer. The ErrorBoundary and write-queue already route through
it. Today the default sink only `console.error`s — nothing is persisted. So the
plumbing for "send errors somewhere" exists; we just need a durable sink.

## The two real options

### Option 1 — Hosted error tracker (Sentry)
Industry standard. `@sentry/react` captures unhandled errors, React render errors,
promise rejections, breadcrumbs, release/version, browser, and **user context**
(`Sentry.setUser({ id, email })`). You search by user, see stack traces with sourcemaps,
get grouping/dedup, alerts, and a dashboard — all built.

- **Pros:** zero backend to build; rich context; sourcemap-resolved stacks; search by
  user/email is native; free tier covers a small org's volume.
- **Cons:** external service / data leaves our infra (PII in errors — scrub it); another
  vendor; free tier has quotas.
- **Wiring:** add `@sentry/react`, init at boot with `release` + `environment`, call
  `setErrorReporter` to forward our `ReportedError`s to `Sentry.captureException`, and
  set `Sentry.setUser` on auth state change. ~Half a day. (Already anticipated in
  `report-error.ts`'s header comment and `docs/production-readiness.md` §3.)

### Option 2 — Self-hosted: a Supabase `error_logs` table
Since errors should be searchable by username and we already run Supabase, we can write
them to our own DB. This directly matches the request ("error log database, search for
their username").

```sql
create table error_logs (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  auth_user_id uuid,              -- who was logged in (null if guest)
  person_id   text,              -- resolved app person, for easy name search
  email       text,
  context     text,              -- route / 'write-queue' / 'react-render'
  message     text not null,
  stack       text,
  detail      jsonb,             -- componentStack, table, op, etc.
  url         text,              -- location.hash at the time
  user_agent  text,
  app_version text               -- build SHA / version for correlating to a release
);
-- RLS: admins read all; inserts via a security-definer RPC or Edge Function so
-- anonymous/guest errors can still be recorded without exposing the table.
```

A `log_client_error` Edge Function (or `security definer` RPC) accepts a batch and
inserts with the service role. The error sink in `report-error.ts` forwards to it
(debounced/batched, fire-and-forget, never throws). An admin page ("Error Log") lists
recent rows, **searchable by email/name**, filterable by context/date.

- **Pros:** data stays in our DB; trivially search by username; integrates with the
  existing admin UI; no vendor; free.
- **Cons:** we build + maintain it (table, RPC, sink, admin UI, retention/pruning); no
  automatic sourcemap resolution (stacks are minified unless we upload/lookup sourcemaps
  ourselves); no grouping/alerting unless we build it.

## Recommendation

**Do both, staged — but lead with Option 2 because it directly answers the user's
need** (search a DB by username, see that person's errors):

1. **Now:** build the `error_logs` table + `log_client_error` Edge Function + forward
   from `report-error.ts`'s sink, stamping `auth_user_id`/`email`/`person_id`,
   `location.hash`, `user_agent`, and a build version. Add an admin "Error Log" page
   with search-by-name/email. This is self-contained and uses infra we already run.
2. **Capture more at the source:** add `window.onerror` + `onunhandledrejection`
   handlers that call `reportError`, so we catch everything, not just boundary/queue
   errors. Add a build-time version constant (git SHA) so logs correlate to a release.
3. **Later / optional:** add Sentry on top for sourcemap-resolved stacks, grouping, and
   alerting if the DB log proves too noisy to triage by hand. The sink can fan out to
   both.

### Privacy note
Scrub obvious PII from `detail` before storing (no raw tokens, no full payloads with
emails of *other* users). Set a retention window (e.g. prune `error_logs` older than
90 days) so the table doesn't grow unbounded.

## References
- Existing plumbing: `src/lib/report-error.ts`, `src/components/ErrorBoundary.tsx`
- `docs/production-readiness.md` §3 (Sentry already anticipated)
- Sentry React: https://docs.sentry.io/platforms/javascript/guides/react/
- Supabase Edge Functions: https://supabase.com/docs/guides/functions
