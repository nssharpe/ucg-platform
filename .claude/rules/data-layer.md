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

**`syncFromSupabase()` does NOT refresh registrations/scores/people slices** — it's `loadAll()`,
which excludes exactly the tables this section moved off global hydration. A write whose ONLY
client-visible effect is a slice-scoped row changing state server-side (a payment webhook/
free-order fulfillment flipping a registration `paid`, for instance) is invisible until the
relevant slice is explicitly invalidated. This bit UAT M-12-02 (`2026-08-22`): `Cart.tsx`'s
`onPaid` called `syncFromSupabase()` and nothing else, so a just-paid registration kept reading
"Pending Purchase" until a hard reload (which resets the module-level slice caches, forcing a
refetch). `registrations-slice.ts` now exports `invalidateMyRegistrations()` /
`invalidateClubRegistrations(clubId)` / `invalidateEventRegistrations(eventId)` (force a refetch
bypassing the "mine" tier's same-person no-op guard / wrapping the by-club/by-event slices'
`invalidate`) — call the scope-appropriate one(s) after ANY write that changes a registration's
state without going through `writeRegistration`'s own optimistic
`applyLocalRegistrationUpsert`.

**M-12-02's fix had its own gap (UAT M-12-03, `2026-08-27`): don't derive WHICH scope key to
invalidate by looking a row up in a slice that might itself be incomplete.** `Cart.tsx`'s
`onPaid` computed which event ids to `invalidateEventRegistrations()` by walking each
just-paid item's `refRegIds` through `regs.find(...)` (the by-club/"mine" slice) and silently
dropping any id not found — harmless for a personal checkout (`invalidateMyRegistrations()` is
also called unconditionally, and `MyRegistrations.tsx` reads that same "mine" tier directly), but
`Club.tsx`'s `EventRegGrid` reads ONLY the by-event slice with no such fallback, so a `regs` set
that's momentarily incomplete right at checkout completion left the by-event invalidation
silently skipped — permanently stale until a hard reload. Fixed by unioning in
`eventIdsForCartItems` (`pricing.ts`), which derives the same ids from the cart items' labels
alone, with no registration-slice dependency at all. **The general lesson:** when a write's
invalidation target is derived by looking a row up in ANOTHER cache (rather than being known
directly, e.g. from the write's own payload), prefer a derivation with no cache dependency, or at
least union one in — a lookup-based derivation can silently under-invalidate exactly when the
looked-up cache is least trustworthy.

All built on the shared generic `src/lib/slice-cache.ts`. Slices are **memory-only** (never
localStorage).

**`mutate()` never reaches a slice.** A page that renders a slice (Profile.tsx adminView renders
`usePersonAdmin` + `useMembershipsForPerson`) shows nothing from a `mutate()` that patches
`db.people` — and the administered person is usually not in `db.people` at all (UAT 2026-09-06:
Activate crashed on `d.people.find(...)!`, Save looked unsaved). After a local write whose
result a slice displays, patch that slice: `applyLocalPersonAdminUpsert(p)`
(`people-admin-slice.ts`), `applyLocalPersonMembershipUpsert(personId, m)`
(`memberships-admin-slice.ts`), or the registrations equivalents. Prefer these optimistic
patches over `invalidate*()` right after a `push*` — the push is a fire-and-forget queue enqueue,
so an immediate refetch can read the pre-write row.

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

## Permanent write failures must purge what they failed to write

`handlePermanentWriteFailure` (supabase.ts) purges failed `registrations` upsert rows from the
legacy array AND invalidates the slice tiers. The naive "resync everything" recovery does NOT
work for slice-tiered tables — `syncFromSupabase` no longer covers them, so a locally-inserted
row whose server write failed permanently survives as a phantom (UAT RT-01 2026-08-27: made the
next save classify as a change-fee edit and orphaned cart lines that 409'd checkout). A table
moved off the boot sync must get the same treatment here.

Client `''` sentinels never reach FK columns: `registrationToRow` maps `clubId || null` — the
empty-string "independent" sentinel is a CLIENT convention only (same trap class as the
`paid_via` nullable note in registrations-and-camps.md).
