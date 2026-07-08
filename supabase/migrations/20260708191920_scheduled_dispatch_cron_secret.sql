-- scheduled-dispatch cron auth fix (observed live 2026-07-08): on projects
-- with new-style API keys, the Edge runtime's SUPABASE_SERVICE_ROLE_KEY does
-- NOT equal the legacy service-role JWT the cron job sends as its bearer, so
-- the function's exact-match check 403'd every run in both environments.
-- The function now ALSO accepts an `x-cron-secret` header matching its
-- CRON_SECRET function secret; this migration re-schedules the job to send
-- that header, read from a third Vault secret `cron_secret`.
--
-- Manual per-environment setup (in addition to project_url/service_role_key):
--   1. select vault.create_secret('<random 64-hex>', 'cron_secret');
--   2. supabase secrets set CRON_SECRET=<same value> --project-ref <ref>
-- Same value in both places. See supabase/README.md "Scheduled dispatch".

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
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret'),
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
