-- C2: DB-enforced guard on `registrations` so a raw-PostgREST caller with
-- their own JWT (athlete_id = my_person_id()) or a club manager
-- (manages_club(club_id)) cannot self-flip `paid` to true. `regs_write` is
-- FOR ALL with no column restriction, and (like memberships) the app write-
-- through whole-row-upserts every registration (registrationToRow in
-- src/lib/supabase.ts), so the trigger must compare OLD vs NEW, not just
-- reject "paid=true" outright.
--
-- Enumeration of every legitimate non-admin client path that sets paid=true
-- (grepped src/ before writing this):
--   1. Club.tsx addToCart (~L893-911): host-club $0 entries. hostFree =
--      newRegistrationEntryTotal(...) === 0, which is 0 whenever
--      competingClubId === event.hostClubId (pricing.ts) OR the event's
--      entryFee/secondDisciplineFee are configured to 0 for EVERYONE
--      (EventWizard's entry-fee inputs are plain `min={0}` numbers — an admin
--      can legitimately run a free event for every club, not just the host).
--      So the real invariant is "the computed fee is 0", not "club ==
--      host_club_id" — this trigger replicates the fee-zero check directly
--      against the events row rather than assuming host-only.
--   2. MyRegistrations.tsx saveRegs "else" branch (~L148): same shape —
--      `reg.paid = changeFee === 0 && entryTotal === 0`, zeroed by the same
--      host-club-or-configured-free rule (registrationChangeFee/
--      newRegistrationEntryTotal, pricing.ts).
--   3. cart-sync.ts removeCartItemWithSync's 'revert-registration' branch
--      (also used by Club.tsx swapAthlete's cart-item revert): removing a
--      'change' cart item with a captured prior_reg_snapshot pushes the FULL
--      PRIOR row back verbatim, which can have paid=true even though the
--      currently-stored row (mutated by the chargeable edit that created the
--      change line) has paid=false. Traced the exact code (Club.tsx saveRegs
--      L836-845, MyRegistrations.tsx L133-142, Club.tsx swapAthlete L966-979):
--      whenever a chargeable edit re-pends an already-paid reg, it ALWAYS sets
--      paid=false AND updated_pending=true on the row it pushes at edit time,
--      and the snapshot it captures is the reg's state from BEFORE that same
--      mutation (paid=true, updated_pending=false in the ordinary case). So a
--      legitimate revert is always paid(false->true) PAIRED WITH
--      updated_pending(true->false) in the same UPDATE. A malicious direct
--      "UPDATE registrations SET paid=true" leaves updated_pending untouched
--      and does not satisfy this pairing. (Known narrow gap, not a new
--      vulnerability: if a reg was edited chargeably twice before the first
--      change fee was paid, the second snapshot's updated_pending could
--      already be true pre-edit, and a legitimate revert to THAT snapshot
--      would fail this check — pre-existing app bug M7 in the security review
--      findings, not something this trigger needs to newly support; fails
--      safe as a rejected write, not an exploit.)
-- No client path sets updated_pending=true together with paid transitioning
-- to true other than this exact revert shape, so pairing the two is a safe,
-- narrow allowance. updated_pending is otherwise freely writable (never
-- itself gates money).
--
-- Privileged callers (service_role — stripe-webhook; admin JWT; no JWT at all
-- i.e. direct DB/dashboard/migration) bypass every check, same as the
-- membership guard.

create or replace function guard_registration_paid() returns trigger as $$
declare
  v_privileged boolean;
  v_fee_zero boolean;
begin
  v_privileged := auth.role() is null or auth.role() = 'service_role' or is_admin();
  if v_privileged then
    return new;
  end if;

  -- Close the two-step staging bypass on Allowance 2 below. `updated_pending`
  -- is otherwise freely client-writable, so without this guard an attacker
  -- could (1) UPDATE updated_pending=true on their own unpaid reg (paid stays
  -- false, so the paid-block below never fires), then (2) UPDATE paid=true +
  -- updated_pending=false, which Allowance 2 would accept — self-flipping paid
  -- in two writes. The ONLY legitimate way updated_pending becomes true is a
  -- chargeable edit re-pending an ALREADY-PAID reg, which ALWAYS sets it in the
  -- SAME statement that drops paid true->false (verified in Club.tsx saveRegs
  -- L836-845 / swapAthlete L966-979 and MyRegistrations.tsx L133-142). No
  -- legit path sets updated_pending=true on INSERT, or while paid stays false.
  -- So: reject a non-privileged updated_pending false->true (or INSERT true)
  -- unless paid is simultaneously going true->false.
  if new.updated_pending is true
     and (tg_op = 'INSERT' or old.updated_pending is distinct from new.updated_pending)
     and not (tg_op = 'UPDATE' and old.paid is true and new.paid is false) then
    raise exception 'guard_registration_paid: non-privileged caller cannot set updated_pending=true except when re-pending an already-paid registration';
  end if;

  -- Only scrutinize a paid transitioning to true (INSERT with paid=true, or
  -- UPDATE where it flips false->true). Anything else (paid staying false,
  -- paid going true->false, an unrelated column change) is unaffected.
  if new.paid is true and (tg_op = 'INSERT' or old.paid is distinct from new.paid) then

    -- Allowance 1: the computed fee for this registration is genuinely zero
    -- (host-club OR an admin-configured $0 event) — mirrors
    -- newRegistrationEntryTotal/registrationChangeFee (pricing.ts) directly
    -- against the events row rather than trusting the client's own math.
    select (e.host_club_id is not null and e.host_club_id = new.club_id)
        or (e.entry_fee = 0 and e.second_discipline_fee = 0
            and coalesce((e.change_fee->>'amount')::numeric, 0) = 0)
      into v_fee_zero
      from events e
      where e.id = new.event_id;

    if coalesce(v_fee_zero, false) then
      return new;
    end if;

    -- Allowance 2: a legitimate snapshot revert (see enumeration above) —
    -- paid flips false->true only paired with updated_pending flipping
    -- true->false in the SAME statement.
    if tg_op = 'UPDATE'
       and old.updated_pending is true
       and new.updated_pending is false then
      return new;
    end if;

    raise exception 'guard_registration_paid: non-privileged caller cannot set paid=true on a non-free registration outside a snapshot revert';
  end if;

  return new;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

drop trigger if exists guard_registration_paid on registrations;
create trigger guard_registration_paid
  before insert or update on registrations
  for each row execute function guard_registration_paid();
