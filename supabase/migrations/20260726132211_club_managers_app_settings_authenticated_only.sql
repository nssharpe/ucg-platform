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
-- visitor, signed in or not — so this migration ships together with a
-- companion client change (same PR) that moves `club_managers` from
-- loadAll's hard-fail table list into the same "tolerated if absent" pattern
-- app_settings already uses. Without that change, restricting club_managers
-- would make loadAll() throw for every anonymous visitor and silently
-- degrade EVERY public page (Events, EventDetail, Results, …) back to stale
-- local/seed data. app_settings was already in the tolerated list, so it
-- needed no client change.
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
