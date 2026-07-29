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

## THE ACTUAL GOAL (Nate, 2026-07-28) — perceived speed, not payload size

Important context that reframes this whole spec. The original "hydrate everything at
boot" design was a deliberate attempt at **McMaster-Carr-style instant navigation** —
the platform UCG is replacing is painfully slow to use, and that is the problem being
solved. Payload size and boot time are proxies; **"does clicking around feel instant"
is the real success metric.**

Worth being clear about what McMaster actually does, because it is nearly the opposite
of what this app was doing: server-rendered HTML, **small** per-page payloads,
aggressive CDN + service-worker caching, and — the key trick — **prefetching the next
page on hover/intent**, so the content is already in the browser by the time you click.
It never ships the whole catalogue to the client. Loading 29 MB up front is the
antithesis of that approach, and a 21-second first load is the worst possible outcome
for perceived speed.

So the slice work in Phases 2-3 moves this app *toward* McMaster's model, not away from
it. But it comes with an honest tradeoff that must be tracked:

> **Boot got much faster; navigation got slightly slower.** Opening a Results page used
> to be ~0 ms (already in memory) and now costs a measured **~0.78 s** at nationals
> scale. Good trade overall — nobody tolerates a 21 s boot — but it is a regression on
> the exact axis the project cares about, and it is only fully repaid by prefetching.

**Consequence: a perceived-speed phase belongs in this plan and was never scoped.**
The slice layer makes it cheap, and in fact only became *possible* because of it —
`slice-cache.ts` already exposes `ensure(key)`, which starts a fetch without rendering
anything. Before the slice layer there was nothing to prefetch: data was either all
loaded or not loaded.

- **Prefetch on hover/focus** for event / results / club links — highest value, ~a line
  per link. Every new on-demand fetch should route through `ensure()` so it stays
  startable independently of a component mounting; do not foreclose this.
- **Service-worker caching** of the app shell (the PWA already exists).
- **Skeletons / keep-previous-content**, never a blank panel. A page that flashes empty
  on every visit reads as *slower* than the thing being replaced, whatever the numbers
  say.
- **Measure navigation timing and LCP**, not just cold boot. The current scoreboard is
  incomplete: boot is well measured, click-to-content is not measured at all.

Two constraints this implies elsewhere:
1. **The hosting move is a prerequisite for part of this.** Proper CDN caching and HTML
   prefetching do not work under GitHub Pages with a HashRouter — see whats-next §2.4
   (Cloudflare Pages + `BrowserRouter`). Full server-rendering would be a re-platform
   (Next.js/Remix) and is NOT recommended at ~6 months to launch; prefetching data in
   the current SPA captures most of the benefit at a fraction of the risk.
2. **Phase 5 must keep persisting Tier 1 to `localStorage`.** Instant first paint on a
   repeat visit is the one genuinely McMaster-ish property this app already has;
   dropping it wholesale would work against the goal.

### Phase 4 is REWRITTEN on the strength of this (2026-07-28)

The original Phase 4 — split every person into a slim row plus on-demand full rows — is
superseded. The 2026-07-26 recon found the proposed subset wrong in both directions
(`gradYear`, the field the spec named, has **zero** standalone uses; `altClubIds`, which
it excluded, is read at 9 ordinary sites), and the split's danger list runs through
membership *pricing*, synchro eligibility, and nationals categorization.

The Tier-2 insight applies instead: **scope which people load, rather than splitting
every person into partial rows.** A club manager needs their roster; an athlete needs
the names at their event; an admin fetches league-wide on demand. Same payload win, no
"which fields belong in slim?" problem, and it sidesteps the entire danger list — every
row you get is a complete row.

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

