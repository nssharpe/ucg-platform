# Security & correctness review — money paths (2026-07-02)

Deep review of the payment/RLS/cart surface by three parallel read-only reviewers
(edge functions, RLS/migrations, client state machine), with every CRITICAL/HIGH
finding independently re-verified against the code by the controller before inclusion.
Remediation design: `docs/plans/2026-07-02-security-hardening.md`.

> **Remediation status (2026-07-02):** Phase 1 (DB guard triggers + policy lockdowns)
> is **shipped & verified live** — it closes **C1, C2, C3, H2, H3** and hardens **M3**
> (migrations `20260702182709`–`182714`; `scripts/verify-hardening.mjs` passes 10/10).
> **Still OPEN** (Phase 2/3 of the hardening plan): **C4 and H4** — these run through
> the *legitimate* Stripe webhook (service-role, which bypasses the guard triggers by
> design), so they need the Phase 2 server-side fee-schedule derivation + ref-ownership
> validation + fulfillment snapshot, NOT a DB trigger. Also open: H1 transactional
> fulfillment, M1/M2/M4/M5. **Part 2 (client cart state machine — C5, H5–H8, M6–M9, L2)
> is SHIPPED 2026-07-02** (`docs/plans/2026-07-02-cart-state-fixes.md`), with two minor
> non-money-loss residuals noted in that plan. A finding being listed below does not
> mean it is still open; check this box.

**Context for severity:** the platform is live with real users and (test-mode→soon live)
real money. Exploits below need only a signed-in user issuing raw PostgREST calls with
their own JWT — no elevated role. Client-side UI guards do not constrain such a caller.

## CRITICAL

### C1 — Any member can self-activate a paid membership (and skip the waiver)
`memberships_write` (`20260601000004_text_ids_score_extras.sql:142`, re-created from
`…000002_rls.sql`) is `FOR ALL` with `person_id = my_person_id()` in both `USING` and
`WITH CHECK`, no column restrictions. A member can `upsert` their own membership row
with `status='active'`, `paid_via='comp'`, `waiver_signed_at=now()`,
`club_cart_pending=false` — free active membership, waiver hold cleared, and it
satisfies the club-eligibility gate. **Verified.**

### C2 — Any athlete can mark their own registration paid
`regs_write` (same migrations, `:154`) is `FOR ALL` with `athlete_id = my_person_id()`.
`registrations.paid` / `updated_pending` are client-writable — an athlete can
`UPDATE registrations SET paid=true` on their own row, entering an event without
paying. The webhook is *supposed* to be the only writer of `paid`; the DB doesn't
enforce it. **Verified.**

### C3 — Any member can self-approve as manager of ANY club (club takeover)
`20260624000020_manager_access_requests.sql`: `mar_read` lets the requester SELECT
their own request row — including the secret `token` column. `decide_manager_access`
(SECURITY DEFINER, granted to `anon, authenticated`) authorizes purely on token
possession and never checks decider ≠ requester (or that the decider manages the club).
Flow: request manager access to any club → read own token via PostgREST → call
`decide_manager_access(token,'approve',…)` → inserted into `club_managers`.
`manages_club()` then grants that person read/write over the club's people (PII),
registrations, carts, invoices. **Verified.**

