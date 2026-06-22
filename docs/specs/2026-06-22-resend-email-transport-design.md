# Resend email transport + wiring up dead email stubs — design

Date: 2026-06-22
Status: Draft for review
Owner: Nate (PM); implementation: Claude

## Problem

Two problems, addressed together because they share a transport:

1. **Transport is test-grade.** Email sends through **Gmail SMTP** (denomailer)
   from three Edge Functions, each duplicating the `SMTPClient` setup. It runs on
   a personal Gmail app password, is subject to Gmail's daily recipient limits,
   and forces a 50-recipient cap on the broadcast.

2. **Several "email" actions are dead stubs.** They toast "sent" / "queued" but
   send nothing. The reported case: an admin clicks **Invite** on a member with no
   account → it toasts "setup email queued", writes a `pending` `account_invites`
   row, but **never emails** (a literal `// TODO`), and the button then locks to
   "Invite sent" forever (`disabled={hasPendingInvite}`) with no resend path —
   and nothing ever flips the invite off `pending` (claiming is by email-match at
   signup via `link_or_create_person`, which never touches `account_invites`).

`naigc.org` is now **verified** in Resend, so sends can come from
`nate.sharpe@naigc.org` to any recipient.

## Goal

- Replace the Gmail SMTP transport with **Resend** behind a single shared helper,
  parameterized via secrets so the sender changes without a redeploy.
- Wire every actionable dead email stub to actually send, and make each
  caller's toast reflect the real send result. Add a **Resend** affordance to the
  account-invite button.

## Part A — Transport migration

### Shared module — `supabase/functions/_shared/resend.ts`

Dependency-free (global `fetch`):

- `resendFrom()` — returns `RESEND_FROM` secret, default
  `United Club Gymnastics <onboarding@resend.dev>`. Sender is config, not code.
- `sendOne({ to, subject, html, text })` → POST `https://api.resend.com/emails`.
- `sendBatch(messages[])` → POST `https://api.resend.com/emails/batch` (one
  distinct message per recipient, ≤100/call → preserves the no-leaked-list
  property and avoids the per-second rate limit a loop would hit).
- Both read `RESEND_API_KEY`; throw a clear, function-surfaced error if missing.
- Return shapes map onto each function's existing JSON contract
  (`sentCount`/`failedCount`/`sent`/`failed`), so front-end invokers in
  `src/lib/supabase.ts` need no changes.

### Existing functions (transport swap only — auth/validation/HTML untouched)

- `send-email` — build `messages[]`, call `sendBatch`. Cap stays **50**; reword
  the cap error (it currently says "Switch to Resend" — we now *are* Resend).
- `request-guardian-waiver` — single `sendOne`.
- `notify-club-cart` — `sendOne` per manager.

### Secrets (`supabase secrets set`, sandbox disabled)

- `RESEND_API_KEY` — the Resend key. Secret only; never committed.
- `RESEND_FROM` — set to `United Club Gymnastics <nate.sharpe@naigc.org>`
  (domain is verified).

The `GMAIL_*` secrets stay in place but unused — the rollback path.

## Part B — Wire up the dead email stubs

### Auth model (the key constraint)

`send-email` is **admin-only** (403s non-admins). So:

- **Reuse `send-email`** only for genuinely admin-initiated sends, composing the
  HTML client-side:
  - **#1 Account invite** ([Admin.tsx:273](../../src/pages/Admin.tsx)) — admin.
  - **#4 Waiver email modal** ([Profile.tsx:577](../../src/pages/Profile.tsx),
    `adminView`) — admin emails a member a link to sign their season waiver.
- **New notify-style functions** (mirror `notify-club-cart`: *any signed-in
  caller → authorize them for the action → resolve recipients with the service
  role → send via `_shared/resend.ts`*) for non-admin-triggered sends where
  recipients must be resolved server-side:
  - `send-club-invite` → **#2/#3**. Authorizes the caller manages the target
    club; sends to the entered/known address. `kind: 'coach' | 'membership'`
    selects the template (join-as-coach vs purchase-membership link).
  - `request-manager-access` → **#5**. Any signed-in member; resolves the club's
    managers + league admins server-side and notifies them. **Email only — no DB
    record** (a manager-access-request table is a separate feature).
  - `notify-sanction` → **#6/#7/#8**. `event: 'submitted' | 'approved' |
    'rejected'`. For `submitted`, resolve sanctioning team + admins
    (`user_roles.role in ('sanctioning','admin')` → `people.auth_user_id` →
    email). For `approved`/`rejected`, notify the host (the request's submitting
    club / requester).

Each new function gets a thin front-end invoker in `src/lib/supabase.ts`
(fire-and-forget where the UX doesn't need the result; awaited where the toast
reports success/failure).

### Invite link target

Claiming is purely email-match at signup (no `/invite/:token` route exists; the
`token` is vestigial). Invite emails link to `…/#/?signup=1` and instruct the
recipient to sign up **using this email address**.

### Call-site changes (front end)

- **#1** `createAccountInvite` — create the row, `await sendEmail`, toast the
  real result. Replace the permanently-disabled "Invite sent" button with an
  enabled **"Resend"** that re-sends for the existing invite row (bumps a
  client-side resent timestamp; no schema change). This sidesteps the stuck
  `pending` state without re-architecting the accept flow.
- **#2/#3/#4/#5/#6/#7/#8** — call the appropriate invoker, `await`, and replace
  the false "sent/queued/notified" toast with one driven by the actual result.

## Out of scope / deferred

- **Sanction reminder emails** (3d/1d before deadline) — needs a scheduler
  (cron); no such infra. Left as a TODO.
- **Payment confirmation emails** ([Club.tsx:897](../../src/pages/Club.tsx),
  [Membership.tsx:260](../../src/pages/Membership.tsx)) — gated on the deferred
  Stripe flow; the payment itself is a stub. Defer with payments.
- New-club-request email (pre-existing separate TODO).
- A manager-access-request table (see #5).

## Testing / verification

No automated harness covers Edge Functions or UI (Vitest is node-only, pure
logic). Verification is live:

- Deploy all functions (`supabase functions deploy <name> --project-ref
  wkyerxlgricfphopocoz`).
- Smoke test each path to a real inbox and confirm receipt + the invoker's
  result-driven toast: broadcast, account invite + **resend**, waiver email,
  club coach/membership invite, manager-access request, sanction
  submit/approve/reject.
- The pre-fix "failing test" for the reported bug is the symptom itself: toast
  claims sent, inbox empty, button locks. Fix is verified by a delivered email
  and a working Resend button.

## Rollback

Revert the three migrated functions to SMTP and redeploy (the `GMAIL_*` secrets
remain). The new notify functions are additive — disabling them just restores
the prior no-op toasts.
