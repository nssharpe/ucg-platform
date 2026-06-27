-- 20260626150100_rename_apparatus.sql
-- Phase 2 of the "Events rename" work: rename the gymnastics APPARATUS columns.
--   registrations.events → registrations.apparatus  (text[] of apparatus codes)
--   scores.event         → scores.apparatus         (single apparatus code)
--
-- This is the companion to 20260626150000_rename_meet_entity.sql, which renamed
-- the competition ENTITY (Meet → Event). After the entity migration the
-- `registrations` table carried BOTH `event_id` (the renamed competition FK) and
-- `events` (this still-to-be-renamed apparatus list); this migration finishes the
-- job so apparatus is named `apparatus` everywhere.
--
-- SAFETY NOTE — renames are non-destructive and dependency-preserving: Postgres
--   tracks every dependent object (indexes, RLS policies, realtime publication
--   membership) by the column's internal OID, not by its textual name. A
--   `RENAME COLUMN` re-points automatically and rewrites no data.
--
-- `scores.id` is a composite text value `${eventId}|${regId}|${apparatus}`. Only
-- the column/field NAMES change in code; existing id VALUES are opaque and are
-- NOT rewritten here (no code parses them back out). `scores` keeps
-- `replica identity full`, so realtime DELETE payloads continue to carry old keys.

-- ── Columns ───────────────────────────────────────────────────────────────
alter table registrations rename column events to apparatus;
alter table scores        rename column event  to apparatus;

-- ── Cosmetic: auto-generated index names ──────────────────────────────────
-- Guarded with IF EXISTS so a missing/divergent generated name doesn't break the
-- push. (No dedicated single-column index on these apparatus columns is expected;
-- these statements are defensive only. Definitions track by OID regardless.)
alter index if exists registrations_events_idx rename to registrations_apparatus_idx;
alter index if exists scores_event_idx         rename to scores_apparatus_idx;
