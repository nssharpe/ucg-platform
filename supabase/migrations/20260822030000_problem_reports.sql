-- Durable admin record of user-submitted "Report a problem" submissions
-- (new ask from the product owners, 2026-08-21). Today `report-problem`
-- only emails a routed inbox — screenshots attached, nothing persisted — so
-- there is no way to find a submission again without digging through email.
-- This table gives admins a searchable/resolvable queue in the "Errors &
-- Problems" admin page, alongside the existing `error_logs` capture. The
-- email stays the alerting path; this table is the review path.
--
-- id is uuid (NOT the usual app-generated text) because, like `error_logs`,
-- every row is inserted by the service role from a single Edge Function
-- (`report-problem`) — there is no client-generated id to preserve.
create table problem_reports (
  id                 uuid primary key default gen_random_uuid(),
  created_at         timestamptz not null default now(),
  -- Reporter identity, resolved SERVER-SIDE by report-problem from the
  -- caller's JWT/`people` row — never trusted from the client payload.
  -- Not strict FKs: a reporter's auth user / people row can later be
  -- deleted (F5) without invalidating this historical record, matching
  -- refund_requests.reviewed_by's rationale.
  auth_user_id       uuid,
  reporter_person_id text,
  reporter_email     text,
  reporter_name      text,
  category           text not null check (category in ('bug', 'question', 'unsure')),
  description        text not null,
  route              text,
  app_version        text,
  user_agent         text,
  -- Snapshot of the client's recent-error ring buffer at submit time (same
  -- shape report-problem already emails), for context without a second
  -- round trip to error_logs.
  recent_errors      jsonb,
  -- Screenshots stay EMAIL-ONLY (not persisted here) -- just the count, so
  -- the admin view can point back at the email ("N screenshots — see
  -- email") instead of duplicating attachment storage.
  attachment_count   int not null default 0,
  status             text not null default 'open' check (status in ('open', 'resolved')),
  resolved_at        timestamptz,
  resolved_by        uuid,
  resolution_note    text
);
create index problem_reports_status_created_idx on problem_reports (status, created_at desc);

-- ---------------------------------------------------------------------------
-- RLS -- admin-only read/update; NO insert policy (report-problem inserts
-- with the service role, which bypasses RLS entirely -- same idiom as
-- error_logs' service-role writes, except error_logs additionally allows
-- anon/authenticated client inserts, which this table deliberately does not
-- need since it only ever gets one row per report-problem call).
-- ---------------------------------------------------------------------------
alter table problem_reports enable row level security;

create policy problem_reports_select_admin on problem_reports for select
  using (is_admin());

-- Admins resolve/reopen a report (status + resolved_at/resolved_by/note)
-- directly from the client under this policy -- no edge function needed for
-- a same-privilege same-table status flip. WITH CHECK repeats the USING
-- predicate so a resolve can't be (ab)used to also change ownership away
-- from admin-only visibility mid-edit.
create policy problem_reports_update_admin on problem_reports for update
  using (is_admin())
  with check (is_admin());
