# Plan: security hardening of the money paths

Fixes for `docs/specs/2026-07-02-security-review-findings.md`. Three phases; Phase 1
is DB-only and shippable immediately; Phase 2 touches both Edge Functions; Phase 3 is
deferred hardening. Implementer notes assume the CLAUDE.md rules (build/eslint/vitest,
migrations via `supabase migration new`, enum gotcha, `--no-verify-jwt` trio check).

**Design principle:** the DB must enforce what the webhook assumes — "only fulfillment
writes paid/active state" becomes a trigger-level guarantee, not a convention. Client
UI keeps working unchanged; only raw-PostgREST abuse is cut off.

---

## Phase 1 — DB-only migrations (C1, C2, C3, H2, H3, M3)

### 1a. C1 — guard trigger on `memberships`
`BEFORE INSERT OR UPDATE` trigger; when caller is NOT privileged
(`is_admin() OR current_setting('request.jwt.claims', true) is null OR auth.role() = 'service_role'`
— service role bypasses RLS but NOT triggers, so check it explicitly), reject:
- `NEW.status = 'active'` (activation is webhook/admin only);
- setting/changing `waiver_signed_at` to non-null (webhook/waiver-function only);
- `NEW.paid_via` in `('card')` (card is webhook-only; `'comp'` writes come from admins,
  already allowed by the admin branch; `'club'`-flavored client values, if any, stay legal).
**Legit client writes that MUST keep working** (verify each with the seeded users):
member creates their own pending membership row during purchase (status
`pending-waiver`/`pending-club-payment`, `club_cart_pending=true` on club push);
`record-waiver-signature` (service role) flips status; admin comp path (admin JWT).
Grep `pushMembership|memberships` in `src/` to enumerate every client write first.

### 1b. C2 — guard trigger on `registrations`
Same trigger pattern; for non-privileged callers reject `paid` transitioning
false→true **except** the host-club case: allow when the reg's competing club is the
event's host club (`NEW.club_id = (select host_club_id from events where id = NEW.event_id)`
— confirm the actual column name). Client must still be able to: create regs
`paid:false`, set `updated_pending=true` on its own paid reg (change flow), and revert
fields from `prior_reg_snapshot` (never transitions paid false→true). Admin/service
unrestricted.

### 1c. C3 — stop exposing the manager-access token to the requester
The decide RPC is intentionally no-login, so token SECRECY is the entire auth model —
the requester must never see it. Drop `mar_read` and replace with a policy/view that
excludes the token, or keep the policy and
`REVOKE SELECT (token) ON manager_access_requests FROM authenticated, anon;`
(column grants compose with RLS). First grep `manager_access_requests` in `src/` to
see whether any requester-facing UI reads its own rows (if none, plain drop is
cleanest). Belt-and-braces: in `decide_manager_access`, also return 'invalid' when
`my_person_id()` is non-null and equals `r.requester_person_id`.

### 1d. H2 — coupons: kill public read, harden `redeem_coupon`
- `DROP POLICY public_read_coupons ON coupons;` (admin_all already covers the Promos
  UI). Grep `from('coupons')` in `src/` first — post-2026-07-02, coupon validation is
  server-side only, so no member-facing read should remain; fix any straggler to go
  through the checkout function.
- Recreate `redeem_coupon` to also enforce: coupon active window (`starts_at`/`ends_at`),
  and when `restricted_to_person_id` is set, that it equals the redeeming person
  (pass the person id from the webhook; keep the atomic `used_count < max_uses` bump).
  Pin `search_path` (it already is) and keep grants minimal — consider revoking from
  `authenticated` entirely once only the webhook (service role) calls it; check whether
  any client path still invokes it.

### 1e. H3 — club memberships created only by fulfillment
Drop the `manages_club(club_id)` branch from `club_mem_insert` (keep admin). Confirm
`stripe-webhook` (service role, bypasses RLS) creates/activates `club_memberships` on
club-membership purchase — it does per S4; verify the code path, then confirm no other
client write exists (grep `club_memberships` in `src/`).

### 1f. M3 — pin `search_path` on all SECURITY DEFINER helpers
`is_admin`, `auth_has_role`, `my_person_id`, `manages_club`, `link_or_create_person`,
`redeem_coupon`: add `SET search_path = public, pg_temp`. (RETURNS-shape unchanged ⇒
`CREATE OR REPLACE` is fine here.)

