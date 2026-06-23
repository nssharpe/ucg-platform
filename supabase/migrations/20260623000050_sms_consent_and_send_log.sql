-- Phase 3 of the SMS (Telnyx) work: per-person SMS consent + richer send-log
-- columns on comm_log (segment count, encoding, estimated cost).

-- SMS consent (CTIA opt-in). Defaults to false: a member must explicitly opt in
-- on their profile before they can be texted. sms_consent_at records when.
alter table people
  add column if not exists sms_consent    boolean not null default false,
  add column if not exists sms_consent_at timestamptz;

-- Send-log enrichment for SMS sends. Email rows leave these null.
alter table comm_log
  add column if not exists segments      int,            -- segments per recipient
  add column if not exists encoding      text,           -- 'GSM-7' | 'UCS-2'
  add column if not exists cost_estimate numeric(10, 4); -- est. total USD for the send
