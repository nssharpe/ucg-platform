-- Event-management v2 Phase 0, Task 2: event entity field extensions (spec §A).
-- Fields and config only -- no fee/pricing behavior (late-fee pricing is a
-- later task) and no cap enforcement (capacity config stored now, enforced
-- in a later phase).

alter table events add column if not exists venue text;
alter table events add column if not exists street_address text;
alter table events add column if not exists country text;
alter table events add column if not exists hotel_link text;
alter table events add column if not exists age_calc_at timestamptz;

-- { startsAt: ISO datetime string, fee: number } -- fee in dollars, matching
-- the entry_fee/change_fee convention (plain dollar amounts, not cents).
alter table events add column if not exists late_reg jsonb;
-- { name, email, ccOnConfirmation: boolean } -- now general (competitions +
-- camps), replacing camp_config's directorName/directorEmail/directorCcOnConfirmation.
alter table events add column if not exists director jsonb;
-- { total?: number, perDiscipline?: Record<'MAG'|'WAG'|'TNT', number>,
--   perLevel?: Record<levelId, number> } -- stored only; not enforced yet.
alter table events add column if not exists capacity jsonb;
-- { bodyHtml: string, fromAlias?: string, replyTo?: string }
alter table events add column if not exists confirmation_email jsonb;

-- Backfill director + age_calc_at from camp_config for rows that have one,
-- then strip those four keys from camp_config now that they live at the
-- event level (general to all events, not camp-only).
update events
set
  director = jsonb_strip_nulls(jsonb_build_object(
    'name', camp_config->>'directorName',
    'email', camp_config->>'directorEmail',
    'ccOnConfirmation', coalesce((camp_config->>'directorCcOnConfirmation')::boolean, false)
  )),
  age_calc_at = (camp_config->>'ageCalcAt')::timestamptz,
  camp_config = (camp_config - 'directorName' - 'directorEmail' - 'directorCcOnConfirmation' - 'ageCalcAt')
where camp_config is not null;

-- If stripping those four keys left camp_config as an empty object, null it
-- out rather than keep a meaningless '{}'.
update events set camp_config = null where camp_config = '{}'::jsonb;

-- A camp_config with no director info backfills to the degenerate
-- '{"ccOnConfirmation": false}' (jsonb_strip_nulls keeps the false) — null
-- those out so "no director" stays NULL rather than a meaningless object.
update events set director = null
where director - 'ccOnConfirmation' = '{}'::jsonb
  and coalesce((director->>'ccOnConfirmation')::boolean, false) = false;
