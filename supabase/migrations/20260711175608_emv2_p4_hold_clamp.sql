-- Event-management v2 Phase 4, Task 3: hold-squat guard.
--
-- registrations.hold_expires_at is client-writable under the existing
-- registration RLS (same insert/update policies as every other reg column) —
-- a malicious client could set a far-future hold and squat a capacity spot
-- without ever paying. Clamp it server-side to at most 30 minutes out on
-- every write; a null value (no hold) passes through unchanged.
--
-- No role check needed: legitimate server writes never exceed 30 minutes
-- either (create-checkout-session's own hold-refresh writes exactly
-- CART_HOLD_MINUTES=30 out). The 24h waitlist-promotion hold lives on
-- waitlist_groups.hold_expires_at instead, a column only ever written by
-- service-role Edge Functions (clients get column-grant UPDATE on `status`
-- only — see 20260711135842_emv2_p4_capacity_schema.sql) so it is unaffected
-- by this trigger.
--
-- CLAUDE.md upsert-trigger trap: the app writes whole-row upserts, so a
-- BEFORE INSERT trigger can fire with tg_op='INSERT'/OLD=NULL even on an
-- existing row. This clamp needs neither OLD nor tg_op — it's a pure
-- function of NEW, so that trap does not apply here.
create or replace function clamp_registration_hold() returns trigger as $$
begin
  if new.hold_expires_at is not null and new.hold_expires_at > now() + interval '30 minutes' then
    new.hold_expires_at := now() + interval '30 minutes';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

drop trigger if exists clamp_registration_hold on registrations;
create trigger clamp_registration_hold
  before insert or update on registrations
  for each row execute function clamp_registration_hold();
