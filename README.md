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

- **Guests** (no account) browse public pages — live results, events.
- **Members** (signed in) manage their profile, buy memberships, self-attach to
  clubs, request new clubs.
- **Club managers** (a `club_managers` row) co-manage their club's roster, managers,
  and event registration.
- **App roles** (`user_roles`): `admin` (league controls + a "View as" person
  impersonation tool), plus scoped roles `sanctioning`, `regional_rep`,
  `finance_admin`, `refund_manager` — admins are NOT implicitly any of the others.
- **Event host** = a manager of the event's host club (derived, not a stored role),
  or a per-event grant via `event_admins`.
- **Judges** will be account-free via a per-event code (sub-project D, not built yet).

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

Keep the working copy at a short, space-free path **outside Dropbox** — e.g.
`C:\dev\ucg-platform`. The old Dropbox path (spaces + `&`) broke npm/npx shims and
caused `dist/` build locks; cloning to `C:\dev` fixes both, so plain `npm` commands
work normally. See [`CLAUDE.md`](CLAUDE.md) for the historical context.

```bash
npm install
npm run dev      # http://localhost:5173/ucg-platform/
npm run build    # production build to dist/
npm test         # Vitest — scoring engines + capability derivation
npm run test:e2e # Playwright smoke suite vs the staging backend
npm run lint
```

Tests live in [`tests/`](tests) (Vitest, node env): ground-truth checks for every
scoring engine plus the capability logic. `npm test` / `npx vitest` work normally
from the `C:\dev` path. E2E smoke specs live in [`e2e/`](e2e) (Playwright) and run
against the **staging** Supabase project (see [`supabase/README.md`](supabase/README.md)
→ "Staging project"; needs the gitignored `.env.staging.local`).

Without Supabase env vars the app uses the password gate `fortheloveofthesport`
(SHA-256 in `src/lib/store.ts` `GATE_HASH`) — obfuscation for private demos, not
real security.

### Dev auto-login (authenticated local testing)

The dev server normally has no signed-in user, so member/club/admin/checkout UI
can't be exercised locally. To fix that, copy [`.env.example`](.env.example) to
`.env.local` and fill the `VITE_DEV_AUTH_*` vars with the credentials of **real
seeded Supabase test users** (athlete / club-manager / admin). On dev boot the app
then performs a real `signInWithPassword`, yielding a real JWT so RLS and Edge
Functions work exactly as in production. A small bottom-left switcher flips between
the seeded roles. This path is **dev-only** — it's dynamic-imported behind
`import.meta.env.DEV` (see [`src/lib/dev-auth.ts`](src/lib/dev-auth.ts)) and is never
bundled into a production build. Passwords live only in `.env.local` (gitignored);
leave the vars blank to keep the dev server unauthenticated.

## Status & roadmap

**Done:** Supabase backend (write-through + realtime live results) · real auth +
capability model · accounts↔people · club management + new-club requests · admin role
grants · membership lifecycle (digital waiver e-signature, club-pay) · **club-membership
lifecycle + registration/hosting gate** · club roster & meet-reg grid + roster club
switcher · **admin-create invites with set-password links** (Add-athlete) · club cart,
coupons (incl. account-restricted) & invoices · **View Cart + Purchase History + My
Registrations** (client-side PDF receipts/waiver proof) · account merge (persisted) ·
meet/session/squad builder + meet wizard · native scoring engines for all disciplines ·
nationals finals-qual / awards engine · live results · imported real Nationals 2026
data · **transactional email via Resend + SMS via Telnyx** (Communicate broadcast with a
persistent communication log, guardian-waiver links, club-cart notices, invites) ·
**client error-log DB + admin Error Log** · PWA + perf work · test suite ·
**Stripe Embedded Checkout payments** (memberships, event entries, change fees, coupons —
server-authoritative fulfillment; test mode) · **security hardening Phases 1–2** (RLS
guard triggers, token exposure, retryable fulfillment) · **event "Meet management"**
(Draft/Live publication state + timestamp-driven registration open/close, a
role-gated last-date-to-edit lockout, correct cross-club registration visibility on a
club-transfer, synchro same-level auto-sync) · **2026 UCG rebrand** (tokens, licensed
fonts, logos) · **event management v2 in full** (P0–P6, 2026-07-07 → 2026-07-16: host
dashboard/workbook/communication, per-unit add-ons + camps, in-app refunds + $0
checkout, capacity/waitlists/by-session registration, nationals ops — competition
order, finals lineups, check-in — and finance dashboards with .xlsx export) ·
**staging environment + Playwright E2E smoke suite** · **scheduled dispatch**
(pg_cron reminders/escalations/waitlist promotion).

**Next:** the single authoritative open-work list is
[`docs/whats-next.md`](docs/whats-next.md) (reconciled 2026-07-16) — headlines:
Stripe go-live ([checklist](docs/stripe-go-live-checklist.md)) + Supabase Pro,
legal/counsel, security hardening Phase 3 + rate limiting, the 2026-07-04 UI/UX fix
batch, then sub-projects B (typed memberships) → C (multi-club picker) → D (codeless
judge access) → E (scoring config). Docs index in [`docs/`](docs).

**Path to launch:** [`docs/production-readiness.md`](docs/production-readiness.md) is the
gap analysis + phased plan for reaching production gold standards (UX, security,
reliability, observability, legal), with steps split between Nate and Claude.

Spec: `../Reg & Scoring Platform Specification.md`.
