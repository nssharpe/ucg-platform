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
| `20260702201710_payments_lines_snapshot.sql` | **Security hardening Phase 2 (C4/H4/H1).** Adds nullable `payments.lines_snapshot` (jsonb) — the validated, server-priced line set (`{id,kind,label,amount_cents,paid_cents,club_id,ref_*}[]`) frozen at checkout-session-create time (`paid_cents` — the POST-coupon per-line charge — added by emv2 P3 T6, 2026-07-10: it is the refund base in `process-refund`; `amount_cents` stays the PRE-discount list price used for `invoice_items`/receipts; pre-T6 snapshots lack it and refunds fall back to the invoice_item amount under the payment-level cap). `stripe-webhook` fulfills FROM this snapshot instead of re-reading client-writable `cart_items`, closing the TOCTOU where a line's refs could be mutated after create but before fulfillment (C4/H4). Because fulfillment no longer depends on `cart_items` being present, the webhook moves its atomic idempotency claim to the END (all writes idempotent), so a mid-fulfillment failure is retryable instead of leaving a stuck 'pending' payment (H1). Null for pre-deploy pending payments (webhook falls back to `cart_items` for those). **(applied 2026-07-02)** |
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
| `20260709210935_event_files_bucket.sql` | **Event-management v2 Phase 1, Task 4 (spec §C status card + §B4 "insurance certificate upload"): first private/RLS'd Storage bucket.** Creates PRIVATE bucket `event-files` (path convention `insurance/<event_id>/<filename>`; the earlier `brand` bucket, `20260708201845`, is public with no `storage.objects` policies at all). Write (insert/update/delete) restricted to admins + sanctioning (`is_admin() or coalesce(auth_has_role('sanctioning'), false)`) — the event owner uploads, host-club managers/event admins do not. Read (select) additionally reaches host-club managers (`manages_club((select host_club_id from events where id = (storage.foldername(name))[2]))`) and that event's `event_admins` grantees, every branch `coalesce`-wrapped fail-closed. See "Storage buckets" above. |
| `20260709211656_event_host_tools.sql` | **Event-management v2 Phase 1, Task 5 (spec §C): the host viewing page's three RPCs.** Same fail-closed authorization on all three (admins, sanctioning, `manages_club(host club)`, or an `event_admins` grantee for the event): `event_host_roster(p_event_id)` — SECURITY DEFINER, returns one row per non-refunded registration joined to `people`/`clubs` (reg identity + discipline/level/apparatus/session/paid state + the full athlete-detail column set from the admin CSV export: shirt, dietary, email, phone, emergency contact, student status, region) — a deliberate event-scoped RLS exception so a host can see athletes from every competing club, not just their own; `event_collected_total(p_event_id)` — sums non-refunded `invoice_items.amount` where `ref_event_id` matches (entry/change/addon lines are all written `kind='meet-entry'`; `kind='fee'` processing-fee lines never carry a `ref_event_id` so they're excluded structurally, plus a defensive `kind <> 'fee'`); `mark_medals_received(p_event_id)` — the host's one scoped write, `jsonb_set`s `owner_checklist.medalsTracking.hostReceived = true` (hosts can't UPDATE `events` directly). |
| `20260709214034_comm_log_event_id.sql` | **Event-management v2 Phase 1, Task 7 (spec §J): event-scoped communication's sent log.** Adds `comm_log.event_id` (text, FK → `events` on delete set null) + index `(event_id, sent_at desc)`, so `EventCommunicate.tsx`'s per-event "Sent log" can filter to one event. No RLS change needed — the existing own-or-admin read policy (`20260623000020_comm_log.sql`) already gives a host their own rows regardless of `event_id`. |
| `20260710020303_host_post_close_edit.sql` | **Event-management v2 Phase 1, Task 8 (final task, spec §C + Nate's 2026-07-09 scope answer): scoped post-regCloses host editing.** Adds `is_event_host(p_event_id)` — a shared SECURITY DEFINER predicate factored out of the repeated inline block in the two prior host-tools migrations (admin/sanctioning/`manages_club(host club)`/`event_admins` grantee; returns `false`, never raises/null, safe to inline directly in RLS). Uses it for three fixes/additions: (1) new `event_host_sessions_{insert,update,delete}` / `event_host_squads_{insert,update,delete}` policies on `event_sessions`/`squads` closing a T3-review gap — an `event_admins` grantee (no club management) saw the host `EventManage` UI but every save silently failed RLS, since `host_sessions`/`host_squads` only reach `manages_club(host_club_id)`; (2) new `event_host_scores_write` on `scores` (which carries `event_id` since the meet→event rename) extending write reach to `is_event_host(event_id)` — today's `scores_write` is role-gated only (`judge`/`meet-host`/admin), so a host-club manager/grantee with none of those app roles couldn't score their own event; (3) `guard_registration_paid`/`guard_registration_edit_lockout` (the two existing `registrations` triggers) now also treat a **transaction-local GUC** `app.event_host_write = 'true'` as privileged — set by the two new RPCs below right after their own auth succeeds, and nowhere else, so the new reach is exactly as wide as those vetted RPCs and no wider (a blanket `is_event_host()` bypass baked into the triggers themselves would have reopened self-serve `paid=true` for a host-club manager's OWN *other*, non-host club at the same event; see the migration's §4 comment for the full argument). Also adds the roster-edit RPC pair, never a direct `registrations` RLS grant: `host_upsert_registration(p_event_id, p_reg jsonb)` — authorizes `is_event_host`, gates to strictly after `events.reg_closes` UNLESS admin/sanctioning (who can already edit anytime via direct RLS), validates the athlete exists and the reg's `event_id` matches, then applies ONLY a fixed whitelist (`athlete_id`/`club_id`/`discipline`/`level_id`/`apparatus`/`apparatus_levels`/`session_id`/`partner_athlete_id`) — INSERT sets `paid := true` (host-added regs mirror the existing host-club-$0 rule: it's the host's own meet, no charge, no cart line), UPDATE never touches `paid`/`updated_pending`/`refunded`/`camp_survey`; `host_delete_registration(p_event_id, p_reg_id)` — same auth/gate, hard delete, deliberately NO refund/payment side effect (refunds are Phase 3, spec §H — the client warns explicitly before every roster mutation); `find_person_for_host(p_event_id, p_email)` — exact-email-only account lookup (mirrors `grant_event_admin`, no name search) so the roster tool's "add athlete by email" flow can resolve a person id. The club-membership gate (an active `club_memberships` row for the event's season) is enforced CLIENT-side in the add-athlete flow (`clubHasActiveMembership`/`seasonForDate`, Club.tsx's idiom) — deliberately not replicated in SQL, matching every other registration entry point's enforcement depth. Client: `EventHostPage`'s new "Competition setup" section (a link to `/events/:slug/manage`, unlocked once `now > event.regCloses`) + `RosterToolsCard` (grouped-by-club roster with inline level/apparatus/session editing, remove, and an "add athlete by email" form; a one-time-per-visit warning modal gates the first mutation). `EventManage`'s `canScore` gate also picked up `\|\| caps.isSanctioning` (previously admin/host-only, so a pure-sanctioning caller saw no score-entry/results links even though they could already write sessions/squads). |
| `20260710024630_addon_unit_fields.sql` | **Event-management v2 Phase 2, Task 1: per-unit add-on line fields.** Adds nullable `addon_size` + `addon_assignee` (`text`) to both `cart_items` and `invoice_items`. Phase 2 moves add-ons (banquet/t-shirt/banner/leo) from one cart line per add-on TYPE to one line per UNIT purchased (refund-ready) — `addon_size` carries the shirt/leo size for that unit, `addon_assignee` carries a banquet ticket's assignee (a person id, or the sentinel `'extra'` for unassigned). New per-unit lines use `InvoiceItem.kind:'addon'` with `refLineType` distinguishing `'tshirt'\|'banner'\|'banquet'\|'leo'`; the legacy `kind:'banquet'` enum value is untouched for old data. No RLS changes (existing `cart_items`/`invoice_items` policies are column-agnostic). Applied 2026-07-10 (during T3 verification — it had been written in T1 but not yet pushed; without it, per-unit addon cart writes failed with "Could not find the 'addon_assignee' column"). |
| `20260710151638_event_host_addons_and_camp_detail.sql` | **Event-management v2 Phase 2, Task 7 (final P2 task): host workbook needs — purchased add-ons + camp roster detail.** Applied 2026-07-10 (staging + prod, phase-end batch). `event_host_roster(p_event_id)` gains `dob`/`gender`/`camp_survey`/`created_at` (DROP+CREATE — a table function's column list can't change in place) so the host workbook's Camp roster sheet doesn't need a second query. New RPC `event_host_addons(p_event_id)` — same fail-closed authorization as `event_host_roster`/`event_collected_total` — returns one row per purchased add-on UNIT (t-shirt/leo/banquet; excludes `'banner'`, a flat per-event purchase) across every competing club, `not refunded`; no separate paid-status filter is needed since `invoice_items` rows are only ever written by `stripe-webhook` at fulfillment time. Returns both `addon_assignee` (banquet-only: a person id or `'extra'`) and `ref_user_id` (set only on an athlete's own t-shirt/leo self-purchase — club-manager t-shirt buys set neither) since the host workbook's camp per-athlete sheet needs the latter to attribute a purchased size to an athlete. |
| `20260710212354_refund_manager_role.sql` | **Event-management v2 Phase 3, Task 4 (refunds, spec §H): `refund_manager` app_role.** Own file (the enum-add-can't-share-a-transaction gotcha) — adds the value so the "Refund manager" role is grantable, gating the refund review queue built in T6. **Applied staging + prod 2026-07-11.** |
| `20260710212356_refunds_foundations.sql` | **Event-management v2 Phase 3, Task 4: refund data model + RLS foundations.** Adds `clubs.is_league_host` (boolean, default false — admin-set on exactly the league's own club via the clubs editor's "Is league host club" checkbox) and the `refund_requests` table (app-generated **text** id; one row per refund ask against either a registration entry fee (`kind='registration'`, `reg_id`) or a purchased add-on unit (`kind='addon'`, `invoice_item_id`); `payment_id` is **uuid** — `payments.id` is the lone uuid PK in the schema, everything else is app-generated text — caught at `db push` when the FK type mismatched; `reason` enum `injury`\|`illness`\|`bereavement`\|`other`; `status` `pending`\|`approved`\|`rejected`; `refund_amount_cents`/`stripe_refund_id` populated once processed). Refunds are only offered for events whose HOST club has `is_league_host` (`eventIsRefundEligible`, `src/lib/events-core.ts` — not enforced in SQL here, a later task's concern). RLS is **SELECT-only, fail-closed** — requester reads own rows (`requester_person_id = my_person_id()`), club managers read their club's rows (`manages_club(club_id)`), refund managers + admins read everything (`is_admin() or coalesce(auth_has_role('refund_manager'), false)`). **No INSERT/UPDATE/DELETE policies at all** — every write (request/approve/reject/process) happens via a SECURITY DEFINER RPC or service-role Edge Function in T5/T6, mirroring the `payments` table's server-only write model. **Applied staging + prod 2026-07-11.** |
| `20260710230000_refund_manager_review_reads.sql` | **Event-management v2 Phase 3, Task 6: refund-manager read access for the review queue.** The `refund_manager` role already reads every `refund_requests` row (T4), but is NOT implicitly an admin and has no other RLS branch (`is_admin()` / `athlete_id = my_person_id()` / `manages_club(...)`) to resolve an arbitrary member's purchase for review — `RefundReview.tsx` needs item labels/amounts and requester/athlete names. Adds three additive SELECT-only policies, each scoped via a join back to `refund_requests` (not a blanket league-wide grant): `invoice_items` (exactly the line stamped as `refund_requests.invoice_item_id` — both kinds stamp it, per `request-refund`'s registration-kind fix, commit `42f5776`), `invoices` (the parent of a visible `invoice_item`, needed because `syncFromSupabase`'s client-side stitching only attaches an item onto `db.invoices` when the invoice row itself is RLS-visible too), and `people` (the requester, or the athlete on a referenced registration). Admins already read all three via existing `is_admin()` branches; this only adds the `refund_manager` branch. **⚠ Superseded/hotfixed by `20260711023234` below** — the `invoice_items`/`invoices` policies this migration created caused RLS recursion; do not reason about those two policies from this migration's text alone. **Applied staging + prod 2026-07-11.** |
| `20260711022219_guard_registration_refunded.sql` | **Event-management v2 Phase 3, security review fix (post-T7, review of commit `21333eb`): DB-level lockout on refunded registrations.** "A refunded registration can't be re-enabled except by an admin" was UI-only (Club.tsx/MyRegistrations.tsx hide the controls) — `registrations` is member/club-manager writable under RLS, so a caller could hit PostgREST directly and flip `refunded:false`/`keep_listed:true` on their own row after a post-deadline partial refund. Adds a **sibling** trigger `guard_registration_refunded()` (BEFORE INSERT OR UPDATE, same event `guard_registration_paid` already fires on — kept separate rather than folded in, since `refunded`/`keep_listed` is a distinct invariant from the `paid`/`updated_pending` state machine and the paid guard's history is already a hard-won record of the upsert-trigger trap not worth re-touching). Same privileged bypass as the paid guard (`auth.role() is null or auth.role() = 'service_role' or is_admin()`) so admin re-enable (T7) and `process-refund`'s service-role write both pass. Non-privileged callers: re-SELECTs the pre-write row by `new.id` (never trusts `tg_op`/`OLD` — the app always whole-row-upserts, see `20260703034325`'s header) and rejects any change to `refunded` or `keep_listed` (including a fresh non-privileged INSERT setting either to `true` — correct, only service-role/admin paths ever set them). Safe against false rejections because `registrationToRow` (`src/lib/supabase.ts` ~line 250) always sends both columns explicitly on every upsert. **Applied staging + prod 2026-07-11.** |
| `20260711023234_fix_refund_manager_read_recursion.sql` | **HOTFIX for `20260710230000_refund_manager_review_reads.sql`: RLS policy recursion (42P17).** The pre-existing `invoice_items_read` policy checks its parent `invoices` row via subquery, and the new `invoices_refund_manager_read` policy (from the migration above) checked back into `invoice_items` via subquery — RLS policy subqueries run with the caller's own privileges, so evaluating either table's policies forced evaluating the other's, and Postgres detected the cycle and errored **42P17 for EVERY caller**, breaking ALL `invoice_items` reads project-wide (surfaced by the E2E suite against staging; prod had the same breakage for the few minutes before this hotfix landed). Fix: drops both cyclic policies and replaces their subqueries with two new SECURITY DEFINER helper functions — `refund_request_covers_item(iid)` / `refund_request_covers_invoice(inv)` — whose bodies run as the function owner and bypass RLS (the same reason `my_person_id()`/`manages_club()` are safe inside policies), so there's no policy re-entry. Grants/fail-closed pattern unchanged (PUBLIC execute revoked, `authenticated` granted). **Applied staging + prod 2026-07-11** (same day as the migration it fixes). |
| `20260711135842_emv2_p4_capacity_schema.sql` | **Event-management v2 Phase 4, Task 1: capacity & sessions — schema + TS plumbing foundation ONLY (no UI, no edge-function logic, no cap/waitlist enforcement — later P4 tasks).** Adds `events.registration_mode` (`text`, default `'by-discipline'`, CHECK `'by-discipline'\|'by-session'`) — `'by-session'` is the new mode where sessions are pre-created with per-apparatus routine caps and athletes register into a specific session. `events.capacity` already existed (`20260706193421`) — no new column, just a `comment on column` nailing down the counting rule the enforcement tasks will implement: `total` counts **ATHLETES** (competitions + camps, one athlete = one count regardless of apparatus entered), while `perDiscipline` (T&T) and `perLevel` (WAG/MAG) count **ROUTINES** (apparatus entries — one athlete entering 4 apparatus counts as 4). Adds `event_sessions.max_routines` (`jsonb`, null = uncapped; shape `{ [apparatusCode]: number }`, by-session mode only). Adds `registrations.waitlisted` (bool, default false), `waitlist_group_id` (`text` FK → `waitlist_groups` on delete set null), `hold_expires_at` (`timestamptz` — a soft 30-min cart-add hold, refreshed at checkout start; enforcement is a later task) plus a partial index `(event_id) where waitlisted` and an index on `waitlist_group_id`. New table **`waitlist_groups`** (app-generated **text** id, matching every other table except `payments.id`): grouped, all-or-nothing FIFO waitlist entries keyed by `event_id` + (`club_id` XOR `person_id` — a strict `(club_id is null) <> (person_id is null)` CHECK, security-relevant: allowing both would let a personal caller smuggle a club scope they don't manage past the per-branch policies) + `discipline` + optional `level_id`/`session_id`; `status` `text` CHECK `'waiting'\|'notified'\|'promoted'\|'cancelled'\|'expired'`; `queued_at` is the FIFO sort key, bumped to `now()` on re-queue (a lapsed 24h `hold_expires_at` promotion hold sends a group back to the end of the queue rather than deleting/recreating the row). RLS follows the `is_admin()`/`manages_club()`/`my_person_id()` SECURITY DEFINER helper pattern (no raw cross-table subqueries, avoiding the `20260710230000`/`20260711023234` 42P17 recursion trap), with each actor branch pinned to its own scope column (`club_id is not null and manages_club(club_id)` / `person_id is not null and coalesce(person_id = my_person_id(), false)`): SELECT/INSERT/UPDATE for admin, the club's manager, or the requesting person; INSERT additionally pins `status = 'waiting'` via WITH CHECK (clients cannot create a row in any other state). UPDATE is locked to **cancel-only, two layers**: a **column-level grant** — `grant update (status) on waitlist_groups to authenticated` — means clients can't touch `queued_at` (FIFO queue-jump) or `notified_at`/`hold_expires_at` (self-granted capacity reservation once enforcement counts notified holds), and the UPDATE policy's WITH CHECK pins the NEW row's `status = 'cancelled'` (WITH CHECK can't see the OLD row, but cancel-only needs no OLD-row visibility — it just constrains the new value). There is **no DELETE policy** — cancellation is that status UPDATE, and promotion/notify/expiry/re-queue transitions are service-role (Edge Function) only, bypassing RLS and column grants. Explicit `revoke all ... from public` + `grant select, insert ... to authenticated` + the status-only update grant. Consequence noted in code: `pushWaitlistGroup` (an upsert) is effectively insert-only for clients — its conflict-update path writes every column and is denied by the column grant. TS: `Event.registrationMode`/`Event.capacity` (doc-comment updated), `EventSession.maxRoutines`, `Registration.waitlisted`/`waitlistGroupId`/`holdExpiresAt`, new `WaitlistGroup` interface, `DB.waitlistGroups`; `src/lib/supabase.ts` gets `pushWaitlistGroup`/`deleteWaitlistGroup` (inline row type — table not yet in generated `database.types.ts`, same pattern as `rowToPayment`/`rowToEventAdmin`/`rowToRefundRequest`) and `loadAll` hydration. **Applied: staging 2026-07-12, prod 2026-07-13.** |
| `20260711175608_emv2_p4_hold_clamp.sql` | **Event-management v2 Phase 4, Task 3: hold-squat guard.** `registrations.hold_expires_at` (T1) is client-writable under the existing reg RLS — a malicious client could set a far-future value and squat a capacity spot without paying. New trigger `clamp_registration_hold()` (BEFORE INSERT OR UPDATE) clamps `new.hold_expires_at` to at most `now() + 30 minutes` when set past that; a null value (no hold) passes through untouched. No role check needed — legitimate server writes (`create-checkout-session`'s hold refresh, T3) never ask for more than 30 minutes either; the 24h waitlist-promotion hold lives on the separate `waitlist_groups.hold_expires_at` column, which clients can't write at all (T1's column-grant). Reads only `NEW`, no `OLD`/`tg_op` — exempt from the upsert-trigger trap. **Applied: staging 2026-07-12, prod 2026-07-13.** |
| `20260713140000_emv2_p5_session_requests.sql` | **Event-management v2 Phase 5, Task A1: nationals session-request survey — schema foundation ONLY (no UI, no edge-function/checkout logic — later P5 tasks A2/A3).** On `event.kind = 'nationals'` events, clubs and independent athletes each answer a "session-request survey" (spec §L.1/§E5.4) before the host finalizes session assignments: a club submits one survey per registered WAG level, plus one combined MAG survey and one combined T&T survey; an independent athlete submits one survey per discipline they're registered in. New table **`session_requests`** (app-generated **text** id): `event_id` FK → `events`; dual scope `club_id`/`person_id` with the same strict `(club_id is null) <> (person_id is null)` XOR CHECK as `waitlist_groups` (same rationale — prevents a personal caller smuggling a club scope they don't manage); `discipline` (existing `discipline` enum); `level_id` FK → `levels` (WAG club variant only, null for combined MAG/TNT and every independent survey); `answers` `jsonb` (free-form payload — arrival window/day, preferred session ids, separate-gyms preference, notes; kept jsonb rather than fixed columns so the A2 UI can refine the field set without another migration); `created_at`/`updated_at`. Unique index on `(event_id, coalesce(club_id,''), coalesce(person_id,''), discipline, coalesce(level_id,''))` — one survey per key, re-submission upserts. RLS follows the `is_admin()`/`auth_has_role()`/`manages_club()`/`my_person_id()` SECURITY DEFINER helper pattern (no raw cross-table subqueries — avoids the 42P17 recursion trap). Unlike `waitlist_groups` (cancel-only UPDATE), surveys are **fully editable** — SELECT/INSERT/UPDATE/DELETE all use the same actor predicate (admin, `auth_has_role('sanctioning')`, the club's manager, or the requesting person), with INSERT/UPDATE's WITH CHECK pinning each actor branch to its own scope column same as the SELECT read; no status to pin since there's no state machine here, just an editable payload. Explicit `revoke all ... from public` + `grant select, insert, update, delete ... to authenticated`. TS: `SessionRequestAnswers`/`SessionRequest` (`src/lib/types.ts`), `DB.sessionRequests`; `src/lib/supabase.ts` gets `rowToSessionRequest`/`pushSessionRequest`/`deleteSessionRequest` (inline row type — table not yet in generated `database.types.ts`) and `loadAll` hydration; pure helpers `requiredSessionRequests`/`sessionRequestAnswered`/`missingSessionRequests` in `src/lib/pricing.ts` (unit-tested, `tests/session-requests.test.ts`) for A2/A3 to reuse. **Applied staging + prod 2026-07-16.** |
| `20260713173105_emv2_p5_competition_order.sql` | **Event-management v2 Phase 5, Task B1: "Set Competition Order" data foundation ONLY (spec §E6) — no UI, no drag-and-drop logic (later P5 task B2).** Club-facing (MAG/WAG only, not T&T): a club manager picks a level, sees one column per apparatus, and drags athlete names into competing order; competition order within an apparatus splits into sections capped at 12 (WAG)/15 (MAG) per section, club-controlled. Adds `events.competition_order_locked` (`boolean`, default `false`) — a host/admin event-settings checkbox: once true, club managers can only view orders, only admins may still edit. New table **`competition_orders`** (app-generated **text** id): `event_id`/`club_id`/`level_id` FKs, `apparatus` `text` (matches `registrations.apparatus` codes), `sections` `jsonb` default `'[]'` — an array of arrays of registration ids, outer = section order, inner = competing order within that section, encoding both the athlete order AND the club's section split in one column (rewritten wholesale on every drag-drop save); `updated_at`. Unique index on `(event_id, club_id, level_id, apparatus)` — one row per key, re-saving upserts. New SECURITY DEFINER helper **`event_order_locked(eid)`** (fail-closed: `coalesce(...,true)` treats a missing event as locked, not open — unreachable via the NOT NULL FK, but the default matches the documented intent) gates writes in the RLS predicates below — same `is_admin()`/`auth_has_role()`/`manages_club()` helper idiom as `waitlist_groups`/`session_requests` (avoids the 42P17 recursion trap; `event_order_locked` reads `events` directly and `events`' own policies never read `competition_orders`, so no cycle). RLS: **SELECT** — admin, `auth_has_role('sanctioning')`, or the club's manager (a club can always view its own order, locked or not — view-only-after-lock is enforced by omitting write access, not by hiding the row). **INSERT/UPDATE/DELETE** — `is_admin() or (manages_club(club_id) and not event_order_locked(event_id))`, identical predicate on every clause (UPDATE's USING and WITH CHECK both use it, so a locked event's rows become fully read-only for club managers while admins can always edit). Explicit `revoke all ... from public` + `grant select, insert, update, delete ... to authenticated`. TS: `CompetitionOrder` interface + `Event.competitionOrderLocked` (`src/lib/types.ts`), `DB.competitionOrders`; `src/lib/supabase.ts` gets `rowToCompetitionOrder`/`pushCompetitionOrder`/`deleteCompetitionOrder` (inline row type — table not yet in generated `database.types.ts`) and `loadAll` hydration, plus `competition_order_locked` mapped in `eventToRow`/the events row mapper (same pattern as `registration_mode`). Content-validation trigger **`competition_orders_validate()`** (BEFORE INSERT OR UPDATE, SECURITY DEFINER — the guard-trigger idiom; reads only NEW so it's exempt from the upsert-trigger trap): RLS scopes WHO writes, this pins WHAT — `sections` must be an array of arrays of strings, no registration id twice, and every id must reference a registration of that row's event AND club (blocks a direct-PostgREST caller storing another club's reg ids that host tooling would then trust). Per-section 12/15 caps stay client-side (`sectionCap` — the cap depends on the app-code discipline taxonomy). Pure helpers `sectionCap`/`splitIntoSections`/`flattenSections`/`sectionsValid`/`moveInSections` in new module `src/lib/competition-order.ts` (unit-tested, `tests/competition-order.test.ts`) for the B2 UI to reuse. Also added the `@dnd-kit/core`+`@dnd-kit/sortable`+`@dnd-kit/utilities` dependency (React 19-compatible, no peer-dep issues) for B2's drag-and-drop UI. **Applied staging + prod 2026-07-16.** |
| `20260713174958_emv2_p5_finals_lineups.sql` | **Event-management v2 Phase 5, Task C1: "Finals roster" data foundation ONLY (spec §E7, §L.3) — no UI (later P5 task C2), no reminder/hard-lock scheduling logic (later P5 task C3).** A nationals team (club + level + placement category) picks up to 4 athletes per apparatus for finals, plus drag order. Adds `events.finals_roster_locked` (`boolean`, default `false`) — a **separate lock from `competition_order_locked`** (own hard-lock timing, 10pm day-1 per §L.3): once true, club managers can only view lineups, only admins may still edit. New table **`finals_lineups`** (app-generated **text** id): `event_id`/`club_id`/`level_id` FKs, `category` `text` (the nationals engine's `deriveCategory` output, e.g. `'Collegiate Women+'` — free text, no DB enum), `apparatus` `text`, `reg_ids` `jsonb` default `'[]'` — an ordered array of registration ids capped at 4 (finals competing order); `updated_at`. Unique index on `(event_id, club_id, level_id, category, apparatus)` — one row per key, re-saving upserts. New SECURITY DEFINER helper **`event_finals_locked(eid)`** (fail-closed `coalesce(...,true)`, missing event = locked) mirrors `event_order_locked(eid)` exactly — same `is_admin()`/`auth_has_role()`/`manages_club()` idiom, avoids the 42P17 recursion trap. RLS is the identical shape to `competition_orders`: **SELECT** — admin, `auth_has_role('sanctioning')`, or the club's manager (view-only-after-lock via omitted write access, not row hiding). **INSERT/UPDATE/DELETE** — `is_admin() or (manages_club(club_id) and not event_finals_locked(event_id))` on every clause. Explicit `revoke all ... from public` + `grant select, insert, update, delete ... to authenticated`. TS: `FinalsLineup` interface + `Event.finalsRosterLocked` (`src/lib/types.ts`), `DB.finalsLineups`; `src/lib/supabase.ts` gets `rowToFinalsLineup`/`pushFinalsLineup`/`deleteFinalsLineup` (inline row type — table not yet in generated `database.types.ts`) and `loadAll` hydration, plus `finals_roster_locked` mapped in `eventToRow`/the events row mapper (same pattern as `competition_order_locked`). Content-validation trigger **`finals_lineups_validate()`** (BEFORE INSERT OR UPDATE, SECURITY DEFINER, reads only NEW — same idiom as `competition_orders_validate()`): `reg_ids` must be a JSON array of at most 4 distinct strings, each referencing a registration of that row's event AND club. Pure helpers `FINALS_LINEUP_MAX`/`finalsLineupValid`/`moveInLineup`/`toggleInLineup` in new module `src/lib/finals-lineup.ts` (unit-tested, `tests/finals-lineup.test.ts`) for the C2 UI to reuse. Also extracted a shared Telnyx SMS transport, `supabase/functions/_shared/telnyx.ts` (`toE164`/`sendSmsBatch`), out of `send-sms/index.ts` so the C3 scheduler (no admin JWT, service-role only) can send finals-lineup reminder texts through the same Telnyx call shape; `send-sms` now imports from the shared module instead of duplicating it, behavior unchanged. **Applied staging + prod 2026-07-16.** |
| `20260716084700_emv2_p5_finals_deadline.sql` | **Event-management v2 Phase 5, Task C3: finals-lineup deadline nag + hard lock.** Adds `events.finals_lineup_deadline_at` (`timestamptz`, nullable) — the admin-set finals-lineup submission deadline instant (spec §L.3 "9pm Friday deadline"). Being a `timestamptz`, the scheduler does zero timezone math — it just compares to `now()`. `scheduled-dispatch` gets a new consumer: for every `kind = 'nationals'` event whose deadline has passed, it (1) derives missing team-apparatus finals lineups by replicating `src/lib/nationals-teams.ts`'s `eligibleTeams` + `src/lib/nationals-adapter.ts`/`src/nationals/categories.ts`'s `deriveCategory` inline (edge functions can't import from `src/`) and diffing against `finals_lineups` rows with a non-empty `reg_ids` for that exact `(club_id, level_id, category, apparatus)` key, then (2) for clubs with ≥1 missing lineup, emails + SMS-texts that club's managers (idempotent via `claimNotifications`/`releaseClaims` under kinds `finals-lineup-nag-email`/`finals-lineup-nag-sms`, same as the existing owner-task/sanction consumers; SMS reuses `_shared/telnyx.ts`, respects the opt-out `sms_consent` model), and (3) once `now() >= deadline + 1h`, idempotently flips `finals_roster_locked` to `true` (a plain `update ... where finals_roster_locked = false`, no notification-log claim needed since the update itself is the idempotency guard). Per-team session-timed reminders (5 min after a team's last session, the Friday-10am-last-session special case, and the day-1 8pm open reminder) are explicitly DEFERRED — they depend on the §L.2 session-assignment tool, which Julia marked incomplete/skip-for-now. TS: `Event.finalsLineupDeadlineAt` (`src/lib/types.ts`); `src/lib/supabase.ts` maps `finals_lineup_deadline_at` in both the events row mapper and `eventToRow` (identical nullable-timestamptz pattern to `last_date_to_edit`/`lastDateToEdit` — cast, since the column isn't in generated `database.types.ts` yet). `EventWizard.tsx` gets a checkbox+datetime-local input (`hasFinalsDeadline`/`finalsLineupDeadlineAt`) in the nationals-only "Finals & qualification" section, following the `hasEditLockout`/`lastDateToEdit` pattern exactly. **Applied staging + prod 2026-07-16.** |
| `20260716085950_emv2_p5_event_checkins.sql` | **Event-management v2 Phase 5, Task E1 (final P5 task, spec §L.4): nationals check-in flow.** League/meet admins OPEN check-in for a club (or an independent athlete) at an event; the club manager (or the athlete themself) then confirms with a checkbox + typed signature ("Your club is checked in"/"You are checked in"). New table **`event_checkins`** (app-generated **text** id): `event_id` FK → `events`; dual scope `club_id`/`person_id` with the same strict `(club_id is null) <> (person_id is null)` XOR CHECK as `waitlist_groups`/`session_requests`; `status` `text` CHECK `'open'\|'checked-in'` (a row EXISTS only once opened — "no row" IS the not-yet-opened state, no separate boolean needed); `signed_name`, `checked_in_at`, `checked_in_by` (FK → `people`, who confirmed), `opened_by` (FK → `people`, the admin who opened it). Unique index on `(event_id, coalesce(club_id,''), coalesce(person_id,''))` — one row per scope, re-opening upserts. RLS follows the `is_admin()`/`auth_has_role()`/`manages_club()`/`my_person_id()` SECURITY DEFINER helper pattern (no raw cross-table subqueries — avoids the 42P17 recursion trap). **SELECT** — admin, sanctioning, the club's manager, or the scoped person. **INSERT — admin/sanctioning ONLY** (WITH CHECK also pins `status = 'open'`) — opening check-in is an admin/league action; a club cannot self-open. **UPDATE** — same actor predicate as SELECT on both USING and WITH CHECK (the confirming club/athlete needs to reach its own row), WITH CHECK additionally re-pins `status in ('open','checked-in')`; the REAL guard against a club editing `event_id`/`club_id`/`person_id`/`opened_by` (or self-opening) is a **column-level grant** — `grant update (status, signed_name, checked_in_at, checked_in_by) on event_checkins to authenticated` — mirroring `waitlist_groups`' `grant update (status)` pattern, since RLS alone restricts which ROWS are writable, not which COLUMNS. **DELETE** — admin only (undo an erroneous open). Explicit `revoke all ... from public` + `grant select, insert ... to authenticated` + the column-scoped update grant. TS: `EventCheckin` interface (`src/lib/types.ts`), `DB.eventCheckins`; `src/lib/supabase.ts` gets `rowToEventCheckin`/`eventCheckinToRow`/`pushEventCheckin`/`confirmEventCheckin`/`deleteEventCheckin` (inline row type — table not yet in generated `database.types.ts`) and `loadAll` hydration. Client: `EventCheckinCard` (`src/components/EventCheckinCard.tsx`) mounted on `Club.tsx` (club scope), `MyRegistrations.tsx` (independent-athlete scope), and an admin "Open check-in" list + view-as selector on `Events.tsx`'s `EventDetail` (reusing the D1 `NationalsAdminViewCard` scope-selector pattern) — all gated on `event.kind === 'nationals'` to keep check-in scoped to P5, though the underlying feature isn't nationals-specific by spec. **Applied staging + prod 2026-07-16.** |
| `20260716120000_emv2_p6_finance_foundations.sql` | **Event-management v2 Phase 6, Task T1: finance-dashboard foundations (spec §M) — schema/RLS only, no UI (later P6 tasks).** Two new tables, both plain admin/finance_admin CRUD (unlike `payments`/`refund_requests`, no server-only write model): **`accounting_codes`** (app-generated **text** id) — a lookup mapping an app-defined `item_key` (unique, e.g. `'membership'`, `'meet-entry:entry'`, `'addon:tshirt'`) to an external `code` (e.g. QuickBooks) + optional `label`, so the dashboards can group revenue by accounting code. **`host_payouts`** (app-generated **text** id) — a manual record of money paid OUT to an event host club (payouts happen outside Stripe): `event_id` FK → `events`, `amount_cents`, `method` CHECK `'check'\|'paypal'\|'ach'`, `reference` (check #/PayPal txn/ACH ref, free text), `paid_on` `date`, `notes`, `created_by` (person id, not a strict FK — same convention as `refund_requests.reviewed_by`). RLS on both: **all four policies (SELECT/INSERT/UPDATE/DELETE, kept separate per the RLS-upsert-trap rule) share one predicate** — `coalesce(is_admin(), false) or coalesce(auth_has_role('finance_admin'), false)` — using the existing `is_admin()`/`auth_has_role()` SECURITY DEFINER helpers (0002_rls.sql), no new helper functions, no raw cross-table subqueries. Explicit `grant select, insert, update, delete on accounting_codes, host_payouts to authenticated`. Also adds **five new additive `..._finance_read` SELECT policies** (`payments_finance_read`, `invoices_finance_read`, `invoice_items_finance_read`, `refund_requests_finance_read`, `people_finance_read`) granting `finance_admin` the same read reach admins already have on those tables via existing policies — pure OR-widening, existing policies untouched, no recursion risk since `auth_has_role` is SECURITY DEFINER. No new grant statements were added for those five tables: grepping all prior migrations (incl. `20260625231808`, which created `payments`) found no explicit `grant ... to authenticated` on any of them — they've always relied on the project's default Supabase schema privileges (set once at project setup, outside migration history) plus RLS as the only real gate, so the new finance_admin policies ride on that same existing table privilege. TS: `AccountingCode`/`HostPayout` types (`src/lib/types.ts`), `DB.accountingCodes`/`DB.hostPayouts`; `src/lib/supabase.ts` gets `rowToAccountingCode`/`accountingCodeToRow`/`pushAccountingCode`/`deleteAccountingCode` and `rowToHostPayout`/`hostPayoutToRow`/`pushHostPayout`/`deleteHostPayout` (inline row types — tables not yet in generated `database.types.ts`) and `loadAll` hydration. **Applied staging + prod 2026-07-16.** |
| `20260717140238_mfa_aal2_admin_enforcement.sql` | **Auth hardening (MFA Phase B): aal2-conditional `is_admin()`.** Redefines `is_admin()` so a caller with a verified MFA factor (`auth.mfa_factors`, `status='verified'`) must present an `aal2` JWT; a caller with no factor is unaffected (keeps seeded dev/E2E users + not-yet-enrolled admins working — enrollment is opt-in client-side). Supabase-documented conditional pattern; whole expression `coalesce(..., false)` fail-closed (missing `aal` claim + verified factor ⇒ deny). Pairs with the client step-up interstitial (`MfaChallenge`) and the edge-function AAL guard (`_shared/aal-guard.ts`) — see "Auth: MFA" section below. **Applied staging + prod 2026-07-17.** |

> **Naming note (rename applied 2026-06-27):** the schema descriptions above that
> predate these two migrations still say `meets`/`meet_id`/`ref_meet_id`/
> `registrations.events`/`scores.event` — those are now `events`/`event_id`/
> `ref_event_id`/`registrations.apparatus`/`scores.apparatus`. The app's realtime helper
> `subscribeMeetScores` is now `subscribeEventScores` (filter `event_id=eq.…`). See
> `docs/specs/2026-06-26-events-rename-and-registration-flow.md`.

All migrations are applied to the live project and tracked by the linked CLI
(`supabase db push`) — the P4 pair (`20260711135842_emv2_p4_capacity_schema`,
`20260711175608_emv2_p4_hold_clamp`) was applied to staging 2026-07-12 and
prod 2026-07-13. Migrations are append-only —
add new ones rather than editing applied files. See `../CLAUDE.md` for the
enum-add transaction gotcha.

### Storage buckets

| Bucket | Public? | Purpose | Write access | Read access |
|--------|---------|---------|---------------|-------------|
| `brand` | Public | Static brand assets (licensed webfonts, logos) served at `/storage/v1/object/public/brand/…`. | No `storage.objects` write policies — service-role/CLI only. | Public (bucket-level). |
| `event-files` | **Private** | Event-owner-checklist files — currently insurance certificates, path convention `insurance/<event_id>/<filename>` (`event_id = (storage.foldername(name))[2]`). First private/RLS'd bucket in the project. | INSERT/UPDATE/DELETE: admins + sanctioning-team only (`event_files_{insert,update,delete}`, `20260709210935_event_files_bucket.sql`). | SELECT: admins, sanctioning, the event's host-club managers (`manages_club`), or that event's `event_admins` grantees (`event_files_select`) — all fail-closed via `coalesce`. |

`event-files` is accessed exclusively via signed URLs (`insuranceCertificateUrl()`,
~10 min expiry) — there is no public path. Uploads go through
`uploadInsuranceCertificate(eventId, file)` (`src/lib/supabase.ts`), which client-side
validates extension (`pdf`/`jpg`/`jpeg`/`png`) and a 10MB cap before calling
`supabase.storage.from('event-files').upload(...)`; the storage RLS policy is the real
enforcement boundary. `OwnerChecklistCard`'s `insurance` task (`src/pages/Events.tsx`)
is the current writer; `InsuranceCertificateLink` (module-scope, same file) is a
reusable "View certificate" link that resolves the signed URL on click, meant to be
reused by the upcoming host-facing status page (spec §C).

## Edge Functions (`functions/`)

Deno functions deployed with `supabase functions deploy <name> --project-ref <ref>`.
Email goes through **Resend** (HTTP API) via the shared helper `functions/_shared/resend.ts`
(`resendFrom`/`sendOne`/`sendBatch`); secrets `RESEND_API_KEY` / `RESEND_FROM`. SMS goes
through **Telnyx** (`send-sms`). The old `GMAIL_*` secrets are unused (rollback only).
Front-end invokers live in `src/lib/supabase.ts`. The notify-style functions allow any
signed-in caller and resolve recipients server-side with the service role; `send-email`
is the only *league-wide* admin-gated sender — `send-event-email` (below) is scoped to
one event and also admits sanctioning/hosts/event-admin grantees.

| Function | Purpose | Caller |
|----------|---------|--------|
| `send-email` | Communicate broadcast / test sender (Resend batch, 50-recipient cap). (AAL guard) | admin only |
| `send-event-email` | Event-scoped communication (event-mgmt v2 §J): emails one event's registrants, filtered by role (athlete/manager/clubEmail) + session/level/discipline. Recipients resolved server-side from `registrations`/`people`/`club_managers`/`clubs` (service role) — the client never supplies a recipient list. `test:true` sends ONLY to the caller's own auth email. Shares the pure filter/dedupe helpers in `_shared/event-comm.ts` with the client (`EventCommunicate.tsx`). Same 50-recipient cap pattern as `send-email`. **`verify_jwt` stays `true`** — NOT one of the three-function `--no-verify-jwt` set below. **Email only** — SMS deliberately stays league-admin-only (controller/Nate decision 2026-07-09, deviation from spec §J); the admin SMS toggle on the same page reuses `send-sms` with client-resolved recipients instead. | admin / sanctioning / host-club manager / event_admins grantee (AAL guard) |
| `send-sms` | Communicate text sender (Telnyx); records sent messages to `sms_messages`. (AAL guard) | admin only |
| `sms-webhook` | Inbound Telnyx webhook: DLRs → `sms_messages` status, inbound replies → store + email admins, STOP → `sms_consent` off. Verifies Telnyx Ed25519 signature (`TELNYX_PUBLIC_KEY`). | Telnyx (no JWT; signature-verified) |
| `record-waiver-signature` | Server-stamps real IP into `waiver_signatures`, activates membership (club-pay rows → `pending-club-payment`; returns `pendingPayment`). The no-login (token) path stamps `signer_role` from the request row, not the request body. | signed-in owner (JWT, no token) / no-login token (self or guardian) |
| `request-guardian-waiver` | Creates a signing token + emails a minor's guardian the link. | signed-in owner |
| `create-waiver-link` | Mints a no-login waiver signing link for a member (admin "Activate" popup — email or copy). Takes optional `signerRole: 'self'\|'guardian'` (default `'guardian'`) stored on the request row. Returns `{token, link, signerRole}`. (AAL guard) | admin / club manager |
| `notify-club-cart` | Emails a club's managers when a member pushes fees to the cart. | any signed-in member |
| `send-membership-welcome` | "Welcome to UCG" email for a no-club member's FIRST membership-only purchase, CC'ing the region's regional-team address and naming its Regional Leader(s). Re-checks no-club + not-Outside-US server-side; resolves region (`STATE_REGIONS[state]`), reps (`regional_rep` role ∩ `regional_rep_regions`), and CC address server-side. | any signed-in member (self only) |
| `send-club-invite` | Invite a coach (signup) or a member (purchase membership) by email. (AAL guard) | club manager / admin |
| `invite-account` | Create an account + email a branded set-password link (Resend). Used by club "Add athlete"/"Add coach" (`roles` set to match kind). (AAL guard) | club manager / admin |
| `request-manager-access` | "Request Club Admin Role": records `manager_access_requests` + emails the requested club's managers (admins only if the club has none yet) a no-login review link; first responder approves/denies. | any signed-in member |
| `notify-manager-access-denied` | Emails the requester that their Club Admin request was not approved. Token-gated (deploy `--no-verify-jwt`); resolves recipient server-side; fails closed unless the request is `denied`. | no-login (secret token) |
| `notify-sanction` | Sanction lifecycle emails (submitted → team+admins; approved/rejected → requester). | any signed-in member |
| `create-checkout-session` | Stripe Embedded Checkout. As of **S4** generalized to **every** cart-line kind (membership / club-membership / member-targeted membership / meet entry / change fee / addon) for **both** self carts and manager-paid club carts. **Recomputes** all amounts server-side (cart `amount` never trusted) — season fees + existing memberships for memberships; meet config (honoring host-club $0) keyed on the new `ref_meet_id`/`ref_line_type` tags for entries/changes/addons — adds the service fee (`processingFee`), creates the session (`ui_mode:'embedded'`, no redirect), inserts a `pending` `payments` row. Returns `{ clientSecret, sessionId, paymentId }`. **emv2 P3 free-order path:** if a coupon fully covers the cart (post-discount total is exactly $0), the function skips Stripe entirely — inserts the `payments` row with `stripe_session_id: null`, calls the new shared `fulfillPayment` (`_shared/fulfill.ts`) directly, retries once inline on failure, logs to `error_logs` and returns 500 (no stranded pending order) if the retry also fails — and returns `{ free: true, paymentId }` instead of a client secret; FE `CartCheckout.tsx` has a `'free'` stage that polls the payment row to `paid` instead of mounting Stripe Embedded. | any signed-in member (own cart) / club manager (club cart) |
| `request-refund` | Refund REQUEST (emv2 P3, spec §H): inserts a `refund_requests` row (service role is the only writer — the table's RLS is SELECT-only) and emails the requester + refund managers (falls back to admins if none are set up). Auth is fail-closed and server-computed from the caller's own `people`/`club_managers` rows — self-owner of the registration/purchase, or a manager of the owning club. Only offered for events whose host club has `clubs.is_league_host = true`. Rejects a duplicate pending/approved request against the same item (409). `verify_jwt` stays `true`. | any signed-in member (self) / club manager |
| `process-refund` | Refund review + Stripe processing (emv2 P3, spec §H, T6): `reject` (email only, no state change) or `approve` — refund base is the snapshot line's post-coupon `paid_cents` from `payments.lines_snapshot` (falls back to the `invoice_items.amount` list price for pre-T6 snapshots), 100% at-or-before `events.last_date_to_edit` else 75%, capped at `payment.amount_subtotal` minus already-approved refunds against that same payment (`refund_requests.refund_amount_cents` sum). Atomically claims the request (`status: pending → approved`, conditional update) **before** calling `stripe.refunds.create` on the original `payment_intent`, so a concurrent retry can't double-refund; on Stripe failure the claim is reverted to `pending` and logged to `error_logs`. A $0-capped approval (e.g. a fully-couponed order) skips the Stripe call. On-time approval **deletes** the registration (scores cascade via FK); post-deadline approval sets `refunded: true, keep_listed: true`, blanks `apparatus`/`apparatus_levels`/`partner_athlete_id`. Auth: `refund_manager` or `admin` role only, fail-closed. `verify_jwt` stays `true`. | refund manager / admin (AAL guard) |
| `scheduled-dispatch` | Invoked every 15 min by the `scheduled-dispatch-15min` pg_cron job. Two consumers: (1) sanction-vote reminder emails (3-day / 1-day / voting-closed nudge) to Sanctioning Team + admins who haven't voted; (2) event-owner task escalation emails (`owner-task` kind, event-mgmt v2 §B4) — for every non-camp event with an assigned `owner`, walks the 7 `owner_checklist` tasks (skips `done` ones), computes each task's due date via `_shared/owner-checklist.ts`, and emails the owner at the 1-week/1-day/daily-overdue stages. Both idempotent via `notification_log`. Gateway keeps `verify_jwt = true`, AND the function itself requires the bearer token to equal `SUPABASE_SERVICE_ROLE_KEY` exactly (or the `x-cron-secret` header) — no user-JWT path. | pg_cron only (service-role bearer) |
| `report-problem` | In-app "Report a problem" (nav-drawer entry, Layout.tsx sidebar footer). Validates category (`bug`/`question`/`unsure`) + description (≤5000 chars) + ≤10 recent-error strings (≤500 chars each, from the client's `report-error.ts` ring buffer) + route/appVersion. Reporter identity (name/email) is resolved server-side from the caller's JWT/`people` row — never trusted from the payload. Routes to a hardcoded recipient map at the top of the function (`bug`→Nate+Julia, `question`→the `+ucghelp` aliases, `unsure`→all four); sends one email via `renderEmail`, `reply_to` set to the reporter so replies land with them. Accepts optional image `attachments` (≤3, jpeg/png/webp, ≤2MB each post-client-compression, magic-byte-verified + filename-sanitized via `_shared/attachment-validation.ts`; client compresses to ≤1600px JPEG q0.8 in `src/lib/image-resize.ts`) forwarded to Resend. `verify_jwt` stays `true` (not part of the no-verify-jwt trio). | any signed-in user |
| `admin-reset-mfa` | Auth-hardening break-glass (Phase B): deletes ALL of a target auth user's MFA factors via the admin API (`auth.admin.mfa.listFactors`/`deleteFactor`) and emails them a notice. Takes `targetUserId` or `targetEmail`. Used by the Members page "Reset 2FA" action for someone who lost their authenticator/passkey. **AAL-guarded** (`_shared/jwt-aal.ts`, mirrors the hardened `is_admin()` migration): an MFA-enrolled admin caller must present an `aal2` JWT or gets 403 — closes the stolen-aal1-JWT → strip-own-factors → pass-is_admin() bypass. `verify_jwt` stays `true`. | admin only (aal2 if enrolled) |
| `stripe-webhook` | The sole completer for PAID orders. Verifies the Stripe signature with `constructEventAsync` against `STRIPE_WEBHOOK_SECRET` (**fail-closed** if unset). On `session.completed`/`async_payment_succeeded`, looks up the real processing fee from the balance transaction and the M5 amount-reconciliation assertion, then delegates the actual fulfillment (flip `registrations.paid` via `ref_reg_ids`, activate membership(s)/club memberships, write the paid invoice, clear cart lines, email the payer a receipt, camp-details block, coupon redemption) to the shared **`fulfillPayment`** core (`_shared/fulfill.ts`, emv2 P3 — extracted verbatim from the webhook so the new $0-total free-order path in `create-checkout-session` can call the identical logic; semantics unchanged, still idempotent via `fulfilled_at`). On `expired`/`async_payment_failed` → mark `failed`. | Stripe (no JWT; deploy `--no-verify-jwt`; signature-verified) |

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
on that legacy client-side path). **In-app refunds shipped (emv2 P3, 2026-07-11)** — see
`request-refund`/`process-refund` above (100%/75% by `last_date_to_edit`, refund base +
payment-level cap, `refund_manager` role, `#/admin/refunds` review page; only for events
hosted by an `is_league_host` club). A Dashboard-issued refund (bypassing this flow) still
does not reflect back into `payments.status`/fulfillment.

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
  `meet-nat26.tshirt_addon.lastPurchaseAt` is set to `2027-06-30T23:59:00Z`
  (2026-07-10): the seeded cart's t-shirt line outlives the event's past
  `reg_closes` under the P2 per-type deadline enforcement — without it the
  cart-checkout E2E spec fails with "purchase window has closed".
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
- **refund_manager** — a `user_roles` row (emv2 P3); reviews the refund queue at
  `#/admin/refunds` via `RequireRefundAccess` (`isAdmin() || isRefundManager()`).
  Admins are NOT implicitly refund managers, but the `process-refund`/`request-refund`
  functions accept either role/fall back to admins for notification recipients.
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

## Auth: MFA / aal2-for-admins (added 2026-07-17)

TOTP (+ passkey, if the SDK/project support it) MFA is opt-in for everyone via
Profile → "Two-factor authentication" (`src/pages/ProfileMfa.tsx`), enroll/
challenge/verify through `supabase.auth.mfa.*` / `supabase.auth.webauthn.*`.
Design doc: `docs/research/2026-06-22-auth-2fa-passkeys.md`.

- **Sign-in step-up:** `App.tsx` renders `MfaChallenge` (outside the router,
  like the existing auth-flash gate) whenever the live session is `aal1` but
  the account has a verified factor (`nextLevel === 'aal2'`) —
  `needsMfaStepUp()` in `src/lib/mfa-core.ts`. A no-factor account (every
  seeded dev/E2E user) never sees it.
- **RLS enforcement:** migration `20260717140238_mfa_aal2_admin_enforcement`
  hardens `is_admin()` — an admin with a verified factor must present an
  `aal2` JWT for `is_admin()` to return true; an admin with no factor is
  unaffected. Fail-closed (`coalesce(..., false)`). **Applied staging + prod
  2026-07-17** (E2E green against staging post-apply — seeded no-factor users
  unaffected).
- **Edge-function AAL guard (swept 2026-07-17):** privileged functions
  authorize via the service-role client and so bypass the RLS-level
  `is_admin()` hardening — each now calls the shared
  `requireAalForEnrolledCaller` (`functions/_shared/aal-guard.ts`, pure logic
  in `_shared/jwt-aal.ts`, vitest-covered) right after its existing
  auth+role gate: any caller with a verified MFA factor must present an aal2
  JWT or gets 403 (unenrolled callers untouched; factor-list failure → 500,
  fail closed). Guarded: `admin-reset-mfa`, `send-email`, `send-sms`,
  `send-event-email`, `invite-account`, `create-waiver-link`,
  `send-club-invite`, `manage-waitlist`, `process-refund` — the "(AAL
  guard)" markers in the function table above. The no-verify-jwt trio and
  recipient-resolution-only functions are deliberately excluded.
- **Admin reset (break-glass):** `#/admin/members` → "Reset 2FA" calls the
  `admin-reset-mfa` edge function (admin-only), which deletes every one of the
  target's MFA factors via the service-role admin API and emails them a
  notice. **If the only remaining admin locks themselves out** (loses their
  device and no other admin can run the reset for them), the fallback is the
  **Supabase dashboard**: Auth → Users → find the user → delete their MFA
  factor there directly. There is no in-app recovery-code story (Supabase
  doesn't provide one) — this dashboard path is the true last resort.

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
- **Waitlist promotion sweep** (event-mgmt v2 P4 T7): per event with live
  `waitlist_groups`, pass 1 resolves `notified` groups (regs no longer
  waitlisted → `promoted`; hold lapsed → requeued to the back with a
  "hold lapsed" email), then pass 2 promotes `waiting` groups in strict
  `queued_at` FIFO using the shared `_shared/capacity.ts` `checkCapacity`
  engine — a group that doesn't fit blocks its violated cap DIMENSIONS
  (total / level / discipline / session+apparatus) for the rest of that
  event's sweep so no later group can jump the queue within a contended
  dimension, while groups on disjoint dimensions may still promote.
  Promotion sets `notified` + a hold of min(now+24h, `last_date_to_edit`)
  and emails the group contact (club managers / the person, resolved
  server-side via `_shared/waitlist-contacts.ts`); events past
  `last_date_to_edit` are skipped entirely. Status transitions are atomic
  conditional updates (`eq('status', …)`), so overlapping runs / a
  concurrent admin override can't double-claim; emails are best-effort
  (a missing Resend config never breaks the sweep). Admin override +
  read-only queue live in the `manage-waitlist` function (actions
  `promote` — force-notify IGNORING capacity — and `requeue`, both
  admin/sanctioning-only; action `list` is readable by
  admin/sanctioning/host-club managers/event-admin grantees and backs the
  event page's Waitlist card, since `waitlist_groups` RLS only exposes a
  group to its own club/person).

All consumers dedupe idempotently (via `notification_log` where email is the
state, via conditional status claims for the waitlist sweep) and are isolated
in their own try/catch so one consumer's failure can't take down another.

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

## Data backups (since 2026-07-11)

`node scripts/backup-db.mjs` dumps every row of every `public`/`auth`/`storage`
table (both envs) to gzipped JSON in the Dropbox-synced folder
`C:\Users\nssha\Steinsharpe Dropbox\Nate Sharpe\ucg-db-backups\` (offsite via
Dropbox), keeping the newest 14 per env. A Windows scheduled task
(**"UCG DB Backup"**, daily 03:00, runs only while Nate is logged in;
`schtasks /query /tn "UCG DB Backup"`) runs it automatically.

- **Scope:** data only — schema is recreated from `supabase/migrations/`;
  Storage bucket **file bytes** are NOT included (only `storage.objects`
  metadata). Brand fonts have their Dropbox source; `event-files` uploads
  (insurance certs) would need re-upload after a total loss.
- **Creds:** direct-connection passwords in `.env.local` — `STAGING_DB_PASSWORD`
  and `PROD_DB_PASSWORD` (both present since 2026-07-17; if `PROD_DB_PASSWORD`
  is ever removed, prod is skipped with a warning).
- **TLS:** fully verified — `scripts/supabase-prod-ca-2021.crt` (Supabase's
  public root CA, committed to the repo 2026-07-17). If the file is deleted the
  script warns and connects encrypted-but-unverified.
- Verified live 2026-07-17: prod 74 tables / 3,990 rows + staging dumps, no TLS
  warning.
- This is interim insurance for the dev/test phase only — **Supabase Pro
  backups/PITR remain the hard pre-flight gate before real money** (go-live
  checklist).

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
