# Dev Test-Auth (Option C) — seeded auto-login for local verification

Date: 2026-06-25. Status: spec, not yet built. Prerequisite for verifying the Stripe
integration (`2026-06-25-stripe-integration.md`) and for all future authenticated-UI work.

## Problem
The dev/preview server (`ucg-dev` 5173, `ucg-preview` 5176) runs **unauthenticated** —
Supabase is env-configured but there's no signed-in `me`, so member/club/admin/checkout
UI can't be exercised live, and preview-tool verification keeps stalling. This blocks
visual verification on essentially every feature.

A *fake* `me` is insufficient: with no real Supabase session the client runs as the `anon`
role (RLS blocks member/club reads + writes) and Edge Functions reject the unauthenticated
call. So we need a **real** session for a seeded test user — just triggered automatically in
dev instead of via the login form.

## Requirement
A **dev-only auto-login** that:
- Is **firewalled to dev builds**: gated on `import.meta.env.DEV` **AND** the presence of the
  dev-auth env vars. It must be impossible for this path to run in a production build (Vite
  sets `import.meta.env.DEV` false in `vite build`; the env vars are absent in CI). Verify the
  production bundle contains no auto-login by grepping `dist/assets` after a build.
- On boot in dev, if not already signed in, performs a **real** `signInWithPassword` using
  credentials from gitignored env vars (e.g. `VITE_DEV_AUTH_EMAIL` / `VITE_DEV_AUTH_PASSWORD`),
  yielding a real JWT so the existing `onAuthenticated`/`syncFromSupabase` path populates `me`,
  roles, RLS, and Edge-Function auth exactly as a normal login would.
- Supports **switching the active test user** with minimal friction (at least: change the env
  var and reload; nice-to-have: a tiny dev-only switcher that signs in one of a small map of
  seeded users — athlete / club-manager / admin — so all role surfaces are testable). Keep the
  switcher itself dev-gated and trivial; don't over-build.
- Plays nicely with the existing auth lifecycle: don't fight `useAuthLoading`/`useRolesLoaded`,
  the `?setpw=1` HashRouter workaround, or sign-out (a manual sign-out in dev shouldn't instantly
  auto-login into a loop — guard with a session-storage "I signed out" marker or similar).

## Seeded test accounts (the human/setup step)
Create real Supabase **test users** in the project and matching `people`/roles so each role
surface is exercisable. Nate has standing authority to create these. At minimum:
- an **athlete** in a club (with a membership + a cart with items, so checkout is testable),
- a **club manager** (manages a club with roster + registrations),
- a **league admin**.
Document the emails (not passwords) in the spec/PR so future sessions know which user is which.
Passwords live only in the local gitignored `.env`.

## Files (let the subagent confirm by reading)
- `src/lib/auth.ts` — auth lifecycle (`onAuthenticated`, `syncFromSupabase`, sign-out reset).
- `src/lib/supabase.ts` — the Supabase client / sign-in calls.
- `src/App.tsx` — boot sequence (where `?setpw=1` is handled); the auto-login trigger likely fits here.
- `.env` handling / `vite-env.d.ts` for the new `VITE_DEV_AUTH_*` typing; ensure `.env` is gitignored.
- `.env.example` — add the new vars (names only, blank values) so the convention is discoverable.

## Docs to update (required)
- `CLAUDE.md` — replace the "**No-session gotcha**" and "Dev server caveat" notes: dev now
  auto-logs-in a seeded test user when `VITE_DEV_AUTH_*` are set, so authenticated UI (incl.
  Stripe test checkout) IS exercisable locally. Document the env vars, the dev-build gating, and
  which seeded users exist.
- `README.md` / `docs/README.md` — note the local dev auth setup under getting-started.
- `.env.example` — the new vars.

## Verification
- `npm run build` clean; **grep `dist/assets` to confirm no auto-login / no `VITE_DEV_AUTH_`
  literals leaked into the production bundle.**
- `npx eslint` the touched files.
- With the vars set: `ucg-preview` boots already signed-in as the seeded user; a member/club
  screen renders real data (proves RLS works under the real JWT). Capture a screenshot.
- Standing finish: branch → verify → merge to `main` → push.
