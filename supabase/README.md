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
| `20260628125200_waiver_sign_request_names.sql` | Recreates `get_waiver_sign_request` to join `people` and return `first_name`/`last_name`, so the direct-link waiver signing page can enforce the same name-match validation as the inline purchase flow. **Applied 2026-06-28.** |
| `20260702012205_coupon_event_scope_and_payment_code.sql` | Adds `coupons.applies_to_event_id` (scopes a promo code to one specific event — hard-expires the day after that event ends) and `payments.coupon_code` (carries an applied code through to `stripe-webhook`, which writes it onto `invoices.coupon_code` and calls `redeem_coupon`). **Applied 2026-07-02.** |
| `20260702033412_cart_items_prior_reg_snapshot.sql` | Adds nullable `cart_items.prior_reg_snapshot` (jsonb) — a snapshot of the affected `registrations` row(s)' pre-change values, captured when a `kind=meet-entry`/`ref_line_type=change` cart item is created. Lets removing that cart item revert the registration(s) to their prior state (`src/lib/cart-sync.ts` `removeCartItemWithSync`) instead of leaving them mutated/orphaned. Null for non-change items and rows predating this feature. **Applied 2026-07-02.** |
| `20260702182709_pin_search_path.sql` | **Security hardening Phase 1 (M3).** Pins `SET search_path = public, pg_temp` on `auth_has_role`/`is_admin`/`my_person_id`/`manages_club`/`link_or_create_person` (bodies unchanged — `CREATE OR REPLACE`, no shape change). `redeem_coupon` is pinned separately in `…coupons_lockdown.sql` since it's being recreated there anyway. **(applied 2026-07-02)** |
| `20260702182710_guard_membership_writes.sql` | **Security hardening Phase 1 (C1).** `BEFORE INSERT OR UPDATE` trigger on `memberships`: non-privileged callers (not admin/service-role/direct-DB) can't set `status='active'`, `paid_via` in `('card','comp')`, or a non-null `waiver_signed_at` that doesn't match a real `waiver_signatures` row for that person+season. Allows the legitimate whole-row rewrite the app write-through always does (only rejects actual *transitions*), and allows the one legitimate client self-sign case (Membership.tsx `complete('club')` stamping `waiverSignedAt` right after a real `record-waiver-signature` call). **(applied 2026-07-02)** |
| `20260702182711_guard_registration_paid.sql` | **Security hardening Phase 1 (C2).** Same trigger pattern on `registrations`: non-privileged callers can't transition `paid` to `true` except (a) the computed fee is genuinely zero (host-club OR an admin-configured $0 event — checked directly against `events.entry_fee`/`second_discipline_fee`/`change_fee`, not just host-club-equality) or (b) a legitimate `prior_reg_snapshot` revert, identified by `paid` flipping false→true paired with `updated_pending` flipping true→false in the same statement (`src/lib/cart-sync.ts` `removeCartItemWithSync`'s `revert-registration` branch). To stop that revert-signature being *staged* in two writes, a non-privileged `updated_pending` false→true (or INSERT true) is itself rejected unless paired with `paid` going true→false in the same statement — the only way any legit path sets it (a chargeable edit re-pending an already-paid reg). **(applied 2026-07-02)** |
| `20260702182712_mar_token_exposure.sql` | **Security hardening Phase 1 (C3).** Drops `mar_read` on `manager_access_requests` (confirmed unused by any requester-facing UI — the review page only calls the token-gated RPCs) and replaces it with an admin-only read policy, closing the raw-PostgREST token read. Recreates `decide_manager_access` (body otherwise identical) adding a belt-and-braces check: returns `'invalid'` when the caller is signed in and is the request's own requester. **(applied 2026-07-02)** |
| `20260702182713_coupons_lockdown.sql` | **Security hardening Phase 1 (H2).** Drops `public_read_coupons` (confirmed no member-facing coupon read exists — only the admin-gated Promos UI and `loadAll`, which tolerates an RLS-filtered empty result). Recreates `redeem_coupon(p_code, p_person_id default null)` — adds the active-window (`starts_at`/`ends_at`) and `restricted_to_person_id` checks, keeps the atomic `used_count < max_uses` bump, and pins `search_path`. The optional trailing param keeps the currently-deployed `stripe-webhook`'s 1-arg call (`redeem_coupon(p_code)`) working unchanged; Phase 2 can start passing the payer's person id when it redeploys the webhook. Revokes `EXECUTE` from `PUBLIC` (and `authenticated`) — a fresh function grants EXECUTE to PUBLIC by default and all roles inherit it, so revoking only `authenticated` would leave the grant intact — then grants back to `service_role` only (confirmed the client-side `redeemCoupon()` export has zero callers — dead code from the retired Membership.tsx direct-pay coupon UI). **(applied 2026-07-02)** |
| `20260702182714_club_memberships_insert_lockdown.sql` | **Security hardening Phase 1 (H3).** Drops the `manages_club(club_id)` branch from `club_mem_insert`, leaving admin-only INSERT. Confirmed no legitimate client manager INSERT path exists — the only UI wired to `pushClubMembership` is the admin-only "Grant (admin)" button; the manager-facing "Purchase" button pushes a cart line instead, and `stripe-webhook` (service role) creates the row on fulfillment. **(applied 2026-07-02)** |
| `20260702201710_payments_lines_snapshot.sql` | **Security hardening Phase 2 (C4/H4/H1).** Adds nullable `payments.lines_snapshot` (jsonb) — the validated, server-priced line set (`{id,kind,label,amount_cents,club_id,ref_*}[]`) frozen at checkout-session-create time. `stripe-webhook` fulfills FROM this snapshot instead of re-reading client-writable `cart_items`, closing the TOCTOU where a line's refs could be mutated after create but before fulfillment (C4/H4). Because fulfillment no longer depends on `cart_items` being present, the webhook moves its atomic idempotency claim to the END (all writes idempotent), so a mid-fulfillment failure is retryable instead of leaving a stuck 'pending' payment (H1). Null for pre-deploy pending payments (webhook falls back to `cart_items` for those). **(applied 2026-07-02)** |
| `20260703034325_fix_guard_registration_paid_upsert.sql` | **Bug fix, `guard_registration_paid` (20260702182711).** That trigger trusted `tg_op`/`OLD` to detect "is this really an update of an existing row" — but the app never issues plain UPDATEs to `registrations`; `pushRegistration` always whole-row-upserts (`INSERT ... ON CONFLICT (id) DO UPDATE`), and Postgres fires the row-level BEFORE INSERT trigger unconditionally while considering the insert candidate (`tg_op='INSERT'`, `OLD=NULL`) *before* the conflict is resolved. That made Allowance 2 (snapshot revert) and the "paid staying true, no real transition" skip permanently unreachable for any upsert of an already-paid, non-host/non-free registration — discovered live via the B8 fix below (an apparatus-only edit failed to save because it re-asserts an unchanged `paid=true`). Fixed by explicitly re-`SELECT`ing the row by `id` at the top of the function instead of trusting `tg_op`/`OLD` — every existing allowance (privileged bypass, fee-zero check, snapshot-revert pairing, staging-bypass guard) is otherwise unchanged. **(applied 2026-07-03)** |
| `20260703035157_email_has_account.sql` | **Feedback tracker B8.** Adds `email_has_account(p_email text) returns boolean` — a no-login, security-definer RPC checking `auth.users` (not `people`, since "has an account" means "can sign in") so the sign-in gate can show "No account exists for that email" instead of a generic wrong-password error on a failed sign-in. Account-enumeration via this check is an accepted tradeoff (confirmed with Nate) — it returns only a boolean. Granted to `anon`/`authenticated`. **(applied 2026-07-03)** |
| `20260703221303_fix_club_managers_self_lockout.sql` | **Bug fix, discovered live while consolidating the club edit UI (B8).** `pushClub()` always re-synced `club_managers` via a plain client-side delete-then-insert under RLS (`cm_write: using/with check (manages_club(club_id))`), and `manages_club()` is `stable` + queries `club_managers` live — so a non-admin manager saving their OWN club: the DELETE ran while still authorized and wiped every row for that club (including their own), then the INSERT of the replacement rows re-evaluated `manages_club()` as now-FALSE and was rejected, leaving the club with **zero managers** and no clear error. Fixed with `replace_club_managers(p_club_id, p_person_ids)` — a security-definer RPC that checks authorization ONCE up front, then deletes+inserts atomically server-side (the client's `pushClub` now enqueues this as a new `'rpc'` write-op kind instead of the old `remoteReplace`). Admins were never affected (`manages_club()` includes `is_admin()`, unaffected by `club_managers`' contents). **(applied 2026-07-03)** |
| `20260703221855_clubs_manager_update.sql` + `20260703222142_clubs_manager_upsert_fix.sql` + `20260703223152_clubs_manager_no_delete.sql` | **Bug fix, also discovered live via the same B8 work.** `clubs` had only `public_read` (select) and `admin_all` (`is_admin()`) — no policy ever let a non-admin club manager write their OWN club row, even though Club.tsx's "Edit club details" button is shown to any manager (`canManage = actingAsAdmin || managedClubIds.includes(club.id)`). The first migration added an UPDATE-only policy, which was insufficient: `pushClub` writes via `.upsert()` (`INSERT ... ON CONFLICT DO UPDATE`), and Postgres RLS still requires an applicable INSERT policy's `with check` to pass for the candidate row even on the conflict-update path. The second migration widened the policy to `for all` (`manager_all`) to cover the INSERT-phase check too — but adversarial review flagged that `for all` also grants DELETE, which nothing in the app needs (no `remoteDelete('clubs', ...)` caller exists) and shouldn't be reachable by a non-admin (cascades to `club_managers`/`cart_items`/`club_memberships`/etc.). The third migration narrows it to separate `manager_insert` (insert) + `manager_update` (update) policies, dropping the DELETE grant — a genuinely new club id still can't be created by a non-admin (`manages_club()` is false for a club they don't yet manage) or admin-only deleted, only the upsert-of-an-existing-managed-club case is newly allowed. **Verified live at each step**: before this set, ANY non-admin manager save of "Edit club details" silently failed end-to-end; after, saves persist correctly with least-privilege grants. **(applied 2026-07-03)** |
| `20260704015242_sms_consent_opt_out_model.sql` (empty no-op, stray file from an interrupted command) + `20260704015417_sms_consent_opt_out_model.sql` | **SMS consent model change: opt-in → opt-out.** Nate confirmed with Julia that SMS is now covered by the liability waiver signed at registration, so the explicit opt-in checkbox is removed from Profile.tsx. `people.sms_consent` default flipped from `false` to `true`; existing rows backfilled to `true` EXCEPT anyone who has already sent a STOP-family reply (matched via `sms_messages`, inbound, normalized last-10-digits phone — mirrors `sms-webhook`'s `findPeopleByPhone`/`normalizePhone`, no SQL equivalent existed). `sms-webhook`'s STOP handling is completely UNCHANGED — it remains the only way to become ineligible, a CTIA/TCPA requirement independent of how consent was obtained. Client-side: `personToRow` (`src/lib/supabase.ts`) now defaults a brand-new person's `sms_consent` to `true` (was silently forcing `false` on every insert, which would have overridden the new column default and left new signups permanently ineligible); `partitionByConsent` (`src/lib/sms-send.ts`) now excludes only explicit `false` instead of requiring strict `true`. **(applied 2026-07-04)** |
| `20260704035120_event_status_draft_live_only.sql` + `20260704035144_event_status_backfill_live.sql` | **Feedback tracker B4 (1 of 4).** Simplifies `events.status` from a 5-value manually-flipped enum (`draft`/`reg-open`/`reg-closed`/`in-progress`/`complete`) to just `draft`/`live` — the real-time phase is now DERIVED from `reg_opens`/`reg_closes`/`start_date`/`end_date` at read time (`deriveEventPhase` in `src/lib/events-core.ts`), not manually set. Root cause: the ACTUAL registration-gating logic (`Club.tsx`) trusted the manually-flipped `status` field and completely ignored the already-present `reg_opens`/`reg_closes` timestamps (previously cosmetic-only, used just for date-badge coloring) — an admin had to remember to flip status, and a forgotten flip silently kept registration open past the deadline (or required a manual "Override: reopen reg" button, now removed since editing `reg_closes` via the normal "Edit event" flow achieves the same declaratively). First migration adds `'live'` to the `event_status` enum (its own transaction, per the documented enum-gotcha); second backfills every non-draft row to `'live'` (they were all "published" under the old model) — the old enum values are NOT removed from the Postgres type (can't cheaply drop enum values) but the app never writes them again. Adversarially reviewed (no findings) and verified live: edited an event's `regCloses` via the normal edit flow and confirmed the registration-open badge/CTA flipped automatically with no manual override. **(applied 2026-07-04)** |
| `20260704041049_event_last_date_to_edit.sql` | **Feedback tracker B4 (2 of 4).** Adds optional `events.last_date_to_edit` (nullable timestamptz, default NULL = no lockout). Past this date, only an admin or the event's HOST club's managers may still edit a registration — enforced server-side by a new `guard_registration_edit_lockout()` trigger (BEFORE INSERT/UPDATE/DELETE on `registrations`), mirroring `guard_registration_paid`'s established pattern exactly: privileged bypass FIRST (`auth.role() is null or 'service_role' or is_admin()`, so `stripe-webhook`'s post-payment writes are never blocked even if they land after the deadline), then re-`SELECT`s the pre-write row by `id` explicitly (not `tg_op`/`OLD`) to correctly detect a real edit vs. a genuinely new registration under the app's whole-row-upsert write pattern — the exact same upsert-trigger-phase trap `guard_registration_paid` hit once already (see `20260703034325`). DELETE is included (Club.tsx's saveRegs deletes rows for deselected disciplines, which is as much an edit as an UPDATE). Client-side UX mirror: `canStillEditRegistration()` (`src/lib/events-core.ts`, unit tested) hides the Edit button and shows "Edit locked"/"Edit deadline passed" in Club.tsx/MyRegistrations.tsx — NOT the authoritative gate, just avoids a confusing failed-save. Adversarially reviewed (no findings) and verified live: set a past deadline, confirmed a non-host club manager sees "Edit locked" while an admin still sees "Edit". **(applied 2026-07-04)** |
| `20260704044529_sync_synchro_partner_level.sql` + `20260704133502_fix_sync_synchro_auth_null_bypass.sql` + `20260704133734_sync_synchro_revoke_public_grant.sql` | **Feedback tracker B4 (4 of 4, final sub-item).** T&T synchro ("SY") same-level auto-sync: whoever actively selects a partner sets the SY level for BOTH (Nate: "if A is HF and selects B (previously NF), the pair gets registered ... as a High Flyer synchro pair" — not a validation, an active push). A new `sync_synchro_partner_level(p_my_reg_id, p_sy_level)` SECURITY DEFINER RPC exists because the caller (an athlete saving their own registration, or their club manager) generally lacks RLS write access to the PARTNER's own registration row (a different athlete, often a different club) — the RPC re-derives the partner from the caller's OWN just-saved registration and re-authorizes server-side before updating only that row's `apparatus_levels->>'SY'` key. **CRITICAL bug caught by adversarial review in the first draft**: the auth check `if not (is_admin() or athlete_id = my_person_id() or manages_club(club_id))` copied the `regs_write` RLS policy's EXPRESSION but not its fail-CLOSED semantics — for an anonymous caller `my_person_id()` is null, so the OR-chain evaluates to Postgres's three-valued NULL (not false), and `if not NULL` does not raise, silently ALLOWING the write; since the function is SECURITY DEFINER this bypassed RLS entirely. Fixed by wrapping the predicate in `coalesce(..., false)` (verified live: the same anon-equivalent call now correctly raises "not authorized"); a follow-up migration also revoked the default Postgres `PUBLIC` execute grant and the unneeded `anon` grant (defense-in-depth; the real fix is the coalesce, this alone would not have closed the hole). `registrations_edit_lockout`/`guard_registration_paid` still apply to this RPC's UPDATE (SECURITY DEFINER changes the executing role for permission checks, not what `auth.uid()`/`is_admin()`/`manages_club()` read). Deliberately leaves `paid`/`updated_pending` untouched (a free administrative sync, matching the B8 apparatus-tweak-is-free precedent) — flagged for Nate as a minor economic asymmetry (a level change that would be chargeable through the front-door editor is free via this sync onto an already-paid partner), not a security issue. **(applied 2026-07-04)** |
| `20260703132252_add_fee_invoice_item_kind.sql` | **Bug fix: missing cents in Purchase History/receipts.** Adds `'fee'` to the `invoice_item_kind` enum (shared by `invoice_items.kind` and `cart_items.kind`). Entry/membership/change fees are always whole-dollar configured amounts — the Stripe service fee (3%+$0.30) was the only source of cents in what a customer actually paid, but it was shown at checkout and in the receipt EMAIL only, never persisted as its own `invoice_items` row, so Purchase History / the receipt PDF / the invoice detail modal always summed to a whole-dollar total. `stripe-webhook`'s `fulfill()` now also writes a `kind:'fee'` line (`ii-<payment.id>-fee`, deterministic/idempotent) whenever `payments.service_fee > 0`. No charge/fee calculation changed — this only adds a previously-missing line for money already collected. **(applied 2026-07-03)** |
| `20260706192423_notification_log.sql` | **Event-management v2 Phase 0.** `notification_log` — dedupe/idempotency ledger for scheduled/automated notifications (`id` = deterministic `'<kind>:<ref_id>:<recipient>'`, unique `(kind, ref_id, recipient)`). Service-role only: RLS enabled with NO policies, and default `public`/`anon`/`authenticated` grants revoked. First consumer: `scheduled-dispatch`'s sanction-vote reminder emails. |
| `20260706192445_scheduled_dispatch_cron.sql` | **Event-management v2 Phase 0.** The platform's first scheduled job: `pg_cron`/`pg_net` extensions + a `scheduled-dispatch-15min` cron job (`*/15 * * * *`) that POSTs to the `scheduled-dispatch` Edge Function with a service-role bearer token, both read from Supabase Vault (`project_url`/`service_role_key` — NOT hardcoded, NOT created by this migration). Idempotent: unschedules any existing same-named job first. See "Scheduled dispatch (pg_cron)" below for the manual per-environment secret setup + verification queries. |
| `20260706193421_event_v2_fields.sql` | **Event-management v2 Phase 0, Task 2 (spec §A).** Adds scalar `events.venue`/`street_address`/`country`/`hotel_link`/`age_calc_at`, plus jsonb `late_reg` (`{startsAt, fee}` — fee in dollars, matching the `entry_fee`/`change_fee` convention), `director` (`{name, email, ccOnConfirmation}` — now general to all events, not camp-only), `capacity` (`{total?, perDiscipline?, perLevel?}` — stored only, NOT enforced yet), and `confirmation_email` (`{bodyHtml, fromAlias?, replyTo?}`). Backfills `director`/`age_calc_at` from `camp_config`'s `directorName`/`directorEmail`/`directorCcOnConfirmation`/`ageCalcAt` for existing rows, then strips those four keys from `camp_config` (nulling it out if that leaves it empty). Fields and config only in this migration — no cap enforcement (still stored-only). Late-fee **pricing** behavior (once-per-athlete surcharge, server-recomputed in `create-checkout-session`) shipped in Task 3 with no additional migration — see `docs/README.md`'s emv2 P0 Task 3 note. |
| `20260708191920_scheduled_dispatch_cron_secret.sql` | **Scheduler auth fix.** Re-schedules `scheduled-dispatch-15min` to ALSO send an `x-cron-secret` header (Vault secret `cron_secret`, matching the function's `CRON_SECRET` secret) — the bearer-equals-`SUPABASE_SERVICE_ROLE_KEY` check 403'd every run on both envs because the Edge runtime's env key ≠ the legacy service-role JWT on new-API-key projects. See "Scheduled dispatch (pg_cron)" below. **Applied staging + prod 2026-07-08.** |
| `20260708201845_create_brand_storage_bucket.sql` | **2026 rebrand.** Creates the public `brand` storage bucket (upsert, `public=true`) for static brand assets — currently the licensed Greed/Suisse woff2 webfonts served via `/storage/v1/object/public/brand/fonts/…` (see `docs/specs/2026-07-08-ucg-rebrand.md`; font files must never be committed to the repo per EULA). Public read only; no `storage.objects` write policies, so uploads are service-role/CLI only (`supabase storage cp … ss:///brand/… --experimental`). **Applied staging + prod 2026-07-08** (fonts uploaded to prod only — the app hardcodes prod URLs). |
| `20260709131708_event_owner_checklist.sql` | **Event-management v2 Phase 1, Task 1 (spec §B3-4).** Adds `events.owner` (`{userId?, name, email}` or null) and `events.owner_checklist` (jsonb, keyed by task id — see `supabase/functions/_shared/owner-checklist.ts`). Extends write reach to sanctioning-team members alongside the existing admin/host policies (predicate everywhere: `is_admin() or coalesce(auth_has_role('sanctioning'), false)`): `sanctioning_update` + `sanctioning_insert` on `events` (INSERT is required because `pushEvent` saves via whole-row upsert — the RLS upsert trap: the conflict-update path must still pass an INSERT policy's WITH CHECK; no DELETE granted on events), and per-command `sanctioning_sessions_{insert,update,delete}` / `sanctioning_squads_{insert,update,delete}` on `event_sessions`/`squads` (pushEvent rewrites them via delete+insert `remoteReplace`, which the host/admin-only `host_sessions`/`host_squads` policies would otherwise reject for a pure-sanctioning caller; per-command rather than `for all` so each grant is explicit). Adds `list_sanctioning_team()` — SECURITY DEFINER, fail-closed, revokes the PUBLIC execute grant — returning the sanctioning+admin roster (`user_roles` joined to `people` on `auth_user_id`) for the owner-assign dropdown. `events.created_at` already existed (from the original `meets` table); no backfill needed. |
| `20260709133846_event_admins.sql` | **Event-management v2 Phase 1, Task 3 (spec §C): per-event admin grants.** New `event_admins` table (`id` text PK app-style, `event_id` → `events` cascade, `user_id` uuid, `email`, `name`, `granted_by`, unique `(event_id, user_id)`) — a net-new per-event ACL giving another ACCOUNT the same host-level access to ONE event (surfaced through `isEventHost()` in `capabilities-core.ts`). RLS is **read-only** (select for admins, sanctioning, the granted user themselves, or `manages_club(host club)`; whole predicate fail-closed via `coalesce`); there are NO insert/update/delete policies — all writes go through two SECURITY DEFINER RPCs mirroring `replace_club_managers` (authorize ONCE up front, fail-closed, `set search_path`, PUBLIC execute revoked): `grant_event_admin(p_event_id, p_email)` (authorized for admins / host-club managers / existing event admins of that event; exact case-insensitive email match on `people` with `auth_user_id is not null`, raises `No account found for that email.` otherwise; upserts on the unique pair and returns the matched identity — deliberately NO name-substring search, PII decision) and `revoke_event_admin(p_event_id, p_user_id)` (same authorization; deletes the row). |

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
| `scheduled-dispatch` | Invoked every 15 min by the `scheduled-dispatch-15min` pg_cron job. Two consumers: (1) sanction-vote reminder emails (3-day / 1-day / voting-closed nudge) to Sanctioning Team + admins who haven't voted; (2) event-owner task escalation emails (`owner-task` kind, event-mgmt v2 §B4) — for every non-camp event with an assigned `owner`, walks the 7 `owner_checklist` tasks (skips `done` ones), computes each task's due date via `_shared/owner-checklist.ts`, and emails the owner at the 1-week/1-day/daily-overdue stages. Both idempotent via `notification_log`. Gateway keeps `verify_jwt = true`, AND the function itself requires the bearer token to equal `SUPABASE_SERVICE_ROLE_KEY` exactly (or the `x-cron-secret` header) — no user-JWT path. | pg_cron only (service-role bearer) |
| `stripe-webhook` | The sole completer. Verifies the Stripe signature with `constructEventAsync` against `STRIPE_WEBHOOK_SECRET` (**fail-closed** if unset). On `session.completed`/`async_payment_succeeded` runs **idempotent** fulfillment (event-id + `fulfilled_at` guarded) for all line kinds (S4): flip the exact `registrations.paid` via `ref_reg_ids`, activate membership(s) + club memberships, write the paid invoice with the **real** `stripe_fee` (billed to the **club** via `invoices.club_id` for club carts, to the payer for self carts), clear cart lines, email the **payer** a receipt (the paying manager for a club cart). On `expired`/`async_payment_failed` → mark `failed`. | Stripe (no JWT; deploy `--no-verify-jwt`; signature-verified) |

Stripe functions share `functions/_shared/stripe.ts` (Stripe client via `npm:stripe`,
fetch HTTP client, SubtleCrypto provider, and `processingFee`/all-line-kind pricing
mirroring `src/lib/pricing.ts` + the meet config). Secrets: `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET` (test values first). Register the webhook endpoint
`https://<ref>.supabase.co/functions/v1/stripe-webhook` for events
`checkout.session.{completed,async_payment_succeeded,async_payment_failed,expired}`.
**S4 status:** both functions are generalized to all cart-line kinds + club carts and are
**deployed + verified live** (test mode); the `cart_items`/`invoice_items`
`ref_event_id` + `ref_line_type` columns are live.

**S5 (finance wiring + go-live):** the webhook already records `invoices.stripe_fee` +
`invoices.stripe_payment_intent_id` (real cents from the balance txn); S5 closed the FE gap
where `supabase.ts` dropped those columns, so **Phase 5 finance now reads the real fee**.
Go-live (swap test→live keys + webhook secret, $1 smoke test + refund, payout/bank check) is
a documented runbook: [`../docs/stripe-go-live-checklist.md`](../docs/stripe-go-live-checklist.md).
**Promo codes at Stripe checkout (2026-07-02):** `create-checkout-session` now validates +
applies a coupon server-side, scoped to matching cart line(s) via `Coupon.appliesTo`
(`any`/`athlete-membership`/`club-membership`/`coach-membership`/`meet-entry` +
`appliesToEventId` for one specific event — hard-expires the day after that event ends,
regardless of `endsAt`). `payments.coupon_code` carries it to the webhook, which writes
`invoices.coupon_code` and calls `redeem_coupon`. See CLAUDE.md's "Promo codes at Stripe
checkout" entry for the full design.

**Still deferred:** moving `Membership.tsx` direct card-pay to Stripe (coupons already work
on that legacy client-side path), and an in-app admin refund path (today refunds are issued
**manually in the Stripe Dashboard** — a Dashboard refund does not yet reflect back into
`payments.status`/fulfillment; sketch in the checklist).

## Auth email templates (repo-managed since 2026-07-08)

Supabase Auth's transactional emails (confirmation / invite / magic link / recovery /
email change / reauthentication) are **no longer Dashboard-managed**. They render from
the SAME shared layout as the Resend emails and live in the repo:

- `scripts/render-auth-email-templates.mts` imports `_shared/email-layout.ts`
  (via `node --experimental-strip-types`) and generates `supabase/templates/*.html`
  (Go-template vars like `{{ .ConfirmationURL }}` left intact). Never hand-edit the
  generated HTML — change the copy in the script or the design in `email-layout.ts`,
  regenerate, and push. Restyling the Resend wrapper therefore also restyles Auth
  emails **after a regenerate + config push**.
- `supabase/config.toml` declares the subjects + `content_path`s; apply with
  `supabase config push` (prod, linked project). Verified live 2026-07-08 (recovery
  email received with branded body; template-content propagation to the running auth
  service takes ~5 min — subjects are near-instant).

**⚠ `config push` traps (bit us live 2026-07-08):**
1. It pushes CLI **defaults for every key you did NOT declare** in the section — the
   first push reset prod `site_url`/`additional_redirect_urls`/`enable_confirmations`/
   `otp_length`/MFA to localhost defaults for a few minutes. That's why `config.toml`
   mirrors the full intended `[auth]` config; keep every key in it deliberate.
2. Under agent/CI detection the CLI **auto-confirms** the diff prompt, and a closed
   stdin (`</dev/null`) makes the `[Y/n]` prompt default to **Yes** — so `--agent no
   </dev/null` is NOT a dry-run (it applied once, 2026-07-09). The only safe dry-run
   is an EXPLICIT decline: `echo n | supabase config push --agent no` — read the
   printed diff before any real push.
3. CLI **v2.107 silently skipped template `content`** (pushed subjects only) — fixed
   by v2.109. Keep the CLI current before template pushes.
4. **Staging is a no-op:** free tier + default email provider → Supabase 400s the
   whole auth-config update ("Email template modification is not available for free
   tier projects"). Staging keeps GoTrue default templates and its old
   `site_url` (localhost:3000); the `[remotes.staging]` block in config.toml becomes
   usable only if staging gets custom SMTP/paid plan.

## Staging project (`ucg-staging`, since 2026-07-04)

A second Supabase project in the NAIGC org — ref **`xogpiksqtkayxwmczlbx`** — so
migrations and E2E tests stop hitting prod first. The CLI stays **linked to prod**;
target staging explicitly:

- **Migrations:** `supabase db push --db-url "postgresql://postgres:$STAGING_DB_PASSWORD@db.xogpiksqtkayxwmczlbx.supabase.co:5432/postgres" --include-all`
  (password + keys live in gitignored `.env.local` under `STAGING_*`).
- **Ad-hoc SQL:** `supabase db query --db-url ... -f <file>` — ONE statement per call
  (the CLI uses a prepared statement; multi-statement scripts must be split).
- **Functions:** all 15 deployed with `--project-ref xogpiksqtkayxwmczlbx`; the same
  three (`stripe-webhook`, `sms-webhook`, `notify-manager-access-denied`) need
  `--no-verify-jwt`, same non-sticky trap as prod.
- **Secrets:** `RESEND_API_KEY`/`RESEND_FROM`/`STRIPE_SECRET_KEY` mirror prod (test
  keys); `APP_PUBLIC_URL=http://localhost:5177`; `STRIPE_WEBHOOK_SECRET` is
  staging-specific — a dedicated Stripe **test** webhook endpoint
  (`STAGING_STRIPE_WEBHOOK_ENDPOINT_ID` in `.env.local`) points at the staging
  functions URL. Telnyx secrets are NOT set (SMS untested on staging).
- **Seeded state:** demo seed pushed via Admin → Demo tools → `pushAll`, plus the
  three dev test-auth users (same emails/passwords as prod, staging-specific auth
  UUIDs in `.env.local`) with the `.jtmp/seed-dev-users.sql` fixtures adapted:
  `dev-club`, Dev Athlete (active s26 membership + 2-line cart, $60), Dev Manager
  (manages `dev-club`), Dev Admin (`admin` role). `scores` realtime is enabled.
- **App against staging:** `.env.staging.local` (gitignored) holds the staging
  VITE_ vars; `npm run dev -- --mode staging` (launch config `ucg-staging`,
  port 5177). Playwright E2E boots its own on 5178.
- **Fresh-backend boot order gotcha:** seed `seasons` BEFORE any sign-in. A signed-in
  boot against a season-less backend crashes (`Layout.tsx` assumes a current season
  exists), and the first sign-in's `link_or_create_person` row defeats
  `syncFromSupabase`'s empty-remote guard, wiping the local seed you'd push from.

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

## Scheduled dispatch (pg_cron)

`supabase/migrations/20260706192445_scheduled_dispatch_cron.sql` schedules a
`pg_cron` job named **`scheduled-dispatch-15min`** that runs every 15 minutes
(`*/15 * * * *`) and, via `pg_net.http_post`, POSTs an empty JSON body to
`<project_url>/functions/v1/scheduled-dispatch` with an
`Authorization: Bearer <service_role_key>` header. The Edge Function fans out
to whatever scheduled work exists:

- **Sanction-request voting reminders** (3 days / 1 day before
  `sanction_requests.deadline_at`, plus a "voting closed" nudge at the
  deadline) to Sanctioning Team + admins who haven't yet voted.
- **Event-owner task escalation** (`owner-task` kind, event-mgmt v2 §B4): for
  every competition/sanctioned event (camps are skipped — no host to
  shepherd) with an `events.owner` assigned, walks the 7
  `events.owner_checklist` tasks, skipping any already marked `done`. Each
  task's due date comes from the pure `_shared/owner-checklist.ts`
  (`ownerTaskDueDate`); `ownerReminderStage` maps (now, due) to `'1w'` / `'1d'`
  / a daily `'overdue-YYYY-MM-DD'` stage. The owner gets one email per
  (event, task, stage) — the date-keyed overdue stage makes "once per day
  while overdue" naturally idempotent via `notification_log`
  (`ref_id = '<eventId>:<taskId>:<stage>'`), same pattern as the sanction
  consumer.

Both consumers dedupe idempotently via `notification_log` and are isolated in
their own try/catch so one consumer's failure can't take down the other.

**Three secrets, created manually per environment** (NOT via migration — the
migrations only read them). **All set up in both envs 2026-07-08.**

```sql
select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
select vault.create_secret('<service-role-key>', 'service_role_key');
select vault.create_secret('<random 64-hex>', 'cron_secret');
```

plus the matching function secret (SAME value as `cron_secret`):

```
supabase secrets set CRON_SECRET=<same value> --project-ref <ref>
```

Run once against prod (`wkyerxlgricfphopocoz`) and once against staging
(`xogpiksqtkayxwmczlbx`) with each project's own URL/key/secret.

**Verify the job is scheduled and running:**

```sql
select * from cron.job;
select * from cron.job_run_details order by start_time desc limit 5;
-- and the function's actual HTTP responses (200 = healthy; 403 = auth broken):
select status_code, left(content, 120) from net._http_response order by id desc limit 3;
```

**Critical:** `scheduled-dispatch` must stay `verify_jwt = true` at the
gateway — unlike `stripe-webhook`/`sms-webhook`/`notify-manager-access-denied`,
it does NOT get `--no-verify-jwt`. The gateway's JWT check alone isn't the
real authorization boundary though — the function itself requires EITHER the
bearer token to equal its `SUPABASE_SERVICE_ROLE_KEY` env OR the
`x-cron-secret` header to equal its `CRON_SECRET` secret (fail-closed, no
user-JWT path). The `x-cron-secret` path is the one that actually works in
practice: on projects with new-style API keys the Edge runtime's
`SUPABASE_SERVICE_ROLE_KEY` does NOT equal the legacy service-role JWT the
cron sends as its bearer — every run 403'd in both envs until migration
`20260708191920` added the header (observed live 2026-07-08).

## Observability

- `comm_log` — every Communicate send; surfaced in Communicate → "Communication history".
- `error_logs` — front-end errors (via `report-error.ts` sink + `window` handlers in
  `main.tsx`); surfaced in the admin **Error Log** page (search by user email). See
  `docs/research/2026-06-22-error-logging-observability.md`.

## Not covered yet (future migrations)

Payments are **built and deployed in test mode** (Stripe Embedded Checkout, Phases S1–S5 —
`payments`/`invoices`/`cart_items` tables + the `create-checkout-session`/`stripe-webhook`
functions above; finance fee/payment-intent wiring done; security hardening Phases 1–2
applied). Remaining before real money flows: Nate runs the go-live checklist (live keys).
Still future: a membership-expiry notification consumer on the new `scheduled-dispatch`
job (see "Scheduled dispatch (pg_cron)" above — the scheduler infra now has two
consumers: sanction-vote reminders and event-owner task escalation), scheduled database
backups, and the public API surface for other leagues. (Waiver e-signature **is** built — migrations 0010–0030 +
`record-waiver-signature` / `request-guardian-waiver`; it stores a structured signature
evidence record. PDF proof and receipts are generated **client-side** (jsPDF) on demand;
server-emailed PDF attachments will come with the payments work.)
