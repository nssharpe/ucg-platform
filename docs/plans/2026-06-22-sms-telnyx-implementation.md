# SMS (Telnyx) — Implementation Plan (2026-06-22)

Wires real SMS sending into the **Communicate** tool using Telnyx, per the provider
research in [`docs/research/2026-06-18-sms-providers.md`](../research/2026-06-18-sms-providers.md).
Mirrors the existing `send-email` Edge Function + `sendEmail` invoker pattern.

## Status of prerequisites (console, done by Nate)
- [ ] Telnyx messaging profile created (STOP/HELP keywords kept at defaults).
- [ ] Long-code number purchased and attached to the profile.
- [ ] Payment method + balance added.
- [ ] **A2P 10DLC brand + campaign submitted** (non-profit/low-volume tier).
      ← long pole, ~1–3 wks. **Sending is carrier-filtered until this is approved.**
- [ ] `TELNYX_API_KEY` and `TELNYX_FROM_NUMBER` (E.164, e.g. `+1512...`) in hand.

Build can proceed in parallel with 10DLC vetting; just don't expect real delivery
until the campaign is approved.

## Architecture (matches send-email)
- **Edge Function `send-sms`** — admin-gated (verify_jwt + `admin` role check, same
  gate as `send-email`). Takes `{ body, recipients: [{phone, name}] }`, POSTs each to
  Telnyx `POST https://api.telnyx.com/v2/messages` with the `messaging_profile_id`
  (or `from` number), returns per-recipient `{ ok, sentCount, failedCount, error }`.
- **Front-end invoker `sendSms`** in `src/lib/supabase.ts`, alongside `sendEmail`.
- **Communicate UI** ([Admin.tsx:1683](../../src/pages/Admin.tsx)) already has the
  `channel: 'email' | 'sms'` toggle and a `SendRecord` with `channel: 'sms'`. The
  stub at `doSend` (`'SMS sending is not wired up yet (demo)'`) is the wire-in point.

## Phase 1 — Send path (minimal, ship first) — ✅ BUILT 2026-06-22
Done except the deploy + secrets (blocked on Telnyx API key + number from Nate):
- `supabase/functions/send-sms/index.ts` (+ `segments.ts` Deno copy) — admin-gated,
  E.164 normalization, server-side segment cap, per-recipient Telnyx send.
- `sendSms` / `SendSmsResult` in `src/lib/supabase.ts`.
- Communicate `doSend` branches on channel; SMS path validates phones + multi-segment confirm.
- **Remaining:** `supabase secrets set TELNYX_API_KEY / TELNYX_FROM_NUMBER` then
  `supabase functions deploy send-sms --project-ref wkyerxlgricfphopocoz`.

### Phase 1 — original notes
1. **Secrets**: `supabase secrets set TELNYX_API_KEY=... TELNYX_FROM_NUMBER=...`
   (and `TELNYX_MESSAGING_PROFILE_ID` if sending via profile rather than a fixed from).
2. **`supabase/functions/send-sms/index.ts`** — copy `send-email` structure:
   - Same CORS + admin-auth block.
   - `MAX_RECIPIENTS` cap (keep low until 10DLC throughput is known; start ~50).
   - Validate E.164 phone per recipient; skip/blank-out invalid numbers.
   - Loop (or small concurrency) → Telnyx `/v2/messages` with
     `Authorization: Bearer ${TELNYX_API_KEY}`. Collect per-number status.
   - Return the same shape `sendEmail` returns so the UI handler is symmetric.
3. **`sendSms(body, recipients)`** in `src/lib/supabase.ts` — `functions.invoke('send-sms', ...)`.
4. **Wire `doSend`** in Admin.tsx: when `channel === 'sms'`, validate body length
   (see Phase 2 counter), require recipients to have `phone`, call `sendSms`, and
   record a `SendRecord` with `channel: 'sms'`.
5. Deploy: `supabase functions deploy send-sms --project-ref wkyerxlgricfphopocoz`.

## Phase 2 — Segment counter (client-side) — ✅ BUILT 2026-06-22
- `src/lib/sms-segments.ts` (pure: `analyzeMessage`, `isGsm7`, `normalizeToGsm7`)
  + `tests/sms-segments.test.ts` (11 cases, ground-truth segment values).
- Communicate composer shows live chars · encoding · segment count, hard-warns on
  Unicode, offers a one-click Normalize. `--warn` token added (AA contrast on white).

### Phase 2 — original notes
Per research lines 53–69. In the Communicate composer, when `channel === 'sms'`:
- Detect encoding: GSM-7 vs UCS-2 (any non-GSM char → Unicode).
- Live readout: **chars used · encoding · # segments** (160/153 GSM-7; 70/67 Unicode).
- Warn on crossing into a new segment; **hard-warn on Unicode** (emoji/smart quotes).
- Optional "normalize to GSM-7" button (— → -, curly quotes → straight).
- Default soft cap: 1 segment, with explicit "send as N segments" confirm.
- Put the pure logic in a testable module (e.g. `src/lib/sms-segments.ts`) so it gets
  Vitest coverage like the scoring engines — **add `tests/sms-segments.test.ts`**.

## Phase 3 — Consent + send log (compliance + the stubbed confirmation)
Per research lines 76–87.
- **SMS-consent flag** per member (migration: add `sms_consent` + `sms_consent_at`
  to the member/profile table). Filter the SMS audience to consented recipients only.
- **Server-side cap**: `send-sms` also rejects/alerts over a configured max segments.
- **Send log**: persist recipients, segment count, cost estimate, timestamps so the
  Communicate "who it went to" confirmation becomes real (table + insert from the fn).

## Phase 4 — Inbound webhook (deferred; what the console field was asking about)
The "Webhook URL" in the profile wizard points here. **Not needed to send.** When built:
- New function **`sms-webhook`** at
  `https://wkyerxlgricfphopocoz.supabase.co/functions/v1/sms-webhook`.
- **Deploy with `--no-verify-jwt`** (Telnyx can't send a Supabase JWT) and instead
  verify Telnyx's **Ed25519 request signature** (`telnyx-signature-ed25519` headers)
  using the public key from the portal.
- Handle: **delivery receipts (DLRs)** → update the send log; **inbound replies** →
  store/notify; honor STOP at the app layer too (set `sms_consent = false`).
- Then paste that URL into the messaging profile's Webhook URL field.

## Testing / verification
- Vitest: segment-counter logic (Phase 2). No network in tests.
- Manual: test-send to Nate's own number via the existing test-send UI before any blast.
- Don't trust 10DLC delivery until the campaign shows **approved** in the portal.
