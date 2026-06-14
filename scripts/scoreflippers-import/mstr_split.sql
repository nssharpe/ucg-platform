-- Re-split MSTR athletes (2026-06-13): Female/Other -> wag-masters per Nate's confirmation.
begin;
update people set levels = '{"WAG":"wag-masters"}'::jsonb
where gender != 'Male' and levels->>'MAG' = 'mag-masters';
commit;
