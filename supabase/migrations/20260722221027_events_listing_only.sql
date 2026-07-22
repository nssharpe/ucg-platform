-- Nationals two-tier publish model (PM feedback 2026-07-23): an admin can
-- publish just name/dates/location ("Publish Dates and Location Only") before
-- the full event details are ready. `listing_only` flags that state; it's a
-- plain boolean column with no RLS/grant changes of its own — it inherits the
-- existing `events` table's grants/RLS as-is.
alter table events add column listing_only boolean not null default false;
