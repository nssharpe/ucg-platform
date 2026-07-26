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

**Phase 2 — Move `scores` to slices.** Smallest blast radius: 13 references across 10
files, and the heaviest table by projected volume. Also the one with realtime already
scoped per event, so it validates the slice design end to end.

**Phase 3 — Move `registrations` to slices.** The big one: 60 references across 20
files. Tier 2 keeps "my registrations" synchronous, so the work concentrates in the
event/club-scoped surfaces (Club, Events, host dashboards, nationals components).

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
