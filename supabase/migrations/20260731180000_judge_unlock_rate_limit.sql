-- judge-entry unlock rate limiting (2026-07-31 review finding §3.3).
--
-- `judge-entry`'s `unlock` op resolves a 6-digit access code to a long token that
-- grants score-write access to a live event. Its only brute-force defense was an
-- `await sleep(300)` per failed attempt, described in the source as "a soft brake
-- against code-guessing -- 6 digits is only 1e6 combinations."
--
-- That brake does not throttle anything. It delays ONE request's own response; it
-- does not serialize concurrent requests, and each attempt runs in its own Deno
-- isolate. MEASURED against staging: 40 concurrent invalid codes all returned 401,
-- none throttled, from a single client. Throughput rises with concurrency and
-- there is no server-side cap to hit.
--
-- This table is the cap. `judge-entry` counts a caller's recent FAILED unlock
-- attempts before doing any lookup and refuses past the limit.
--
-- Why a dedicated table rather than reusing `error_logs` (which already records
-- every failed unlock as the brute-force audit trail): enforcement must not depend
-- on a log-retention decision. Pruning `error_logs`, or changing what it keeps,
-- would silently widen this limit. Audit and enforcement are kept separate on
-- purpose. It also gives the failure logging a bounded home -- the review noted
-- that `error_logs` writes from this function use the service role and therefore
-- deliberately BYPASS the 20/min limit added in `20260726132301`, so a brute-force
-- run was also an unbounded anonymous write amplifier.
--
-- Write model: server-only. RLS enabled with ZERO client policies, matching
-- `payments` / `refund_requests` / `coupon_reservations`. Only the service role
-- (i.e. the edge function) ever reads or writes it. The sequence is locked down
-- too -- a table-level revoke does not cover the backing sequence, and leaving it
-- grantable would let a client burn ids.
--
-- `attempt_key` is the first hop of `x-forwarded-for`, or 'unidentified' when the
-- header is missing/malformed. Same identity `guard_error_logs_rate_limit()`
-- computes, so there is one notion of "who" across both mechanisms.
--
-- MEASURED 2026-07-31, and better than assumed: Supabase's edge gateway PREPENDS
-- the true client IP to `x-forwarded-for`, so a caller-supplied value lands after
-- it and `split(...)[0]` still yields the real client. A test that deliberately
-- injected 40 different fake IPs recorded 40 rows under one key -- the tester's
-- actual address. Spoofing the key is therefore not straightforward here. Do NOT
-- read that as a hard authentication boundary: it is a property of the platform's
-- header handling, not something this schema enforces.
--
-- The real trade-off is the opposite one: callers behind a shared NAT (a gym
-- where every judge is on one WiFi) share a single bucket. That is why a
-- successful unlock CLEARS the key's rows -- the first judge who gets in wipes
-- everyone's fumbles -- and why the long-token (link/QR) path is exempt from the
-- limit entirely. A venue can always fall back to the QR it was sent.

create table if not exists judge_unlock_attempts (
  id          bigserial primary key,
  attempt_key text not null,
  created_at  timestamptz not null default now()
);

-- Supports both hot paths: the windowed count per key, and the prune-by-age
-- sweep the function runs opportunistically.
create index if not exists judge_unlock_attempts_key_time
  on judge_unlock_attempts (attempt_key, created_at desc);
create index if not exists judge_unlock_attempts_created_at
  on judge_unlock_attempts (created_at);

alter table judge_unlock_attempts enable row level security;

-- No policies are created. With RLS on and no policy, anon/authenticated get
-- zero rows and zero writes; service_role bypasses RLS entirely.
revoke all on judge_unlock_attempts from anon, authenticated;
revoke all on sequence judge_unlock_attempts_id_seq from anon, authenticated;

comment on table judge_unlock_attempts is
  'Rate-limit counter for judge-entry unlock failures (6-digit code path only). '
  'Server-only: RLS on with zero policies. Rows are pruned per-key as they age out '
  'of the window, and deleted outright on a successful unlock.';