> **STATUS (2026-07-28): `memberships` / `invoices` / `invoice_items` are still
> UNSCOPED in `loadAll`** — this paragraph's fix was written down 2026-07-24 but never
> built for these three tables, and that's exactly the hole whats-next §7 describes:
> under RLS, an unfiltered `select('*')` still costs the DB O(table size), because the
> planner must evaluate the row-security predicate against every row to know what the
> caller may see — no rewrite of the predicate's *shape* changes that big-O, only
> narrowing the *query* does (an indexed `.eq('person_id', ...)`-style filter lets the
> planner touch a handful of rows instead of the whole table). A same-day investigation
> tried the predicate-shape route anyway (wrapping the cross-table subqueries in
> `memberships`/`invoice_items`'s RLS policies in SECURITY DEFINER helper functions,
> matching the existing `manages_club()`/`my_person_id()` pattern) and it was
> **measured and rejected**: at 0.5×-projected scale, `memberships` came back
> statistically unchanged (~5.0–5.3s either way) and `invoice_items` got measurably
> **worse** (7.4s → 11.4s). Root cause: Postgres can hash-materialize a raw correlated
> `EXISTS` subquery into a single semi-join pass over the referenced table (confirmed
> via a `hashed SubPlan` node in the plan), but a SECURITY DEFINER function call is
> opaque to the planner and can never be hashed that way — it pays its own per-call
> cost (~0.9ms measured) on every row of an unfiltered scan, which loses to the
> hashed-subquery plan once the referenced table's own policy stack isn't already the
> dominant cost. **Do not re-attempt a policy-rewrite fix for this — the fix is
> implementing the scoping this paragraph already specifies**: explicit
> caller-scoped filters on `memberships` / `invoices` / `invoice_items` in `loadAll`
> (self rows + the caller's managed-club ids, mirroring what RLS already permits —
> same shape as the Tier 3 slice work Phases 2–3 did for `scores`/`registrations`, just
> staying synchronous/hydrated-at-boot per Tier 2's definition rather than moving to
> on-demand slices). Full data + the surviving hygiene fix (duplicate-SELECT-policy /
> `for all`-grants-DELETE cleanup, kept because it's correctness-independent of the
> scale question) are in `supabase/README.md`'s entry for
> `20260728015930_tier2_rls_policy_cost.sql` and `docs/whats-next.md` §7.
>
> **UPDATE (branch `perf/tier2-scoped-loadall`, drafted 2026-07-28): the scoping
> above is now BUILT.** `loadAll` resolves the caller's person id (via
> `supabase.auth.getSession()` matched against the already-fetched `people` rows)
> and managed-club ids (from `club_managers`, mirroring `manages_club()`) BEFORE
> issuing the memberships/invoices/invoice_items reads, then scopes each:
> `memberships` by `person_id IN (self + managed-club rosters)`; `invoices` by two
> merged queries (`athlete_id = self` OR `club_id IN (managed clubs)` -- a single
> `.in()`/`.eq()` can't express an OR across two different columns); `invoice_items`
> by `invoice_id IN (those invoices' ids)`, sequenced after the invoices query
> resolves. No authorization change -- every non-privileged caller gets exactly the
> rows RLS already permitted them; anon boot skips these three fetches entirely
> when the scope is empty (zero network calls, strictly better than before).
>
> **Privileged league-wide consumers convert to on-demand fetches (CONTRACT shape
> #4/#6), not boot data:** `Finance.tsx`/`RefundReview.tsx` (money surfaces --
> gate every total on `status === 'ready'`), `AdminClubs.tsx`/`Communicate.tsx`'s
> audience filter/`Home.tsx`'s admin dashboard (league-wide memberships),
> `AdminMembers.tsx`'s merge modal (arbitrary-person memberships, fetched fresh --
> never cached -- right before the destructive merge, same rule as its existing
> registrations fetch), `Profile.tsx` adminView (a per-person memberships slice,
> since this is a view/edit page where caching is a genuine win), `Club.tsx`'s
> Roster/EventRegGrid (a by-club slice -- Club.tsx is reachable by ANY signed-in
> account for ANY club, and an admin's `canManage` is true everywhere, so an
> admin viewing a club they don't personally manage needs this too), and
> `person-data.ts`'s GDPR export (`invoices` now a parameter, same shape as its
> existing `scores`/`registrations` parameters). New code: `invoices-admin-slice.ts`,
> `memberships-admin-slice.ts` (three shapes: league-wide, by-person, by-club),
> plus `fetchMembershipsForPersonRemote`/`fetchMembershipsForPersonIdsRemote`/
> `fetchAllMembershipsAdminRemote`/`fetchInvoicesForPersonRemote`/
> `fetchAllInvoicesAdminRemote`/`buildInvoicesFromRows` in `supabase.ts`. All new
> "everything"/by-person/by-club fetches route through the shared slice-cache
> infra (`ensure`/`useScope`) so a future prefetch-on-hover can start a fetch
> without a component mounting.
>
> **Measured (2026-07-28, scale-seeded staging at 0.5x, real club-manager JWT,
> `VITE_DEV_AUTH_MANAGER_*` against `xogpiksqtkayxwmczlbx`):** with the manager
> additionally granted a scale-seeded club (188 visible memberships, 95 invoices,
> 115 invoice_items -- a real, non-trivial result set, not an empty one) --
> `memberships` **455ms**, `invoices` **277ms**, `invoice_items` **365ms**, against
> this same doc's baseline of `memberships` ~5.3s / `invoices` ~5.5s /
> `invoice_items` ~7.4s for the old unfiltered read at the same table sizes
> (5500/9000/12500 rows respectively) -- roughly a 10-20x improvement, and all
> three comfortably clear of the `statement timeout` that the unfiltered reads hit
> at this scale. Reproduced/cleaned via the same `seed-scale.mjs` harness;
> staging verified restored to the documented fixture baseline after `--clean`
> (memberships 70, invoices 14, invoice_items 14, people 84, registrations 130,
> scores 248, events 4, clubs 9).

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

