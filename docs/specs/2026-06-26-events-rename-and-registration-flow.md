# Events rename + registration→cart flow + duplicate-key fix

**Date:** 2026-06-26
**Status:** Approved (brainstormed with Nate 2026-06-26)
**Scope:** Three related feedback items, sequenced as three atomic phases.

## Background

Feedback batch (Nate, 2026-06-26):

1. Rename the **"Meets"** page to **"Events"** (it will encompass camps/retreats,
   clinics, etc., not just competitions). New subtitle. Restructure the page like
   **My Registrations**: two tabs (Upcoming / Past) + a sortable, searchable table.
   Keep the "+ Sanction new meet" button but Title Case it.
2. When registering for a meet, the add-on step has **"Continue to cart"** and
   **"Skip add-ons"**. Remove "Skip add-ons" (selecting nothing already *is*
   skipping). "Continue to cart" should **save and navigate to `#/cart`**, not just
   close the modal in place. The no-add-on path should also land on `#/cart`.
3. Going to the cart raised: *"1 change didn't save … duplicate key value violates
   unique constraint `invoice_items_pkey`."*

During brainstorming, Nate expanded item 1: the rename should go **all the way** —
the data model (`Meet`→`Event`), the database (tables/columns), and the Edge
Functions — for full consistency rather than carrying the debt. Because the word
**"events"** is already used for gymnastics **apparatus** (`registration.events`,
the `EVENTS` constant, `score.event`), apparatus is renamed to **`apparatus`** in the
same pass so "event" unambiguously means a competition/camp/clinic.

## Root-cause analysis — the duplicate-key bug

`SelfRegModal.persistRegs` (`src/pages/Meets.tsx`) creates a **fresh invoice on every
registration** with `items: [...cart]` — the *entire* current cart, not just the
newly added lines — and `invoiceItemToRow` reuses each **cart-item id as the
`invoice_items` primary key** (`invoice_items.id` is a single-column PK). Register for
a second meet and an earlier cart item is re-inserted under a new invoice id →
`duplicate key value violates unique constraint "invoice_items_pkey"`. The write-queue
retry surfaces the *"1 change didn't save"* toast.

Since the Stripe webhook now writes the authoritative paid invoice on fulfillment
(Phase S4), this client-side invoice stub is **legacy and harmful**. Fix = delete the
stub-creation block (confirm nothing reads it first; the cart is the pre-payment
source of truth).

## Naming decisions (locked)

- **Entity:** `Meet` → `Event` everywhere (types, components, vars, routes, UI, DB,
  Edge Functions).
- **Apparatus:** `events` → `apparatus` everywhere (`registration.events` →
  `registration.apparatus`, `EVENTS` → `APPARATUS`, `score.event` → `score.apparatus`,
  scoring engine + tests + DB columns).
- **Routes:** `/meets*` → `/events*`, with `/meets*` kept as `<Navigate replace>`
  redirects so existing `#/meets/<slug>` links survive.
- **Sanction button:** "+ Sanction new meet" → **"+ Sanction New Event"** (admin-only,
  unchanged behavior).

The DOM global `Event` type is **not** used anywhere in `src` (verified), so defining
a TS `Event` type is acceptable. After both renames, `registrations` has `event_id`
(competition FK) + `apparatus` (apparatus list) with no residual confusion.

---

## Phase 1 — Registration→cart flow + duplicate-key fix

Small, ships the reported pain first, on the current (pre-rename) code.

**Files:** `src/pages/Meets.tsx` (`SelfRegModal`).

1. **Remove "Skip add-ons".** The add-on step keeps only **"Continue to cart"**.
2. **Navigate to cart.** `persistRegs` accepts/performs a `navigate('/cart')` after a
   successful save. Both the add-on path (`handleAddons` → `persistRegs`) and the
   no-add-on path (`handleRegSave` → `persistRegs` when `!hasAddons`) land on `#/cart`.
   Use `useNavigate()` from react-router.
