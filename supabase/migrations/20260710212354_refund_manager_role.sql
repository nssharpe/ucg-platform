-- Event-management v2 Phase 3 (refunds, spec §H): adds the 'refund_manager'
-- value to the app_role enum (user_roles.role) so the "Refund manager" role
-- can be granted (gates the refund review queue built in T6). Mirrors
-- 20260624233241_app_role_finance_admin.sql.
--
-- IMPORTANT: `ALTER TYPE ... ADD VALUE` cannot be run in the same transaction
-- that then USES the new value. This file runs by itself and commits before
-- any file that references 'refund_manager' (refunds_foundations.sql).

alter type app_role add value if not exists 'refund_manager';
