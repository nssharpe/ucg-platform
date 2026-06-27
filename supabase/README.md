# UCG backend (Supabase) — wired in

This folder holds the database schema and security policies for the production
backend, and it is now **wired into the running app**:

- `src/lib/supabase.ts` is a write-through layer — every local `mutate()` call
  site also pushes the change to Supabase (no-ops when env vars are absent).
- `src/pages/Gate.tsx` + `src/lib/auth.ts` replace the localStorage password
  gate with Supabase Auth (email/password sign in & sign up) once configured.
- `src/pages/Results.tsx` subscribes to realtime score changes via
  `subscribeMeetScores` so spectators see scores the moment a judge posts them.
- The admin "Demo tools" panel can push the local seed DB to Supabase
  (`pushAll`) for initial seeding.

When `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` are absent, the app falls
back unchanged to the localStorage prototype store (`src/lib/store.ts`) with
the original password gate.

## Why Supabase

It gives us, on a managed free/low tier, everything the spec needs without
building it from scratch: Postgres (relational data + the scoring logic can run
in SQL), row-level security (the role model below), authentication, an
auto-generated REST + realtime API (live results push), file storage (waiver
PDFs, exports), and scheduled functions (membership-expiry emails, backups).
It also leaves a clean path to the spec's "we need an API" requirement — the
PostgREST API is automatic, and Edge Functions cover custom endpoints.

## Files

Migration filenames use Supabase's required timestamp format
(`<YYYYMMDDHHmmss>_name.sql`); the leading `NNNN_` labels below are the historical
sequence numbers used in conversation. In order:

| Migration | Purpose |
|------|---------|
| `…000001_schema.sql` (0001) | All tables + enums, mirroring `src/lib/types.ts`. |
| `…000002_rls.sql` (0002) | Row-level security: helper functions + public read for results. |
| `…000003_score_source_calcs.sql` (0003) | Adds `wag-sv-calc` / `tnt-calc` to the `score_source` enum. |
| `…000004_text_ids_score_extras.sql` (0004) | App-generated id columns → `text`; adds score calc-state columns + `scores` replica identity. |
| `…000005_account_foundation.sql` (0005) | `club_requests` table + RLS, widened `club_managers` RLS, `link_or_create_person` claim-by-email RPC. |
| `…000006_nationals.sql` (0006) | Nationals finals-qualification / awards config + supporting columns. |
| `20260618000007_feedback_2026_06_18.sql` (0007) | 6/18 feedback batch, Waves 1–3. |
| `20260618100000_sanctioning_role.sql` | Adds the `sanctioning` app role (own file — enum-add must commit before use). |
| `20260618200000_event_management.sql` (0008) | Event/sanctioning subsystem schema (meets event type, sanction id, camp config). |
| `20260620000010_membership_status_pending_waiver.sql` | Adds the `pending-waiver` membership status. |
| `20260620000020_waiver_esign.sql` | `waiver_documents`, `waiver_signatures`, `waiver_sign_requests` + RLS. |
| `20260620000030_seed_general_waiver.sql` | Seeds the default general waiver document. |
| `20260623000010_coupon_account_restriction.sql` | Adds `coupons.restricted_to_person_id` (promo codes usable by a single account). |
| `20260623000020_comm_log.sql` | `comm_log` — one row per Communicate send (channel, recipients, outcome). RLS: sender reads own, admins all. |
| `20260623000030_error_logs.sql` | `error_logs` — client error log (anyone inserts, admins read), powers the admin Error Log page. |
| `20260623000040_club_memberships.sql` | `club_memberships` (per club+season) — the registration/hosting gate; backfills the current season for clubs with active members. |
| `20260623000050_sms_consent_and_send_log.sql` | `people.sms_consent`/`sms_consent_at` (CTIA opt-in) + `comm_log.segments`/`encoding`/`cost_estimate` (SMS send-log enrichment). |
| `20260623000060_sms_messages.sql` | `sms_messages` — per-message log (outbound DLR status + inbound replies) the `sms-webhook` function updates. RLS: admins read; service-role writes. |
| `20260623000070_self_pay_invoice_rls.sql` | Lets a member write their OWN `invoices` + `invoice_items` (direct-pay membership receipts, incl. $0-after-promo). Replaces the admin-only `invoice_items` write policy with an owner-write one. Adds `redeem_coupon(code)` security-definer RPC (atomic `used_count` bump, enforces `max_uses`) so members don't need direct UPDATE on `coupons`. |
| `20260624000010_member_club_cart_rls.sql` | `cart_member_clubpush` policy: a member may insert/read/delete a club-cart row that is theirs (`ref_user_id = self`) when the club has `allow_club_pay`. Fixes "send to club cart" failing RLS for non-managers. |
| `20260624000020_manager_access_requests.sql` | `manager_access_requests` (tokenized "Request Club Admin Role") + `get_manager_access_request` / `decide_manager_access` security-definer RPCs (granted to anon for the no-login review page). First responder approves (adds to `club_managers`) or denies; idempotent. |
| `20260624204707_people_outside_us.sql` | `people.outside_us` boolean (default false) — athlete/coach trains outside the US, so the state field is optional and Region resolves to "Outside US". |
| `20260624233240_app_role_regional_rep.sql` | Adds the `regional_rep` app role (own file — enum-add must commit before use). |
| `20260624233241_app_role_finance_admin.sql` | Adds the `finance_admin` app role (own file — enum-add must commit before use). |
| `20260624233242_regional_rep_regions.sql` | `regional_rep_regions` (user_id → region, one per rep) for Regional Representatives. RLS: admins manage all; a rep reads own row. |
| `20260625001248_waiver_sign_request_signer_role.sql` | Adds `waiver_sign_requests.signer_role` (`'self'`\|`'guardian'`, default `'guardian'`) so a no-login link can carry the intended signer; recreates `get_waiver_sign_request` to return it. Lets an 18+ athlete sign their OWN waiver via the no-login path instead of being recorded as their own guardian. |
| `20260625180951_registrations_paid.sql` | Phase 3 (3f/3g): `registrations.paid` (boolean, default false — explicit "entry fee paid" flag; new regs land false = "Pending Purchase", pay paths flip true; historical rows backfilled true) + `registrations.updated_pending` (already-paid reg edited back to re-pending by a change fee = "Updated pending purchase") + `cart_items.ref_reg_ids` / `invoice_items.ref_reg_ids` (`text[]` linking a meet-entry/change-fee line to the exact registration id(s) it pays for). RLS unchanged. |
| `20260625231808_payments_and_invoice_stripe_fields.sql` | Stripe Phase S1: `payments` table — the server-side record of a Stripe Embedded Checkout session (`pending` row on session create, flipped `paid` by the verified webhook). All money cols in **cents**; idempotency via unique `stripe_session_id` + `stripe_event_id`; item refs (`cart_item_ids`/`ref_reg_ids`/`ref_season_id`/`ref_type`); FK cols `person_id`/`invoice_id` are **text** (match the text ids). RLS: **service-role writes only** (no client write policy), signed-in person self-reads own rows (`is_admin() or person_id = my_person_id()`). Adds `invoices.stripe_payment_intent_id` + `invoices.stripe_fee` (nullable; feed Phase 5 finance with real fees). The two Edge Functions land in S2 — see `docs/specs/2026-06-25-stripe-integration.md`. |
| `20260626144305_s4_cart_line_tags.sql` | Stripe Phase S4: adds `ref_meet_id` (now `ref_event_id` — see rename below) + `ref_line_type` to **both** `cart_items` and `invoice_items` so the server can price addons + distinguish entry vs change fees deterministically when recomputing every cart-line kind (memberships, event entries, change fees, addons) for self and club carts. RLS unchanged. |
| `20260626150000_rename_meet_entity.sql` | **Meet→Event rename (entity).** `meets`→`events`, `meet_sessions`→`event_sessions`; `meet_id`→`event_id` (event_sessions/registrations/scores); `cart_items.ref_meet_id`/`invoice_items.ref_meet_id`→`ref_event_id`; `sanction_requests.created_meet_id`→`created_event_id`; enum `meet_status`→`event_status`; cosmetic index renames. All renames preserve FKs/RLS/realtime (Postgres tracks dependents by OID). **Applied 2026-06-27.** |
| `20260626150100_rename_apparatus.sql` | **Apparatus rename.** `registrations.events`→`registrations.apparatus`, `scores.event`→`scores.apparatus` — disambiguates gymnastics apparatus from the renamed competition Event entity. **Applied 2026-06-27.** |
| `20260627120000_rename_event_levels_apparatus.sql` | **Apparatus consistency follow-up.** `registrations.event_levels`→`apparatus_levels` (the per-apparatus T&T level map — the last apparatus-overloaded column name). Non-destructive rename; no Edge Function references it. **Applied 2026-06-27.** |