3. **Delete the client-side invoice stub.** Remove the `d.invoices.push(invoice)` /
   `pushInvoice(invoice)` block in `persistRegs` (the one that bundles `[...cart]`).
   Verify no reader depends on these self-created stubs (search for consumers of
   `invoices` filtered by `athleteId` with `paidAt === null`); the cart remains the
   pre-payment source of truth and Stripe writes the real invoice on fulfillment.
4. Update the add-on step subtext (no more "Skip any you don't want" referencing a
   button that's gone) — leaving a field blank omits that add-on.

**Verify:** build + eslint(touched) + vitest; exercise self-registration via dev
auto-login (athlete) for an add-on meet and a no-add-on meet — confirm it lands on
`#/cart` with the lines present and **no duplicate-key toast** after registering for a
second meet.

---

## Phase 2 — The Rename (atomic merge)

DB + Edge Functions + app + routes must land together or production breaks.

### 2a. Database migration

One migration (`supabase migration new rename_meets_to_events`). All renames preserve
FKs / RLS policies / realtime membership because Postgres stores dependents by OID;
only object *names* change. Policy **names** are renamed for cosmetic consistency.

- Tables: `meets` → `events`, `meet_sessions` → `event_sessions`.
- Columns `meet_id` → `event_id`: `event_sessions`, `registrations`, `scores`.
- `registrations.events` → `registrations.apparatus`.
- `scores.event` → `scores.apparatus`.
- `cart_items.ref_meet_id` → `ref_event_id`; `invoice_items.ref_meet_id` →
  `ref_event_id`.
- `sanction_requests.created_meet_id` → `created_event_id`.
- Rename indexes + RLS policy names that embed `meet`/`meet_sessions` for clarity
  (definitions auto-track via OID).
- `scores` keeps `replica identity full` (already set) — rename does not affect it.
- Note: the `scores.id` text format comment (`${meetId}|${regId}|${event}`) is updated
  to `${eventId}|${regId}|${apparatus}`; **existing id values are not rewritten**
  (the composite is opaque; no code parses it back out — verify).

### 2b. Regenerate `database.types.ts`

Generated file (standard `supabase gen types typescript`). Regenerate against the
linked project **after** the migration is pushed, or hand-edit the renamed
tables/columns to match if generation isn't run. Confirm `Row<'events'>`,
`Row<'event_sessions'>`, and the renamed columns appear.

### 2c. Edge Functions (update + redeploy)

- `create-checkout-session` — `'meets'`→`'events'`, `meet_id`→`event_id`,
  `ref_meet_id`→`ref_event_id`, local `meet`/`meets`/`meetIds` identifiers.
- `stripe-webhook` — `ref_meet_id`→`ref_event_id` (selects + invoice-item writes).
- `notify-sanction` — `created_meet_id`→`created_event_id`, `'meets'`→`'events'`.

### 2d. App-wide TS/TSX rename

- **Types** (`src/lib/types.ts`): `Meet`→`Event`, `MeetSession`→`EventSession`,
  `MeetStatus`→`EventStatus`; `Registration.events`→`apparatus`;
  `Score.event`→`apparatus`; `EVENTS`→`APPARATUS`; `CartItem.refMeetId`→`refEventId`,
  `InvoiceItem.refMeetId`→`refEventId`; `SanctionRequest.createdMeetId`→`createdEventId`.
- **Mapper layer** (`src/lib/supabase.ts`): every `rowTo*`/`*ToRow` for the renamed
  tables/columns; `from('meets')`→`from('events')`, etc.; `loadAll` keys.
- **Capabilities** (`capabilities-core.ts` + `capabilities.ts`): `isMeetHost`→
  `isEventHost`, `paidRegistrationClub` (uses `meetId`→`eventId`), etc.
- **Scoring** (`src/scoring/*`): apparatus `event`→`apparatus` field/param renames;
  keep ground-truth values — tests must stay green.
- **Components/pages:** `MeetWizard`→`EventWizard`, `MeetDetail`/`MeetManage`/
  `MeetResults`/`MeetStatusBadge`, plus all `meet`/`meetId`/`meets` locals. Files
  renamed to match (e.g. `MeetWizard.tsx`→`EventWizard.tsx`) where it aids clarity.
- **Tests** (`tests/**`): apparatus field renames in fixtures/expectations.

### 2e. Routes + nav

- `App.tsx`: add `/events`, `/events/:slug`, `/events/:slug/manage`,
  `/events/:slug/nationals` → existing (renamed) components. Keep `/meets`,
  `/meets/:slug`, `/meets/:slug/manage`, `/meets/:slug/nationals` as
  `<Navigate to={/events…} replace />` (preserving `:slug` via a tiny redirect
  wrapper using `useParams`).
- `navHistory.ts`: `/meets` label "Meets"→"Events"; `/meets/` "Meet"→"Event"; add the
  `/events` equivalents (keep `/meets` mappings for redirected history).
- `Layout.tsx` nav link + label → Events / `/events`.

### Cutover order (pre-launch; brief inconsistency acceptable)

1. Merge code to `main` (frontend auto-deploys via GitHub Actions).
2. Deploy the 3 Edge Functions.
3. `supabase db push` the rename migration.
4. Regenerate `database.types.ts` (if generating live) — already committed from the
   migration's known shape; reconcile if drift.

**Verify:** build + eslint(touched, incl. `supabase/functions/**`) + vitest (scoring
green); live smoke via dev auto-login (results page, a registration, a checkout
session create) against the renamed DB + redeployed functions; confirm `#/meets/<slug>`
redirects to `#/events/<slug>`.

---

## Phase 3 — Events page redesign (on renamed code)

**File:** the renamed Events list component (was `Meets()` in `src/pages/Meets.tsx`;
move/rename to `src/pages/Events.tsx`). Model the structure on
`src/pages/MyRegistrations.tsx`.

- **Title** "Events"; **subtitle**: "Current and Past UCG Hosted (Nationals,
  FlipFest, etc.) and UCG Sanctioned (Regular Season Meets) Events".
