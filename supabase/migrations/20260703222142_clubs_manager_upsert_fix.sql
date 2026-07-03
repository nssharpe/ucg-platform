-- Fix 20260703221855_clubs_manager_update.sql: it added an UPDATE-only
-- policy, but pushClub() writes via `.upsert()` (INSERT ... ON CONFLICT DO
-- UPDATE). Postgres RLS requires an applicable INSERT policy's WITH CHECK to
-- pass for the candidate row EVEN when the statement ultimately takes the
-- ON CONFLICT DO UPDATE path — an UPDATE-only policy doesn't cover that
-- INSERT-phase check, so a non-admin manager's upsert still failed with
-- "new row violates row-level security policy for table clubs" (confirmed
-- live). Widen to `for all`, still scoped by manages_club(id): for a
-- genuinely NEW club id (not yet in club_managers), manages_club() is false,
-- so a non-admin still can't create one — only admins can (admin_all,
-- unchanged) — this only additionally covers the upsert-of-an-existing-
-- managed-club case.
drop policy if exists manager_update on clubs;
create policy manager_all on clubs for all
  using (manages_club(id)) with check (manages_club(id));
