# UCG Registration & Scoring Platform

React + TypeScript + Vite. Live: https://nssharpe.github.io/ucg-platform/
Supabase backend (env-gated). Deploys via GitHub Actions on push to `main`.

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

## Deferred / TODO (not yet built)
- **Transactional email** — the new-club-request flow (and any future notifications)
  should email `newclubinquiries@naigc.org`, but no email provider/Edge Function
  exists yet. For now the in-app `club_requests` queue is the source of truth; wire a
  provider (e.g. Resend via a Supabase Edge Function) when the Stripe Edge Functions
  land, then make the request flow fire a best-effort email.
- Stripe payments (memberships, meet entries, banquet), typed membership purchase +
  per-season waiver, codeless judge access (URL / 6-digit / QR), multi-judge + score-
  entry-mode meet config, PDF certs, finals rosters. See `docs/superpowers/specs/`.
