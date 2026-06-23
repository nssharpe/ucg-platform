-- Phase 4 of the SMS (Telnyx) work: per-message log for delivery receipts (DLRs)
-- and inbound replies. comm_log stays the aggregate per-blast composer history;
-- this table is the message-level record the sms-webhook function updates.
create table if not exists sms_messages (
  id           text primary key,                 -- Telnyx message id
  direction    text not null,                    -- 'outbound' | 'inbound'
  phone        text not null,                    -- the other party (E.164 if known)
  status       text,                             -- DLR status; inbound = 'received'
  body         text,                             -- inbound reply text (null for outbound)
  error        text,                             -- DLR failure detail, if any
  comm_log_id  uuid references comm_log(id) on delete set null,  -- future linkage to the blast
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists sms_messages_phone_idx on sms_messages (phone, created_at desc);

alter table sms_messages enable row level security;

-- Admins read the message log; writes come from the service role (sms-webhook /
-- send-sms), which bypasses RLS — no insert/update policy needed.
create policy sms_messages_read on sms_messages for select using (is_admin());
