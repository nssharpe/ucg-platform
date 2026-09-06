---
paths:
  - "supabase/functions/**"
  - "supabase/config.toml"
  - "supabase/templates/**"
  - "scripts/render-auth-email-templates.mts"
  - "src/lib/sms-send.ts"
  - "src/lib/season-lifecycle.ts"
---

# Edge Functions and transactional email

Deploy: `supabase functions deploy <name> --project-ref wkyerxlgricfphopocoz` (sandbox disabled;
no Docker; `_shared/` bundles automatically).

## CRITICAL — `--no-verify-jwt` is NOT sticky

A bare redeploy silently resets `verify_jwt=true`, and Supabase's gateway then rejects the caller
BEFORE the function runs: no logs, invisible failure. A real customer charge sat unfulfilled
2026-07-02.

Three functions need the flag: **`stripe-webhook`, `sms-webhook`,
`notify-manager-access-denied`**.

A PostToolUse hook (`scripts/hooks/post-bash-checks.mjs`) now runs
`supabase functions list --project-ref <ref>` after every `functions deploy` and reports if any
of the three shows `verify_jwt: true`. **If that hook reports it could not run, check manually**
— don't assume it's fine.

## Email (Resend)

Shared helper `_shared/resend.ts` (`sendOne`/`sendBatch`; optional `cc`, `reply_to`, and
`fromName` — the last swaps ONLY the sender display name, the address always stays
`RESEND_FROM`'s verified one; since E-03's retirement 2026-08-27 NO registration-confirmation path passes `fromName`/`reply_to` — the sender is always United Club Gymnastics). Secrets:
`RESEND_API_KEY`, `RESEND_FROM` (naigc.org is verified), `APP_PUBLIC_URL`.

All transactional emails render through `_shared/email-layout.ts`
(`renderEmail({ heading, bodyHtml, cta?, footnoteHtml? })`) — the branded navy-header /
white-card / orange-CTA wrapper. **New email-sending functions should use it** rather than
composing bare `<p>` HTML. `send-email` (admin free-text broadcast — the caller controls the full
body) defaults to sending `html` as-is, but (E-01, `2026-08-27`) accepts an optional `wrap:
{ title, cta? }` payload field that routes `html` through `renderEmail` as `bodyHtml` instead
(`title` → `heading`; there's no `preheader` param on either side — `renderEmail` has no slot for
one). `src/lib/supabase.ts`'s `sendEmail(subject, html, recipients, wrap?)` mirrors this. Callers
that want the branded wrapper without leaving `send-email`'s free-form default behind (e.g.
`Profile.tsx`'s waiver-link emails) pass `wrap`; the admin Communicate broadcast still doesn't.

Supabase Auth's own templates (confirmation/invite/magic-link/recovery/…) are repo-managed and
render from the SAME layout: `scripts/render-auth-email-templates.mts` →
`supabase/templates/*.html` → `supabase config push` (prod only — staging is free-tier and 400s
template pushes). **Before any `config push`, use the `config-push-dryrun` skill** — that
command has pushed unintended auth defaults to prod. Full runbook: `supabase/README.md` →
"Auth email templates".

## Invoker pattern

Invokers unwrap errors via `edgeErrorMessage(error)` (the real JSON message), **not**
`error.message`. All invokers live in `src/lib/supabase.ts` — match the pattern.

## Function inventory

- **Broadcast/admin-gated:** `send-email`, `send-sms` (Telnyx).
- **Webhooks (`--no-verify-jwt`):** `stripe-webhook`, `sms-webhook` (Telnyx DLRs/inbound/STOP,
  Ed25519 verified, fail-closed), `notify-manager-access-denied`.
- **Waivers:** `request-guardian-waiver`, `record-waiver-signature`, `create-waiver-link`.
- **Notifications:** `notify-club-cart`, `send-membership-welcome` (first no-club membership; CCs
  the regional team address only; the once-only guard is CLIENT-side in `Membership.tsx`),
  `send-club-invite`, `invite-account`, `request-manager-access`, `notify-sanction`.
- **Event-scoped:** `send-event-email` (authorized for admin/sanctioning/host-club
  managers/event-admin grantees; recipients resolved SERVER-side; hosts get no SMS; test-send =
  caller only; cc = one copy message).
- **Money:** `create-checkout-session`, `stripe-webhook`, `request-refund`, `process-refund`,
  `reconcile-payments` (admin/finance_admin + AAL).
- **`withdraw-registration`** (athlete self-serve WITHDRAWAL, owners' spec 2026-08-23; self-only,
  no club-manager branch): removes (before `last_date_to_edit`) or keeps-and-scratches (at/after
  it, stamping `registrations.withdrawn_at` — never `refunded`) every one of the caller's own
  non-refunded rows for one (event, club). Shown instead of `request-refund` wherever that flow
  isn't offered — see `supabase/README.md`'s function inventory for the full rule.
