-- 0008_event_management.sql
-- Event Management subsystem (Wave 4). Idempotent. Apply AFTER 0007.
-- See docs/specs/2026-06-18-event-management.md.

-- ── Meets: event type, sanction id, camp config ────────────────────────────
alter table meets add column if not exists event_type text not null default 'competition';
alter table meets add column if not exists sanction_id text;
alter table meets add column if not exists camp_config jsonb;

-- ── sanction_requests ──────────────────────────────────────────────────────
create table if not exists sanction_requests (
  id                  text primary key,
  host_club_id        text references clubs (id) on delete set null,
  requester_person_id text references people (id) on delete set null,
  event_kind          text not null default 'competition',
  status              text not null default 'draft',
  payload             jsonb not null default '{}'::jsonb,
  submitted_at        timestamptz,
  deadline_at         timestamptz,
  decided_at          timestamptz,
  created_meet_id     text references meets (id) on delete set null,
  sanction_id         text
);
alter table sanction_requests enable row level security;

-- Host club managers see/edit their own; Sanctioning Team + admins see/edit all.
drop policy if exists sanction_requests_rw on sanction_requests;
create policy sanction_requests_rw on sanction_requests for all
  using (
    exists (select 1 from user_roles ur where ur.user_id = auth.uid()
            and ur.role in ('admin','sanctioning'))
    or exists (select 1 from people p where p.id = sanction_requests.requester_person_id
               and p.auth_user_id = auth.uid())
    or manages_club(sanction_requests.host_club_id)
  )
  with check (
    exists (select 1 from user_roles ur where ur.user_id = auth.uid()
            and ur.role in ('admin','sanctioning'))
    or exists (select 1 from people p where p.id = sanction_requests.requester_person_id
               and p.auth_user_id = auth.uid())
    or manages_club(sanction_requests.host_club_id)
  );

-- ── sanction_votes ─────────────────────────────────────────────────────────
create table if not exists sanction_votes (
  id            text primary key,
  request_id    text not null references sanction_requests (id) on delete cascade,
  voter_user_id uuid not null,
  vote          text not null,         -- approve | reject | abstain
  comment       text,
  voted_at      timestamptz not null default now(),
  unique (request_id, voter_user_id)
);
alter table sanction_votes enable row level security;

-- Sanctioning Team + admins read all votes and cast their own.
drop policy if exists sanction_votes_read on sanction_votes;
create policy sanction_votes_read on sanction_votes for select
  using (exists (select 1 from user_roles ur where ur.user_id = auth.uid()
                 and ur.role in ('admin','sanctioning')));
drop policy if exists sanction_votes_write on sanction_votes;
create policy sanction_votes_write on sanction_votes for all
  using (voter_user_id = auth.uid()
         and exists (select 1 from user_roles ur where ur.user_id = auth.uid()
                     and ur.role in ('admin','sanctioning')))
  with check (voter_user_id = auth.uid()
         and exists (select 1 from user_roles ur where ur.user_id = auth.uid()
                     and ur.role in ('admin','sanctioning')));

-- ── Camp registration survey (overnight accommodations) ────────────────────
alter table registrations add column if not exists camp_survey jsonb;
