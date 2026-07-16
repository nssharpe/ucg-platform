-- emv2 P5 C3: finals-lineup deadline nag + hard lock
--
-- Adds the admin-set finals-lineup submission deadline instant (spec §L.3
-- "9pm Friday deadline"). scheduled-dispatch nags club managers with missing
-- finals lineups at/after this instant, and hard-locks
-- events.finals_roster_locked at deadline + 1h. Absent => the scheduler does
-- nothing for the event (no guessing at a deadline).

alter table events add column if not exists finals_lineup_deadline_at timestamptz;

comment on column events.finals_lineup_deadline_at is
  'Finals-lineup submission deadline instant (nationals only, spec §L.3 "9pm Friday deadline"). '
  'scheduled-dispatch nags club managers with missing finals lineups at/after this instant and '
  'hard-locks finals_roster_locked at deadline + 1h. Absent => scheduler does nothing for the event.';
