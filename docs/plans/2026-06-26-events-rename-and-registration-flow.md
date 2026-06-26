# Events Rename + Registration→Cart Flow — Implementation Plan

> **For agentic workers:** Execute with `superpowers:subagent-driven-development`
> (one fresh implementer subagent per task; review reports inline between tasks). This
> is a **lean** plan per the repo's CLAUDE.md rule ("dispatch straight from the spec;
> skip redundant per-phase plan docs"): the authoritative requirements + file mappings
> live in the spec — this plan sequences the work into dispatchable tasks and records
> the verification gates. **Read the spec alongside this plan:**
> `docs/specs/2026-06-26-events-rename-and-registration-flow.md`.

**Goal:** Rename the Meet entity to Event (app + DB + Edge Functions, plus apparatus
`events`→`apparatus`), redesign the Events page as a tabbed sortable/searchable table,
fix the registration→cart flow, and eliminate the `invoice_items_pkey` duplicate-key bug.

**Architecture:** Three atomic phases, each merging to `main` on its own. Phase 1 is a
small pre-rename fix. Phase 2 is the atomic rename (DB migration + Edge Function
redeploys + app rename + routes, all merged + cut over together). Phase 3 builds the
new Events page on the renamed code.

**Tech stack:** React + TS + Vite, Supabase (Postgres + Edge Functions/Deno), Vitest.

**Standing rules (from CLAUDE.md):** subagents verify with `npm run build` (tsc -b) +
`npx eslint <touched files, incl. supabase/functions/**>` + `npx vitest run`; subagents
create migrations/edge-fn code but **never** push/deploy — the controller owns the
single `supabase db push` + edge deploys, batched at Phase 2's end. After each phase,
merge to `main` and push.

---

## Phase 1 — Registration→cart flow + duplicate-key fix

Small; the controller may do this inline (file already in context) rather than
dispatching. Spec §"Phase 1".

**Files:** `src/pages/Meets.tsx` (`SelfRegModal` only).

- [ ] **1.1 — Add navigation + remove the invoice stub + drop "Skip add-ons".**
  - Import `useNavigate` from `react-router-dom`; call `const navigate = useNavigate()`
    in `SelfRegModal`.
  - In `persistRegs`, **delete** the `d.invoices.push(invoice)` / `pushInvoice(invoice)`
    block (the one bundling `[...allItems]` from the whole cart) and the now-unused
    `allItems`/`invoice` locals. This removes the `invoice_items_pkey` collision.
    (`pushInvoice` import may become unused — drop it if so.)
  - At the end of `persistRegs` (after the toast), call `navigate('/cart')` so **both**
    the add-on path and the no-add-on path land on the cart. (Keep `onClose()` — it
    closes the modal before navigating.)
  - In the add-on step JSX: remove the **"Skip add-ons"** `<button>`; keep only
    **"Continue to cart"**. Reword the helper `<p>` so it no longer references skipping
    via a button (e.g. "Optional add-ons for this event — leave a field blank to omit it.").
- [ ] **1.2 — Verify no reader depends on the deleted self-invoice stubs.**
  - Confirm nothing relies on client-created unpaid invoices for an athlete:
    `grep -rn "invoices" src --include=*.tsx --include=*.ts | grep -i "paidAt\|athleteId"`.
    PurchaseHistory/finance read **paid** invoices (Stripe-written); the deleted stubs
    were unpaid and id-colliding. If a genuine reader exists, stop and report.
- [ ] **1.3 — Verify.** `npm run build`; `npx eslint src/pages/Meets.tsx`;
  `npx vitest run`. Then live (dev auto-login, athlete): register for an add-on event
  and a no-add-on event → confirm each lands on `#/cart` with the lines present;
  register for a second event → confirm **no** duplicate-key toast.
- [ ] **1.4 — Commit + merge Phase 1 to `main` and push.** Sweep docs if impacted
  (likely none — internal flow only).

---

## Phase 2 — The Rename (atomic)

Everything in Phase 2 merges as ONE commit/PR and cuts over together. Decompose into
sequential subagent passes (no parallel — shared working tree), each reaching a green
`npm run build` before the next. Spec §"Phase 2".

### Task 2.1 — DB migration (author only; controller pushes later)

**Files:** Create `supabase/migrations/<ts>_rename_meets_to_events.sql` (use
`supabase migration new rename_meets_to_events`).

- [ ] One migration performing ALL renames (tables, columns, indexes, policy names) per
  spec §2a: `meets→events`, `meet_sessions→event_sessions`; `meet_id→event_id` on
  `event_sessions`/`registrations`/`scores`; `registrations.events→apparatus`;
  `scores.event→apparatus`; `cart_items.ref_meet_id→ref_event_id`;
  `invoice_items.ref_meet_id→ref_event_id`; `sanction_requests.created_meet_id→created_event_id`.
  Use `alter table ... rename ...` (FKs/RLS/realtime track by OID). Rename policy +
  index names that embed `meet` for cosmetic consistency. Do NOT rewrite existing
  `scores.id` values (composite is opaque; verified no parser).
