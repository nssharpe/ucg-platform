-- Communication log: one row per send (email/text) from the Communicate tool, so
-- senders can confirm what went out and to whom.
create table if not exists comm_log (
  id               uuid primary key default gen_random_uuid(),
  sender_user_id   uuid not null default auth.uid(),
  sender_person_id text references people(id) on delete set null,
  sent_at          timestamptz not null default now(),
  channel          text not null,          -- 'email' | 'sms'
  is_test          boolean not null default false,
  subject          text,
  body             text,
  recipient_count  int not null default 0,
  sent_count       int,
  failed_count     int,
  recipients       jsonb,                  -- [{ name, contact }]
  error            text
);
create index if not exists comm_log_sender_idx on comm_log (sender_user_id, sent_at desc);

alter table comm_log enable row level security;

-- Senders read their own log; admins read all.
create policy comm_log_read on comm_log for select
  using (is_admin() or sender_user_id = auth.uid());
-- A signed-in user may insert their own log rows.
create policy comm_log_insert on comm_log for insert
  with check (sender_user_id = auth.uid());
