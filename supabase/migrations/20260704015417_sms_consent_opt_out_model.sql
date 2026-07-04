-- SMS consent model change: opt-IN (Profile.tsx checkbox) -> opt-OUT (STOP).
-- Nate confirmed with Julia: SMS is now covered by the liability waiver signed
-- at registration, so the explicit opt-in checkbox is removed from the UI.
-- Everyone is consenting by default going forward; a STOP-family reply
-- (handled by sms-webhook, entirely UNCHANGED by this migration) remains the
-- ONLY way to become ineligible for future texts — a CTIA/TCPA requirement,
-- independent of how consent was originally obtained.
--
-- Backfill: flip everyone to sms_consent = true EXCEPT anyone who has ALREADY
-- sent a STOP-family reply (sms_messages, inbound) — those must stay opted
-- out; silently re-enabling them would violate the STOP guarantee. Matches by
-- normalized last-10-digits phone (mirrors sms-webhook's
-- findPeopleByPhone/normalizePhone in JS — there's no stored SQL equivalent).
with stopped_phones as (
  select distinct right(regexp_replace(phone, '[^0-9]', '', 'g'), 10) as last10
  from sms_messages
  where direction = 'inbound'
    and upper(trim(body)) in ('STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT')
)
update people p
set sms_consent = true
where sms_consent = false
  and (
    p.phone is null
    or right(regexp_replace(p.phone, '[^0-9]', '', 'g'), 10) not in (select last10 from stopped_phones)
  );

-- New people rows are consenting by default going forward too.
alter table people alter column sms_consent set default true;