- [ ] Subagent does NOT push. Verify SQL parses by eye + matches spec.

### Task 2.2 — Entity rename: `Meet`→`Event` (app + Edge Functions + routes)

**Files (entity group — spec §2c/2d/2e):** `src/lib/types.ts`, `src/lib/supabase.ts`,
`src/lib/capabilities-core.ts`, `src/lib/capabilities.ts`, `src/lib/navHistory.ts`,
`src/lib/store.ts`, `src/lib/seed.ts`, `src/lib/pricing.ts`, `src/lib/scoring.ts`,
`src/lib/nationals*.ts`, `src/lib/awards-deck.ts`, `src/App.tsx`,
`src/components/MeetWizard.tsx`→`EventWizard.tsx`, `src/components/RegistrationEditor.tsx`,
`src/components/Layout.tsx`, `src/components/NationalsConfigEditor.tsx`,
`src/pages/Meets.tsx`→`Events.tsx` (rename file; exports `Events`/`EventDetail`/
`EventManage`), `src/pages/{Home,Cart,Club,Judge,Nationals,Results,ScoreDetail,
MyRegistrations,Sanction,Profile,PurchaseHistory,Admin,ManagerAccessReview,Membership}.tsx`,
`src/nationals/types.ts`, `src/lib/database.types.ts` (hand-edit renamed tables/cols),
and Edge Functions `supabase/functions/{create-checkout-session,stripe-webhook,notify-sanction}/index.ts`.

- [ ] Rename, in this order, then fix the compile cascade until `npm run build` is green:
  - Types: `Meet`→`Event`, `MeetSession`→`EventSession`, `MeetStatus`→`EventStatus`;
    `CartItem.refMeetId`→`refEventId`, `InvoiceItem.refMeetId`→`refEventId`,
    `SanctionRequest.createdMeetId`→`createdEventId`.
  - Vars/fields: `meetId`→`eventId`, `refMeetId`→`refEventId`, `createdMeetId`→
    `createdEventId`, `isMeetHost`→`isEventHost`, and local `meet`/`meets` identifiers.
  - Mapper layer: `from('meets')`→`from('events')`, `from('meet_sessions')`→
    `from('event_sessions')`, `meet_id`→`event_id`, `ref_meet_id`→`ref_event_id`,
    `created_meet_id`→`created_event_id` in `rowTo*`/`*ToRow`/`loadAll`.
  - Components: rename `MeetWizard`→`EventWizard` (and file), `MeetDetail`/`MeetManage`/
    `MeetResults`/`MeetStatusBadge`→`Event*`; update all imports.
  - Edge Functions: `'meets'`→`'events'`, `meet_id`→`event_id`, `ref_meet_id`→
    `ref_event_id`, `created_meet_id`→`created_event_id`, local `meet*` identifiers.
  - Routes (`App.tsx`): add `/events`, `/events/:slug`, `/events/:slug/manage`,
    `/events/:slug/nationals`; keep `/meets*` as `<Navigate replace>` redirects that
    preserve `:slug` (small wrapper reading `useParams().slug`). Update internal
    `to="/meets…"`/`navigate('/meets…')` to `/events`.
  - Nav (`navHistory.ts` + `Layout.tsx`): label "Meets"→"Events", path `/meets`→
    `/events`; keep `/meets*` label mappings for redirected history.
  - `database.types.ts`: hand-edit renamed tables/columns to match the migration.
- [ ] **DO NOT** touch apparatus `events`/`EVENTS`/`score.event` in this task (Task 2.3).
- [ ] Verify: `npm run build` green; `npx eslint` the touched files (incl.
  `supabase/functions/**`); `npx vitest run` (should still pass — apparatus untouched).

### Task 2.3 — Apparatus rename: `events`→`apparatus`

**Files (apparatus group — spec §2d/2b):** `src/lib/types.ts`
(`Registration.events`→`apparatus`, `Score.event`→`apparatus`, `EVENTS`→`APPARATUS`),
`src/lib/scoring.ts`, `src/lib/seed.ts`, `src/lib/supabase.ts` (the `events`/`event`
columns in reg/score mappers → `apparatus`), `src/lib/nationals*.ts`,
`src/nationals/{artistic,awards,combined,teams,tnt,validation}.ts`,
`src/components/RegistrationEditor.tsx`, `src/pages/{Events,Home,Club,Judge,Nationals,
Results,ScoreDetail,MyRegistrations}.tsx`, `src/lib/database.types.ts`
(`registrations.events`→`apparatus`, `scores.event`→`apparatus`), and tests
`tests/{lib/capabilities-core,lib/pricing-registration,pricing}.test.ts`,
`tests/nationals/{adapter,artistic,tnt,validation}.test.ts`, `tests/nationals/helpers.ts`.

