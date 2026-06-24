-- Self-service direct-pay RLS.
-- A member who buys their own membership directly (Membership.tsx → "Pay now")
-- writes an invoice + invoice_items and redeems any coupon. The original RLS only
-- let admins/club-managers write those tables, so a member's purchase silently
-- failed RLS — no receipt was ever stored (even the $0-after-promo case). This
-- lets a member create their OWN invoice and its line items, and moves coupon
-- redemption behind a security-definer RPC so members never get blanket UPDATE on
-- coupons (which would let them rewrite discount amounts).

-- invoices: a member may INSERT their own invoice (athlete_id = self). SELECT is
-- already covered by invoice_owner; admin/manager full control by invoice_admin.
drop policy if exists invoice_self_insert on invoices;
create policy invoice_self_insert on invoices for insert
  with check (athlete_id = my_person_id());

-- invoice_items: the owner of the parent invoice (the member, or a club manager)
-- may write its line items. Replaces the admin-only write policy. SELECT stays on
-- invoice_items_read.
drop policy if exists invoice_items_admin on invoice_items;
drop policy if exists invoice_items_owner_write on invoice_items;
create policy invoice_items_owner_write on invoice_items for all
  using (is_admin() or exists (
    select 1 from invoices i where i.id = invoice_items.invoice_id
      and (i.athlete_id = my_person_id() or manages_club(i.club_id))))
  with check (is_admin() or exists (
    select 1 from invoices i where i.id = invoice_items.invoice_id
      and (i.athlete_id = my_person_id() or manages_club(i.club_id))));

-- redeem_coupon: atomically bump used_count, enforcing max_uses. Returns true iff
-- a redemption was recorded. Security definer so authenticated callers need no
-- direct UPDATE on coupons.
create or replace function redeem_coupon(p_code text)
returns boolean as $$
declare v_ok boolean;
begin
  update coupons
     set used_count = coalesce(used_count, 0) + 1
   where code = p_code
     and (max_uses is null or coalesce(used_count, 0) < max_uses)
  returning true into v_ok;
  return coalesce(v_ok, false);
end;
$$ language plpgsql volatile security definer;

grant execute on function redeem_coupon(text) to authenticated;
