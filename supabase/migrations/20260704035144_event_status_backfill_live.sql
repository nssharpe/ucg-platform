-- B4 follow-up to 20260704035120: backfill every existing non-draft event to
-- 'live' (they were already published under the old model — 'reg-open',
-- 'reg-closed', 'in-progress', and 'complete' all meant "published", just at
-- different manually-tracked phases). The old enum values are left defined
-- (Postgres can't cheaply drop enum values) but the app never writes them
-- again — the real-time phase is derived from dates, not stored.
update events set status = 'live' where status <> 'draft';
