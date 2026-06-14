-- Post-import corrections (2026-06-13):
--  1. Add wag-masters level (WAG Masters rule set exists alongside mag-masters).
--  2. NC -> Advanced (mag-adv); L7 -> Developmental (mag-dev) per renamed CompLevels.
begin;

insert into levels (id, discipline, name, sv_max, vaults, sort_order)
values ('wag-masters', 'WAG', 'Masters', null, 2, 6);

update people set levels = '{"MAG":"mag-adv"}'::jsonb
where id in ('298238','298219','298220','528699','528708','528732','538743');

update people set levels = '{"MAG":"mag-dev"}'::jsonb
where id = '398531';

commit;
