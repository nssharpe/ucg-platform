-- Adds the 'regional_rep' value to the app_role enum (user_roles.role) so the
-- "Regional Representative" User Role can be granted. A regional rep also has a
-- region, stored per-user in regional_rep_regions (added in a later migration).
--
-- IMPORTANT: `ALTER TYPE ... ADD VALUE` cannot be run in the same transaction
-- that then USES the new value. This file runs by itself and commits before any
-- file that references 'regional_rep'.

alter type app_role add value if not exists 'regional_rep';