- [ ] **TRAP:** rename ONLY the apparatus domain — `reg.events`/`registration.events`,
  the `EVENTS` constant + its uses, and `score.event`/`s.event` (single apparatus).
  **Never** rename React/DOM `event`/`e` handler params, `React.ChangeEvent`,
  `onChange`, `addEventListener`, realtime `postgres_changes`/DELETE "events", or the
  nationals `split('|')` category keys. Inspect each `.event`/`events` hit in context.
- [ ] Apply: `Registration.events`→`apparatus`, `Score.event`→`apparatus`,
  `EVENTS`→`APPARATUS`; DB-mapper columns `events`→`apparatus`, `event`→`apparatus`;
  update tests' fixtures/expectations to the new field names (keep all ground-truth
  values identical — scoring results must not change).
- [ ] Verify: `npm run build` green; `npx eslint` touched files;
  `npx vitest run` — **all scoring/nationals tests green** (this is the guardrail).

### Task 2.4 — Controller: cutover + merge (NOT a subagent task)

- [ ] Final `npm run build` + `npx eslint` (all touched, incl. functions) + `npx vitest run`.
- [ ] Merge Phase 2 to `main` + push (frontend auto-deploys).
- [ ] Deploy the 3 Edge Functions:
  `supabase functions deploy create-checkout-session --project-ref wkyerxlgricfphopocoz`
  (repeat for `stripe-webhook`, `notify-sanction`).
- [ ] `supabase db push` (sandbox disabled) the rename migration; review the pending
  diff first.
- [ ] Optionally regenerate `database.types.ts` live and reconcile any drift vs the
  hand-edit.
- [ ] Smoke (dev auto-login): live results page renders; a registration saves; a
  checkout session is created (exercises the renamed columns + redeployed functions);
  `#/meets/<slug>` redirects to `#/events/<slug>`.
- [ ] **Doc sweep:** update `CLAUDE.md` (table/column names, route names, Edge Function
  column refs), `supabase/README.md` (schema), `README.md`/`docs/README.md` if they
  name Meets/meet tables. Same session.

---

## Phase 3 — Events page redesign

On the renamed code. Spec §"Phase 3". Model on `src/pages/MyRegistrations.tsx`.

**Files:** `src/pages/Events.tsx` (the `Events` list component, renamed from `Meets` in
Phase 2).

- [ ] **3.1 — Build the tabbed table.** Replace the 3-card grid with:
  - Title "Events"; subtitle exactly: "Current and Past UCG Hosted (Nationals,
    FlipFest, etc.) and UCG Sanctioned (Regular Season Meets) Events".
  - Admin button text → **"+ Sanction New Event"** (opens `EventWizard`).
  - Tabs Upcoming / Past split on `endDate >= today()` (string compare, like
    MyRegistrations). Search input filtering name + `city, state` + disciplines.
  - Sortable table, columns: **Event Name** (link `/events/:slug`, with the
    `EventStatusBadge` beside it) · **Location** (`city, state`) · **Date(s)**
    (`fmtDate(start)–fmtDate(end)`) · **Disciplines** (`disciplines.join(' · ')`) ·
    **Reg Opens** (`fmtDate(regOpens.slice(0,10))`) · **Reg Closes** · **Details**
    (link). Clickable headers toggle asc/desc; default Upcoming asc / Past desc by date.
  - Wrap the table in a horizontal-scroll container (`overflow-x:auto`) so it doesn't
    overflow the page at 375px. Ensure header/row contrast meets the global UI rule.
- [ ] **3.2 — Verify.** `npm run build`; `npx eslint src/pages/Events.tsx`;
  `npx vitest run`. Live (dev auto-login): tab switch, search, column sort all work.
  Responsive sweep 375 / 768 / 1280 via preview tooling — confirm
  `documentElement.scrollWidth ≤ clientWidth` (no page overflow; table scrolls within
  its container), screenshots at each width.
- [ ] **3.3 — Commit + merge Phase 3 to `main` and push.** Doc sweep: note the Events
  page structure in `CLAUDE.md`/`README.md` if relevant.

---

## Self-review (against the spec)

- **Coverage:** Phase 1 ⇒ spec items 2 + 3 (flow + bug). Phase 2 ⇒ the full rename
  (entity + apparatus + DB + Edge Fns + routes/redirects + types). Phase 3 ⇒ Events
  page (tabs/table/search/sort + subtitle + Title-Case button). All spec sections map
  to a task.
- **Type consistency:** `Event`/`EventSession`/`EventStatus`, `eventId`/`refEventId`/
  `createdEventId`, `isEventHost`, `apparatus`/`APPARATUS`, `event_id`/`ref_event_id`/
  `created_event_id`, tables `events`/`event_sessions` — used consistently across 2.1/
  2.2/2.3 and Phase 3.
- **Traps recorded:** apparatus rename must skip DOM/handler `event`s; `scores.id`
  composite left intact (no parser); routes keep `/meets` redirects; Phase 2 merges +
  cuts over atomically (code deploy → edge deploy → db push).
