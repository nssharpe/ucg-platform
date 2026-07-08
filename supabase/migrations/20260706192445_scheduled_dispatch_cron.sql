-- scheduled-dispatch-15min — the platform's first scheduled job. Every 15
-- minutes, invokes the `scheduled-dispatch` Edge Function (sanction-vote
-- reminder emails today; more scheduled work can hang off the same function
-- later). The function itself stays `verify_jwt = true` at the gateway AND
-- additionally requires the bearer token to equal SUPABASE_SERVICE_ROLE_KEY
-- exactly (see supabase/functions/scheduled-dispatch/index.ts) — no user-JWT
-- path exists, so this cron job's service-role bearer is the only caller.
--
-- The two secrets read below (`project_url`, `service_role_key`) are NOT
-- created by this migration — they must be created manually, once per
-- environment (prod / staging), via SQL in the SQL editor or `supabase db
-- query`:
--   select vault.create_secret('https://<project-ref>.supabase.co', 'project_url');
--   select vault.create_secret('<service-role-key>', 'service_role_key');
-- See the "Scheduled dispatch (pg_cron)" section of supabase/README.md for
-- the full runbook (verification queries, secret names, etc.).

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Idempotent: drop any existing job with this name before (re)scheduling, so
-- re-running this migration (or applying it to an environment that already
-- has the job from a manual test) doesn't error or double-schedule.
select cron.unschedule('scheduled-dispatch-15min')
where exists (select 1 from cron.job where jobname = 'scheduled-dispatch-15min');

select cron.schedule(
  'scheduled-dispatch-15min',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url') || '/functions/v1/scheduled-dispatch',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