> **Naming note (rename applied 2026-06-27):** the schema descriptions above that
> predate these two migrations still say `meets`/`meet_id`/`ref_meet_id`/
> `registrations.events`/`scores.event` — those are now `events`/`event_id`/
> `ref_event_id`/`registrations.apparatus`/`scores.apparatus`. The app's realtime helper
> `subscribeMeetScores` is now `subscribeEventScores` (filter `event_id=eq.…`). See
> `docs/specs/2026-06-26-events-rename-and-registration-flow.md`.

All migrations are applied to the live project and tracked by the linked CLI
(`supabase db push`). Migrations are append-only — add new ones rather than editing
applied files. See `../CLAUDE.md` for the enum-add transaction gotcha.

## Edge Functions (`functions/`)

Deno functions deployed with `supabase functions deploy <name> --project-ref <ref>`.
Email goes through **Resend** (HTTP API) via the shared helper `functions/_shared/resend.ts`
(`resendFrom`/`sendOne`/`sendBatch`); secrets `RESEND_API_KEY` / `RESEND_FROM`. SMS goes
through **Telnyx** (`send-sms`). The old `GMAIL_*` secrets are unused (rollback only).
Front-end invokers live in `src/lib/supabase.ts`. The notify-style functions allow any
signed-in caller and resolve recipients server-side with the service role; `send-email`
is the only admin-gated sender.

| Function | Purpose | Caller |
|----------|---------|--------|
| `send-email` | Communicate broadcast / test sender (Resend batch, 50-recipient cap). | admin only |
| `send-sms` | Communicate text sender (Telnyx); records sent messages to `sms_messages`. | admin only |
| `sms-webhook` | Inbound Telnyx webhook: DLRs → `sms_messages` status, inbound replies → store + email admins, STOP → `sms_consent` off. Verifies Telnyx Ed25519 signature (`TELNYX_PUBLIC_KEY`). | Telnyx (no JWT; signature-verified) |
| `record-waiver-signature` | Server-stamps real IP into `waiver_signatures`, activates membership (club-pay rows → `pending-club-payment`; returns `pendingPayment`). The no-login (token) path stamps `signer_role` from the request row, not the request body. | signed-in owner (JWT, no token) / no-login token (self or guardian) |
| `request-guardian-waiver` | Creates a signing token + emails a minor's guardian the link. | signed-in owner |
| `create-waiver-link` | Mints a no-login waiver signing link for a member (admin "Activate" popup — email or copy). Takes optional `signerRole: 'self'\|'guardian'` (default `'guardian'`) stored on the request row. Returns `{token, link, signerRole}`. | admin / club manager |
| `notify-club-cart` | Emails a club's managers when a member pushes fees to the cart. | any signed-in member |
| `send-membership-welcome` | "Welcome to UCG" email for a no-club member's FIRST membership-only purchase, CC'ing the region's regional-team address and naming its Regional Leader(s). Re-checks no-club + not-Outside-US server-side; resolves region (`STATE_REGIONS[state]`), reps (`regional_rep` role ∩ `regional_rep_regions`), and CC address server-side. | any signed-in member (self only) |
| `send-club-invite` | Invite a coach (signup) or a member (purchase membership) by email. | club manager / admin |
| `invite-account` | Create an account + email a branded set-password link (Resend). Used by club "Add athlete"/"Add coach" (`roles` set to match kind). | club manager / admin |
| `request-manager-access` | "Request Club Admin Role": records `manager_access_requests` + emails the requested club's managers (admins only if the club has none yet) a no-login review link; first responder approves/denies. | any signed-in member |
| `notify-manager-access-denied` | Emails the requester that their Club Admin request was not approved. Token-gated (deploy `--no-verify-jwt`); resolves recipient server-side; fails closed unless the request is `denied`. | no-login (secret token) |
| `notify-sanction` | Sanction lifecycle emails (submitted → team+admins; approved/rejected → requester). | any signed-in member |
| `create-checkout-session` | Stripe Embedded Checkout. As of **S4** generalized to **every** cart-line kind (membership / club-membership / member-targeted membership / meet entry / change fee / addon) for **both** self carts and manager-paid club carts. **Recomputes** all amounts server-side (cart `amount` never trusted) — season fees + existing memberships for memberships; meet config (honoring host-club $0) keyed on the new `ref_meet_id`/`ref_line_type` tags for entries/changes/addons — adds the service fee (`processingFee`), creates the session (`ui_mode:'embedded'`, no redirect), inserts a `pending` `payments` row. Returns `{ clientSecret, sessionId, paymentId }`. | any signed-in member (own cart) / club manager (club cart) |
| `stripe-webhook` | The sole completer. Verifies the Stripe signature with `constructEventAsync` against `STRIPE_WEBHOOK_SECRET` (**fail-closed** if unset). On `session.completed`/`async_payment_succeeded` runs **idempotent** fulfillment (event-id + `fulfilled_at` guarded) for all line kinds (S4): flip the exact `registrations.paid` via `ref_reg_ids`, activate membership(s) + club memberships, write the paid invoice with the **real** `stripe_fee` (billed to the **club** via `invoices.club_id` for club carts, to the payer for self carts), clear cart lines, email the **payer** a receipt (the paying manager for a club cart). On `expired`/`async_payment_failed` → mark `failed`. | Stripe (no JWT; deploy `--no-verify-jwt`; signature-verified) |

