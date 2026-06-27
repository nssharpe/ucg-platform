-- 20260627120000_rename_event_levels_apparatus.sql
-- Consistency follow-up to the apparatus rename: the per-apparatus T&T level map
-- column was still named `event_levels` (an apparatus-meaning "event"). Rename it
-- to `apparatus_levels` so apparatus is named consistently everywhere.
--
-- Non-destructive: a RENAME COLUMN re-points dependents by OID and rewrites no data.
-- This is a jsonb column (apparatus-code → level-id map); no index/constraint
-- depends on it. No Edge Function references it (verified).
alter table registrations rename column event_levels to apparatus_levels;
