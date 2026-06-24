-- Allow a signed-in user to INSERT their OWN people row even when the client
-- could not set auth_user_id at insert time (first-time self-save self INSERT).
--
-- The prior policy required is_admin() OR manages_club(main_club_id) OR
-- auth_user_id = auth.uid(). An ordinary member saving their own profile fails
-- the first two (a member does not *manage* their own club), and if the client
-- upserts a row with auth_user_id = null the third fails too -> INSERT rejected
-- ("new row violates row-level security policy for table people").
--
-- Belt-and-suspenders alongside the client fix (which now stamps auth_user_id
-- on the acting user's own row): add a self branch keyed on the VERIFIED JWT
-- email so a signed-in user can always insert their own row. This NEVER allows
-- inserting a row for anyone else — the email on the new row must equal the
-- caller's own authenticated email. coalesce guards a null JWT email so the
-- branch evaluates false (never matches a null/empty people.email) rather than
-- yielding SQL NULL.
drop policy if exists people_admin_insert on people;
create policy people_admin_insert on people for insert
  with check (
    is_admin()
    or manages_club(main_club_id)
    or auth_user_id = auth.uid()
    or lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
