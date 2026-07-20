-- P4 (2026-07-20 season card / UCG-hosted events spec): per-season
-- UCG-hosted event instances (FlipFest camp, Nationals championship) are
-- regular `events` rows tagged with which template created them. Plain
-- nullable text, no enum — mirrors `events.kind`/`events.event_type`'s style
-- but this one has no server-side behavior riding on it (client-only: pins
-- EventWizard's timezone + hides the Nationals-kind checkbox).
alter table public.events add column if not exists ucg_hosted text;

comment on column public.events.ucg_hosted is
  'Set to ''flipfest'' or ''nationals'' when this event is the UCG-hosted instance for a season (created via the Seasons & fees "Create" flow), NULL for a regular sanctioned event.';
