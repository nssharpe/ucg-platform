-- Refund requests: group per REGISTRATION + a reviewer rejection reason
-- (UAT Z-04-01/02/03 + Nate's Z-04 note, confirmed with the requirements
-- owner 2026-08-21).
--
-- WHY. `refund_requests` was one row per (kind, reg_id|invoice_item_id,
-- payment_id) with no grouping at all -- request-refund inserted exactly one
-- row per call, and RefundRequestDialog.tsx called it once per registration.
-- For a registration paid across TWO invoices (an original entry invoice
-- plus a later "add discipline" invoice -- each its own Stripe payment),
-- only the FIRST invoice_item/payment the old request-refund resolved ever
-- got a refund_requests row; the second payment was invisible to the whole
-- refund flow, so approving "the" refund never touched it. The confirmed fix
-- (rule 1) is "one refund request per REGISTRATION, covering every paid line
-- across every payment that funded it" -- which needs a stable id to tie N
-- per-payment rows together as ONE reviewable decision.
--
-- `request_group_id` is that id: request-refund mints ONE per
-- registration-kind call and stamps it on every row it inserts for that
-- registration (one row per resolved (payment_id, invoice_item_id) pair);
-- process-refund now approves/rejects a whole group atomically instead of a
-- single row. An add-on request stays a one-row group
-- (`request_group_id = id`) -- add-ons were never split across
-- invoice_items/payments in the first place, so grouping is a no-op for
-- them, but every row still needs SOME group id for process-refund to look
-- up generically regardless of kind.
--
-- `rejection_reason` is new: rule 6 requires a REQUIRED free-text reason on
-- reject, stored and included in the rejection email. There was previously
-- nowhere to put it -- the existing `reason`/`reason_detail` columns are the
-- REQUESTER's stated reason for wanting the refund, not the reviewer's
-- reason for declining it.

alter table refund_requests add column if not exists request_group_id text;

-- Backfill: every existing row was already its own one-row "group" under the
-- pre-fix one-call-per-item flow (a registration paid across two invoices
-- simply never produced a second row to group at all) -- so backfilling to
-- the row's own id is exactly correct, not a lossy approximation.
update refund_requests set request_group_id = id where request_group_id is null;

alter table refund_requests alter column request_group_id set not null;

create index if not exists refund_requests_request_group_id_idx
  on refund_requests (request_group_id);

alter table refund_requests add column if not exists rejection_reason text;

comment on column refund_requests.request_group_id is
  'Ties together every refund_requests row that belongs to ONE reviewable decision: all the '
  'per-payment rows for a single registration refund (rule 1, UAT Z-04 -- one request per '
  'registration, covering every payment that funded it), or the single row for an add-on '
  'request. process-refund approves/rejects a whole group atomically; RefundReview.tsx renders '
  'one card per group. Backfilled to `id` for every pre-existing row.';
comment on column refund_requests.rejection_reason is
  'Required free-text reason the reviewer gave for REJECTING a request (UAT Z-04 rule 6) -- '
  'distinct from `reason`/`reason_detail`, which are the REQUESTER''s stated reason for wanting '
  'the refund. Null for approved/pending rows.';

-- No RLS changes: refund_requests stays SELECT-only for clients (T4,
-- 20260710212356) -- request_group_id/rejection_reason are written exclusively
-- by the service-role request-refund/process-refund Edge Functions, same as
-- every other column on this table.
