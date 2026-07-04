-- B4 (2 of 4): "Last date to edit" a registration + role-gated lockout.
-- Nate: past this date, only an admin or the event's HOST club's managers
-- may still edit a registration (members self-editing via MyRegistrations.tsx
-- and non-host club managers are locked out). NULL (default) means no
-- lockout — unchanged behavior for every existing event.
alter table events add column if not exists last_date_to_edit timestamptz;

-- Enforced server-side (not just a client-side UI gate) via a BEFORE
-- INSERT/UPDATE/DELETE trigger on registrations, mirroring
-- guard_registration_paid's established pattern:
--  - Privileged bypass FIRST (no auth context / service_role / admin) —
--    critical so stripe-webhook's post-payment `paid`/`updated_pending`
--    flips (which can legitimately land after the edit deadline, e.g. a
--    club pays a pending cart line late) are never blocked.
--  - Re-resolve the pre-write row by id explicitly rather than trusting
--    tg_op/OLD — an upsert (INSERT ... ON CONFLICT DO UPDATE, which is how
--    the app always writes registrations) fires the BEFORE INSERT phase
--    unconditionally before the conflict resolves, so trusting tg_op/OLD
--    would make a real edit's lockout check unreachable (the exact upsert
--    trap already fixed once for guard_registration_paid, see
--    20260703034325's header for the full explanation) — a row with no
--    existing match is a genuinely NEW registration, not gated by this
--    lockout (new registrations are separately gated by the event's
--    reg-open/reg-closed window, sub-item 1).
--  - DELETE is included: Club.tsx's saveRegs deletes rows for disciplines a
--    manager deselects, which is as much an "edit" as an UPDATE.
create or replace function guard_registration_edit_lockout() returns trigger as $$
declare
  v_privileged boolean;
  v_row registrations%rowtype;
  v_last_edit timestamptz;
  v_host_club_id text;
begin
  v_privileged := auth.role() is null or auth.role() = 'service_role' or is_admin();
  if v_privileged then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;

  if tg_op = 'DELETE' then
    v_row := old;
  else
    select * into v_row from registrations where id = new.id;
    if not found then
      return new; -- genuinely new registration — not gated by the edit lockout
    end if;
  end if;

  select e.last_date_to_edit, e.host_club_id into v_last_edit, v_host_club_id
    from events e where e.id = v_row.event_id;

  if v_last_edit is null or now() <= v_last_edit then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;

  if manages_club(v_host_club_id) then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;

  raise exception 'This event''s edit deadline has passed; only an admin or the host club can make changes now.';
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

drop trigger if exists registrations_edit_lockout on registrations;
create trigger registrations_edit_lockout
  before insert or update or delete on registrations
  for each row execute function guard_registration_edit_lockout();
