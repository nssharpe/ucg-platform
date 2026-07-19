-- Per-event scoring config (PM decision 2026-07-19): judge panels (1 or 2 —
-- 2 means each judge enters an execution evaluation and the two are
-- averaged) + default entry mode ('calculator' vs 'simple'/manual). Also
-- adds the second judge's execution-input columns on `scores` (deductions2/
-- e_score2) so a two-panel score can carry both judges' raw inputs alongside
-- the existing single-judge deductions/e_score.
--
-- No RLS changes: both `events` and `scores` already have table-level grants
-- (no column-level grants exist on either table — confirmed via grep across
-- supabase/migrations before writing this), so a plain column add inherits
-- read/write reach from the existing table grants + RLS policies, same as
-- 20260601000004_text_ids_score_extras.sql's scores.calc/calc_state columns.

begin;

alter table events add column if not exists scoring_config jsonb;

alter table scores add column if not exists deductions2 numeric;
alter table scores add column if not exists e_score2     numeric;

commit;