Stripe functions share `functions/_shared/stripe.ts` (Stripe client via `npm:stripe`,
fetch HTTP client, SubtleCrypto provider, and `processingFee`/all-line-kind pricing
mirroring `src/lib/pricing.ts` + the meet config). Secrets: `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET` (test values first). Register the webhook endpoint
`https://<ref>.supabase.co/functions/v1/stripe-webhook` for events
`checkout.session.{completed,async_payment_succeeded,async_payment_failed,expired}`.
**S4 status:** both functions are generalized to all cart-line kinds + club carts but are
**built, not yet deployed** (Nate deploys at phase end); the new `cart_items`/`invoice_items`
`ref_meet_id` + `ref_line_type` columns are already live.

**S5 (finance wiring + go-live):** the webhook already records `invoices.stripe_fee` +
`invoices.stripe_payment_intent_id` (real cents from the balance txn); S5 closed the FE gap
where `supabase.ts` dropped those columns, so **Phase 5 finance now reads the real fee**.
Go-live (swap test→live keys + webhook secret, $1 smoke test + refund, payout/bank check) is
a documented runbook: [`../docs/stripe-go-live-checklist.md`](../docs/stripe-go-live-checklist.md).
**Deferred:** card-checkout coupons, moving `Membership.tsx` direct card-pay to Stripe, and
an in-app admin refund path (today refunds are issued **manually in the Stripe Dashboard** —
a Dashboard refund does not yet reflect back into `payments.status`/fulfillment; sketch in
the checklist).

## Stand it up

1. Create a project at https://supabase.com (free tier is fine to start).
2. Run the migrations — either:
   - **SQL editor:** paste `0001_schema.sql`, run; then `0002_rls.sql`, run; or
   - **CLI:** `supabase link --project-ref <ref>` then `supabase db push`.
3. In the app, copy `.env.example` → `.env.local` and fill in the project URL
   and anon key (Settings → API). `src/lib/supabase.ts` activates automatically.
4. Seed: export the prototype's demo data (League Controls → Demo tools can be
   extended to dump JSON) or write an `INSERT` seed. The shapes match the schema
   1:1, so a small script can map the seed in `src/lib/seed.ts` to rows.

## Post-deploy setup

After the schema (0001 + 0002) is applied and the app is deployed with the env
vars set, finish setup with the following one-time steps:

1. **Apply migrations 0003 and 0004** in the SQL editor.
   - 0004 runs fine as a single script (it's wrapped in its own transaction).
   - 0003 uses `alter type ... add value if not exists`, which **cannot run
     inside a transaction block**. Run each statement individually (select and
     execute one line at a time, or paste them one at a time):
     ```sql
     alter type score_source add value if not exists 'wag-sv-calc';
     alter type score_source add value if not exists 'tnt-calc';
     ```

2. **Grant yourself admin** after your first sign-up (Gate → Sign up):
   ```sql
   insert into user_roles (user_id, role)
   select id, 'admin' from auth.users where email = 'nssharpe@gmail.com';
   ```

3. **Enable realtime for `scores`** so live results push to spectators:
   - Database → Replication → add the `scores` table to the
     `supabase_realtime` publication, or run:
     ```sql
     alter publication supabase_realtime add table scores;
     ```
   - Migration 0004 also sets `alter table scores replica identity full;` —
     without it, DELETE events replicate only the primary key, so the per-meet
     `meet_id=eq.…` realtime filter silently drops them.

4. **Seed data**: sign in as the admin user, then use Admin → League Controls
   → Demo tools → "Push local DB → Supabase" to copy the seeded prototype data
   into the new database.

## Role model (RLS)

The app's permission model (see `src/lib/capabilities-core.ts`) collapses to a few
real concepts, enforced by RLS:

- **admin** — the only account-level role; lives in `user_roles`. Full access.
- **club manager** — a `club_managers` row (person↔club). Reads/writes the people,
  registrations, cart and invoices for clubs they manage, and (since 0005)
  co-manages their own club's manager list. Not a `user_roles` entry.
- **meet host** — *derived*, not stored: a manager of the meet's `host_club_id`.
  Manages that meet's sessions/squads and may write its scores.
- **member** (baseline signed-in person) — reads/writes their own `people` row,
  memberships, alt-clubs, registrations, and (since 0070) their own `invoices` +
  `invoice_items` so a direct-pay membership generates a receipt; coupon
  redemption goes through the `redeem_coupon(code)` RPC. May also push their own
  fee to a club's cart when the club allows it (`cart_member_clubpush`, since
  20260624000010). "Athlete"/"coach" are membership types, not roles.
