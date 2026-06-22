# Resend email transport — design

Date: 2026-06-22
Status: Draft for review
Owner: Nate (PM); implementation: Claude

## Problem

Transactional and broadcast email currently sends through **Gmail SMTP**
(denomailer) from three Edge Functions. This is explicitly test-grade: it runs
through a personal Gmail app password, is subject to Gmail's daily recipient
limits, and forces a hard 50-recipient cap on the broadcast to avoid tripping
them. The CLAUDE.md notes and the function headers themselves flag "swap to
Resend before real production sends."

Each of the three functions also **duplicates** the entire SMTP setup
(`new SMTPClient(...)`, per-recipient `client.send(...)`, `client.close()`),
so the transport lives in three places.

## Goal

Replace the Gmail SMTP transport with **Resend** across all three functions,
behind a single shared helper, parameterized via secrets so the sender address
can change without a code edit or redeploy.

## Sending functions (unchanged responsibilities)

- `send-email` — admin-only Communicate broadcast. Validates an admin caller,
  builds a recipient list, sends one message per recipient (no leaked recipient
  list), capped at 50.
- `request-guardian-waiver` — emails a single guardian a signing link.
- `notify-club-cart` — emails each manager of a club (small N) a cart summary.

`record-waiver-signature` does not send email and is untouched.

## Design

### Shared module — `supabase/functions/_shared/resend.ts`

A small, dependency-free module (uses global `fetch`; no npm/deno import) that
owns the Resend transport:

- `resendFrom(): string` — returns the `RESEND_FROM` secret, defaulting to
  `United Club Gymnastics <onboarding@resend.dev>`. Sender is configuration, not
  code, so it flips from the test address to `nate.sharpe@naigc.org` with a
  secret change only.
- `sendOne({ to, subject, html, text }): Promise<{ id }>` — POST
  `https://api.resend.com/emails`. Used by `request-guardian-waiver` and (in a
  loop) `notify-club-cart`.
- `sendBatch(messages[]): Promise<{ sent, failed }>` — POST
  `https://api.resend.com/emails/batch`. One distinct message per recipient
  (≤100 per call), so the **no-leaked-recipient-list** property is preserved and
  the whole send is a single HTTP request — avoiding the per-second rate limit a
  50× loop would hit. Used by `send-email`.
- Both read `RESEND_API_KEY` and throw a clear, function-surfaced error if it is
  missing (mirrors today's "Email is not configured" 500).
- Return shapes map cleanly onto each function's existing JSON response contract
  (`sentCount` / `failedCount` / `sent` / `failed`), so the front-end invokers in
  `src/lib/supabase.ts` need **no** changes.

### Per-function changes

Mechanical and surgical — drop the `SMTPClient` import and the
`new SMTPClient(...)` / `client.send(...)` / `client.close()` blocks; keep all
auth, authorization, payload validation, recipient construction, and HTML body
logic exactly as-is.

- `send-email` — assemble `messages[]`, call `sendBatch`. Cap stays **50**. The
  cap error text is updated (it currently says "Switch to Resend" — we now *are*
  Resend; reword to reference a paid Resend plan / higher cap).
- `request-guardian-waiver` — single `sendOne`.
- `notify-club-cart` — `sendOne` per manager, preserving its per-recipient
  success/failure tracking.

### Secrets

Set via `supabase secrets set` (sandbox disabled):

- `RESEND_API_KEY` — the Resend key. Stored as a secret only; **never** committed.
- `RESEND_FROM` — `onboarding@resend.dev` initially; flip to
  `United Club Gymnastics <nate.sharpe@naigc.org>` once `naigc.org` is verified
  in Resend (DNS records added in WordPress.com; verification in progress as of
  this writing).

The existing `GMAIL_USER` / `GMAIL_APP_PASSWORD` / `GMAIL_FROM_NAME` secrets stay
in place but go unused. They are the rollback path: revert the three functions
and redeploy if Resend misbehaves.

## Domain verification (operational, not code)

`naigc.org` is registered in Resend. DKIM (`resend._domainkey` TXT), SPF MX
(`send` → `feedback-smtp.us-east-1.amazonses.com`, pri 10), and SPF TXT
(`send` → `v=spf1 include:amazonses.com ~all`) were added in WordPress.com DNS.
Once Resend shows **Verified**, `RESEND_FROM` flips to the naigc.org address and
sends can reach any recipient. Until then, the unverified account can only send
from `onboarding@resend.dev` to Nate's own signup address — sufficient to smoke
test the wiring.

## Testing / verification

- No new unit tests: the Edge Functions carry no pure logic the Vitest suite
  covers, and there is no Deno test harness in the repo. (The shared helper is a
  thin `fetch` wrapper; its correctness is verified by a live send.)
- Deploy all three functions (`supabase functions deploy <name> --project-ref
  wkyerxlgricfphopocoz`).
- Live smoke test once the domain is verified: send a one-recipient broadcast to
  a real address and confirm receipt plus the `{ sentCount: 1, failedCount: 0 }`
  response. Spot-check a guardian-waiver request and a club-cart notification.

## Out of scope

- The deferred **new-club-request** email (separate TODO).
- Rewriting any HTML email templates.
- DOM/component tests (none exist in the repo).
- Resend webhooks, broadcasts API, audiences, or retry/queueing — YAGNI for
  test-to-light-production grade.

## Rollback

Revert the three functions to the SMTP versions and redeploy; the `GMAIL_*`
secrets are still present, so email resumes on the old transport with no other
changes.
