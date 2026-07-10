-- Event-scoped communication (event-mgmt v2 §J): tag comm_log rows with the
-- event they were sent for, so the host dashboard's "sent log" can filter to
-- just this event's sends. Existing RLS (own-or-admin read, self insert,
-- 20260623000020_comm_log.sql) already fits unchanged — a host reading their
-- own sends naturally sees only their own rows regardless of event_id.
alter table comm_log add column if not exists event_id text references events(id) on delete set null;
create index if not exists comm_log_event_idx on comm_log (event_id, sent_at desc);
