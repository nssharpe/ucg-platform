# Data-layer architecture for scale (whats-next item 6.3)

**Status:** design spec, 2026-07-24. Supersedes the "act on the documented triggers"
posture in [`../production-readiness.md`](../production-readiness.md#architecture-watch-list-not-gaps-yet--written-down-so-they-dont-surprise-us).
Nate's call (2026-07-24): architect for live-at-scale now rather than waiting for a
trigger to fire, and build a harness that seeds 1–2 years of realistic volume so
performance can be tested before real users arrive.

## How it works today

`loadAll()` ([`src/lib/supabase.ts:2140`](../../src/lib/supabase.ts)) issues ~40
`select('*')` queries in one `Promise.all` and hydrates the entire database into a
single in-memory `DB` object. `store.ts` persists that object to `localStorage` under
`ucg-db-v1` and every page reads it synchronously (`db.registrations.filter(...)`). No
page queries the database itself.

This buys real simplicity — no spinners, no per-page fetch code, no cache invalidation,
works offline — and it is why the app feels instant after boot. It is also structurally
unable to survive real usage.

## Measured baseline (prod, 2026-07-24)

Counts via a read-only `head:true` probe as the seeded admin:

| Table | Rows |
|---|---|
| people | **2,636** |
| clubs | 223 |
| invoice_items | 69 |
| invoices | 43 |
| memberships | 39 |
| registrations | **35** |
| waiver_signatures | 30 |
| payments | 24 |
| cart_items | 10 |
| events | 6 |
| scores | **3** |
| everything else | ≤ 27, mostly 0 |

So the payload is small *today*, and none of the three documented triggers has fired.
That is the only good news here.

## MEASURED AT SCALE (2026-07-26, Phase 1) — the assumption was wrong

Seeded staging with the harness (`scripts/seed-scale.mjs`) and measured a real cold
boot in Chromium against it. **The result inverts this spec's premise.**

| | Prod today | Seeded staging |
|---|---|---|
| `registrations` | 35 | **50,130** (full 2-yr projection) |
| `scores` | 3 | **52,248** (~30% of the 2-yr projection) |
| localStorage snapshot | trivial | **28.95 MB** |
| Cold boot → persisted snapshot | — | **21.1 seconds** |
| localStorage quota error | — | **did NOT fire** |

Two corrections to what this document previously assumed:

1. **The ~5 MB localStorage cap is NOT the tripwire.** Chromium accepted a **28.95 MB**
   snapshot without raising. The "first localStorage quota error in `error_logs`"
   trigger therefore **cannot be relied on to warn us** — in Chrome it may never fire at
   all. (Safari's stricter limit likely still would, so the instrumentation stays worth
   having; it just isn't the alarm we thought.)
2. **Boot time is the real cliff, and it is already catastrophic.** 21.1 seconds from
   cold load to hydrated snapshot — on a *desktop* over broadband, with a warm dev
   server. The documented trigger is 3 s on mid-tier mobile; we are ~7× past it on
   hardware far better than the target. A phone on cell data would be multiples worse.

And this measurement is **conservative in three ways**: `scores` was only at ~30% of the
2-year projection; `people` contributed just 1 row (RLS scoped it for the signed-in dev
user) rather than the ~6k a real admin session would pull; and invoices/payments/
memberships never seeded before the run was interrupted.

**Consequence for sequencing.** Phases 2-3 (moving `scores` and `registrations` onto the
slice layer) were framed here as "act when a trigger fires". A trigger has fired — the
boot-time one — and the quota trigger we were counting on turns out to be unreliable.
This is not next-year work. It is the thing that makes the app unusable at the first
nationals-sized dataset, and it should be scheduled ahead of further polish.

*Reproduce:* `node --env-file=.env.local scripts/seed-scale.mjs` (staging-only, hard-
guarded against the prod ref), measure, then `--clean` — verified to restore staging
exactly (scores 248, registrations 130, people 84, events 4, clubs 9; zero `scale-`
rows left).

## The urgent finding: silent truncation, already latent

`fetchAllRows` ([`supabase.ts:74`](../../src/lib/supabase.ts)) exists to page past
**PostgREST's 1000-row cap**, and its own doc comment says so. It is used for exactly
one table: `people` (2,636 rows — it needed it). **Every other table in `loadAll`,
including `registrations` and `scores`, uses a bare `.select(...)` with no `.range()`
loop.** Past 1000 rows those queries silently return the first 1000 with no error.

This is not a future scaling concern, it is a correctness bug on a short fuse:

- A single nationals weekend produces roughly *athletes × apparatus* score rows —
  on the order of 4,000–8,000. The scores table blows the cap at the **first nationals**,
  and the failure mode is a Results page that quietly shows partial results.
- `registrations` follows at the first genuinely large event, or within one busy season
  in aggregate.
- Because the truncation is silent, the first symptom is a user reporting missing data,
  and the Finance dashboards computing totals off a truncated set.

**Phase 0 below fixes this independently of the rest of the architecture and should
ship first.**

## Projected volume (the seeding target)

Basis: ~223 clubs and 2,636 people today; collegiate club gymnastics; ~40 events per
season including regionals and a nationals.

| Table | 1 season | ~2 years | Est. JSON/row | 2-year payload |
|---|---|---|---|---|
| scores | ~75k | ~175k | ~250 B | **~44 MB** |
| registrations | ~25k | ~50k | ~350 B | **~17 MB** |
| invoice_items | ~12k | ~25k | ~250 B | ~6 MB |
| invoices / payments | ~8k each | ~18k each | ~300 B | ~5 MB each |
| people | — | ~6k | ~500 B | ~3 MB |
| memberships | ~5k | ~11k | ~200 B | ~2 MB |

A boot payload north of **60 MB**, against a `localStorage` quota of ~5 MB. Both the
"per-page queries for the heavy tables" path and the localStorage strategy have to
change; there is no version of the current design that survives this.

---

## Target architecture

### Tier the tables by growth shape

**Tier 1 — Reference.** Small, bounded, needed by nearly every page:
`seasons`, `levels`, `clubs`, `app_settings`, `waiver_documents`, `accounting_codes`,
`coupons` (admin-only anyway). *Keep global hydration and localStorage persistence
exactly as-is.* These never grow with usage.

**Tier 2 — Mine.** Bounded per signed-in user: my `person` row, the people I manage, my
`memberships`, my `cart_items`, my `invoices` / `invoice_items` / `payments`, my
`registrations`, my `refund_requests`. *Hydrate at boot but scoped to the caller* — RLS
already restricts most of these to the caller's own rows, so the change is mostly making
the scoping explicit rather than relying on RLS to shrink a `select('*')`. Stays small
and stays synchronous, which is what keeps My Registrations / Cart / Purchase History
simple.

**Tier 3 — Unbounded and contextual.** Never globally hydrated: `scores`,
`registrations` beyond mine, `waiver_signatures`, `event_checkins`, `competition_orders`,
`finals_lineups`, `session_requests`, `waitlist_groups`, `event_admins`,
`judge_access_codes`, `sms_messages`, `error_logs`. *Fetched per scope, on demand* —
almost always "for one event" or "for one club", which is exactly how the UI already
thinks about them.

**`people` is the special case.** 2,636 rows now, ~6k projected, and needed everywhere
for name lookups — but nearly every use is `id → display name / club / grad year`. Split
it: a **slim directory projection** (id, firstName, lastName, mainClubId, gradYear —
roughly 80 B/row, so ~500 KB at 6k people) hydrated globally, and full person rows
fetched on demand where a page actually needs the rest of the profile. This keeps every
existing name lookup synchronous, which is what makes the split cheap.

### The slice-layer CONTRACT (settled 2026-07-26 — Phases 2 and 3 both implement this)

Derived from enumerating every real consumer of `db.scores` (13 references / 10 files).
The access patterns are NOT uniform, so a single `useScope(table, key)` would be a poor
fit. Four shapes are needed, and `registrations` maps onto the same four:

1. **By event** — the dominant pattern (`scoring.ts`, `Results.tsx`, `Events.tsx`,
   `Judge.tsx`, `nationals-adapter.ts`). API: `useEventScores(eventId)` /
   `useEventRegistrations(eventId)` → `{ rows, status }`.
2. **Mine** — `Home.tsx` and `person-data.ts` filter scores by the signed-in person's
   registration ids. This is Tier 2: keep it hydrated at boot, scoped to the caller, and
   **synchronous**. That is what keeps My Registrations / Cart / Purchase History
   simple, and it is the main reason Phase 3 is survivable at all.
3. **Single record** — `ScoreDetail.tsx` looks up one score by composite id. Needs a
   direct fetch-by-id, not a whole slice.
4. **Everything** — only `pushAll` (admin Demo Tools, `RequireAdmin`). Keep an explicit
   "fetch all" used *only* there; it must never be on a normal render path.

**Two MORE shapes, found by enumerating `registrations` (2026-07-26 recon).** The
four above came from `scores`; `registrations` needs these as well:

5. **By club, cross-event.** `Home.tsx:255` filters by `clubId` with no event scope —
   it exists precisely to *discover* which events a club has touched, so no by-event
   slice can serve it. `Cart.tsx`'s `surveyGateForItems`/`earliestHoldMs` do
   `db.registrations.find(id)` on cart `refRegIds` that may point at ANY event, and the
   same code runs for each managed-club section. Both need a per-owner cross-event set.
6. **By arbitrary person, all events — NOT a slice.** `person-data.ts:97` (GDPR export)
   and `AdminMembers.tsx:49/51/161` (duplicate-athlete merge) read one *arbitrary*
   person's registrations across every event. **Serve these with a targeted direct
   fetch, never from a cache**, so completeness is guaranteed by the query rather than
   by hoping a slice is warm. `AdminMembers` is the sharpest case in the entire
   refactor: its read feeds a `mutate()` that reassigns/hard-deletes those rows and then
   deletes the person — an incomplete read silently ORPHANS registrations against a
   deleted `athleteId`. That is data corruption, not a wrong count.

**COMPLETENESS IS A CORRECTNESS CONSTRAINT, not just a UX one.** These computations are
only correct with the full by-event set present, and must gate on `status === 'ready'`
before running — never compute from a loading slice:

- **`capacity.ts`** (`checkCapacity`/`splitFit`): caps are **event-wide across every
  club**, so the caller must pass the full by-event slice, never a club-narrowed subset.
  A partial slice *undercounts usage and admits over-capacity registrations*.
- **The nationals engine** (`nationals-adapter.ts` -> decathlon/omnithon/awards/team
  finals): rank and qualification math over the whole field. A partial slice yields
  plausible but WRONG placements.
- **`pricing.ts`'s `priorDisciplineCount`** inputs (Club.tsx, Events.tsx,
  MyRegistrations.tsx): the athlete's own regs for that event must be complete or the
  fee is wrong. Satisfied by the synchronous Tier-2 "mine" cache — **provided "mine"
  stays fully hydrated and is not derived from a partial by-event slice.**
- **`Club.tsx` roster classification** (`hasActiveReg`, L1093): a partial slice makes a
  registered athlete look unregistered, inviting a manager to re-register and RE-CHARGE
  them. No visible error — the worst kind.

**Two live unguarded empty states must gain loading guards in Phase 3:**
`Events.tsx:1078` (`NationalsSummaryCard` -> "No registrations yet.") and
`EventCheckinCard.tsx:213` ("No registrations yet for this event."). Both read
`db.registrations` synchronously today, so they are harmless now and become confident
lies the moment the read goes async. The correct idiom already exists two components
away in the same file — `RosterToolsCard` uses `rows: T[] | null` with an explicit
loading branch before the empty branch. Copy it.

**Also fix while in there:** `EventCommunicate.tsx:407` memoizes on `db.registrations`
directly — the in-place `mutate()` trap that Club.tsx / MyRegistrations.tsx explicitly
guard against with comments. It is wrong today, independent of this refactor.

**`status` is mandatory and non-optional in the return type.** The single biggest hazard
in this refactor is a page that filters an unloaded slice, gets `[]`, and confidently
renders an empty state — "no scores posted yet" when the truth is "not loaded yet".
Returning `{ rows, status }` rather than a bare array makes forgetting it a type error
instead of a silent wrong answer. Every consumer must distinguish `loading` from
`ready && empty`.

**Other rules:**
- Slices are **memory-only** — never written to `localStorage`. This is what removes the
  28.95 MB snapshot measured above.
- Every slice fetch paginates via the shared `fetchAllRows` (Phase 0) so no scoped query
  can reintroduce the 1000-row truncation.
- Writes keep their current shape: `mutate()` + `push*` through the write queue. The
  optimistic local update applies to whichever slice holds the row. The in-place
  `mutate()` trap applies to slices too — read slice rows directly each render, never
  `useMemo` on a nested path.
- `scores` already has a per-event realtime channel (`scores:${eventId}`) keyed exactly
  like the slice — it becomes the slice's invalidation signal rather than a special case.
- Non-React consumers (`scoring.ts`, `nationals.ts`, `nationals-adapter.ts`,
  `person-data.ts`) must take rows as PARAMETERS rather than reaching into `db.*`
  themselves. That keeps them pure and testable, and it is the change that makes the
  React-side slice boundary honest.

### The slice layer

Add a scoped-slice cache alongside the existing store:

```
useScope('registrations', { eventId })  →  { rows, status: 'loading' | 'ready' | 'error' }
useScope('scores',        { eventId })  →  { rows, status }
```

Rules:

1. **Status is not optional.** The single biggest hazard in this refactor is a page that
   filters an unloaded slice, gets `[]`, and renders a confident empty state. Every
   consumer must distinguish `loading` from `ready && empty`. The hook returns a status
   rather than a bare array specifically so that "I forgot" is a type error, not a
   silent wrong answer.
2. **Slices are memory-only.** Never written to `localStorage`. This is what removes the
   5 MB cliff permanently.
3. **Every fetch paginates.** Generalize `fetchAllRows` into the shared fetch path so no
   scoped query can inherit the 1000-row bug.
4. **Writes are unchanged in shape.** `mutate()` + `push*` through the write queue stays
   exactly as it is; the optimistic local update applies to whichever slice holds the
   row. The in-place `mutate()` trap (CLAUDE.md) applies to slices too — read slice rows
   directly each render, never `useMemo` on a nested path.
5. **Realtime keeps working.** The existing `scores:${eventId}` channel already scopes to
   one event, which is the same key the slice uses — it becomes the slice's invalidation
   signal rather than a special case.

### What does not change

Tier 1 + Tier 2 reads stay synchronous off `db.*`, so the pages that carry the most
product logic (Cart, Membership, Profile, My Registrations) are barely touched. The
offline read-only gate, the write queue, `classifyWriteError`, and the rollback path all
keep their current semantics.

---

## Phasing

Each phase is independently shippable and independently valuable.

**Phase 0 — Stop the silent truncation. ✅ DONE 2026-07-24.** All ~34 `loadAll` table
reads now route through `fetchAllRows`, which additionally applies a deterministic
`ORDER BY` before every `.range()` call — without one, paginated reads can silently
duplicate and skip rows across page boundaries, a second latent bug the original
`people`-only pagination already carried. Sort keys live in the new pure
`src/lib/pagination.ts` (`sortKeysForTable`, unit-tested): `id` by default, with the
four composite/alternate-key tables registered explicitly (`club_managers`,
`person_alt_clubs`, `app_settings`, `coupons` — independently confirmed as exactly the
set that fails a `select('id')` probe). `registrations` keeps its explicit column list
so it doesn't request the SELECT-revoked `camp_survey`.

*Proof (staging):* `scores` 248 rows → inserted 1,500 → the OLD bare `select()`
returned **exactly 1000**, reproducing the bug; the new paginated fetch returned all
**1,748 rows with 1,748 unique ids** (no duplicates, no gaps); probe rows cleaned up.

**Phase 1 — Instrumentation + the scale-seed harness.**
- `scripts/seed-scale.mjs`: generate a target-volume dataset (default ~2-year
  projection above; `--scale` to dial it) into **staging only**, with a hard guard
  against ever pointing at the prod project ref.
- Boot instrumentation: record payload bytes and hydration duration, and catch the
  `localStorage` quota error *specifically* so it lands in `error_logs` as a named
  condition instead of a generic write failure. This is what makes the three documented
  triggers able to fire on their own.
- Then measure against the seeded staging set and record the numbers here.

**Phase 2 — Move `scores` to slices. ✅ DRAFTED 2026-07-26, branch
merged to `main` 2026-07-26.** Smallest blast radius: 13
references across 10 files, and the heaviest table by projected volume. Also the one
with realtime already scoped per event, so it validates the slice design end to end.

*What shipped on the branch:* the generic slice-layer infrastructure
(`src/lib/slice-cache.ts` — `createEventScopedSlice`, memory-only, status
transitions, realtime patch helpers, reusable as-is by Phase 3) plus the scores
instantiation (`src/lib/scores-slice.ts`) implementing all four CONTRACT shapes —
`useEventScores` (by event), `useMyScores`/`<MyScoresBoot/>` (Tier 2 "mine",
synchronous), `useScoreById` (single record), and `fetchScoresForRegIds` (admin
export — deliberately NOT the "mine" cache, since an admin can export someone
other than themselves). `loadAll` no longer fetches `scores`; `SEED_VERSION` bumped
to 8. All 10 original consumers plus the transitively-affected `Nationals.tsx`
were updated so `scoring.ts`/`nationals-adapter.ts`/`person-data.ts` take `scores`
as a parameter instead of reading `db.scores`. `nationals.ts` (demo Nationals-2026
import) and `supabase.ts`'s `pushAll` needed NO changes — both already operate on
the local, admin-populated `db.scores` (the demo/prototype "everything" store),
which is exactly the CONTRACT's shape #4 and was never on a normal render path.

*Measured (2026-07-26, scale-seeded staging, 52,748 scores):* a full paginated
fetch of the entire `scores` table — the load Phase 2 removes from every boot —
took **14.46 s** and transferred **~21.7 MB** of JSON. The replacement, a single
nationals-scale event's scores (2,442 rows) via the new per-event slice fetch,
took **~0.78 s / ~695 KB**, and is only ever paid when that event's Results/Judge/
Nationals page is actually opened. A full live end-to-end `loadAll()` boot comparison was not completed in the Phase 2
session. The implementer reported it as blocked by staging's `registrations` table
"missing its base `GRANT SELECT ... TO authenticated`" — **that diagnosis was wrong and
there is no environment gap to fix.** Verified 2026-07-26 against BOTH staging and prod,
as anon AND as an authenticated seeded user, using the app's real column list: reads
succeed everywhere.

What actually happened is the **column-revoke trap already documented in CLAUDE.md**:
`registrations.camp_survey` has SELECT revoked, so a `select('*')` (rather than the
app's explicit `REGISTRATION_COLUMNS_NO_SURVEY` list) fails — and PostgREST reports it
with misleading TABLE-level wording:

    select('*')                 -> 42501: permission denied for table registrations
    select('id, camp_survey')   -> 42501: permission denied for table registrations
    select(<app column list>)   -> ok

Reproduced directly. The error names the table, not the column, which is exactly why it
reads as a missing base grant. **No action for Nate.** When measuring, use the app's
column list.

Phase 2's component-level numbers above still stand on their own: removing the full
`scores` fetch takes ~14.46 s out of the Phase 1 baseline of 21.1 s, leaving
`registrations` as the dominant remaining cost — which is precisely what Phase 3
addresses.

**Phase 3 — Move `registrations` to slices. ✅ DRAFTED 2026-07-27, branch
merged to `main` 2026-07-26.** The big one: ~61
references across ~20 files, closed out in four staged, individually-verified
commits per file/concern group (Stage 1 infra → Stage 2 easy reads → Stage 3
money-critical writes → Stage 4 arbitrary-person fetches + loadAll removal).

*What shipped on the branch:* `src/lib/registrations-slice.ts`, reusing Phase
2's `slice-cache.ts` infrastructure completely unchanged, implementing all SIX
CONTRACT shapes (registrations needed two more than scores did — see the
CONTRACT section above): `useEventRegistrations` (by event), `useMyRegistrations`
(Tier 2 "mine", synchronous — `<MyRegistrationsBoot/>` mounted in App.tsx),
`useRegistrationById` (single record), the unchanged `db.registrations`
"everything" path (`pushAll`/`nationals.ts`, needed no changes — same
conclusion Phase 2 reached for scores), `useClubRegistrations` (by club,
cross-event — the shape scores didn't need), and `fetchRegistrationsForPerson`
(arbitrary person, direct uncached fetch — the other new shape). `loadAll` no
longer fetches `registrations`; `SEED_VERSION` bumped to 9.

Every one of the ~61 original consumers was converted, plus several more the
CONTRACT explicitly names as canonical (`Home.tsx`'s `ClubManagerCard`/
`AthleteDashboard`) or that a full post-Stage-3 sweep turned up
(`scoring.ts`'s `sessionResults`, `Results.tsx`). The COMPLETENESS section
below was written from this phase's own recon and drove three real fixes,
not just mechanical swaps:
- **Club.tsx's `hasActiveReg` roster classification** (the highest-risk read
  named below) gates the whole roster render on `status === 'ready'`.
- **A write-side twin of the completeness bug**, found in three places
  (Club.tsx's `swapAthlete`/waitlist-checkout, `MyRegistrations.tsx`'s
  retain-and-blank loop, `AdminMembers.tsx`'s duplicate-athlete merge): code
  that read `d.registrations.find(id)` to get a base row to update would
  silently no-op once `d.registrations` is permanently empty in
  Supabase-configured mode — every such site now falls back to the
  already-fetched slice/fetch row instead of trusting `d.registrations` to
  contain it.
- **A real architectural gap in `loadAll` itself**: `Event.sessions[].squads[].athleteRegIds`
  (which registration is placed in which squad) used to be built inside
  `loadAll` by cross-referencing `registrations.squad_id` — with no other
  data source. Fixed by adding `Registration.squadId` (mapped from the
  already-selected `squad_id` column) and having `SquadBuilder` (Events.tsx)
  bootstrap `athleteRegIds` from the by-event slice once, per session, via a
  `hydratedSessionIds` ref-gated effect — otherwise every previously-built
  squad would have silently rendered empty on reopen, and "Auto-split
  evenly" would have overwritten real squad_id values with a fresh random
  split on save.

*Measured (2026-07-27, scale-seeded staging: 50,130 registrations, 175,000
scores — the fullest seed run yet, not the ~30% partial run Phase 2 measured
against):* a full paginated fetch of the entire `registrations` table — the
load Phase 3 removes from every boot — took **22.9 s** and transferred
**~24.7 MB** of JSON. The replacement, the largest single scale-seeded
event's registrations (674 rows) via the new per-event slice fetch, took
**~0.4 s / ~200 KB**, paid only when that event's page is opened.

A full live end-to-end `loadAll()` boot comparison was blocked again, this
time by a genuinely NEW finding (not a misdiagnosis like Phase 2's): once
`memberships`/`invoices`/`invoice_items` hold 10k+ rows, ANON/AUTHENTICATED
queries against them fail with `500` / "canceling statement due to statement
timeout" — reproduced directly, and confirmed NOT a missing grant: a
service-role client queries the same tables fine (12,498 memberships, no
error). This reads like an expensive RLS policy (a per-row subquery/join)
that nothing has exercised at this scale before now. **Untouched by the
Phase 3 diff** (Phase 3 never reads either table) — a real, separate
production risk worth investigating before a real nationals season
accumulates 10k+ memberships/invoices, but out of scope for this phase.
`docs/whats-next.md` carries the follow-up.

*Reproduce/clean:* same `scripts/seed-scale.mjs` harness as Phase 1 — this
run hit two transient `fetch failed`/`statement timeout` errors mid-seed and
mid-clean respectively; both resolved on a plain re-run (the script's
upserts are idempotent per the header comment). Verified restored to the
documented baseline after `--clean`: scores 248, registrations 130, people
84, events 4, clubs 9.

**Phase 4 — Slim the `people` directory projection**, with full rows on demand.

**Phase 5 — Restrict what persists to `localStorage`** to Tier 1 + Tier 2, and bump
`SEED_VERSION` so stale full-fat snapshots are discarded rather than loaded.

## Verification requirements

- Every phase: `npm run build`, `npx eslint <touched>`, `npx vitest run`.
- Phases 2–4 additionally: exercise the affected pages against the **scale-seeded
  staging** dataset, not the small prod-like set — the whole point is that correctness
  bugs here only appear above the row cap. Confirm no page renders a confident empty
  state while its slice is still loading.
- Phase 0: prove the fix by seeding >1000 rows in one table on staging and confirming
  the client sees all of them (this is the regression test for the bug).
