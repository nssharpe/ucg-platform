-- error_logs retention: prune rows older than 90 days (research note
-- docs/research/2026-06-22-error-logging-observability.md, privacy note) so
-- the client-error table doesn't grow unbounded. Daily at 04:10 UTC via
-- pg_cron (already installed for scheduled-dispatch). Plain SQL delete — no
-- Edge Function round-trip needed.
select cron.unschedule('error-logs-retention-daily')
where exists (select 1 from cron.job where jobname = 'error-logs-retention-daily');

select cron.schedule(
  'error-logs-retention-daily',
  '10 4 * * *',
  $$ delete from error_logs where created_at < now() - interval '90 days'; $$
);