### C4 — Client-chosen `ref_line_type` lets a new entry be priced as a "change" (often $0)
`create-checkout-session` picks the fee schedule from the client-supplied
`ref_line_type` tag (`index.ts:278`), and the webhook flips whatever `ref_reg_ids` the
row carries (`stripe-webhook/index.ts:259`). The `cart_owner` RLS policy lets a member
set `kind`/`ref_line_type`/`ref_reg_ids` freely on their own cart rows. Craft
`{kind:'meet-entry', ref_line_type:'change', ref_reg_ids:[my unpaid entry reg]}` →
charged the change fee (`event.change_fee?.amount ?? 0` — **$0 for events with no
change fee configured**) instead of the full entry total, then fulfillment marks the
reg paid. Rated CRITICAL (upgraded from the reviewer's HIGH) because it monetizes to
free/near-free event entry through the *legitimate* checkout flow. **Verified**
(pricing branch + unconditional flip + permissive cart RLS).

## HIGH

### H1 — Mid-fulfillment failure leaves a captured payment permanently half-fulfilled
`stripe-webhook`: the atomic `fulfilled_at` claim (correctly fixed 2026-06-28) runs
BEFORE a sequence of independent, non-transactional PostgREST writes (memberships →
registrations → invoice → cart clear → status). If any step after the claim throws,
the function 500s and Stripe retries — but the retry short-circuits on the already-set
`fulfilled_at`. Money captured; regs unflipped / no invoice / no receipt;
`payments.status` stuck `pending`; recovery is manual-only (an `error_logs` row).
The 2026-07-02 stuck-payment incident shows this class of failure is real
operationally. **Verified** (control flow confirmed from code).

### H2 — All coupon codes are world-readable; redemption is unguarded
`public_read_coupons … USING (true)` (`20260601000002_rls.sql:74`): anon can enumerate
every code, discount, and `restricted_to_person_id`. Compounded by `redeem_coupon`
(SECURITY DEFINER, granted to `authenticated`) which only bumps `used_count` — any
signed-in user can burn arbitrary codes to `max_uses` (DoS on discounts), and
`restricted_to_person_id` is not enforced by the RPC. **Verified.**

### H3 — A club manager can grant their own club a free active club-membership
`club_mem_insert` (`20260623000040_club_memberships.sql:22`) allows
`manages_club(club_id)` INSERT — the manager can insert `{status:'active'}` directly,
bypassing the club-fee purchase that the row is supposed to gate. Chains with C3
(anyone → manager → free club membership for any club). **Verified.**

### H4 — `ref_reg_ids`/`ref_user_id` never ownership-checked at checkout
`create-checkout-session` authorizes the cart rows (self vs managed club) but not the
*references*: a payer can reference other people's registrations (webhook flips them
paid — cross-account mutation/griefing) and a manager can target a membership at an
arbitrary `ref_user_id` outside their club. Same root cause as C4 (unvalidated ref
fields); fix together. **Verified structurally.**

## MEDIUM

- **M1 — Coupon over-discount via concurrent sessions:** discount applied at
  session-create; `redeem_coupon` reserved only at fulfillment. N concurrent sessions
  all pass the `used_count` check and all collect the discount; single-use and
  person-restricted codes are reusable within the window.
