---
paths:
  - "src/lib/store.ts"
  - "src/lib/supabase.ts"
  - "src/lib/*-slice.ts"
  - "src/lib/slice-cache.ts"
  - "src/lib/pagination.ts"
  - "src/lib/person-data.ts"
  - "src/lib/types.ts"
  - "src/lib/toast-bus.ts"
---

# Data layer: slices, store mutation, write queue

Full writeup and every phase's measurements: `docs/specs/2026-07-24-data-layer-scale.md`.
Phases 0–5 of the data-layer-scale project ALL SHIPPED (last 2026-07-28). `SEED_VERSION` is 10.

## The slice layer

`scores`, `registrations`, and `people` are no longer globally hydrated. `db.scores` and
`db.registrations` exist only for unconfigured/demo mode, and `db.people` at boot is scoped to
self + managed-club rosters only (Phase 4 is a which-ROWS-load split, not a slim/full field
split — **every row returned is always complete**).

| Data | Read it via |
| --- | --- |
| scores | `useEventScores(eventId)` / `useMyScores()` / `useScoreById()` (`scores-slice.ts`) |
| registrations | `useEventRegistrations(eventId)` / `useMyRegistrations()` / `useRegistrationById()` / `useClubRegistrations(clubId)` / `fetchRegistrationsForPerson(personId)` (`registrations-slice.ts`) |
| people (thin name+club, works for ANONYMOUS callers via `public_competitors`) | `usePeopleNames(ids)` |
| people (full rows) | `usePeopleForIds(ids)` / `usePeopleForClub(clubId)` / `useAdminPeople()` (league-wide, admin-only) / `usePersonAdmin(personId)` / `fetchPersonRemote(personId)` (uncached, for a destructive write) |

All built on the shared generic `src/lib/slice-cache.ts`. Slices are **memory-only** (never
localStorage).

**Hooks return `{ rows, status }` and `status` is non-optional on purpose.** Never render an
empty state without checking `status === 'loading'` first, or you turn "not loaded" into a
confident "none exist". `Club.tsx`'s roster `hasActiveReg` classification is the sharpest
example: a partial read there invites re-registering — and re-charging — an already-registered
athlete.

Pure modules take rows as **PARAMETERS** (`scoring.ts`, `nationals-adapter.ts`,
`person-data.ts`, `cart-sync.ts`).

`fetchRegistrationsForPerson` / `fetchPersonRemote` / `person-data.ts` / `AdminMembers.tsx`'s
merge deliberately do a targeted DIRECT fetch for an arbitrary (non-signed-in-caller)
person/registration set rather than reading any cache — completeness there must come from the
query, since an incomplete read feeds a write that can orphan or corrupt data.

## localStorage persistence (Phase 5)

Restricted to Tier 1 reference data + small Tier 2 caller data (`PERSISTED_KEYS` in
`src/lib/store.ts`) when Supabase-backed. Everything else reconstructs empty and refills from the
`syncFromSupabase()` that always follows boot. Demo/unconfigured mode still persists the whole
`db` (no server to re-sync from).

Measured 2026-07-28 at 0.5× scale: persisted snapshot **28.95 MB → ~53 KB**; persisted `people`
count **1 row** (self) regardless of league size.

## In-place mutation trap

`mutate()` (`store.ts`) mutates the shared `db` object **in place** — a `useMemo`/`useEffect`
keyed on a nested `db.*` path NEVER sees local mutations (only a full `syncFromSupabase()`
reload reassigns). **Read `db.*` directly each render**, and audit for this trap when touching
store consumers.

## `mutate()` returns `boolean` — guard on it

When Supabase is configured and the browser is offline, `mutate()` REFUSES the write (toasts,
returns `false`) so local state never diverges from a queue that isn't accepting new work.

**Any call site whose continuation presumes success — a success toast, modal close, navigate, or
a `push*` OUTSIDE the callback — MUST guard on the return value.** Every existing site was swept
2026-07-17.

Write-queue side: `classifyWriteError` makes RLS/integrity/auth failures `'permanent'` (no
retry; boot-wired toast + drain-then-`syncFromSupabase()` rollback in `supabase.ts`). Non-React
code toasts via `pushToast` (`lib/toast-bus.ts`), the imperative escape hatch into the same
ToastProvider.

## Toasts

`useToast()(msg, { variant?: 'info'|'error', persist? })` — use `{ variant: 'error' }` for
failures (persist until closed).

## PDFs

Client-side (jsPDF), on demand — waiver proof, receipts, cart invoice. No server PDF or storage;
regenerate from data.

## Scale seeding

`node --env-file=.env.local scripts/seed-scale.mjs` seeds a 2-year-projection dataset into
**STAGING ONLY** (hard-guarded against the prod ref; every row id prefixed `scale-`; `--clean`
removes exactly those). Occasionally hits a transient `fetch failed`/`statement timeout` mid-run;
the script's upserts are idempotent, so just re-run.

⚠ 2026-07-28: staging's scaled tables were found already at 0 rows before seeding, so the
documented Playwright E2E fixture baseline is not currently present. 👤 Nate should reseed before
relying on `npm run test:e2e` against staging.
