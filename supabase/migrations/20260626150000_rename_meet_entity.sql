-- 20260626150000_rename_meet_entity.sql
-- Phase 2 of the "Events rename" work: rename the competition ENTITY Meet → Event.
--
-- SAFETY NOTE — renames are non-destructive and dependency-preserving:
--   Postgres stores every dependent object (foreign keys, RLS policies, indexes,
--   triggers, realtime publication membership, views) by the target's internal
--   OID, NOT by its textual name. `ALTER TABLE ... RENAME` / `RENAME COLUMN`
--   therefore re-point automatically — no FK/RLS/index/publication needs to be
--   dropped or recreated, and no data is rewritten. We additionally rename a few
--   auto-generated INDEX names and the `meet_status` enum TYPE purely so the
--   schema reads consistently; those renames are cosmetic.
--
-- SCOPE: entity only (Meet → Event). The apparatus rename
--   (registrations.events → apparatus, scores.event → apparatus) is a SEPARATE
--   migration owned by the apparatus pass and is intentionally NOT done here.
--   After this migration, `registrations` carries BOTH `event_id` (the renamed
--   competition FK) AND `events` (the still-to-be-renamed apparatus list).
--
-- `scores.id` is a composite text value `${meetId}|${regId}|${event}`. Only the
-- column/var NAMES change in code; existing id VALUES are opaque and are NOT
-- rewritten here (no code parses them back out).

-- ── Tables ────────────────────────────────────────────────────────────────
alter table meets         rename to events;
alter table meet_sessions rename to event_sessions;

-- ── Columns: meet_id → event_id ───────────────────────────────────────────
alter table event_sessions rename column meet_id to event_id;
alter table registrations  rename column meet_id to event_id;
alter table scores         rename column meet_id to event_id;

-- ── Columns: cart/invoice/sanction refs ───────────────────────────────────
alter table cart_items        rename column ref_meet_id    to ref_event_id;
alter table invoice_items     rename column ref_meet_id    to ref_event_id;
alter table sanction_requests rename column created_meet_id to created_event_id;

-- ── Cosmetic: enum type name ──────────────────────────────────────────────
-- The status enum carried the old entity name. Renaming the type does not touch
-- the enum's VALUES (still 'draft' | 'reg-open' | … ) and columns typed by it
-- follow the type by OID.
alter type meet_status rename to event_status;

-- ── Cosmetic: auto-generated index names ──────────────────────────────────
-- These were created by un-named `create index on <table> (cols)` statements, so
-- Postgres derived their names from the (old) table/column names. Rename them to
-- match. (Definitions track by OID; this is purely so \d output reads cleanly.)
-- Guarded with IF EXISTS so a divergent generated name doesn't break the push.
alter index if exists meet_sessions_meet_id_idx        rename to event_sessions_event_id_idx;
alter index if exists registrations_meet_id_session_id_idx rename to registrations_event_id_session_id_idx;
alter index if exists scores_meet_id_session_id_idx     rename to scores_event_id_session_id_idx;

-- Note: RLS policy names (public_read / admin_all / host_sessions) are generic
-- and need no rename. `scores` keeps `replica identity full` (unaffected by a
-- table/column rename), so realtime DELETE payloads continue to carry old values.
