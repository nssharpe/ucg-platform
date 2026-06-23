-- Promo codes can be restricted to a single account (person). When set, only that
-- person may redeem the code. Null = usable by anyone (existing behavior).
alter table coupons
  add column if not exists restricted_to_person_id text references people(id) on delete cascade;
