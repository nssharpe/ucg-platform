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
| `record-waiver-signature` | Server-stamps real IP into `waiver_signatures`, activates membership. | signed-in owner (self) / guardian token |
| `request-guardian-waiver` | Creates a signing token + emails a minor's guardian the link. | signed-in owner |
| `notify-club-cart` | Emails a club's managers when a member pushes fees to the cart. | any signed-in member |
| `send-club-invite` | Invite a coach (signup) or a member (purchase membership) by email. | club manager / admin |
| `invite-account` | Admin-create an account + email a branded set-password link (Resend). Used by roster "Add athlete". | club manager / admin |
| `request-manager-access` | Member asks a club's managers + admins for access. | any signed-in member |
| `notify-sanction` | Sanction lifecycle emails (submitted → team+admins; approved/rejected → requester). | any signed-in member |

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
  memberships, alt-clubs, and registrations. "Athlete"/"coach" are membership
  types, not roles.
- **judge** — will be account-free via a per-meet code (sub-project D); not yet
  built. Until then, admins/hosts enter scores.
- **anon / guest** — public read of meets, sessions, registrations, and scores so
  live-results and meet pages work with no login.

Accounts link to a `people` row by verified email on first sign-in via the
`link_or_create_person` security-definer RPC (0005). Helper SQL functions
(`is_admin()`, `manages_club()`, `my_person_id()`) keep the policies readable.
The `app_role` enum still carries the original six values, but only `admin` is
issued as an account role now.

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
`seasonForDate` in `src/lib/capabilities-core.ts`. Managers purchase from the club page
(after a settings review); league admins grant/revoke any season. The gate is ON.

## Observability

- `comm_log` — every Communicate send; surfaced in Communicate → "Communication history".
- `error_logs` — front-end errors (via `report-error.ts` sink + `window` handlers in
  `main.tsx`); surfaced in the admin **Error Log** page (search by user email). See
  `docs/research/2026-06-22-error-logging-observability.md`.

## Not covered yet (future migrations)

Payments (Stripe via an Edge Function — `invoices`/`cart_items` tables already exist),
the membership-expiry notification cron, scheduled database backups, and the public API
surface for other leagues. (Waiver e-signature **is** built — migrations 0010–0030 +
`record-waiver-signature` / `request-guardian-waiver`; it stores a structured signature
evidence record. PDF proof and receipts are generated **client-side** (jsPDF) on demand;
server-emailed PDF attachments will come with the payments work.)
