select levels->>'MAG' as mag_level, levels->>'WAG' as wag_level, gender, count(*)
from people
where levels->>'MAG' = 'mag-masters' or levels->>'WAG' = 'wag-masters'
group by 1,2,3 order by 1,2,3;
