-- Privacy fix (docs/research/2026-07-17-supabomb-scan-results.md, "Finding to
-- fix: camp_survey is world-readable"): `registrations` carries the
-- `public_read using (true)` policy from the original RLS migration
-- (20260601000002_rls.sql) -- intentional, it drives live results/start lists
-- keyed on opaque ids. But `camp_survey` (added later, 20260618200000) rides
-- along on that same public policy and holds real personal detail for
-- sometimes-minor registrants: bedtime, noise level, cabin gender preference,
-- and a free-text roommate request. That column was never re-scoped when it
-- was added -- this migration closes it.
--
-- Approach (matches the writeup, do NOT blanket-revoke without the app-side
-- fix first -- `loadAll` in src/lib/supabase.ts now selects an explicit
-- column list excluding camp_survey, so guest/anon page loads never ask for
-- it in the first place):
--   1. registration_camp_surveys(): a SECURITY DEFINER RPC returning
--      camp_survey only for rows the caller may legitimately see -- the
--      athlete themself, a manager of the registration's OWN club, or an
--      event host (host-club manager / event-admin grantee / admin /
--      sanctioning -- reuses is_event_host() from
--      20260710020303_host_post_close_edit.sql rather than re-deriving that
--      predicate here).
--   2. Column-level lockdown of camp_survey on the base table (revoke the
--      table-wide SELECT, grant it back on every OTHER column -- see the
--      detailed comment at that statement for why a plain column-REVOKE alone
--      would be a no-op here) -- SECURITY DEFINER functions run as the
--      function owner, so this does not affect registration_camp_surveys()
--      or the pre-existing event_host_roster() (which already returns
--      camp_survey to hosts, 20260710151638_event_host_addons_and_camp_detail
--      .sql -- unaffected by both this revoke and the loadAll change since
--      it's a separate RPC that selects the column directly).
--
-- Write-path check (done, not a migration change): every registrations write
-- in src/lib/supabase.ts goes through .upsert()/.update()/.delete() with NO
-- .select() chained, so postgrest-js sends `Prefer: return=minimal` -- no
-- representation is requested back, so the column-level SELECT revoke below
-- cannot break writing camp_survey (INSERT/UPDATE privilege on the column is
-- untouched; only SELECT is revoked).

-- ---------------------------------------------------------------------------
-- registration_camp_surveys(): one row per registration whose camp_survey the
-- caller may read. p_event_id narrows to one event (the common case -- a
-- self-registration modal or edit screen only cares about one event at a
-- time); omit it to check across all of the caller's own/managed events. Rows
-- with camp_survey null are still returned (a registration that hasn't
-- filled out the survey yet) so callers can distinguish "no answer" from "not
-- authorized" cleanly -- authorization is enforced entirely by the WHERE
-- clause, so a row simply doesn't come back if the caller can't see it.
-- ---------------------------------------------------------------------------
create or replace function registration_camp_surveys(p_event_id text default null)
returns table(registration_id text, camp_survey jsonb)
language sql stable security definer set search_path = public, pg_temp as $$
  select r.id, r.camp_survey
  from registrations r
  where (p_event_id is null or r.event_id = p_event_id)
    and (
      coalesce(my_person_id() = r.athlete_id, false)
      or coalesce(manages_club(r.club_id), false)
      or is_event_host(r.event_id)
    );
$$;

revoke execute on function registration_camp_surveys(text) from public;
grant execute on function registration_camp_surveys(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Column-level lockdown. IMPORTANT Postgres privilege trap: anon/authenticated
-- never received an explicit `grant select on registrations` from any
-- migration (grepped -- confirmed same as the finance-foundations migration's
-- own finding for payments/invoices/etc.) -- table access has always come from
-- the project's default Supabase bootstrap privileges (`grant all on all
-- tables in schema public to anon, authenticated`, set once outside migration
-- history). A bare `revoke select (camp_survey) on registrations from ...`
-- would be a NO-OP against that: Postgres ACL checks are a union across every
-- applicable grant, and the pre-existing TABLE-level SELECT grant would still
-- cover every column, camp_survey included -- a column-level revoke only
-- removes a column-level grant that was never separately made. The correct
-- fix (same idiom as `waitlist_groups`'/`event_checkins`' `revoke all ...` +
-- `grant update (status, ...)` column-scoped re-grant elsewhere in this repo):
-- revoke the table-level SELECT entirely, then grant SELECT back on the full
-- column list EXCLUDING camp_survey. RLS (`public_read using (true)`) still
-- decides which ROWS are visible -- this only narrows which COLUMNS of a
-- visible row can be requested. Every legitimate camp_survey reader now goes
-- through registration_camp_surveys() (self / own-club manager / event host)
-- or event_host_roster() (event host, already scoped) -- both SECURITY
-- DEFINER, both unaffected (they run as the function owner, not the caller).
-- ---------------------------------------------------------------------------
revoke select on registrations from anon, authenticated;
grant select (
  id, event_id, athlete_id, club_id, discipline, level_id, apparatus, apparatus_levels,
  session_id, squad_id, refunded, refund_requested, keep_listed, partner_athlete_id, paid,
  updated_pending, created_at, waitlisted, waitlist_group_id, hold_expires_at
) on registrations to anon, authenticated;
