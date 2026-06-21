# UCG Registration & Scoring Platform

The **United Club Gymnastics** (formerly NAIGC) registration and scoring platform,
intended to replace ScoreFlippers. React + TypeScript + Vite, with a Supabase backend.

**Live (development):** https://nssharpe.github.io/ucg-platform/ — deploys from `main`
via GitHub Actions. Hosting is GitHub Pages **for development only**; see
[`docs/hosting-and-launch.md`](docs/hosting-and-launch.md) for the production plan
(`registration.unitedgymnastics.org`).

## Architecture

Two independent halves:

- **Frontend** — a static Vite/React SPA. Reactive in-memory store
  (`src/lib/store.ts`, `useDB`/`mutate`) is the UI's source of truth.
- **Backend** — Supabase (Postgres + Auth + RLS + realtime). `src/lib/supabase.ts`
  is a **write-through** layer: every `mutate()` also mirrors the change to Supabase,
  and `loadAll()` hydrates the snapshot on boot. Row-Level Security is the real
  security boundary. See [`supabase/README.md`](supabase/README.md).

When the Supabase env vars are absent, the app falls back to a **localStorage-only
prototype** with a password gate — handy for offline demos. With them present (the
deployed config), it runs on real Supabase Auth + data.

### Auth & capabilities

There is no role switcher. Permissions are derived from the signed-in user's real
state by [`src/lib/capabilities.ts`](src/lib/capabilities.ts) (React hooks) over the
pure [`src/lib/capabilities-core.ts`](src/lib/capabilities-core.ts) (`deriveCapabilities`):

- **Guests** (no account) browse public pages — live results, meets.
- **Members** (signed in) manage their profile, buy memberships, self-attach to
  clubs, request new clubs.
- **Club managers** (a `club_managers` row) co-manage their club's roster, managers,
  and meet registration.
- **Admins** (the only `user_roles` role) get league controls + a "View as" person
  impersonation tool.
- **Meet host** = a manager of the meet's host club (derived, not a stored role).
- **Judges** will be account-free via a per-meet code (sub-project D, not built yet).

Accounts link to a person row by **verified email** on first sign-in
(`link_or_create_person` RPC); email confirmation must stay ON.

### Scoring

All six NAIGC scoring systems are implemented as **pure TypeScript engines** in
[`src/scoring/`](src/scoring) (MAG SV, Masters, WAG Open, WAG vault, Xcel/Level 9 SV,
T&T), with a shared `init`/`compute` contract and UCG-branded React panels in
[`src/components/scoring/`](src/components/scoring). The judge pad streams D/E/Final
live and posts to results instantly. The original NAIGC calculators remain under
`public/calculators/` only to restore the embedded state of scores entered before the
native engines (legacy `calcState`); new entry never uses them.

## Develop

The repo path contains spaces and an `&`, which breaks npm/npx shims on Windows —
invoke binaries directly. See [`CLAUDE.md`](CLAUDE.md) for the full gotcha list
(including the Dropbox `dist/` lock during builds).

```bash
npm install
npm run dev      # http://localhost:5173/ucg-platform/
npm run build    # production build to dist/
npm test         # Vitest — scoring engines + capability derivation
npm run lint
```

Tests live in [`tests/`](tests) (Vitest, node env): ground-truth checks for every
scoring engine plus the capability logic. Run directly with
`node node_modules/vitest/vitest.mjs run` if the npm shim misbehaves on this path.

Without Supabase env vars the app uses the password gate `fortheloveofthesport`
(SHA-256 in `src/lib/store.ts` `GATE_HASH`) — obfuscation for private demos, not
real security.

## Status & roadmap

**Done:** Supabase backend (write-through + realtime live results) · real auth +
capability model · accounts↔people · club management + new-club requests · admin
role grants · membership lifecycle (digital waiver e-signature, club-pay) · club
roster & meet-reg grid · club cart, coupons & invoices · meet/session/squad builder
+ meet wizard · native scoring engines for all disciplines · nationals finals-qual /
awards engine · live results (AA, event rankings, team scores) · imported real
Nationals 2026 data · test-grade transactional email (Gmail SMTP Edge Functions:
Communicate broadcast, guardian-waiver links, club-cart manager notifications) ·
PWA + perf work · test suite.

**Next (sub-projects):** Stripe payments → typed memberships + per-season waiver (B) →
club-based registration multi-club picker (C) → codeless judge access (D) → meet
1-vs-2-panel + calculator-vs-simple config (E). Further out: PDF certs, banquet
tickets, production email transport (Resend / Workspace relay), external API, finals
rosters. Full status in [`CLAUDE.md`](CLAUDE.md); docs index in [`docs/`](docs).

Spec: `../Reg & Scoring Platform Specification.md`.