- **Ops:** `manage-waitlist` (`promote`/`requeue` = admin/sanctioning only; `list` = +
  host-club managers/event-admin grantees), `admin-delete-person` (admin-only + AAL; tombstones
  the `people` row in place when financial/waiver rows reference it, scrubs denormalized names
  from invoice/snapshot labels, keeps waiver_signatures pending counsel; the export side is
  client-only `collectPersonData`/`person-export.ts`), `judge-entry` (anonymous
  `unlock`/`submit` resolve a `judge_access_codes` code/token to an event and post `scores`
  server-side via the `post_score` compare-and-set RPC (UAT Z-06-01, `20260822020000`) — same RPC
  the signed-in client's `pushScore` calls, so a stale/absent `expectedUpdatedAt` comes back as
  `{conflict:true, current}` (409, read client-side via `edgeErrorBody`) instead of silently
  overwriting a concurrent judge's post; validation in `_shared/judge-entry-core.ts` including size
  caps on source/calc/calcState), `report-problem` (any signed-in caller; reporter identity resolved
  server-side from the JWT, never the client payload; routes bug/question/unsure to a hardcoded
  recipient map at the top of the function; since `20260822030000` also inserts a `problem_reports`
  row with the service role BEFORE the email send — insert failure logs to `error_logs` and never
  blocks the email — powering the admin "Errors & Problems" page's Problem Reports tab).
- **`scheduled-dispatch`** (pg_cron every 15 min): sanction-vote reminders, event-owner task
  escalations (`owner-task`), waitlist promotion sweep (FIFO promote/requeue/complete), season
  lifecycle nag (`season-launch-nag` — escalating admin emails to CREATE the next season row),
  and the daily "anything wrong?" digest (`daily-digest`: new error_logs + stuck-pending-payments
  summary, hardcoded recipient list, at most one per UTC day).
  **`verify_jwt` STAYS true** and it requires an `x-cron-secret` header matching its
  `CRON_SECRET` secret — the runtime's env service key ≠ the legacy JWT (bit us 2026-07-08).

Notify-style functions allow any signed-in caller and resolve recipients server-side; only
`send-email`/`send-sms` are admin-gated. (`send-receipt` was removed 2026-07-04 as dead code —
`stripe-webhook`'s own `emailReceipt()` is the live receipt path. It also renders each purchased
event's `confirmation_email.bodyHtml` above the receipt via the shared "A message from your host"
card and cc's the event director when `ccOnConfirmation`. **UAT E-02-01/E-03 (2026-08-27):** the
per-event reply-to/from-alias override is RETIRED — every confirmation email now sends from the
default UCG sender, no exceptions; `confirmation_email.fromAlias`/`.replyTo` are dead fields kept
only for back-compat parsing of old rows. The subject also now names the one event referenced
when there's exactly one — `confirmationSubject`/`hostMessageCardHtml`
(`_shared/registration-confirmation.ts`) are shared between `emailReceipt` and the new
`send-registration-confirmation` function below, so both paths render an identical-looking host
card.)
- **`send-registration-confirmation`** (verify_jwt true; UAT E-02-02, 2026-08-27): the $0
  host-club SELF-registration confirmation — a host-club registration is created `paid:true` with
  NO cart line, so it never goes through checkout and `emailReceipt` never fires for it. Self-only,
  no club-manager branch (mirrors `withdraw-registration`'s shape): 403s unless the caller IS the
  athlete of every `regId` passed. Wired into `Events.tsx`'s `SelfRegModal.persistRegs` `hostFree`
  branch only — `Club.tsx`'s manager-side `saveRegs` never calls it.

## Lockstep mirrors — change both or neither

- `src/lib/season-lifecycle.ts` ⇄ `_shared/season-lifecycle.ts`
- camp survey rendering ⇄ `_shared/camp-confirmation.ts`
- passkey/aal exemption: `mfa-core.ts` ⇄ `is_admin()` migration ⇄ `_shared/jwt-aal.ts`

Seasons: P3 (2026-07-20) retired the automatic July-1 `current` rollover. "current"/"launched"
are no longer stored flags — everything derives from today's date vs. each season's
`[startsOn, endsOn]` window. Spec:
`docs/specs/2026-07-20-season-card-ucg-events-and-cleanups.md`.

## SMS consent is opt-OUT, not opt-in

`people.sms_consent` defaults to `true` — SMS is covered by the liability waiver signed at
registration (confirmed with Julia), so there is no Profile checkbox. A STOP-family reply
(`sms-webhook`) is the ONLY way to become ineligible. `partitionByConsent`
(`src/lib/sms-send.ts`) excludes only explicit `false`, treating `undefined`/`true` as eligible.
Migration `20260704015417` backfilled everyone to `true` EXCEPT anyone who had already sent a
STOP reply.
