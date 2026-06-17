-- 0006_nationals.sql — Nationals meet type: prelim/finals phases + admin-editable
-- qualification/awards config ("blue numbers"). The qualification & awards logic
-- itself is a pure TS engine (src/nationals/), validated to parity against the
-- reference tool. See docs/specs/2026-06-13-nationals-qual-awards.md.
--
-- No new RLS needed: meets & meet_sessions already carry `admin_all`
-- (using is_admin()) for writes and public read, so kind / nationals_config /
-- phase inherit admin-only writes. scores already has its judge/admin write policy.

create type meet_kind as enum ('standard', 'nationals');

alter table meets
  add column kind             meet_kind not null default 'standard',
  add column nationals_config jsonb;            -- NationalsConfig (TS) or null

-- Prelim vs finals session within a Nationals meet (null ⇒ single-phase session).
alter table meet_sessions
  add column phase text check (phase in ('prelim', 'final'));

-- Apparatus scratch (reference-tool "Scratched"): excluded from placement/team
-- scoring; distinct from a 0.0 score.
alter table scores
  add column scratched boolean not null default false;
