-- 0007b_sanctioning_role.sql
-- Adds the 'sanctioning' value to the app_role enum so the Wave-3 "Sanctioning
-- Team" User Role can be granted (user_roles.role is the app_role enum, defined in
-- 0001 without this value). Also a prerequisite for 0008's RLS policies, which
-- reference role 'sanctioning'.
--
-- IMPORTANT: `ALTER TYPE ... ADD VALUE` cannot be run in the same transaction that
-- then USES the new value. Run this file BY ITSELF and let it commit before running
-- 0008 (or any statement that references 'sanctioning').

alter type app_role add value if not exists 'sanctioning';
