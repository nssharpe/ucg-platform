-- UAT Z-06-01 (S1): no silent score overwrite. Two judges -- one signed in at
-- `#/judge?event=...`, one anonymous via the judge-access unlock on a phone --
-- posted different scores for the same athlete/apparatus seconds apart, and
-- the second one blindly overwrote the first: both paths upsert the SAME
-- deterministic `scores.id` (`${eventId}|${regId}|${apparatus}`) with no
-- version/updated_at compare at all.
--
-- Adds `scores.updated_at` (a trigger stamps it on every UPDATE; INSERT
-- defaults to now()) plus a compare-and-set RPC, `post_score`, that both
-- writer paths now call instead of a bare upsert:
--   - the signed-in client (`pushScore`, src/lib/supabase.ts)
--   - the anonymous `judge-entry` Edge Function (service role), for the
--     codeless-judge path
--
-- `post_score` is SECURITY INVOKER, not DEFINER -- it does no authorization
-- of its own, so the two existing scores write policies (`scores_write`,
-- role-gated; `event_host_scores_write`, is_event_host(event_id) --
-- 20260710020303_host_post_close_edit.sql) keep applying to a signed-in
-- caller EXACTLY as they did for the old direct upsert. A service-role
-- caller (judge-entry) bypasses RLS at the role level (service_role has
-- BYPASSRLS) regardless of the function's own security mode, so the
-- anonymous path is unaffected by this being INVOKER rather than DEFINER.
--
-- The predicate: row-lock the existing row by id (SELECT ... FOR UPDATE, so
-- two concurrent posts serialize instead of racing); if a row is found AND
-- (p_expected_updated_at IS NULL OR it doesn't match that row's updated_at)
-- -> return a conflict WITHOUT writing. "A row exists but the caller expected
-- none" is deliberately a conflict too -- that's exactly the two-judges case:
-- the second judge's device loaded the score pad before the first judge's
-- post landed, so it has never seen an updated_at for this id at all.

begin;

alter table scores add column if not exists updated_at timestamptz;
update scores set updated_at = coalesce(updated_at, entered_at, now()) where updated_at is null;
alter table scores alter column updated_at set default now();
alter table scores alter column updated_at set not null;

create or replace function set_scores_updated_at() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists scores_set_updated_at on scores;
create trigger scores_set_updated_at
  before update on scores
  for each row execute function set_scores_updated_at();

-- ---------------------------------------------------------------------------
-- post_score: compare-and-set score write. p_score carries the same
-- snake_case shape scoreToRow()/the judge-entry function already build for a
-- plain upsert (id, event_id, session_id, reg_id, apparatus, sv, deductions,
-- e_score, final, source, calc, calc_state, adjust_note, adjusted_at,
-- entered_by, entered_at, flashed, scratched, deductions2, e_score2) --
-- `updated_at` is deliberately NOT one of its keys, since it is entirely
-- server-controlled (default on insert, trigger on update).
-- ---------------------------------------------------------------------------
create or replace function post_score(p_score jsonb, p_expected_updated_at timestamptz)
returns jsonb
language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  v_id text := p_score ->> 'id';
  existing scores%rowtype;
  new_row scores%rowtype;
begin
  if v_id is null or v_id = '' then
    raise exception 'post_score: missing score id';
  end if;

  select * into existing from scores where id = v_id for update;

  if found and (p_expected_updated_at is null or p_expected_updated_at <> existing.updated_at) then
    return jsonb_build_object('ok', false, 'conflict', true, 'current', to_jsonb(existing));
  end if;

  insert into scores (
    id, event_id, session_id, reg_id, apparatus, sv, deductions, e_score, final,
    source, calc, calc_state, adjust_note, adjusted_at, entered_by, entered_at,
    flashed, scratched, deductions2, e_score2
  ) values (
    v_id,
    p_score ->> 'event_id',
    p_score ->> 'session_id',
    p_score ->> 'reg_id',
    p_score ->> 'apparatus',
    (p_score ->> 'sv')::numeric,
    (p_score ->> 'deductions')::numeric,
    (p_score ->> 'e_score')::numeric,
    (p_score ->> 'final')::numeric,
    coalesce(p_score ->> 'source', 'manual')::score_source,
    p_score ->> 'calc',
    p_score -> 'calc_state',
    p_score ->> 'adjust_note',
    (p_score ->> 'adjusted_at')::timestamptz,
    p_score ->> 'entered_by',
    coalesce((p_score ->> 'entered_at')::timestamptz, now()),
    coalesce((p_score ->> 'flashed')::boolean, false),
    coalesce((p_score ->> 'scratched')::boolean, false),
    (p_score ->> 'deductions2')::numeric,
    (p_score ->> 'e_score2')::numeric
  )
  on conflict (id) do update set
    event_id    = excluded.event_id,
    session_id  = excluded.session_id,
    reg_id      = excluded.reg_id,
    apparatus   = excluded.apparatus,
    sv          = excluded.sv,
    deductions  = excluded.deductions,
    e_score     = excluded.e_score,
    final       = excluded.final,
    source      = excluded.source,
    calc        = excluded.calc,
    calc_state  = excluded.calc_state,
    adjust_note = excluded.adjust_note,
    adjusted_at = excluded.adjusted_at,
    entered_by  = excluded.entered_by,
    entered_at  = excluded.entered_at,
    flashed     = excluded.flashed,
    scratched   = excluded.scratched,
    deductions2 = excluded.deductions2,
    e_score2    = excluded.e_score2
  returning * into new_row;

  return jsonb_build_object('ok', true, 'current', to_jsonb(new_row));
end;
$$;

revoke all on function post_score(jsonb, timestamptz) from public;
revoke all on function post_score(jsonb, timestamptz) from anon;
grant execute on function post_score(jsonb, timestamptz) to authenticated, service_role;

commit;
