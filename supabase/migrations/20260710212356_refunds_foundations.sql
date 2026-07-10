-- Event-management v2 Phase 3, Task 4: refund foundations (spec §H).
-- Refunds are only offered for events whose host club is the league's own
-- club (identified by the new clubs.is_league_host flag) -- Nate decision,
-- 2026-07-10. This migration adds that flag plus the refund_requests table
-- and its RLS. Writing rows (insert/approve/reject/process) is entirely a
-- later-task (T5/T6) SECURITY DEFINER RPC / service-role Edge Function
-- concern -- no client write policies are added here, matching the
-- payments table's server-only write model.

-- ---------------------------------------------------------------------------
-- clubs.is_league_host
-- ---------------------------------------------------------------------------
alter table clubs add column if not exists is_league_host boolean not null default false;

-- ---------------------------------------------------------------------------
-- refund_requests
-- ---------------------------------------------------------------------------
-- id is app-generated text like every other table (CLAUDE.md: ids are
-- app-generated text, not uuids). One row per refund request against either
-- a registration entry-fee line (kind='registration') or a purchased add-on
-- line (kind='addon'); exactly one of reg_id/invoice_item_id is meaningful
-- per kind, both are nullable so the DB doesn't force a value that doesn't
-- apply to the other kind.
create table refund_requests (
  id                  text primary key,
  created_at          timestamptz not null default now(),
  requester_person_id text not null references people (id) on delete cascade,
  -- Set when the request was made from a club cart context (a club manager
  -- requesting on behalf of an athlete's purchase); null for a self-serve
  -- member request.
  club_id             text references clubs (id) on delete set null,
  event_id            text not null references events (id) on delete cascade,
  kind                text not null check (kind in ('registration', 'addon')),
  reg_id              text references registrations (id) on delete set null,
  invoice_item_id     text references invoice_items (id) on delete set null,
  payment_id          text references payments (id) on delete set null,
  reason              text not null check (reason in ('injury', 'illness', 'bereavement', 'other')),
  reason_detail       text,
  status              text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  -- The reviewing refund manager/admin's person id (text, matching
  -- requester_person_id's convention) -- not a strict FK: a reviewer's
  -- people row can be independently deleted without invalidating the
  -- historical audit trail of who reviewed this request.
  reviewed_by         text,
  reviewed_at         timestamptz,
  refund_amount_cents integer,
  stripe_refund_id    text
);
create index on refund_requests (event_id);
create index on refund_requests (requester_person_id);
create index on refund_requests (club_id);
create index on refund_requests (status);

-- ---------------------------------------------------------------------------
-- RLS -- fail-closed, SELECT-only (no client insert/update/delete policies;
-- all writes happen via SECURITY DEFINER RPCs / service-role Edge Functions
-- built in T5/T6, mirroring the payments table's write model).
-- ---------------------------------------------------------------------------
alter table refund_requests enable row level security;

-- (a) A requester reads their own requests -- so a member can see the status
-- of a refund they asked for. coalesce'd fail-closed per CLAUDE.md (an
-- unauthenticated/un-linked caller's my_person_id() is null, and
-- `null = requester_person_id` evaluates to null, not true, but the
-- coalesce is belt-and-suspenders consistent with the rest of the codebase).
create policy refund_requests_select_own on refund_requests for select
  using (coalesce(requester_person_id = my_person_id(), false));

-- (b) A club manager reads requests tied to their club (requested on behalf
-- of one of their athletes, or against any of their club's registrations).
create policy refund_requests_select_club on refund_requests for select
  using (club_id is not null and manages_club(club_id));

-- (c) Refund managers and admins read every request (the review queue).
-- Admins are NOT implicitly refund managers elsewhere in the app, but DO get
-- full read access here via is_admin() -- consistent with is_admin()'s
-- blanket read reach on other tables (e.g. sanctioning_update's is_admin()
-- OR auth_has_role() pattern).
create policy refund_requests_select_reviewers on refund_requests for select
  using (is_admin() or coalesce(auth_has_role('refund_manager'), false));
