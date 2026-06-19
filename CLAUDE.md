# UCG Registration & Scoring Platform

React + TypeScript + Vite. Live: https://nssharpe.github.io/ucg-platform/
Supabase backend (env-gated). Deploys via GitHub Actions on push to `main`.

## Working style (Nate = PM, not hands-on)
Do as much as possible directly. When a step is technically doable but blocked only
on a one-time setup or a permission grant, ask for *just that unblock*, then execute
the step yourself — don't hand the whole step back to Nate as instructions. Nate has
standing authorization to run `supabase db push` / apply migrations to the live DB
(granted 2026-06-18). Still confirm genuinely destructive prod actions and show what
will apply first.

## Supabase / migrations
- Project ref `wkyerxlgricfphopocoz` (org NAIGC). Migrations in `supabase/migrations/`.
- Apply via `supabase db push` (the shell sandbox blocks network — run with the
  sandbox disabled). Earlier migrations were applied out-of-band via the dashboard
  SQL editor, so the CLI's migration-history table may be out of sync; check
  `supabase migration list` and `migration repair` before a blind push.
- **Enum gotcha:** `ALTER TYPE ... ADD VALUE` cannot be used in the same transaction
  that then references the new value. Put each such change in its OWN migration file
  (e.g. `0007b_sanctioning_role.sql`) so it commits before any file that uses it.

## Build / tooling gotchas
- The repo path contains spaces **and** an `&`, which breaks npm/npx cmd shims on
  Windows. Invoke binaries directly: `node node_modules/<pkg>/bin/...`.
- Dropbox locks `dist/` during `vite build` (EBUSY at prepare-out-dir). Remove
  `dist` first with retries, then build, then re-set the NTFS ADS
  `dist:com.dropbox.ignored=1` (write via node `fs.writeFileSync`). Always verify a
  build by grepping for "files generated" AND confirming `dist/index.html`'s script
  refs exist under `dist/assets` — never trust the piped exit code alone.
- `ucg-prod-preview` launch config runs `vite preview` only — REBUILD first, and
  clear the service worker (unregister + `caches.delete` + reload) or it serves the
  previous bundle.
- Pre-existing lint debt (`src/lib/supabase.ts` `any`s, etc.) — `npm run lint` has
  never been clean. Lint only the files you touch.

## Tests
- Vitest, **node environment**, config in `vitest.config.ts` (no app plugins loaded).
  Tests live in `tests/**/*.test.ts` and cover the **pure** logic: the scoring
  engines (`src/scoring/*`) and capability derivation (`src/lib/capabilities-core.ts`,
  split out from the React hooks in `capabilities.ts` so it imports zero runtime deps).
- Run: `node node_modules/vitest/vitest.mjs run` (npm script `test`, but the shim is
  broken on this path — call the binary directly). Watch: drop `run`.
- The scoring tests encode ground-truth values verified against the original NAIGC
  calculators, so they lock in the port's correctness. No DOM/React/component tests
  yet — those would need a jsdom environment + @testing-library added later.

## Docs
- `README.md` — overview/architecture. `docs/` — `specs/`, `plans/`, and reference
  notes (`docs/hosting-and-launch.md`, `docs/README.md` index). `supabase/README.md`
  — backend schema + RLS model.
- Write new design specs to `docs/specs/`, implementation plans to `docs/plans/`
  (overrides the brainstorming/writing-plans skill defaults — do NOT recreate
  `docs/superpowers/`).

## Deferred / TODO (not yet built)
- **Transactional email** — the new-club-request flow (and any future notifications)
  should email `newclubinquiries@naigc.org`, but no email provider/Edge Function
  exists yet. For now the in-app `club_requests` queue is the source of truth; wire a
  provider (e.g. Resend via a Supabase Edge Function) when the Stripe Edge Functions
  land, then make the request flow fire a best-effort email.
- Stripe payments (memberships, meet entries, banquet), typed membership purchase +
  per-season waiver, codeless judge access (URL / 6-digit / QR), multi-judge + score-
  entry-mode meet config, PDF certs, finals rosters. See `docs/specs/` + `docs/plans/`,
  and the roadmap in `docs/README.md`.
