-- Adds the 'finance_admin' value to the app_role enum (user_roles.role) so the
-- "Finance Admin" User Role can be granted. No extra attributes — gates a later
-- finance-dashboard phase.
--
-- IMPORTANT: `ALTER TYPE ... ADD VALUE` cannot be run in the same transaction
-- that then USES the new value. This file runs by itself and commits before any
-- file that references 'finance_admin'.

alter type app_role add value if not exists 'finance_admin';