**Phase 1 verification:** `supabase db push` (controller, sandbox off). Then, with the
dev seeded users (real JWTs), attempt each exploit via raw PostgREST and confirm
rejection: self-activate membership, self-flip reg paid, read a coupon row, read own
manager-access token, manager-insert club_membership. Then run the app flows that must
still work: membership purchase → club push, registration create/edit/change,
host-club $0 reg, admin comp. `npx vitest run` (pure-logic tests unaffected).

---

## Phase 2 — Edge Function fixes (C4, H4, H1, M5)

### 2a. C4+H4 — server-derived fee schedule + ref ownership validation + snapshot fulfillment
In `create-checkout-session`:
- For every `meet-entry` line, load the referenced regs and derive entry-vs-change from
  **reg state**, ignoring the client tag for pricing: reg `paid=false && !updated_pending`
  ⇒ price as NEW ENTRY (`newRegistrationEntryTotal`); reg `paid=true || updated_pending`
  ⇒ change fee. (Tag stays for display/grouping only.)
- Ownership: self cart ⇒ every `ref_reg_ids` reg has `athlete_id == payer.personId`;
  club cart ⇒ every reg has `club_id == the club`. Membership lines: `ref_user_id` must
  be the payer (self) or a member of the club (club cart). 400 with a clear message on
  violation.
- **TOCTOU fix (important):** cart_items are client-writable between session-create and
  webhook fulfillment, so validating at create-time is not enough. Write the validated,
  server-priced line set (kind, label, cents, ref_reg_ids, ref_user_id, ref_season_id,
  ref_type, ref_event_id) as a jsonb snapshot onto the `payments` row (new nullable
  column, e.g. `payments.lines_snapshot` — own migration), and make `stripe-webhook`
  fulfill FROM THE SNAPSHOT, not from re-read live `cart_items` (it already trusts the
  payments row for amounts; this extends the same principle to the refs). Live cart rows
  are then only deleted by id at fulfillment. Keep the existing empty-cart fallback for
  legacy pending payments with no snapshot.

### 2b. H1 — transactional fulfillment RPC
New SECURITY DEFINER function `fulfill_payment(p_payment_id, …)` (own migration) that,
in ONE transaction: performs the atomic claim (`fulfilled_at IS NULL`), then all DB
writes (memberships activate, `registrations.paid` flip, invoice + invoice_items,
cart_items delete, coupon redeem, `payments.status='paid'` + stripe fee/intent fields).
Returns `claimed boolean`. On any exception the transaction rolls back ⇒ `fulfilled_at`
stays NULL ⇒ Stripe's retry actually retries. The webhook keeps: signature verify,
event filtering, balance-transaction fetch (before the RPC), and the receipt email
(after, best-effort). This preserves the 2026-06-28 duplicate-delivery fix while making
partial failure retryable instead of permanent.

### 2c. M5 — amount reconciliation
Before fulfilling, assert `session.amount_total === payment.amount_subtotal +
payment.service_fee - payment.discount` (use the actual stored columns); on mismatch,
log to `error_logs` and do NOT fulfill (leave retryable).

**Phase 2 verification:** `npm run build`, eslint incl. `supabase/functions/**`,
vitest. Deploy both functions — **`stripe-webhook` with `--no-verify-jwt`**, and run
`supabase functions list` before AND after confirming `verify_jwt:false` for the trio.
End-to-end: seeded-user test purchase (entry + change + coupon), `stripe trigger` for
the webhook path, plus a forced-failure test of the RPC rollback if practical.

---

## Phase 3 — deferred hardening (schedule later)
- **M1** coupon reservation at session-create (reserve on pending payment, release on
  `expired`/`failed` webhook events).
- **M2** tighten `cart_member_clubpush` WITH CHECK (member-owned refs, membership kinds
  only) — defense-in-depth once 2a lands.
- **M4** `people` self-insert-by-email branch → route through `link_or_create_person`.
- **LOW:** scope `club_managers`/`app_settings` reads; rate-limit `error_logs` inserts;
  confirm token generation entropy in `request-manager-access`/waiver-link functions.

## Suggested execution
Phase 1 = one implementer session (migrations are small; the two triggers need the
enumerate-legit-writes grep first). Phase 2 = one implementer session per function is
overkill — one session, two cohesive tasks (2a+2c, then 2b), controller deploys.
Fable-tier review of the two trigger migrations and the fulfillment RPC before push is
strongly recommended (money/auth per the model-routing rules).
