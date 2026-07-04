-- B4 (4 of 4): synchro same-level auto-sync. Whoever actively selects a
-- partner sets the T&T "SY" level for BOTH — not a validation, an active
-- sync (Nate: "if A is HF and selects B (previously NF), the pair gets
-- registered in synchro as a High Flyer synchro pair").
--
-- The client only has RLS-checked write access to the athlete's OWN
-- registration it just saved (via athlete_id = my_person_id(), or
-- manages_club(club_id) for a club manager, or is_admin()) — NOT to the
-- named PARTNER's registration, which typically belongs to a different
-- athlete (often on a different club). A plain client-side upsert of the
-- partner's row would be silently rejected by regs_write's RLS policy for
-- the common case (an athlete registering themselves, whose partner isn't
-- someone they otherwise have write access to). This RPC authorizes ONCE
-- against the CALLER'S OWN registration (proving they have legitimate write
-- access to a row that genuinely names this partner), then updates only the
-- partner's `apparatus_levels->>'SY'` key server-side.
--
-- registrations_edit_lockout and guard_registration_paid still apply to the
-- UPDATE this performs (SECURITY DEFINER changes the executing role for
-- permission checks, but auth.uid()/auth.role() still reflect the ORIGINAL
-- caller in those trigger functions) — so this sync is correctly blocked
-- too if the event's edit deadline has passed and the caller isn't
-- privileged, same as any other edit.
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

  if not (is_admin() or v_my_reg.athlete_id = my_person_id() or manages_club(v_my_reg.club_id)) then
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

grant execute on function sync_synchro_partner_level(text, text) to anon, authenticated;
