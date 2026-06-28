# AGENTS.md — UCG Registration & Scoring Platform

React + TypeScript + Vite. Supabase backend (env-gated). Live:
https://nssharpe.github.io/ucg-platform/ — deploys via GitHub Actions on push to `main`.

## Your role (read this first)
You are an **implementer** invoked on a single, well-scoped task. Make the code
changes and **verify them** (see the gate below), then report what you changed and the
verification output. You do **NOT**:
- commit, push, merge, or touch git history,
- run `supabase db push` or `supabase functions deploy`,
- deploy anything or run other side effects.
Create migration files / edge-function code when a task needs them, but leave applying
them to the orchestrator. If a task is ambiguous or would require any of the above,
stop and report rather than guessing.

## Verification gate — MANDATORY before you report done
Run ALL of these and paste the results:
1. `npm run build` — this runs `tsc -b` (project references). **Use this, NOT
   `tsc --noEmit`** — `--noEmit` silently misses errors that `tsc -b` catches. Confirm
   the build really succeeded: check that `dist/index.html` exists and its script refs
   resolve under `dist/assets` — do not trust the exit code alone.
2. `npx eslint <every file you touched>` — **including any `supabase/functions/**`**.
   Lint must be CLEAN on touched files (zero errors). The CI deploy **fails on any lint
   error**, and `npm run build` does NOT run eslint, so a green build can still break the
   deploy. Pre-existing warnings elsewhere are tolerated; only lint files you changed.
3. `npx vitest run` — all tests pass. If you added **pure** logic (scoring, pricing,
   capability derivation), add a vitest test for it under `tests/**/*.test.ts`
   (node env, no React/DOM).

## ESLint traps that fail the build
- Do **not** define a React component inside another component's render — extract to
  module scope.
- Do **not** call `setState` synchronously in a `useEffect` body — initialize state
  instead.
- `supabase/functions/**` is linted too (e.g. `no-useless-assignment` fires on a
  `let x = null` always reassigned before use).

## UI / readability (hard requirements)
- **Never** put text on a same-or-near-same color background. Resolve CSS
  variables/theme tokens to real values; aim for WCAG AA (≥4.5:1 body, ≥3:1 large/UI).
  Watch hover/active/disabled states and dark-mode overrides.
- Any change touching layout, CSS, the topbar, or the sidebar/nav must work at **375px,
  768px, 1280px**: no horizontal overflow (`documentElement.scrollWidth ≤ clientWidth`),
  topbar stays ≤2 lines, nav becomes an off-canvas drawer **below 860px**
  (`Layout.tsx` + the `@media (max-width: 860px)` block in `index.css`).

## Naming — the Meet→Event / apparatus rename (already applied everywhere)
The old "Meet" entity is now **Event**; gymnastics **apparatus** (formerly also called
"events") is now **apparatus**. Use the new names:
- DB: `meets`→`events`, `meet_sessions`→`event_sessions`, `meet_id`→`event_id`,
  `ref_meet_id`→`ref_event_id`, `registrations.events`→`registrations.apparatus`,
  `scores.event`→`scores.apparatus`, enum `meet_status`→`event_status`,
  `registrations.event_levels`→`apparatus_levels`.
- TS: `Meet`→`Event`, `MeetSession`→`EventSession`, `src/pages/Meets.tsx`→
  `src/pages/Events.tsx`, `meetId`→`eventId`, the `EVENTS` const→`APPARATUS`,
  `Registration.events`→`apparatus`, `Score.event`→`apparatus`,
  `eventLevels`→`apparatusLevels`, calculator prop `eventCode`→`apparatusCode`.
- Routes: `/meets*`→`/events*` (old paths kept as `<Navigate replace>` redirects).
- **Preserved (do NOT rename):** the `'meet-entry'` invoice_item_kind value, the
  `meet-host` app_role, the `meet_kind` enum, the `NationalsConfig.cutoffs.event` jsonb
  key, opaque id prefixes (`meet-…` seed ids), and DOM/realtime/lifecycle `event`s.

## Supabase / migrations
- Migrations live in `supabase/migrations/`, filename format
  `<YYYYMMDDHHmmss>_name.sql`. Create new ones with `supabase migration new <name>`.
- **Enum gotcha:** `ALTER TYPE ... ADD VALUE` cannot be used in the same transaction
  that then references the new value. Put each such change in its **own** migration file
  so it commits before any file that uses it.
- Create migration files for schema changes, but **do not apply them** (no `db push`).

## Tests
- Vitest, **node environment** (`vitest.config.ts`, no app plugins). Tests in
  `tests/**/*.test.ts`, covering the **pure** logic only: scoring engines
  (`src/scoring/*`), pricing (`src/lib/pricing.ts`), capabilities
  (`src/lib/capabilities-core.ts`). No DOM/React/component tests (no jsdom configured).

## Environment
- Repo lives at `C:\dev\ucg-platform` (short, space-free). Plain `npm`/`npx` work.
- New DB collection plumbing pattern: add to `types.ts` (`DB.<x>`), a `rowTo<X>` +
  `push<X>`/`delete<X>` in `src/lib/supabase.ts`, and the `loadAll` Promise.all + map.
- Edge Function invokers must surface errors via `edgeErrorMessage(error)`, not
  `error.message`.
