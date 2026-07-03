-- Fix guard_registration_paid (20260702182711): its Allowance 2 (snapshot
-- revert) and the "no real paid transition" skip were UNREACHABLE for the
-- app's actual write pattern.
--
-- Root cause: the app never issues plain UPDATEs to `registrations` —
-- `registrationToRow`/`pushRegistration` (src/lib/supabase.ts) always whole-
-- row-upserts via supabase-js `.upsert()`, i.e. a single
-- `INSERT ... ON CONFLICT (id) DO UPDATE` statement. For that statement
-- shape, Postgres fires the row-level BEFORE INSERT trigger UNCONDITIONALLY
-- while considering the insert candidate — with tg_op = 'INSERT' and
-- OLD = NULL — BEFORE the conflict against the existing row is even
-- resolved. If that invocation raises, the whole statement aborts right
-- there; Postgres never reaches a BEFORE UPDATE firing with the real OLD row
-- (this is documented Postgres behavior, not a bug in Postgres — the
-- original migration just didn't account for it).
--
-- Net effect: the previous function trusted `tg_op`/`OLD` to tell "is this
-- really an update of an existing row" — for every upsert of an EXISTING
-- non-free registration, it saw tg_op='INSERT'/OLD=NULL regardless, so it
-- re-ran the "is the fee genuinely zero" check from scratch, and Allowance 2
-- (`tg_op = 'UPDATE' and old.updated_pending is true and new.updated_pending
-- is false`) could never match. Any WHOLE-ROW UPSERT of an already-paid,
-- non-host/non-free registration was rejected — even one that changes
-- nothing about `paid` at all (e.g. an apparatus-only tweak, per the B8 fix
-- in Club.tsx/MyRegistrations.tsx that surfaced this live) — and the
-- legitimate cart-removal "revert-registration" snapshot-restore path
-- (cart-sync.ts) was equally unreachable.
--
-- Fix: stop trusting tg_op/OLD. Explicitly re-SELECT the row by primary key
-- (id) at the top of the function — this gives the TRUE pre-write state
-- regardless of which trigger-firing phase Postgres is in for the upsert,
-- and makes every existing allowance (fee-zero, snapshot-revert, the no-op
-- "paid already true" case, and the two-step staging-bypass guard) reachable
-- exactly as originally intended. Every other invariant is unchanged:
-- privileged bypass, the fee-zero check against the events row, the
-- snapshot-revert pairing requirement, and the updated_pending staging-bypass
-- protection.

create or replace function guard_registration_paid() returns trigger as $$
declare
  v_privileged boolean;
  v_fee_zero boolean;
  v_old registrations%rowtype;
  v_old_paid boolean;
  v_old_updated_pending boolean;
  v_has_old boolean;
begin
  v_privileged := auth.role() is null or auth.role() = 'service_role' or is_admin();
  if v_privileged then
    return new;
  end if;

  -- Resolve the ACTUAL pre-write row by id rather than trusting tg_op/OLD
  -- (see header: unreliable for the app's INSERT ... ON CONFLICT DO UPDATE
  -- upsert pattern).
  select * into v_old from registrations where id = new.id;
  v_has_old := found;
  v_old_paid := coalesce(v_old.paid, false);
  v_old_updated_pending := coalesce(v_old.updated_pending, false);

  -- Close the two-step staging bypass (unchanged intent, now keyed off the
  -- re-resolved v_old instead of tg_op/OLD): reject a non-privileged
  -- updated_pending false->true (or true on a fresh insert) unless paid is
  -- simultaneously going true->false.
  if new.updated_pending is true
     and (not v_has_old or v_old_updated_pending is distinct from new.updated_pending)
     and not (v_has_old and v_old_paid is true and new.paid is false) then
    raise exception 'guard_registration_paid: non-privileged caller cannot set updated_pending=true except when re-pending an already-paid registration';
  end if;

  -- Only scrutinize a paid transitioning to true (fresh insert with
  -- paid=true, or an existing row's paid genuinely flipping false->true).
  -- Anything else (paid staying false, paid going true->false, paid staying
  -- true unchanged, an unrelated column change) is unaffected.
  if new.paid is true and (not v_has_old or v_old_paid is distinct from new.paid) then

    -- Allowance 1: the computed fee for this registration is genuinely zero
    -- (host-club OR an admin-configured $0 event).
    select (e.host_club_id is not null and e.host_club_id = new.club_id)
        or (e.entry_fee = 0 and e.second_discipline_fee = 0
            and coalesce((e.change_fee->>'amount')::numeric, 0) = 0)
      into v_fee_zero
      from events e
      where e.id = new.event_id;

    if coalesce(v_fee_zero, false) then
      return new;
    end if;

    -- Allowance 2: a legitimate snapshot revert — paid flips false->true only
    -- paired with updated_pending flipping true->false in the SAME write.
    if v_has_old
       and v_old_updated_pending is true
       and new.updated_pending is false then
      return new;
    end if;

    raise exception 'guard_registration_paid: non-privileged caller cannot set paid=true on a non-free registration outside a snapshot revert';
  end if;

  return new;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;
