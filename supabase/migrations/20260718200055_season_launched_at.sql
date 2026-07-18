-- F6 season lifecycle automation: "launched" state for a season. A season is
-- launched once an admin has finished its details and flipped it live —
-- launched ⇒ its memberships are purchasable and events may be created in it
-- (see src/lib/season-lifecycle.ts / supabase/functions/_shared/season-lifecycle.ts,
-- kept in lockstep). null = not launched.
alter table seasons add column if not exists launched_at timestamptz;

-- Backfill: a pre-existing season must count as already launched — either
-- it's the current season, or it already has memberships sold against it (an
-- admin clearly finished configuring it at some point in the past, even
-- though the concept of "launched" didn't exist yet).
update seasons
set launched_at = now()
where launched_at is null
  and (
    current = true
    or exists (select 1 from memberships m where m.season_id = seasons.id)
  );
