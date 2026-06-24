-- Let a member push their OWN membership fee to a club's cart.
-- The base cart_owner policy only lets admins / club managers write a club's
-- cart_items (club_id set), so a member's "send to club cart" silently failed
-- RLS — the item never reached the club's cart. This adds a policy letting a
-- member insert / read / delete a club-cart row that is THEIRS (ref_user_id =
-- self) when the club has opted into member club-pay (clubs.allow_club_pay).
-- The base policy still governs managers/admins (policies are OR'd).
drop policy if exists cart_member_clubpush on cart_items;
create policy cart_member_clubpush on cart_items for all
  using (ref_user_id = my_person_id())
  with check (
    ref_user_id = my_person_id()
    and club_id is not null
    and exists (select 1 from clubs c where c.id = cart_items.club_id and c.allow_club_pay)
  );
