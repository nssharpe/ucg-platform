with cand as (
  select levels->>'MAG' as level_id, id as athlete_id, main_club_id as club_id, 'MAG'::discipline as discipline from people where levels->>'MAG' is not null and main_club_id is not null
  union all
  select levels->>'WAG', id, main_club_id, 'WAG'::discipline from people where levels->>'WAG' is not null and main_club_id is not null
  union all
  select levels->>'TNT', id, main_club_id, 'TNT'::discipline from people where levels->>'TNT' is not null and main_club_id is not null
)
select distinct on (level_id) level_id, athlete_id, club_id, discipline
from cand
order by level_id, athlete_id;
