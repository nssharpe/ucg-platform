# Supabase backend wiring plan (2026-06-11)

Goal: make the live Supabase project (ref wkyerxlgricfphopocoz) the real data layer,
while the app keeps working unchanged when Supabase env vars are absent (static demo
fallback). Migrations 0001_schema.sql + 0002_rls.sql are already applied; `.env.local`
has VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY (publishable key format).

Architecture (decided): keep the in-memory `db` snapshot + `useDB()`/`mutate()` in
`src/lib/store.ts` exactly as today (optimistic local-first). Add a write-through
repository in `src/lib/supabase.ts`. Each app mutation call site keeps its local
`mutate(...)` but additionally fires the matching remote write. Boot hydrates the
snapshot from Supabase via `loadAll()` when configured; localStorage becomes a cache.

## Task A — Repository + hydration + write-through + seed push

1. In `src/lib/supabase.ts`, implement the repository against the real schema
   (read `supabase/migrations/0001_schema.sql` for exact tables/columns — they mirror
   `src/lib/types.ts` 1:1 in snake_case):
   - Generic helpers: camelCase↔snake_case row mappers; `remoteUpsert(table, rows)`,
     `remoteDelete(table, id)` — fire-and-forget async with console.error on failure
     (no UI blocking); chunk arrays of >500 rows.
   - `loadAll(): Promise<DB | null>` — selects all tables, maps to the `DB` shape
     (`carts` is a Record keyed by owner — see how cart items are stored in schema,
     reconstruct the Record). Returns null on error.
2. In `src/lib/store.ts`:
   - On boot when `isSupabaseConfigured`: start with the localStorage/seed snapshot
     (no flash), call `loadAll()` async; on success replace `db`, bump version,
     persist, notify. Export `syncFromSupabase()` for manual refresh.
   - Add `export function syncWrite(fn: (db: DB) => void, remote?: () => void)` —
     or simpler: leave `mutate` alone and route call sites (next step) through small
     domain helpers in supabase.ts that call `mutate` + remote write. Pick whichever
     keeps call-site diffs smallest; do NOT restructure store.ts.
3. Route every mutation call site (21 across: Admin.tsx, Club.tsx ×5, Meets.tsx ×4,
   Judge.tsx, Membership.tsx, Profile.tsx ×2, ScoreDetail.tsx, MeetWizard.tsx,
   ClubForm.tsx, PersonForm.tsx, nationals.ts) to also perform the remote write for
   the rows it touched. Read each call site; the object(s) it creates/updates are the
   rows to upsert (registrations delete → remoteDelete). `nationals.ts` bulk-load and
   `resetDemo` are LOCAL-ONLY (do not write demo bulk data remotely automatically).
4. Seed/push tool: in the admin League Controls "Demo tools" area (find in Admin.tsx),
   add "Push local DB → Supabase" button (visible only when configured): pushes every
   table of the current local snapshot via chunked upserts, reports progress/done/error
   inline. This is how prod gets seeded (works under RLS once signed in as admin).
5. Typecheck (`node node_modules/typescript/bin/tsc -b`) + `node node_modules/vite/bin/vite.js build` must pass. Commit (do NOT push).

## Task B — Auth + realtime + deploy env

1. Replace the SHA-256 gate (Gate.tsx, store.ts isUnlocked/checkPassword, App.tsx)
   with Supabase Auth WHEN configured: email/password sign-in + sign-up tabs on the
   Gate page (UCG brand styling), session via supabase.auth.getSession() +
   onAuthStateChange; sign-out in the sidebar (Layout.tsx). When NOT configured, keep
   the existing password gate untouched (static demo fallback).
2. Realtime: wire `subscribeMeetScores` into the live results view (Results page /
   wherever scores for a meet render) — on payload, map the row to a `Score` and merge
   into the local snapshot via `mutate` (no full reload). Unsubscribe on unmount.
3. Deploy: `.github/workflows/deploy.yml` — inject `VITE_SUPABASE_URL` and
   `VITE_SUPABASE_ANON_KEY` from GitHub Actions **vars** (publishable key, safe).
   Set them with `gh variable set` (values from `.env.local`).
4. Docs: update `supabase/README.md` status (wired-in), incl. note: after first
   sign-up, grant admin in SQL editor:
   `insert into user_roles (user_id, role) select id, 'admin' from auth.users where email='nssharpe@gmail.com';`
   (adjust to actual user_roles columns in 0002_rls.sql).
5. Typecheck + build pass. Commit (do NOT push).

## Verification (coordinator, after A+B)
Browser run via `ucg-prod-preview` (port 5180): sign-up/sign-in, push seed, reload
hydrates from Supabase, create a club → row visible via REST, score entry writes,
realtime updates a second tab. Then push to main.

## Task C — Inline calculator integration (separate, after A+B verified)
Replace iframe+postMessage score-entry calculators with fully integrated UI.
Scope/design TBD in its own plan — large refactor (5 calculators incl. legacy
jQuery/Bootstrap ones bundled verbatim).
