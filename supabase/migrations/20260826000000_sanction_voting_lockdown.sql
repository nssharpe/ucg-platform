-- Sanction voting quorum fix (UAT round 2, 2026-08-26 owners' decisions).
--
-- THE BUG (client side, fixed in the same commit as this migration).
-- Sanction.tsx hardcoded `FALLBACK_TEAM_SIZE = 5` and floored the live team
-- size at that constant, so `tallyVotes`'s early-approval threshold
-- (ceil(2/3 * teamSize)) demanded 4 approvals against a real 2-person
-- Sanctioning Team — mathematically unreachable, blocking every early
-- approval. Separately, `sanction_votes_write` (20260618200000) let ANY
-- admin cast a vote (`role in ('admin','sanctioning')`), not just the actual
-- Sanctioning Team, so the voter pool never matched who the quorum math was
-- supposed to be counting.
--
-- OWNERS' DECISIONS (2026-08-26), implemented here + client-side:
--  1. Team size = the live COUNT of `user_roles.role = 'sanctioning'` rows.
--     No hardcoded fallback, ever.
--  2. Only the 'sanctioning' role may cast a vote. Admins keep full
--     visibility (queue/detail/tally) but get no vote control. An admin who
--     also holds 'sanctioning' votes normally and counts once toward team
--     size (user_roles' PK is (user_id, role) — one row per role per user).
--  3. Unanimity at small team sizes (ceil(2/3*2) = 2) is intentional — no
--     small-team special case.
--
-- WHY A NEW RPC. `roles_self_read` (20260601000002_rls.sql) only lets a
-- caller read THEIR OWN user_roles row (`user_id = auth.uid() or is_admin()`)
-- — a non-admin sanctioning member cannot COUNT every sanctioning row via a
-- plain client-side select. `sanctioning_team_size()` is SECURITY DEFINER so
-- it can read every user_roles row while gating on the SAME predicate
-- `list_sanctioning_team()` (20260709131708) already uses for an analogous
-- problem — copied, not reinvented.
--
-- SCOPE ADDITION (same session, owners approved 2026-08-26): a Sanctioning
-- Team member may edit a request's voting deadline from the vote page.
-- CHECKED `sanction_requests_rw` (20260618200000) for this — it is already a
-- single `for all` policy admitting `role in ('admin','sanctioning')` with NO
-- status restriction, so a plain (non-admin) sanctioning caller can ALREADY
-- UPDATE `deadline_at` on any row. NO RLS CHANGE WAS NEEDED for this feature
-- (deliberately not narrowing that pre-existing broad policy down to
-- `status = 'voting'` here either — it predates this migration, governs every
-- field on the row, not just the deadline, and narrowing it is a separate
-- decision outside this fix's scope). The `status = 'voting'`-only /
-- `canVoteSanction`-only restriction on WHO sees the deadline editor and
-- WHEN is enforced client-side only (`deadlineEditable`, `src/lib/
-- sanction.ts`) — the same app-business-rule-in-UI / hard-invariant-in-RLS
-- split used throughout this app (e.g. `canStillEditRegistration`).

-- ── sanctioning_team_size(): live count of the 'sanctioning' role ─────────
-- Same fail-closed, SECURITY DEFINER, pinned-search_path shape as
-- next_invoice_number (20260821140000) / list_sanctioning_team
-- (20260709131708). Deliberately counts role = 'sanctioning' ONLY — never
-- 'admin' — since an admin without the sanctioning role does not vote and
-- must not inflate the quorum denominator.
create or replace function sanctioning_team_size()
returns int
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_count int;
begin
  if not (is_admin() or coalesce(auth_has_role('sanctioning'), false)) then
    raise exception 'sanctioning_team_size: not authorized';
  end if;

  select count(*) into v_count from user_roles where role = 'sanctioning';
  return v_count;
end;
$$;

comment on function sanctioning_team_size() is
  'Live count of user_roles rows with role = ''sanctioning'' (the real Sanctioning Team size, '
  'no hardcoded fallback). SECURITY DEFINER because roles_self_read only lets a caller read '
  'their OWN user_roles row -- authorization is checked ONCE up front (admin or sanctioning), '
  'fail-closed, mirroring list_sanctioning_team. Never counts the admin role.';

-- Fresh function grants EXECUTE to PUBLIC by default -- revoke, then grant
-- explicitly. anon can never satisfy the in-body check, so it gets nothing.
revoke execute on function sanctioning_team_size() from public;
revoke execute on function sanctioning_team_size() from anon;
grant execute on function sanctioning_team_size() to authenticated;

-- ── sanction_votes_write: only the 'sanctioning' role may cast a vote ─────
-- Was `role in ('admin','sanctioning')` (20260618200000), which let every
-- admin vote regardless of team membership. `sanction_votes_read` is
-- UNCHANGED (admin + sanctioning keep full read visibility of the tally/vote
-- log, per the owners' "admins keep full visibility" decision). Kept as a
-- single `for all` policy (matching the shape being replaced) rather than
-- splitting into insert/update/delete -- the app never deletes a vote row
-- (castVote only inserts/updates), so this isn't a new DELETE-grant
-- surface, just a narrower actor set on the existing one.
drop policy if exists sanction_votes_write on sanction_votes;
create policy sanction_votes_write on sanction_votes for all
  using (voter_user_id = auth.uid()
         and exists (select 1 from user_roles ur where ur.user_id = auth.uid()
                     and ur.role = 'sanctioning'))
  with check (voter_user_id = auth.uid()
         and exists (select 1 from user_roles ur where ur.user_id = auth.uid()
                     and ur.role = 'sanctioning'));
