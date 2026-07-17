# Supabomb automated security scan — results (2026-07-17)

First run of the automated Supabase-specific scanner
([Supabomb](https://github.com/ModernPentest/supabomb)) that the security-review
decision ([options brief](2026-07-17-security-review-options.md)) settled on as
our pre-live coverage, plus a manual anon-read RLS probe of every sensitive
table (Supabomb's auto-discovery is blind here — see below). Run against
**staging** (`xogpiksqtkayxwmczlbx`); the anon-read probe against **both**
staging and prod (read-only `select`, safe).

## How to re-run
Supabomb is a Python CLI (clone + `pip install -e .` in a venv, or `uv run`).
On Windows force UTF-8 (`PYTHONUTF8=1`) or rich crashes on cp1252. Our project
returns **401 on the bare `/rest/v1` root** (the root needs a role), which trips
Supabomb's over-strict reachability gate — patch `client.py`'s `test_connection`
to also accept 401, or it aborts before doing anything. Then:
```
supabomb enum      --project-ref <ref> --anon-key <anon>
supabomb test      --project-ref <ref> --anon-key <anon>
supabomb check-jwt -p <ref> -k <anon> -e <fn> -e <fn> ...
```

## What Supabomb reported
- **`enum`:** 0 anon-readable tables, 0 anon-accessible RPCs discovered — but
  **only because the OpenAPI schema root is locked (401)**, so the tool had
  nothing to introspect. This is NOT "0 tables are anon-readable" (the manual
  probe below found two); it's a discovery limitation. Treat Supabomb's table
  coverage on this project as **unreliable** — the manual probe is the real one.
- **`test`:** 1 MEDIUM — **anonymous signup is enabled** (recommends email
  confirmation [already ON] + rate limiting + CAPTCHA). This is exactly the
  known [whats-next §2.2] rate-limiting/CAPTCHA gap; no new information.
- **`check-jwt`:** the privileged functions that must require a JWT all correctly
  reject anon (`create-checkout-session`, `process-refund`, `send-email` → 401).
  Webhooks do their own auth (various non-401 codes, expected).
  `admin-reset-mfa`/`report-problem` returned 404 — they're prod-only deploys,
  not on staging; re-check on prod.

## Manual anon-read RLS probe (the real coverage)
Probed anon `select` on 19 sensitive tables on prod + staging. **17 of 19
correctly return zero rows to anon** despite prod holding real data (RLS
filtering works): `people`, `memberships`, `payments`, `invoices`,
`invoice_items`, `refund_requests`, `user_roles`, `waiver_signatures`,
`manager_access_requests`, `coupons`, `error_logs`, `comm_log`, `sms_messages`,
`host_payouts`, `accounting_codes`, `event_admins`, `session_requests`. **PII is
correctly gated** — `people` (names/DOB/contacts) is not anon-readable, which is
the single most important result.

Two tables return rows to anon (both prod + staging):
- `registrations` — **intentional** (`public_read … using(true)`, original RLS
  migration; drives live results / start lists).
- `club_managers` — **intentional** (`cm_read … using(true)`, "everyone can read
  — drives rosters").

Both are keyed on **opaque `person_id`/`athlete_id` text ids**, and the names
behind those ids live in the RLS-gated `people` table — so the public read is
participation/roster structure, not identities. Defensible by design.

## Finding to fix: `camp_survey` is world-readable (CONFIRMED, latent today)

`registrations` carries a `camp_survey` jsonb column (added emv2 P2) holding camp
overnight-accommodation answers: bedtime, noise level, **cabin gender
preference, and a free-text roommate request** — for registrants who are often
**minors**. The `public_read … using(true)` policy on `registrations` predates
this column and was never re-evaluated when it was added, so **camp survey
answers are readable by the anonymous internet** wherever populated.

- **Severity:** medium-high (minor's personal/rooming preferences, possible
  third-party names in free text) — but **low/zero real exposure today**: only
  camp-event registrations populate it, and no camps have run yet, so the field
  is effectively empty in prod right now. **Must be fixed before the first camp
  runs.**
- **Why a scanner + our own review missed it originally:** it's the classic
  "sensitive column bolted onto an already-public table" — invisible unless you
  enumerate columns against the public policy specifically (which this probe did).
- **Fix (needs app + DB, not a one-liner):** `loadAll` does
  `registrations.select('*')`, so a blanket column `REVOKE (camp_survey) FROM
  anon` would break guest registration loading (PostgREST `select *` → column
  permission denied). Do instead: (1) change the broad `loadAll` read to an
  explicit column list **excluding** `camp_survey`; (2) load `camp_survey` via a
  scoped SECURITY DEFINER RPC (athlete-self / club-manager / event-host / admin
  — mirrors `event_host_roster`); (3) then `revoke select (camp_survey) on
  registrations from anon, authenticated`. The three FE consumers
  (`MyRegistrations`, `Events` host view, `host-export`) read it through the
  scoped path. Auth/RLS — controller-reviewed per CLAUDE.md money/auth rules.
  Tracked in [whats-next §2](../whats-next.md).

## Verdict
No critical/high automated findings; PII gating holds; the one real issue
(`camp_survey`) is latent and has a clear scoped-read fix. This pass is the
"free layer" of the accepted security posture (see the go-live checklist known
gap) — re-run on every schema-touching release, especially any new column on the
`registrations` / `scores` / `squads` public-read tables.