**Phase 4 — Scope which people load. ✅ SHIPPED 2026-07-28, branch
`perf/6-3-phase4-5-people-scoping`.** Rewritten from the original "slim
projection + full rows on demand" design (see "Phase 4 is REWRITTEN" above) —
every person row is COMPLETE, just fewer of them load. loadAll's boot read
is now scoped to self + managed-club rosters (two narrow queries: a
`.eq('auth_user_id', ...)` self lookup, then `.in('main_club_id',
managedClubIds)` for the roster), mirroring the Tier 2 memberships/invoices
scoping exactly. Five on-demand shapes cover everything outside that scope:

- `fetchPersonRemote` / `usePersonAdmin` (people-admin-slice.ts) — one
  arbitrary person, full row. Uncached for a destructive write (AdminMembers'
  duplicate-athlete merge, alongside its existing fresh registrations/
  memberships re-fetch) or a one-off export (person-data.ts's GDPR export,
  which gained a `person` parameter the same way it already had `scores`/
  `registrations`/`invoices`); cached via `usePersonAdmin` for a view/edit
  page (Profile.tsx adminView).
- `fetchPeopleForClubRemote` / `usePeopleForClub` — one club's full roster
  (mainClubId OR alt-club affiliation), for a viewer who doesn't personally
  manage that club (Club.tsx — the biggest single consumer, 19 sites — falls
  back to boot-scoped `db.people` while loading so a real manager's own club
  still paints instantly).
