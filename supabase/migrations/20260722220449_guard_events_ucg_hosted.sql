-- Guard events.ucg_hosted against non-admin writes.
--
-- Context: `ucg_hosted` (20260720212144) was added as a client-only display/
-- routing marker. As of the 2026-07-22 feedback pass it now has SERVER-side
-- consequences: `request-refund` treats any event with `ucg_hosted` set as
-- refund-eligible (UCG-hosted events no longer require a league-host club),
-- and the client renders "hosted by UCG". Events rows are writable by their
-- host club's managers (whole-row upserts via pushEvent), so without a guard
-- any host manager could set `ucg_hosted` on their own event via a direct
-- PostgREST call and self-grant refund eligibility + UCG branding.
--
-- Rule: only privileged callers (service role / admin) may CHANGE the value.
-- Non-admin whole-row upserts that round-trip the existing value unchanged
-- (the app's normal write shape) pass untouched.
--
-- Pattern notes (repo traps):
-- - Upsert trigger trap: the app writes INSERT ... ON CONFLICT DO UPDATE, so
--   BEFORE INSERT fires with tg_op='INSERT'/OLD=NULL even for existing rows —
--   re-SELECT the pre-write row by id, never trust tg_op/OLD (cf. 20260703034325).
-- - Fail-closed: privilege predicate wrapped in coalesce(..., false) so an
--   anon caller's NULL never slips through an OR-chain (cf. 20260704133502).

create or replace function guard_events_ucg_hosted() returns trigger as $$
declare
  v_privileged boolean;
  v_old_value text;
begin
  v_privileged := coalesce(
    auth.role() is null or auth.role() = 'service_role' or is_admin(),
    false
  );
  if v_privileged then
    return new;
  end if;

  -- True pre-write state, regardless of upsert trigger-firing phase.
  select ucg_hosted into v_old_value from events where id = new.id;
  if not found then
    v_old_value := null;
  end if;

  if new.ucg_hosted is distinct from v_old_value then
    raise exception 'Only an admin may set or change ucg_hosted on an event.'
      using errcode = '42501';
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

revoke execute on function guard_events_ucg_hosted() from public, anon, authenticated;

drop trigger if exists events_guard_ucg_hosted on events;
create trigger events_guard_ucg_hosted
  before insert or update on events
  for each row execute function guard_events_ucg_hosted();
