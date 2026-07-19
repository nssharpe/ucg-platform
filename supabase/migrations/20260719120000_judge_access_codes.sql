-- Codeless judge access (PM decision 2026-07-19): ONE access code per event;
-- a device that unlocks with it (URL / 6-digit code / QR -- three forms of
-- the same access) can enter scores for ANY discipline/apparatus at that
-- event, with no per-judge identity. This table holds the code/token rows;
-- the ONLY way a non-privileged (anon or unprivileged-signed-in) caller ever
-- reaches this table's data is the `judge-entry` Edge Function's service-role
-- client -- mirrors the no-login `waiver_sign_requests`/
-- `record-waiver-signature` blueprint. RLS below therefore grants NO
-- anon/authenticated baseline read; token/code resolution happens only
-- inside the Edge Function.

create table judge_access_codes (
  id          text primary key,
  event_id    text not null references events (id) on delete cascade,
  token       text not null unique,
  code        text not null,
  created_by  text,
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz
);
create index on judge_access_codes (event_id);
create index on judge_access_codes (code);
-- One ACTIVE (non-revoked) code per event -- "Regenerate" in the host UI
-- revokes the old row (sets revoked_at) before inserting the new one, never
-- hard-deletes, so the audit trail of who generated/revoked when is kept.
create unique index judge_access_codes_one_active_per_event
  on judge_access_codes (event_id) where revoked_at is null;

alter table judge_access_codes enable row level security;

-- Read/write reach mirrors is_event_host(event_id) -- the same helper
-- event_host_scores_write (20260710020303_host_post_close_edit.sql) uses to
-- extend scores write access to admin / sanctioning team / the event's
-- host-club managers / an event-admin grantee for that event. Separate
-- insert/update policies -- NOT `for all`, which would also silently grant
-- DELETE (CLAUDE.md RLS trap) -- since rows are revoked (soft-delete via
-- revoked_at), never hard-deleted, by design.
create policy judge_access_codes_select on judge_access_codes for select
  using (is_event_host(event_id));
create policy judge_access_codes_insert on judge_access_codes for insert
  with check (is_event_host(event_id));
create policy judge_access_codes_update on judge_access_codes for update
  using (is_event_host(event_id))
  with check (is_event_host(event_id));

-- Explicit grant (belt-and-suspenders alongside the RLS policies above,
-- matching event_admins' `grant select ... to authenticated` -- another
-- brand-new security-sensitive table). No grant to `anon` at all: an
-- anonymous judge never reads this table directly, only through the
-- service-role Edge Function.
grant select, insert, update on judge_access_codes to authenticated;