- **sanctioning** — a `user_roles` row; the Sanctioning Team (voting UI later).
- **regional_rep** — a `user_roles` row; a Regional Representative. Their region
  is stored per-user in `regional_rep_regions` (admin-managed; reps read own).
- **finance_admin** — a `user_roles` row; no extra attributes (gates a later
  finance-dashboard phase). Admins are NOT implicitly finance/regional reps.
- **judge** — will be account-free via a per-meet code (sub-project D); not yet
  built. Until then, admins/hosts enter scores.
- **anon / guest** — public read of meets, sessions, registrations, and scores so
  live-results and meet pages work with no login.

Accounts link to a `people` row by verified email on first sign-in via the
`link_or_create_person` security-definer RPC (0005). Helper SQL functions
(`is_admin()`, `manages_club()`, `my_person_id()`) keep the policies readable.
The `app_role` enum carries the original values plus `sanctioning`, `regional_rep`,
and `finance_admin`; `admin`, `sanctioning`, `regional_rep`, and `finance_admin`
are issued as account roles via the admin User Roles page.

## How the app data layer uses this

`src/lib/store.ts` exposes the reactive `useDB`/`mutate` surface the UI reads
and writes. `src/lib/supabase.ts` provides:

- `loadAll()` — hydrates the in-memory snapshot from Supabase on boot
  (`syncFromSupabase`), after first painting the localStorage/seed snapshot
  so there's no flash.
- `push*` helpers — called alongside every `mutate(...)` site to mirror
  changes to Supabase (fire-and-forget, no-op when not configured).
- `subscribeMeetScores` / `applyScorePatch` — realtime score updates for the
  live results page.
- `pushAll` — bulk-pushes a full local DB snapshot, used by the admin
  "Push local DB → Supabase" seed tool.

The localStorage password gate (`checkPassword`/`isUnlocked` in `store.ts`)
remains as the fallback when Supabase isn't configured; `src/pages/Gate.tsx`
and `src/lib/auth.ts` handle Supabase Auth when it is.

## Club-membership gate (since `…000040`)

A club must hold an active `club_memberships` row for a season before its athletes can
register or it can host that season. Enforced **client-side** at the registration and
sanction-request entry points via the pure helpers `clubHasActiveMembership` /
`seasonForDate` in `src/lib/capabilities-core.ts`. Managers purchase from the club page:
clicking **Purchase** opens a review/edit-club-info screen (name, short name, state→region,
email — edits save via `pushClub`), and confirming adds a club-membership **line to the club
cart** (`cart_items` `kind:'membership'`, `ref_type:'club'`, `ref_season_id:<season>`) and
routes to the cart — it does NOT create an active row. The `club_memberships` row is created
(status `active`) only when that cart line is **paid** in `ClubCart` (so the gate stays false
until payment). League admins still grant/revoke any season directly. The gate is ON.

## Observability

- `comm_log` — every Communicate send; surfaced in Communicate → "Communication history".
- `error_logs` — front-end errors (via `report-error.ts` sink + `window` handlers in
  `main.tsx`); surfaced in the admin **Error Log** page (search by user email). See
  `docs/research/2026-06-22-error-logging-observability.md`.

## Not covered yet (future migrations)

Payments are **built** (Stripe Embedded Checkout, Phases S1–S5 — `payments`/`invoices`/
`cart_items` tables + the `create-checkout-session`/`stripe-webhook` functions above; finance
fee/payment-intent wiring done). Remaining before real money flows: Nate deploys the S4
functions and runs the go-live checklist (live keys). Still future: the membership-expiry
notification cron, scheduled
database backups, and the public API
surface for other leagues. (Waiver e-signature **is** built — migrations 0010–0030 +
`record-waiver-signature` / `request-guardian-waiver`; it stores a structured signature
evidence record. PDF proof and receipts are generated **client-side** (jsPDF) on demand;
server-emailed PDF attachments will come with the payments work.)
