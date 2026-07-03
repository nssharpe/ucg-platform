-- Fix a self-lockout bug in club_managers writes, discovered while
-- consolidating the club edit UI (feedback tracker B8).
--
-- pushClub() (src/lib/supabase.ts) always re-syncs club_managers via a plain
-- client-side delete-then-insert under RLS (cm_write: `using/with check
-- (manages_club(club_id))`, from 20260601000005_account_foundation.sql).
-- manages_club() is STABLE and queries club_managers live, so for a non-admin
-- manager saving their OWN club: the DELETE step runs while they're still a
-- manager (manages_club() true) and succeeds, wiping every row for that club
-- INCLUDING their own — then the INSERT step re-evaluates manages_club(),
-- which is now FALSE (their row is gone), so the re-insert of the
-- replacement rows (including their own) fails its `with check` and is
-- rejected. Net effect: the club silently ends up with ZERO managers, with
-- only a generic "couldn't save" toast — no admin bypass exists for a
-- non-admin actor to recover without a direct DB fix. is_admin() acting
-- users are unaffected (manages_club() stays true for them regardless of
-- club_managers' contents), which is why this was never noticed via the
-- admin-heavy usage pattern so far.
--
-- Fix: a SECURITY DEFINER RPC that checks authorization ONCE up front (before
-- any write), then performs the delete+insert atomically in a single
-- function invocation — the self-referential timing gap can't occur because
-- the elevated-privilege writes never re-consult manages_club() mid-flight.
create or replace function replace_club_managers(p_club_id text, p_person_ids text[])
returns void
language plpgsql volatile security definer set search_path = public as $$
begin
  if not manages_club(p_club_id) then
    raise exception 'Not authorized to manage this club.';
  end if;

  delete from club_managers where club_id = p_club_id;

  insert into club_managers (club_id, person_id)
    select p_club_id, person_id from unnest(p_person_ids) as person_id
    on conflict do nothing;
end;
$$;

grant execute on function replace_club_managers(text, text[]) to authenticated;
