-- Narrow 20260703222142's `manager_all` (for all) down to insert+update only.
-- `for all` covers DELETE too, which was never actually needed — the upsert
-- fix only required an INSERT-phase check (for the ON CONFLICT DO UPDATE
-- candidate row) plus a genuine UPDATE check. No app code path deletes a
-- clubs row (no `remoteDelete('clubs', ...)` caller exists), so this grant
-- was unused, but principle-of-least-privilege: a non-admin manager
-- shouldn't be ABLE to delete their club's row at all (which would cascade
-- to club_managers, cart_items, club_memberships, etc.) via a raw client
-- call, even though nothing in the current UI does it. Only admins can
-- delete a club (admin_all, unchanged).
drop policy if exists manager_all on clubs;
create policy manager_insert on clubs for insert
  with check (manages_club(id));
create policy manager_update on clubs for update
  using (manages_club(id)) with check (manages_club(id));
