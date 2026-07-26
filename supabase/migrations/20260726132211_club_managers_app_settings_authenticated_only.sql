-- Security hardening Phase 3, LOW item 1: `club_managers` and `app_settings`
-- both carry a permissive `using (true)` SELECT policy (from
-- 20260601000002_rls.sql and 20260618000007_feedback_2026_06_18.sql
-- respectively), so an anonymous (signed-out) caller can read either table
-- wholesale via raw PostgREST. Neither needs to be public:
--
--   * club_managers rows are just (club_id, person_id) pairs — an internal
--     authorization mapping, not anything rendered on a public page.
--     `manages_club()` (20260601000002_rls.sql) is `security definer`, so it
--     reads club_managers bypassing RLS entirely — scoping this SELECT policy
--     does NOT affect who manages_club() says can manage a club, and every
--     write to this table already goes through the security-definer RPC
--     `replace_club_managers` (20260703221303_fix_club_managers_self_lockout.sql)
--     or the admin branch of `cm_admin`, neither of which depends on this
--     SELECT policy either.
--   * app_settings currently holds one key (`region_overrides`, an admin
--     state→region map) consumed ONLY by the admin-only Regions editor
--     (src/pages/admin/league/Regions.tsx, behind RequireAdmin) — no public
--     page reads it.
--
-- Both tables are consumed client-side ONLY through the single loadAll()
-- Promise.all in src/lib/supabase.ts, which runs unconditionally on app boot
-- (store.ts: `if (isSupabaseConfigured) void syncFromSupabase()`) for EVERY
-- visitor, signed in or not.
--
-- NO companion client change is needed, and the first draft of this migration
-- was wrong about that. A restrictive RLS SELECT *predicate* (what's below)
-- FILTERS ROWS — it does not raise. An anonymous caller reading either table
-- gets `200 []`, not a 403, so loadAll()'s hard-fail `errors` list never sees
-- an error and the boot is unaffected. (A grant-level `revoke select ... from
-- anon` WOULD 403 — that is the distinction; this migration deliberately uses
-- a policy predicate, not a grant revoke.) Verified empirically against
-- staging AND prod as a real anonymous client, 2026-07-26: `club_managers` →
-- error=none rows=0, and the full hard-fail set → zero errors on both.
--
-- The draft's companion change (moving `clubManagersR` into loadAll's
-- "tolerated if absent" set) was therefore reverted: it wasn't needed, and it
-- would have COST a fail-fast signal — a genuine club_managers read failure
-- (outage, future grant regression) would then be silently swallowed for
-- signed-in users too, leaving every club with empty managerIds and manager
-- permissions appearing to vanish with no error surfaced anywhere.
-- app_settings was already tolerated for its own unrelated reason (it may not
-- exist on a pre-0007 DB), which is what made the pattern look applicable.
--
-- Edge Functions are unaffected: every function that reads club_managers
-- (notify-club-cart, manage-waitlist, invite-account, create-waiver-link,
-- admin-delete-person, create-checkout-session, request-manager-access,
-- request-refund, send-club-invite, scheduled-dispatch, send-event-email,
-- _shared/waitlist-contacts.ts) uses the service-role client, which bypasses
-- RLS entirely.

drop policy if exists cm_read on club_managers;
create policy cm_read on club_managers for select
  using (auth.role() = 'authenticated');

drop policy if exists app_settings_read on app_settings;
create policy app_settings_read on app_settings for select
  using (auth.role() = 'authenticated');
