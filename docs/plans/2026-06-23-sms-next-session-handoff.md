# SMS (Telnyx) — fresh-session kickoff prompt

Paste the block below into a new session to continue the SMS work without the
setup-conversation context. Everything it needs is in the repo.

---

I'm continuing the Telnyx SMS integration for the UCG platform. Phases 1–2 are
already built, committed, and pushed (commits `8b0ce2b`, `8356475`). The
`send-sms` Edge Function is deployed and secrets (`TELNYX_API_KEY`,
`TELNYX_FROM_NUMBER=+16787988123`) are set. Read these first for full context:

- `docs/plans/2026-06-22-sms-telnyx-implementation.md` — the master plan + status.
- `docs/research/2026-06-18-sms-providers.md` — provider research / compliance notes.
- `src/lib/sms-segments.ts` + `tests/sms-segments.test.ts` — Phase 2 (done).
- `supabase/functions/send-sms/index.ts` (+ `segments.ts`) — Phase 1 (done, deployed).
- `src/pages/Admin.tsx` `Communicate` component — SMS UI wiring (done).
- `src/lib/supabase.ts` `sendSms` / `SendSmsResult` (~line 511) — invoker (done).

**Current external state (no code action needed):**
- 10DLC brand "NAIGC" Verified; campaign (Low Volume Mixed: 2FA + Account
  Notification + Marketing) SUBMITTED and pending vetting. Test sends are
  carrier-blocked until it's APPROVED + the number is assigned to the campaign —
  this is expected, not a code bug. Do not try to "fix" non-delivery in code.
- Privacy policy at naigc.org needs an SMS clause added (tracked below) before the
  campaign reliably passes vetting. This is a website edit Nate owns, not code.

**Build/test/deploy notes (see CLAUDE.md):**
- Working copy at `C:\dev\ucg-platform`. `npm test` (vitest, node env). `npm run build`.
  Lint only files you touch. Deploy functions:
  `supabase functions deploy <name> --project-ref wkyerxlgricfphopocoz` (sandbox off).
- Nate has standing authorization to apply migrations to the live DB; show what
  will apply first for anything destructive.

Please pick up the remaining work in this order:

## 1. Phase 3 — SMS consent + send log — ✅ DONE 2026-06-23
See the master plan's Phase 3 section for the as-built summary (migration
`20260623000050`, `Profile.tsx` consent checkbox, `Admin.tsx` consent-gated audience,
`src/lib/sms-send.ts` + tests, `comm_log` segment/encoding/cost columns). Original scope:
Per the plan's Phase 3. Use brainstorming/TDD/migration conventions in CLAUDE.md.
- **Consent flag:** new migration adding `sms_consent boolean default false` and
  `sms_consent_at timestamptz` to the member/profile table (find the right table;
  `people` import exceeds 1000 rows — see `fetchAllRows`). Surface a consent
  checkbox on the registration form with CTIA-compliant disclosure text (unchecked
  by default: "Text me registration and event reminders from UCG. Msg & data rates
  may apply. Reply STOP to opt out."). Persist value + timestamp.
- **Filter the SMS audience** in Communicate to consented recipients only.
- **Server-side cap:** `send-sms` already caps segments; also confirm it rejects
  over a configured max recipients once 10DLC throughput tier is known.
- **Send log:** persist (recipients, segment count, encoding, cost estimate,
  timestamps) so the Communicate "who it went to" confirmation becomes real. Decide
  table vs. reuse; insert from the function or the client. Wire the existing
  `SendRecord`/lastSend UI to read from it.

## 2. Phase 4 — inbound webhook (delivery receipts + replies)
Per the plan's Phase 4.
- New function `sms-webhook` deployed with `--no-verify-jwt` (Telnyx can't send a
  Supabase JWT). Verify Telnyx's Ed25519 signature (`telnyx-signature-ed25519` +
  timestamp headers) using the portal's public key.
- Handle delivery receipts (DLR) -> update the send log; inbound replies -> store /
  notify; honor STOP at the app layer (set `sms_consent = false`).
- URL: `https://wkyerxlgricfphopocoz.supabase.co/functions/v1/sms-webhook` — paste
  into the messaging profile's Webhook URL field after deploy.

## 3. Follow-ups / reminders
- **Privacy policy:** confirm naigc.org's policy PDF/page now contains the SMS
  no-sharing clause (drafted 2026-06-23); if not, remind Nate — it gates campaign
  approval. Point the campaign's Privacy policy field at the updated URL.
- **New-club-request email** (separate deferred TODO in CLAUDE.md) is unrelated; skip
  unless asked.
- **Launch TODO** (in the plan): before launch, re-register a standard Mixed campaign
  (Low Volume is dev-only), reassign +16787988123 to it, and consider splitting 2FA
  into its own campaign for deliverability.

Start by reading the plan, confirm the Phase 3 scope with me, then proceed TDD-first.
