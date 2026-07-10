-- Event-management v2 Phase 1, Task 8 (final): scoped post-registration-close
-- host editing (spec §C + Nate's 2026-07-09 scope answer). After `regCloses`,
-- hosts (host-club managers + event-admin grantees) get meet-organization
-- write reach on THEIR event (sessions/squads/scoring already exist as
-- pages -- this migration extends the RLS/RPC layer under them) plus a
-- narrow roster-edit RPC pair. Hosts NEVER get: refunds, fees/pricing config,
-- event creation, or anything money-touching. Deliberately does NOT add an
-- UPDATE policy on `events` itself -- org-level fields (owner/checklist) are
-- already host-writable via their own RPCs (mark_medals_received etc.);
-- event money/config (entry fees, dates, disciplines) stays admin/sanctioning-
-- only. Style-matches 20260709133846_event_admins.sql /
-- 20260709211656_event_host_tools.sql: authorize ONCE up front, fail-closed
-- (coalesce over OR-chains), search_path pinned, execute revoked from public.

-- ---------------------------------------------------------------------------
-- 1. is_event_host(): the shared per-event host predicate, factored out of
--    the repeated inline block in 20260709211656/20260709133846 (admin,
--    sanctioning, the event's host-club managers, or a granted event admin).
--    Returns false (never raises, never null) for an unknown event or a
--    non-host caller -- safe to use directly inside RLS USING/WITH CHECK
--    expressions without an extra coalesce at each call site.
-- ---------------------------------------------------------------------------
create or replace function is_event_host(p_event_id text) returns boolean
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_host_club_id text;
begin
  select e.host_club_id into v_host_club_id from events e where e.id = p_event_id;
  if v_host_club_id is null then
    return false;
  end if;

  return coalesce(
    is_admin()
    or auth_has_role('sanctioning')
    or manages_club(v_host_club_id)
    or exists (select 1 from event_admins ea where ea.event_id = p_event_id and ea.user_id = auth.uid()),
    false
  );
end;
$$;

revoke execute on function is_event_host(text) from public;
grant execute on function is_event_host(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. event_sessions / squads: extend write reach to event-admin GRANTEES.
--    Host-club managers already have reach today (host_sessions/host_squads,
--    20260601000002_rls.sql:124-133); sanctioning already has reach
--    (20260709131708_event_owner_checklist.sql). But a per-event admin
--    GRANT (event_admins row, no club management) has neither -- T3 review
--    flagged this: a grantee sees the host UI (EventManage) but every save
--    silently fails RLS. These are NEW additive per-command policies (never
--    `for all`, so DELETE reach is explicit, not accidental); existing
--    policies are untouched and OR together with these.
-- ---------------------------------------------------------------------------
create policy event_host_sessions_insert on public.event_sessions for insert
  with check (is_event_host(event_id));
create policy event_host_sessions_update on public.event_sessions for update
  using (is_event_host(event_id)) with check (is_event_host(event_id));
create policy event_host_sessions_delete on public.event_sessions for delete
  using (is_event_host(event_id));

-- squads has no event_id column directly -- derive the event via its session.
create policy event_host_squads_insert on public.squads for insert
  with check (exists (
    select 1 from event_sessions s where s.id = squads.session_id and is_event_host(s.event_id)));
create policy event_host_squads_update on public.squads for update
  using (exists (
    select 1 from event_sessions s where s.id = squads.session_id and is_event_host(s.event_id)))
  with check (exists (
    select 1 from event_sessions s where s.id = squads.session_id and is_event_host(s.event_id)));
create policy event_host_squads_delete on public.squads for delete
  using (exists (
    select 1 from event_sessions s where s.id = squads.session_id and is_event_host(s.event_id)));

-- ---------------------------------------------------------------------------
-- 3. scores: DOES carry an event id (renamed from meet_id by
--    20260626150000_rename_meet_entity.sql). Today's write policy
--    (scores_write, 20260601000002_rls.sql:119-121) is role-gated only
--    (admin / judge / meet-host app_role) with no per-event host reach at
--    all -- a host-club manager or event-admin grantee with none of those
--    roles cannot enter scores for their own event. Extend write+read reach
--    to is_event_host(event_id); read is already public (public_read on
--    scores), so this policy's practical effect is write-only, but it's
--    written `for all` (mirroring scores_write's own shape) since a
--    permissive select-true addition is harmless alongside public_read.
-- ---------------------------------------------------------------------------
create policy event_host_scores_write on public.scores for all
  using (is_event_host(event_id))
  with check (is_event_host(event_id));

-- ---------------------------------------------------------------------------
-- 4. Trigger interaction fixes -- both existing registrations triggers must
--    recognize writes made through the new host RPCs below as authorized,
--    via a TRANSACTION-LOCAL GUC (`app.event_host_write`) the RPCs set right
--    after their own is_event_host()/post-close authorization succeeds.
--    Deliberately NOT a blanket `is_event_host(event_id)` bypass baked into
--    the triggers themselves: RLS (regs_write) already blocks a host-club
--    manager from directly UPDATE/DELETE-ing another club's registration row
--    via raw PostgREST (manages_club(club_id) only covers their OWN club), so
--    the only way a host reaches these triggers for a DIFFERENT club's
--    registration is through a SECURITY DEFINER RPC that bypasses RLS. A
--    blanket is_event_host() bypass on the trigger itself would therefore
--    also silently reopen self-serve `paid=true` for a manager's OWN
--    (non-host) other club at an event they merely host -- confining the
--    bypass to the GUC keeps the new reach exactly as wide as the vetted RPC
--    (which re-validates auth + the post-close window + a field whitelist),
--    and zero wider for any other write path. `set_config(..., true)`
--    (is_local) reverts automatically at end of the RPC's transaction --
--    never persists across pooled-connection reuse.
-- ---------------------------------------------------------------------------
create or replace function guard_registration_paid() returns trigger as $$
declare
  v_privileged boolean;
  v_fee_zero boolean;
  v_old registrations%rowtype;
  v_old_paid boolean;
  v_old_updated_pending boolean;
  v_has_old boolean;
begin
  v_privileged := auth.role() is null or auth.role() = 'service_role' or is_admin()
    or coalesce(current_setting('app.event_host_write', true), '') = 'true';
  if v_privileged then
    return new;
  end if;

  select * into v_old from registrations where id = new.id;
  v_has_old := found;
  v_old_paid := coalesce(v_old.paid, false);
  v_old_updated_pending := coalesce(v_old.updated_pending, false);

  if new.updated_pending is true
     and (not v_has_old or v_old_updated_pending is distinct from new.updated_pending)
     and not (v_has_old and v_old_paid is true and new.paid is false) then
    raise exception 'guard_registration_paid: non-privileged caller cannot set updated_pending=true except when re-pending an already-paid registration';
  end if;

  if new.paid is true and (not v_has_old or v_old_paid is distinct from new.paid) then

    select (e.host_club_id is not null and e.host_club_id = new.club_id)
        or (e.entry_fee = 0 and e.second_discipline_fee = 0
            and coalesce((e.change_fee->>'amount')::numeric, 0) = 0)
      into v_fee_zero
      from events e
      where e.id = new.event_id;

    if coalesce(v_fee_zero, false) then
      return new;
    end if;

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

create or replace function guard_registration_edit_lockout() returns trigger as $$
declare
  v_privileged boolean;
  v_row registrations%rowtype;
  v_last_edit timestamptz;
  v_host_club_id text;
begin
  v_privileged := auth.role() is null or auth.role() = 'service_role' or is_admin()
    or coalesce(current_setting('app.event_host_write', true), '') = 'true';
  if v_privileged then
    if tg_op = 'DELETE' then return old; else return new; end if;
  end if;

  if tg_op = 'DELETE' then
    v_row := old;
  else
    select * into v_row from registrations where id = new.id;
    if not found then
      return new; -- genuinely new registration -- not gated by the edit lockout
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

-- ---------------------------------------------------------------------------
-- 5. host_upsert_registration(): the host roster tool's write path (add /
--    edit an athlete's level, apparatus, club, session). `registrations` RLS
--    itself is left UNTOUCHED (per spec: hosts must not get a blanket reg
--    write grant) -- every write goes through this SECURITY DEFINER RPC,
--    which authorizes ONCE, gates to the post-regCloses window (admin/
--    sanctioning are unrestricted -- they can already edit anytime via
--    direct RLS), validates the target athlete exists, and applies ONLY a
--    fixed field whitelist. paid/updated_pending/refunded/camp_survey are
--    NEVER touched by this function -- an update leaves them exactly as
--    stored.
--
--    PAYMENT SEMANTICS (deliberate, per spec): a brand-new host-added
--    registration is created `paid = true` with no cart line -- it's the
--    host's own meet, mirroring the existing host-club $0 rule (a
--    competing-for-host-club registration is already created paid:true with
--    no charge). This is NOT a bypass of that rule; it's the same rule
--    extended to a host managing ANY club's roster in their own post-close
--    tool. No fee is computed or collected here, by design -- entry-fee
--    corrections are handled manually by the UCG team (warned to the host
--    client-side before every roster mutation).
--
--    CLUB-MEMBERSHIP GATE: the "club needs an active club_memberships row for
--    the event's season" rule is enforced CLIENT-side in RosterToolsCard's
--    add-athlete flow (clubHasActiveMembership/seasonForDate,
--    src/lib/capabilities-core.ts) -- the same enforcement depth as every
--    other registration entry point (Club.tsx etc., none of which have a
--    server-side season check). Deliberately NOT replicated in SQL here:
--    seasonForDate's season-window logic lives in tested TS, and duplicating
--    it would create a second source of truth to drift.
-- ---------------------------------------------------------------------------
create or replace function host_upsert_registration(p_event_id text, p_reg jsonb)
returns text
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_host_club_id text;
  v_reg_closes timestamptz;
  v_privileged boolean;
  v_id text;
  v_athlete_id text;
  v_club_id text;
  v_discipline text;
  v_level_id text;
  v_apparatus text[];
  v_apparatus_levels jsonb;
  v_session_id text;
  v_partner_athlete_id text;
  v_existing_event_id text;
begin
  select e.host_club_id, e.reg_closes into v_host_club_id, v_reg_closes
    from events e where e.id = p_event_id;
  if v_host_club_id is null then
    raise exception 'Event not found.';
  end if;

  if not is_event_host(p_event_id) then
    raise exception 'Not authorized to edit this event''s roster.';
  end if;

  v_privileged := is_admin() or coalesce(auth_has_role('sanctioning'), false);
  if not v_privileged and (v_reg_closes is null or now() <= v_reg_closes) then
    raise exception 'Host roster edits are only available after registration closes.';
  end if;

  if (p_reg->>'event_id') is distinct from p_event_id then
    raise exception 'Registration event_id does not match the event being edited.';
  end if;

  v_id := p_reg->>'id';
  if v_id is null or v_id = '' then
    raise exception 'Registration id is required.';
  end if;

  select event_id into v_existing_event_id from registrations where id = v_id;
  if v_existing_event_id is not null and v_existing_event_id <> p_event_id then
    raise exception 'Registration % belongs to a different event.', v_id;
  end if;

  v_athlete_id := p_reg->>'athlete_id';
  if v_athlete_id is null or not exists (select 1 from people p where p.id = v_athlete_id) then
    raise exception 'Athlete not found.';
  end if;

  v_club_id := p_reg->>'club_id';
  v_discipline := p_reg->>'discipline';
  if v_discipline is null then
    raise exception 'Discipline is required.';
  end if;
  v_level_id := p_reg->>'level_id';
  v_apparatus := array(select jsonb_array_elements_text(coalesce(p_reg->'apparatus', '[]'::jsonb)));
  v_apparatus_levels := p_reg->'apparatus_levels';
  v_session_id := p_reg->>'session_id';
  v_partner_athlete_id := p_reg->>'partner_athlete_id';

  -- Authorize the pending write for the two registrations triggers (see
  -- section 4) -- transaction-local, reverts automatically at end of call.
  perform set_config('app.event_host_write', 'true', true);

  if v_existing_event_id is null then
    insert into registrations (
      id, event_id, athlete_id, club_id, discipline, level_id, apparatus,
      apparatus_levels, session_id, partner_athlete_id, paid
    ) values (
      v_id, p_event_id, v_athlete_id, v_club_id, v_discipline::discipline, v_level_id, v_apparatus,
      v_apparatus_levels, v_session_id, v_partner_athlete_id, true
    );
  else
    update registrations set
      athlete_id = v_athlete_id,
      club_id = v_club_id,
      discipline = v_discipline::discipline,
      level_id = v_level_id,
      apparatus = v_apparatus,
      apparatus_levels = v_apparatus_levels,
      session_id = v_session_id,
      partner_athlete_id = v_partner_athlete_id
    where id = v_id and event_id = p_event_id;
  end if;

  return v_id;
end;
$$;

revoke execute on function host_upsert_registration(text, jsonb) from public;
grant execute on function host_upsert_registration(text, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. host_delete_registration(): the roster tool's remove path. Hard delete,
--    same auth + post-close gate as host_upsert_registration. NO payment/
--    refund side effect by design -- refunds are a Phase 3 feature (spec
--    §H); removing a registration here does not touch payments/invoices/
--    invoice_items, so any money already collected for it stays recorded
--    exactly as-is until a refund is separately processed (Stripe-dashboard-
--    manual today). The client-side warning modal says this explicitly
--    before the host can commit any roster mutation.
-- ---------------------------------------------------------------------------
create or replace function host_delete_registration(p_event_id text, p_reg_id text)
returns void
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  v_host_club_id text;
  v_reg_closes timestamptz;
  v_privileged boolean;
  v_existing_event_id text;
begin
  select e.host_club_id, e.reg_closes into v_host_club_id, v_reg_closes
    from events e where e.id = p_event_id;
  if v_host_club_id is null then
    raise exception 'Event not found.';
  end if;

  if not is_event_host(p_event_id) then
    raise exception 'Not authorized to edit this event''s roster.';
  end if;

  v_privileged := is_admin() or coalesce(auth_has_role('sanctioning'), false);
  if not v_privileged and (v_reg_closes is null or now() <= v_reg_closes) then
    raise exception 'Host roster edits are only available after registration closes.';
  end if;

  select event_id into v_existing_event_id from registrations where id = p_reg_id;
  if v_existing_event_id is null then
    raise exception 'Registration not found.';
  end if;
  if v_existing_event_id <> p_event_id then
    raise exception 'Registration % belongs to a different event.', p_reg_id;
  end if;

  perform set_config('app.event_host_write', 'true', true);

  delete from registrations where id = p_reg_id and event_id = p_event_id;
end;
$$;

revoke execute on function host_delete_registration(text, text) from public;
grant execute on function host_delete_registration(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. find_person_for_host(): resolves an existing account by exact email so
--    the roster tool's "Add athlete by email" flow can build a Registration
--    to hand to host_upsert_registration (mirrors grant_event_admin's
--    exact-email-only lookup -- no general people-search exposed to a host).
-- ---------------------------------------------------------------------------
create or replace function find_person_for_host(p_event_id text, p_email text)
returns table(person_id text, first_name text, last_name text, club_id text)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_person record;
begin
  if not is_event_host(p_event_id) then
    raise exception 'Not authorized to edit this event''s roster.';
  end if;

  select p.id, p.first_name, p.last_name, p.main_club_id
    into v_person
    from people p
    where lower(p.email) = lower(p_email)
    limit 1;

  if not found then
    raise exception 'No account found for that email.';
  end if;

  return query select v_person.id, v_person.first_name, v_person.last_name, v_person.main_club_id;
end;
$$;

revoke execute on function find_person_for_host(text, text) from public;
grant execute on function find_person_for_host(text, text) to authenticated;
