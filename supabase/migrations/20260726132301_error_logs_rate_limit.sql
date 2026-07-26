-- Security hardening Phase 3, LOW item 2: error_logs_insert is
-- `with check (true)` (20260623000030_error_logs.sql) — anyone, signed in or
-- not, can insert unlimited rows. That's intentional for the signed-out case
-- (a crash on the Gate screen before login is exactly the kind of error we
-- want reported — src/lib/report-error.ts + main.tsx's window.onerror/
-- unhandledrejection handlers all funnel through logClientError(), which
-- writes as whatever caller happens to be signed in, including anon), so the
-- fix is a rate limit, not an `authenticated`-only lockdown.
--
-- Rate limit: 20 inserts per rolling 1-minute window per caller identity.
-- Chosen so a real crash loop (a broken render on every mount, say) still
-- gets a handful of reports through before being capped, while bulk anon
-- spam (a script hammering the insert endpoint) is bounded to a low rate.
--
-- Caller identity, in priority order:
--   1. auth.uid() when signed in — JWT-verified, not spoofable.
--   2. Otherwise, the first hop of the `x-forwarded-for` header PostgREST
--      exposes via `current_setting('request.headers', true)` — a best-effort
--      proxy for the anon caller's IP. This is spoofable by a raw API caller
--      (nothing stops someone from sending their own X-Forwarded-For), so it
--      is NOT a security boundary on its own — it just raises the bar over no
--      identity at all, which is all a purely anonymous insert can offer.
--   3. If neither is available (header missing, or parsing fails for any
--      reason — wrapped in its own exception handler so a header-shape change
--      can never break legitimate error reporting), every such caller shares
--      one 'anon-unidentified' bucket. Coarse, but bounds worst-case spam;
--      only affects totally unidentifiable anon callers (e.g. direct psql/
--      curl testing with no forwarded-for chain), not real browser traffic
--      through Supabase's edge network.
--
-- The identity is computed by the trigger itself and force-written onto
-- NEW.rate_limit_key regardless of what the client sends (BEFORE INSERT can
-- always override NEW.*), so it can't be spoofed by supplying a fake value
-- in the insert payload the way a client-supplied column could be.
--
-- Privileged callers (service_role — every Edge Function that logs to
-- error_logs: stripe-webhook, create-checkout-session, process-refund,
-- reconcile-payments, admin-delete-person, judge-entry, scheduled-dispatch;
-- admin JWT; or no JWT at all, i.e. direct DB/dashboard/migration) bypass the
-- limit entirely, matching the guard-trigger convention used by C1/C2/H3.
--
-- Fail-closed per the CLAUDE.md SECURITY DEFINER rule: is_admin() is wrapped
-- in coalesce(..., false) so a NULL (e.g. no JWT claims at all — already
-- covered by the auth.role() is null branch, but kept defensive) can never
-- silently grant the privileged bypass.
--
-- Admin reads (error_logs_read, is_admin()-gated) are untouched by this
-- migration — only the INSERT path changes.

alter table error_logs add column if not exists rate_limit_key text;
create index if not exists error_logs_rate_limit_idx on error_logs (rate_limit_key, created_at);

create or replace function guard_error_logs_rate_limit() returns trigger as $$
declare
  v_privileged boolean;
  v_key        text;
  v_ip_key     text;
  v_recent     integer;
  v_limit      constant integer := 20;
  v_window     constant interval := interval '1 minute';
begin
  v_privileged := auth.role() is null or auth.role() = 'service_role' or coalesce(is_admin(), false);
  if v_privileged then
    return new;
  end if;

  begin
    v_ip_key := nullif(
      split_part(current_setting('request.headers', true)::json ->> 'x-forwarded-for', ',', 1),
      ''
    );
  exception when others then
    -- Header missing/malformed — degrade to the shared anon bucket rather
    -- than ever blocking a legitimate error report over a parsing hiccup.
    v_ip_key := null;
  end;

  v_key := coalesce(auth.uid()::text, v_ip_key, 'anon-unidentified');

  select count(*) into v_recent
    from error_logs
    where rate_limit_key = v_key
      and created_at > now() - v_window;

  if coalesce(v_recent, 0) >= v_limit then
    raise exception 'guard_error_logs_rate_limit: rate limit exceeded (max % inserts per minute)', v_limit;
  end if;

  new.rate_limit_key := v_key;
  return new;
end;
$$ language plpgsql security definer set search_path = public, pg_temp;

drop trigger if exists guard_error_logs_rate_limit on error_logs;
create trigger guard_error_logs_rate_limit
  before insert on error_logs
  for each row execute function guard_error_logs_rate_limit();