- `fetchAllPeopleAdminRemote` / `useAdminPeople` — league-wide, admin-only
  (AdminMembers, AdminClubs, Communicate's audience/`audienceCount`, Home's
  admin dashboard, UserRoles, Sanction, ClubForm's manager picker).
- `fetchPeopleForIdsRemote` / `usePeopleForIds` (people-admin-slice.ts) —
  full-row by-ids batch for consumers needing more than name+club: nationals
  categorization (gender/placement/studentStatus — `nationals-adapter.ts`'s
  `buildEntries` gained a `people` parameter the same way Phase 3 added
  `allEventRegs`), the registration-workbook CSV export
  (shirt/dietary/email/phone/emergency), `NationalsSummaryCard`'s
  `independentCount` stat.
- `fetchPublicPeopleForIdsRemote` / `usePeopleNames` (people-slice.ts) — thin
  name+club batch (`CompetitorRef`), backed by the `public_competitors` VIEW
  rather than the `people` table, for pure name-display consumers (Results,
  Judge, ScoreDetail, EventCheckinCard, CompetitionOrderCard,
  FinalsLineupEditor, CapacityConflictDialog). Also `fetchAllPublicCompetitorsRemote`
  / `useAllCompetitors` — the same view, full-table, for Clubs.tsx's public
  directory (member counts + manager names across every club, reachable by
  ANY signed-in account, not just admin).

**A real, pre-existing bug found and fixed as a side effect of building the
by-ids shape correctly.** `people`'s only SELECT policy is
`people_self_read` (self OR `is_admin()` OR `manages_club(main_club_id)`) —
there is no policy granting visibility into an arbitrary other club's
roster. `public_competitors` (migration `20260601000004`, `security_invoker
= false`) exists specifically so, per its own top-of-file comment, "the
live-results & meet pages work with no login" — but the app never actually
queried it; every read went through the real `people` table instead.
**Verified empirically (2026-07-28) against live prod as a genuine anonymous
session:** an anon visitor's persisted `db.people` was `[]`, meaning the
public, no-login Results page showed blank athlete names for every visitor
who wasn't signed in. Confirmed fixed post-Phase-4 against scale-seeded
staging: an anonymous session (`db.people` length 0, confirmed via
localStorage) opening a Results page with real scale-seeded scores showed
correct cross-club names ("Diego Wright — Cap City", "Jonah Bauer — Texas
A&M", etc.) via the new `public_competitors`-backed shape.

**Danger list, all verified:**
- `caps.person` stays a complete row for the signed-in caller (self is
  always in boot scope by construction — `capabilities-core.ts`/
  `capabilities.ts` needed no changes). Membership pricing
  (`Membership.tsx`'s `priceForTypes(season, types, me.memberships)`) still
  reads off it directly.
- Synchro-partner eligibility (`RegistrationEditor.tsx`'s `partnerOptions`)
  keeps drawing candidates from the caller's boot-scoped roster
  (`allAthletes`, passed by Club.tsx/Events.tsx/MyRegistrations.tsx) — the
  recon's own conclusion that this narrowing is acceptable (not a
  regression) held up; those callers' `allAthletes` prop was left
  unconverted by design.
- Nationals categorization gets the full event field's people via
  `usePeopleForIds`, gated on `status === 'ready'` alongside the existing
  `allEventRegs` gate.
- Counts (`Home`'s active-member stats, `Club`'s `rosterSize`,
  `AdminMembers`' `{rows.length} people`, `Communicate`'s `audienceCount`,
  `AdminClubs`' per-club Roster/Active, `NationalsSummaryCard`'s
  `independentCount`) all gate on the relevant fetch's `status === 'ready'`
  — verified live against prod (2,636 people, 223 clubs): AdminMembers
  showed "2636 people", AdminClubs showed real per-club roster/active
  counts, Communicate's audience count read "2633" recipients when
  filtering to Athletes.

**What still persists to localStorage:** see Phase 5 below.

**Phase 5 — Restrict what persists to `localStorage`. ✅ SHIPPED 2026-07-28,
same branch.** Only `PERSISTED_KEYS` (`src/lib/store.ts`) survive to
localStorage when Supabase-backed: Tier 1 reference data (`seasons`,
`levels`, `clubs`, `coupons`, `waiverDocuments`, `accountingCodes`,
`regionOverrides`) plus Tier 2 caller-scoped data now kept small by Phase 4
(`people`, `invoices`, `carts`). `events` is added alongside Tier 1 even
though the original tiering table above didn't list it — it's just as
bounded as clubs and just as central to first paint (Home/the Events
index/Results index all read it synchronously on the very first render), so
dropping it would have cost the "instant first paint on a repeat visit"
property the spec's "THE ACTUAL GOAL" section says to keep. Every other
collection (every Tier 3 table — `clubRequests`, `sanctionRequests`,
`waiverSignatures`, `payments`, `refundRequests`, `waitlistGroups`,
`sessionRequests`, `competitionOrders`, `finalsLineups`, `eventCheckins`,
`eventAdmins`, `accountInvites`, `sanctionVotes`, `clubMemberships`,
`hostPayouts`, `judgeAccessCodes`, plus `registrations`/`scores` which were
already memory-only via the slice layer) is reconstructed empty/undefined on
load and refilled by the `syncFromSupabase()` call that unconditionally
follows boot — normally within a few seconds. Demo/unconfigured mode
(the password-gate prototype) is unchanged — persists the whole `db`, since
there's no server there to re-sync from. Cross-tab sync now **merges** the
incoming persisted subset onto the receiving tab's existing in-memory `db`
(`{ ...db, ...parsed.db }`) instead of replacing it outright, so a
multi-tab session doesn't have its already-fetched Tier 3 collections wiped
to `undefined` by another tab's write. `SEED_VERSION` bumped to 10.

*Measured (2026-07-28, scale-seeded staging at 0.5×: 3,000 people, 30 clubs,
40 events, 25,000 registrations, 87,500 scores, 5,500 memberships, 9,000
invoices, 12,500 invoice_items, 9,000 payments):*

| | Pre-Phase-4/5 baseline (measured 2026-07-26) | Post-Phase-4/5 (measured 2026-07-28) |
|---|---|---|
| Persisted snapshot | 28.95 MB | **~52–53 KB** (~550× smaller) |
| Persisted `people` count | 1 row (RLS-scoped to the signed-in dev user in that run) | **1 row** (self only — confirmed via a real club-manager session; league-wide admin surfaces fetch on demand instead, never persisted) |
| Persisted keys | everything | `seasons, levels, clubs, events, coupons, people, invoices, carts` (confirmed via direct localStorage inspection) |
| localStorage quota error | did not fire | still not the alarm — payload is now trivially small regardless |

Cold-boot `syncFromSupabase()` hydration at this scale took 2.4–7.9 s across
several runs (dominated by the tables Phase 4/5 didn't touch — `payments` at
9,000 unscoped rows especially; `memberships`/`invoices`/`invoice_items`
stay fast per the Tier 2 measurement above). This is a real remaining cost,
separate from the 28.95 MB persisted-snapshot problem Phase 5 removes and
the people-query-cost problem Phase 4 removes — `docs/whats-next.md`
carries the follow-up (the same "500/statement-timeout at 10k+ rows" finding
flagged under Phase 3 covers `payments` too, not just
memberships/invoices/invoice_items).

*Reproduce/clean:* same `scripts/seed-scale.mjs` harness. This run found
staging's row counts were already 0 across every scaled table BEFORE
seeding. NOTE (verified after the run): the conclusion drawn from this — that the
Playwright E2E fixture baseline was missing — was WRONG. Staging measured at the
documented baseline exactly (memberships 70, invoices 14, invoice_items 14, people 84,
registrations 130, scores 248, events 4, clubs 9) with zero `scale-` rows left. The
seed->clean cycle

## Verification requirements

- Every phase: `npm run build`, `npx eslint <touched>`, `npx vitest run`.
- Phases 2–4 additionally: exercise the affected pages against the **scale-seeded
  staging** dataset, not the small prod-like set — the whole point is that correctness
  bugs here only appear above the row cap. Confirm no page renders a confident empty
  state while its slice is still loading.
- Phase 0: prove the fix by seeding >1000 rows in one table on staging and confirming
  the client sees all of them (this is the regression test for the bug).

## Status: Phases 0–5 all shipped (2026-07-28)

The core data-layer-scale work described in this spec is complete: the silent-truncation
bug is fixed (Phase 0), `scores`/`registrations`/`people` all moved off unconditional
global hydration onto scoped boot reads + on-demand fetches (Phases 2–4), and
localStorage persistence is restricted to Tier 1 + small Tier 2 (Phase 5). Remaining
follow-ups, tracked in `docs/whats-next.md`: the perceived-speed phase (prefetch-on-hover,
service-worker caching, navigation-timing measurement — deliberately out of scope here,
see "THE ACTUAL GOAL" above) and the `payments`/`memberships`/`invoice_items`
statement-timeout-at-scale finding for tables this spec's phases didn't scope.
