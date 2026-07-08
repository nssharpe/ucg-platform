-- notification_log — dedupe/idempotency ledger for scheduled/automated
-- notifications (first consumer: sanction-vote reminder emails, see
-- scheduled-dispatch Edge Function). Service-role only: RLS enabled with NO
-- policies, and default PUBLIC/anon/authenticated grants revoked (fail closed
-- — matches project convention, see e.g. 20260702182713_coupons_lockdown.sql).

create table if not exists notification_log (
  id          text primary key,   -- deterministic: '<kind>:<ref_id>:<recipient>'
  kind        text not null,
  ref_id      text not null,
  recipient   text not null,
  sent_at     timestamptz not null default now(),
  unique (kind, ref_id, recipient)
);

alter table notification_log enable row level security;
-- No policies: only the service-role key (used by scheduled-dispatch) can
-- read/write this table; RLS with zero policies denies all other callers.

revoke all on table notification_log from public, anon, authenticated;
