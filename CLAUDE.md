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
  CLI is linked (`supabase link` done 2026-06-19). All migrations are applied and
  tracked by the CLI — through the waiver-e-sign set (`20260620000010/0020/0030`,
  the latest as of 2026-06-21). `supabase functions deploy <name>` deploys Edge
  Functions (see [Email infra] below).
- Migration filenames use Supabase's required timestamp format:
  `<YYYYMMDDHHmmss>_name.sql`. Create new ones with `supabase migration new <name>`.
- Apply via `supabase db push` (the shell sandbox blocks network — run with the
  sandbox disabled).
- **Enum gotcha:** `ALTER TYPE ... ADD VALUE` cannot be used in the same transaction
  that then references the new value. Put each such change in its OWN migration file
  so it commits before any file that uses it.

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

## Email infra (test-grade, working)
- Transactional email works via **Gmail SMTP** Edge Functions (denomailer). Secrets are
  project-wide: `GMAIL_USER` (= nate.sharpe@naigc.org), `GMAIL_APP_PASSWORD`, optional
  `GMAIL_FROM_NAME`, `APP_PUBLIC_URL`. This is **test-grade** (personal Gmail, recipient
  caps) — swap to Resend / Workspace SMTP relay before real production sends.
- Functions in `supabase/functions/`: `send-email` (Communicate broadcast, admin-only),
  `request-guardian-waiver` (minor waiver link), `record-waiver-signature`,
  `notify-club-cart` (emails a club's managers when a member pushes fees to the cart).
- Front-end invokers live in `src/lib/supabase.ts` (`sendEmail`, `requestGuardianWaiver`,
  `notifyClubCart`). Deploy a function: `supabase functions deploy <name> --project-ref
  wkyerxlgricfphopocoz` (sandbox disabled; Docker NOT required).

## Deferred / TODO (not yet built)
- **New-club-request email** — the new-club-request flow should email
  `newclubinquiries@naigc.org`. The email transport now exists (above); the request flow
  just doesn't fire it yet. Wire a best-effort send via the same path.
- Stripe payments (memberships, meet entries, banquet), typed membership purchase +
  per-season waiver, codeless judge access (URL / 6-digit / QR), multi-judge + score-
  entry-mode meet config, PDF certs, finals rosters. See `docs/specs/` + `docs/plans/`,
  and the roadmap in `docs/README.md`.
