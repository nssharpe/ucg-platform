-- CRITICAL fix: sync_synchro_partner_level (20260704044529) had a fail-OPEN
-- authorization bug for an anonymous/unauthenticated caller.
--
-- The guard was: `if not (is_admin() or v_my_reg.athlete_id = my_person_id()
-- or manages_club(v_my_reg.club_id)) then raise exception ...`. This mirrors
-- the regs_write RLS policy's expression, but NOT its fail-closed semantics:
-- RLS treats a NULL USING/WITH CHECK result as deny, whereas `if not (...)`
-- treats NULL as "don't raise" (falsy `if`), i.e. ALLOW.
--
-- For an anon caller, auth.uid() is null, so my_person_id() is null, and
-- `v_my_reg.athlete_id = null` evaluates to NULL (Postgres three-valued
-- logic) rather than false. `is_admin()` and `manages_club()` are both
-- false, so the whole OR-chain is `false OR NULL OR false` = NULL. `not
-- NULL` is NULL, and `if NULL then raise` does NOT raise — execution
-- continued. Since this function is SECURITY DEFINER, the row lookup
-- bypasses RLS entirely, so ANY caller (including the public anon key) could
-- pass an arbitrary registration id belonging to someone else and silently
-- push a SY-level change onto that registration's named partner, for any
-- event with no last_date_to_edit lockout set (registrations_edit_lockout
-- and guard_registration_paid still fire, but neither blocks an anon caller
-- from an apparatus_levels-only write to an event with no deadline).
--
-- Fixed by wrapping the whole predicate in coalesce(..., false), forcing a
-- NULL result to `false` (deny) exactly like RLS does — `not false` = true,
-- so the exception now correctly raises for an unauthenticated caller (or
-- any caller who doesn't own/manage the registration in question). Also
-- narrows the grant to `authenticated` only (dropping `anon`) as
-- defense-in-depth — every real call site requires a signed-in session
-- already, so there is no legitimate anon use case for this RPC.
create or replace function sync_synchro_partner_level(p_my_reg_id text, p_sy_level text)
returns void
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_my_reg registrations%rowtype;
  v_partner_reg_id text;
begin
  select * into v_my_reg from registrations where id = p_my_reg_id;
  if not found then
    return; -- nothing to sync from
  end if;

  if not coalesce(is_admin() or v_my_reg.athlete_id = my_person_id() or manages_club(v_my_reg.club_id), false) then
    raise exception 'sync_synchro_partner_level: not authorized for registration %', p_my_reg_id;
  end if;

  if not ('SY' = any(v_my_reg.apparatus)) or v_my_reg.partner_athlete_id is null then
    return; -- this registration isn't a synchro pairing — nothing to sync
  end if;

  select id into v_partner_reg_id
    from registrations
    where event_id = v_my_reg.event_id
      and athlete_id = v_my_reg.partner_athlete_id
      and 'SY' = any(apparatus)
      and not refunded
    limit 1;

  if v_partner_reg_id is null then
    return; -- partner hasn't registered SY for this event yet — nothing to sync
  end if;

  update registrations
  set apparatus_levels = coalesce(apparatus_levels, '{}'::jsonb) || jsonb_build_object('SY', p_sy_level)
  where id = v_partner_reg_id
    and coalesce(apparatus_levels->>'SY', '') is distinct from p_sy_level;
end;
$$;

revoke execute on function sync_synchro_partner_level(text, text) from anon;
grant execute on function sync_synchro_partner_level(text, text) to authenticated;