- **Button** "+ Sanction New Event" (admin-only), opens `EventWizard`.
- **Tabs:** Upcoming / Past, split on `endDate >= today` (string compare, as
  MyRegistrations does).
- **Search:** one input filtering by event name + location (`city, state`) +
  disciplines.
- **Table columns:** Event Name (link to `/events/:slug`) · Location · Date(s)
  (`startDate–endDate`) · Disciplines · Reg Opens · Reg Closes · Details (link).
- **Sortable:** clickable column headers toggle asc/desc. Default sort: **Upcoming
  ascending** (soonest first), **Past descending** (most recent first). Sort state is
  per-tab-reasonable (a single sort state is fine; default applied on tab entry).
- **Status badge** (`EventStatusBadge`) folded next to the event name.
- **Responsive:** wrap the table in a horizontal-scroll container so it doesn't
  overflow at 375px; verify 375 / 768 / 1280. Readable contrast on all header/row
  states (per global UI rules).
- Replaces the current 3-card grid entirely.

**Verify:** build + eslint(touched) + vitest; live render via dev auto-login; sort +
search interactions; responsive sweep 375/768/1280 (no horizontal overflow of the
page itself; table scrolls within its container).

---

## Out of scope / non-goals

- Adding actual camp/retreat/clinic event *types* to the UI (the rename only makes the
  vocabulary ready; `event_type`/`camp_config` columns already exist).
- Moving `Membership.tsx` direct card-pay to Stripe (separate deferred item).
- Any change to club-side registration (the add-on/cart flow change is scoped to
  member `SelfRegModal`, matching the report).

## Verification summary (all phases)

`npm run build` (tsc -b) + `npx eslint <touched files>` + `npx vitest run`, plus the
per-phase live/responsive checks above. The scoring tests are the guardrail for the
apparatus rename. Each phase merges atomically to `main`; the controller owns the
single `supabase db push` and the Edge Function deploys at Phase 2's end.