- **M2 — `cart_member_clubpush` too broad:** a member at an `allow_club_pay` club can
  insert arbitrary line kinds/refs into the club cart (flooding; foreign `ref_reg_ids`
  paid on the club's dime). Mostly subsumed by the C4/H4 server-side ref validation,
  which also protects club carts; tightening the policy is defense-in-depth.
- **M3 — SECURITY DEFINER helpers don't pin `search_path`:** `is_admin()`,
  `auth_has_role()`, `my_person_id()`, `manages_club()`, `link_or_create_person`,
  `redeem_coupon` (the token RPCs DO pin it). Cheap hardening.
- **M4 — `people` self-insert-by-email branch** allows junk `people` rows with
  arbitrary `main_club_id` for one's own JWT email. Limited impact; tighten later.
- **M5 — Webhook never reconciles `session.amount_total`** against the `payments` row
  amounts before fulfilling. Defense-in-depth assert; cheap.

## LOW

- `club_managers` / `app_settings` readable by anon (`USING (true)`).
- `error_logs` INSERT `WITH CHECK (true)` — anon log spam.
- Token-lookup RPCs have no rate limiting; security rests on token entropy (confirm
  the Edge Functions generate ≥128-bit CSPRNG tokens).

---

# Part 2 — client cart/registration state machine (correctness, not security)

Fix plan: `docs/plans/2026-07-02-cart-state-fixes.md`.

## CRITICAL

### C5 — Club cart dedupe keyed on athlete only → second event's entry fee silently never charged
`Club.tsx` `addToCart` (~line 920): the "already in cart" set is
`cart.filter(kind==='meet-entry').map(refUserId)` — ANY event, and change lines too.
Register athlete X for Event A, then Event B: B's regs are created `paid:false` but
the entry line push is skipped — B's regs are stuck "Pending purchase" forever, no
line exists to pay OR remove-with-sync them, club never billed. Also triggered when X
merely has a change-fee line in the cart. Fix: key on
(`refUserId`, `refEventId`, `refLineType==='entry'`). **Verified.**

## HIGH

### H5 — Multiple cart lines referencing the same reg: removal is order-dependent (delete + resurrect)
`cart-sync.ts`: club `saveRegs` stacks change lines (no `alreadyPending` guard, unlike
MyRegistrations) that can reference the same reg as an entry line. Removing the entry
line deletes a reg still referenced by the change line (checkout then hits the
orphaned-line error); removing the change line afterwards *resurrects* the deleted reg
from the snapshot (`d.registrations.push(prior)` + `pushRegistration`). Stacked change
lines removed out of order clobber newer edits with older snapshots; a discipline
*added* by a change has no snapshot entry and survives removal untracked.

### H6 — Removing a member-pushed membership line strands `clubCartPending=true`
`classifyCartRemoval` treats membership lines as `remove-only`; the only writers of
`clubCartPending` are the club-push (true) and the webhook (false on payment). Manager
deletes the member's pushed fee line from `/cart` → the member's "Pending club $" hold
persists forever with no cart line behind it.

### H7 — Club edit path: discipline added via Edit gets `paid` undefined → shows "Registered"; free outside the change window
`Club.tsx` `saveRegs` only stamps `paid` for regs with a prior; the status cell checks
`r.paid === false`, which `undefined` fails → unpaid rows render the green
"Registered" badge. Worse, before `changeFee.startsAt` the change fee is $0 so NO cart
line is created at all — the added discipline is free and marked registered.
`MyRegistrations.tsx` has the correct else-branch; Club.tsx lacks it.

### H8 — Checkout "Try again" button is a dead end
`CartCheckout.tsx`: `retry()` resets the ref + stage but the session-creating effect
is keyed on `[items]`, and the main surface passes `checkout.items` from React state —
a stable reference — so the effect never re-fires. Any transient
`create-checkout-session` failure strands the user on the spinner. **Verified**
(state-held `items` confirmed at `Cart.tsx:141`).

## MEDIUM

- **M6 — live in-place-mutation-trap instances:** `MyRegistrations.tsx` `byEvent`
  memo (`[db.registrations, …]`) shows stale data right after its own save; same
  latent pattern at `Club.tsx` ~529/~734 and the `useEffect(..., [db, clubId])`
  cleanup hooks (`Cart.tsx` ~342, `Club.tsx` ~740).
- **M7 — second self-edit while a change line is pending:** the existing line's
  `refRegIds`/snapshot are not extended → after payment the second edit's new reg
  stays pending with no line to pay it; removal reverts only to the pre-first-edit
  snapshot.
- **M8 — `cleanupCrossClubCart` drops the moot line without `removeCartItemWithSync`**
  → this club's pending regs orphan in the grid.
- **M9 — no handling of "cart mutated while a checkout session is in flight":**
  removal (even cross-tab) doesn't warn about/expire a live session; the webhook can
  collect money for a reg deleted mid-checkout. (Partially mitigated by the Phase 2a
  fulfillment-snapshot design in the hardening plan; the client-side confirm/expire is
  still wanted.)

## LOW

- **L2 — legacy pre-S4 change lines** (null `refLineType` but non-null `refRegIds`)
  would be misclassified as `delete-registration` on removal. Live data was checked
  2026-07-02 (all null-`refLineType` rows also had null `refRegIds`) — re-verify before
  shipping the classifier change, or backfill `ref_line_type`.

## Verified clean (worth knowing)

- `payments` RLS (service-role write, self-read), `user_roles` (no self-grant),
  `waiver_signatures` (immutable, service-role stamped), `sms_messages`,
  `regional_rep_regions`, `sanction_votes`, `link_or_create_person` (claims only the
  verified-JWT email's row).
- Stripe webhook signature path (fail-closed, async verify), the atomic idempotency
  claim itself, the $0-receipt fallback.
- Service fee `Math.ceil(cents*0.03)+30` byte-identical client/server; computed on the
  post-discount subtotal; cents throughout.
- Coupon *math* (floor 0, ≤ eligible, no double-count, event hard-expiry) — the issues
  are read-exposure (H2) and reservation timing (M1), not the arithmetic.
- Client/server checkout trust boundary for *amounts* (display-only client `amount`s
  are never used server-side) — the gap is the *tag/ref* fields (C4/H4).
