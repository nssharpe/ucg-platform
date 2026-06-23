-- Client error log: a searchable record of front-end errors so support can look
-- up a user and see what went wrong, instead of relying on screenshots.
create table if not exists error_logs (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  auth_user_id uuid default auth.uid(),
  person_id    text,
  email        text,
  context      text,          -- route / 'write-queue' / 'react-render' / 'window'
  message      text not null,
  stack        text,
  detail       jsonb,
  url          text,          -- location.hash at the time
  user_agent   text,
  app_version  text
);
create index if not exists error_logs_created_idx on error_logs (created_at desc);
create index if not exists error_logs_email_idx   on error_logs (lower(email));

alter table error_logs enable row level security;

-- Anyone (incl. signed-out guests) may record an error; only admins may read.
create policy error_logs_insert on error_logs for insert with check (true);
create policy error_logs_read   on error_logs for select using (is_admin());
