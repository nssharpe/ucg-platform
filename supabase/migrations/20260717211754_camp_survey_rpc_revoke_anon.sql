-- Follow-up to 20260717205348_camp_survey_scoped_read.sql: the anon probe
-- after applying it showed anon could still EXECUTE registration_camp_surveys
-- (returning [] — the WHERE clause fails closed, so no data leaked). Cause:
-- Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE on new functions to
-- anon/authenticated/service_role directly, so `revoke ... from public` alone
-- leaves anon's own grant standing (same ACL-union trap as the table grant in
-- the parent migration). Defense-in-depth: revoke anon's execute explicitly.
revoke execute on function registration_camp_surveys(text) from anon;
