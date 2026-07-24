-- Security hardening Phase 3 — M4: `people` self-insert-by-email branch.
--
-- Finding (docs/specs/2026-07-02-security-review-findings.md M4):
-- 20260624233746_people_self_insert_by_email.sql added an insert branch
-- `lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))` to
-- `people_admin_insert`. Unlike the other branches (is_admin(),
-- manages_club(main_club_id), auth_user_id = auth.uid()), this one is NOT
-- scoped to a specific row's identity — it lets any signed-in caller insert a
-- BRAND NEW `people` row (arbitrary id, arbitrary `main_club_id`, arbitrary
-- other columns) as long as the row's `email` column happens to equal their
-- own verified JWT email. That is broader than intended: junk rows with an
-- attacker-chosen `main_club_id` (club-eligibility-adjacent data) can be
-- created for one's own email.
--
-- The legitimate case this branch was covering — claiming/creating "my own"
-- person row on first sign-in — already has a correct, narrower path:
-- `link_or_create_person` (20260601000005_account_foundation.sql, SECURITY
-- DEFINER, search_path pinned by 20260702182709_pin_search_path.sql). It
-- claims at most ONE pre-existing unclaimed row matching the verified email
-- (oldest match, deterministic), or creates exactly one fresh row stamping
-- `auth_user_id = auth.uid()` itself — entirely server-side, bypassing this
-- policy. `src/lib/auth.ts` `onAuthenticated()` calls it FIRST, before any
-- direct `people` write, on every sign-in.
--
-- Enumeration of every client write to `people` (grepped `pushPerson\(` and
-- `from\('people'\)` across src/, 2026-07-24):
--   1. src/lib/auth.ts:108 `pushPerson(updated)` — the once-only "upgrade a
--      freshly-linked/created person to kind:'coach'" mirror, called right
--      after `linkOrCreatePerson` in the SAME `onAuthenticated()` flow, for
--      the caller's OWN row. It did NOT pass `{selfAuthUserId}`, so
--      `personToRow()` omits `auth_user_id` from the upsert payload — and per
--      CLAUDE.md's "RLS upsert trap" (an upsert must pass the INSERT policy's
--      WITH CHECK even on the conflict-update path), the proposed row's
--      `auth_user_id` evaluates to NULL, failing the `auth_user_id =
--      auth.uid()` branch. Today this call depends on the email branch we are
--      removing. FIXED in this same change (see auth.ts diff): the call now
--      passes `{ selfAuthUserId: user.id }`, mirroring the pattern already
--      documented for Profile.tsx's self-save, so it passes the
--      `auth_user_id = auth.uid()` branch instead.
--   2. src/pages/Profile.tsx:274 `pushPerson(d.people[i], selfAuthUserId ?
--      {selfAuthUserId} : undefined)` — self-save already stamps
--      `selfAuthUserId = getSession()?.user.id` (only when NOT `adminView`);
--      admin-editing-another-person omits it and relies on `is_admin()`.
--      Passes `auth_user_id = auth.uid()` or `is_admin()` — unaffected.
--   3. src/components/PersonForm.tsx:83,87 `pushPerson(...)` (no opts) — the
--      ONLY renderer of `<PersonForm>` is src/pages/admin/AdminMembers.tsx:549,
--      reachable only via the `/admin/members` route (`<RequireAdmin>` in
--      App.tsx). Relies on `is_admin()` — unaffected.
--   4. src/pages/admin/AdminMembers.tsx:114 `pushPerson(dp)` (no opts) — the
--      "merge duplicate people" admin tool, same `/admin/members`
--      `<RequireAdmin>` route. Relies on `is_admin()` — unaffected.
--   5. src/lib/supabase.ts:2443 `pushAll`'s bulk `people` upsert — the
--      "Push local DB → Supabase" admin seed tool
--      (src/pages/admin/league/DemoTools.tsx, `/admin/league`
--      `<RequireAdmin>`). Relies on `is_admin()` — unaffected.
-- None of these need the email-match branch once (1) is fixed client-side; it
-- is dropped here.
drop policy if exists people_admin_insert on people;
create policy people_admin_insert on people for insert
  with check (
    is_admin()
    or manages_club(main_club_id)
    or auth_user_id = auth.uid()
  );
