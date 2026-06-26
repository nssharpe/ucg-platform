# Stripe S4 — Extend checkout to meet entries, club cart, change fees (decomposition)

Date: 2026-06-26. Parent spec: `2026-06-25-stripe-integration.md` (§ S4).
Source of truth for the S4 subagent dispatch (per CLAUDE.md execution rules).

## Goal
Generalize the two Edge Functions (`create-checkout-session`, `stripe-webhook`) so they
recompute **every** line amount server-side (trust boundary), and move the remaining
client-side fulfillment server-side:
- `Cart.tsx` `completePurchase` (person carts: meet entries, addons, memberships) → Stripe.
- `Club.tsx` `payClubItems` (club carts: club membership, member memberships, meet entries) → Stripe.
Receipts come from the webhook to the **payer** (manager for club carts).

## Decisions confirmed by Nate (2026-06-26)
- **Add robust line tags (not label parsing).** New columns let the server price every line
  deterministically:
  - `cart_items.ref_line_type` + `invoice_items.ref_line_type` (text): refines `kind` for
    recompute — `'entry' | 'change'` for `meet-entry` lines; `'tshirt' | 'banner'` for `addon`
    lines. Null for memberships (kind + ref_type suffices).
  - `cart_items.ref_meet_id` + `invoice_items.ref_meet_id` (text): the meet a line belongs to —
    **required** to price addon lines (they carry no reg ids); also set on meet-entry lines.
- **Addons priced server-side** from the meet's `tshirt_addon`/`banner_addon` config (via
  `ref_meet_id` + `ref_line_type`).
- **Entry vs change** distinguished by `ref_line_type` (deterministic), amount recomputed from
  meet config + host-club $0.

## Trust-boundary recompute (server, `_shared/stripe.ts` mirrors `pricing.ts`)
- **membership athlete/coach**: group lines by `(targetPerson, season)` where
  `targetPerson = ref_user_id ?? payer`; `priceForTypesDollars(season, types, thatPerson's existing
  active memberships)`. (Club carts: member-membership lines target the member, not the manager.)
- **club membership** (`ref_type='club'`): `season.club_fee`; $0/skip if the club already has an
  active `club_memberships` row for that season.
- **meet-entry `entry`**: load `ref_reg_ids` → regs → meet + competing club;
  `newRegistrationEntryTotal(meet,{competingClubId, priorDisciplineCount, newDisciplineCount})`
  where `newDisciplineCount = #regs in this line`, `priorDisciplineCount = #other non-refunded regs
  for (meet, athlete, competingClub) not in this line`. Host club ⇒ $0.
- **meet-entry `change`**: host club ⇒ $0 else `meet.change_fee.amount`.
- **addon `tshirt`/`banner`**: `meet.tshirt_addon.price` / `meet.banner_addon.price` (via ref_meet_id).
- Drop $0 lines (Stripe rejects $0 line items). Add the `processingFee` service-fee line.

## Ownership (create-checkout-session)
Load items by id (service role), then authorize:
- **self cart**: every item `person_id === callerPerson` (club_id null).
- **club cart**: every item `club_id === X` (person_id null) AND caller is in `club_managers`
  (`club_id=X, person_id=callerPerson`).
- else reject (mixed / unauthorized).
Payments row `person_id` = the **payer** (caller) for self-read polling + receipt. The webhook
derives club-vs-person + clubId by reading the loaded cart_items' `club_id`.

## Webhook fulfillment (generalized, idempotent on event id + fulfilled_at)
- Load cart items by `cart_item_ids`; `clubId` = any item's `club_id` (else null).
- Per item: club membership → create `club_memberships`; athlete/coach membership → activate for
  `ref_user_id ?? payer` (waiver→active else pending-waiver; `paid_via = clubId ? 'club' : 'card'`;
  clear `club_cart_pending`; upsert id `${targetPerson}:${season}:${type}`).
- Collect `ref_reg_ids` across all items → flip those `registrations.paid=true, updated_pending=false`.
- Invoice: club cart ⇒ `{club_id:clubId, athlete_id:null}`; self ⇒ `{club_id:null, athlete_id:payer}`.
  `invoice_items` mirror ALL paid lines (incl. ref_meet_id/ref_line_type/ref_reg_ids).
- Clear paid cart lines; flip payment `paid` (record fee/PI/event id); email payer a receipt
  listing all lines + service fee + total.

## FE
- **New `src/components/CartCheckout.tsx`** (generalized from `Cart.tsx` `MembershipsCheckoutInner`):
  props `{ items: CartItem[]; title: string; onPaid: () => void; backTo?: string }`. Creates the
  session on mount (`createCheckoutSession({ cartItemIds })`), shows server-authoritative
  Subtotal/Service fee/Total + the embedded form (`StripeCheckout`), no client fulfillment.
  Lists item labels WITHOUT per-line prices (avoids stale display-amount mismatch, as in S3).
- **`Cart.tsx`**: remove `completePurchase`; each group card's button + "Purchase everything"
  launch `CartCheckout` inline; `MembershipsCheckout` route reuses `CartCheckout`.
- **`Club.tsx` `ClubCart`**: "Checkout Memberships" + "Pay" launch `CartCheckout` for the club
  cart item ids; remove `payClubItems` + `emailClubReceipt`. Receipt → manager (webhook).

## Known deferrals (flag in report; address in S5)
- **Coupons**: the club cart coupon field is NOT applied by Stripe checkout (server is the amount
  source of truth and has no coupon path yet). Document; revisit in S5.
- Residual: a hand-crafted cart row could still mis-set `ref_line_type` — but amounts are recomputed
  from admin meet config either way, so the dollar exposure is bounded by config, not arbitrary.

## Split (two merges)
- **S4a**: migration + types/mappers + tag all push sites + both Edge Functions (fully general) +
  `CartCheckout` + `Cart.tsx`. Controller pushes the migration after build is green.
- **S4b**: `Club.tsx` rewire (uses the already-general backend + `CartCheckout`).
Each: verify (`npm run build`, `npx eslint <touched incl. supabase/functions/**>`, `npx vitest run`,
responsive 375/768/1280 on checkout UI) → merge to `main` → push. **Nate deploys the Edge
Functions at phase end** (do not deploy).
