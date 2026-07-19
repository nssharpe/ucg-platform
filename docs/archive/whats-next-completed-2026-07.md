# Completed items from whats-next.md

Completed items moved out of whats-next.md on 2026-07-19; details live in specs/memory/git history.

## Nate-only action items

- **Grant `finance_admin`** — done 2026-07-16 (Nate granted all relevant users).
- **Confirm the host-payout "owed" formula with Julia** — answered + shipped 2026-07-17: owed = event gross collected (registrations + add-ons, before service/admin fees), refunds NOT deducted (hosts handle their own refunds; league-hosted events get no payout). `src/lib/finance.ts` updated.

## Open decisions

All resolved by Nate 2026-07-16 and SHIPPED 2026-07-17:

- **Offline stance**: read-only when offline — shipped (write-queue hardening: permanent-failure rollback + toast, `mutate()` offline gate, offline banner).
- **Admin MFA**: shipped in full (merged + deployed 2026-07-17).
- **Bug reports**: shipped — in-app "Report a problem" (category-routed email: site broken → nssharpe@gmail.com + jzsharpe@gmail.com; event/rule/policy → the `+ucghelp` aliases; unsure → both) + version stamp. Swap-to-real-emails is on the go-live checklist.

## Launch blockers

- **Fix `camp_survey` world-readability** — FIXED 2026-07-17 (migrations `20260717205348` + `20260717211754`, applied staging + prod, anon-probe verified on both; fix record in [results](research/2026-07-17-supabomb-scan-results.md)).
- **Daily "anything wrong?" digest** — shipped 2026-07-17: `daily-digest` kind in `scheduled-dispatch` (new `error_logs` rows since the last digest + every `payments` row stuck `pending` > 1h → email via Resend, at most once per UTC day). Runbook in `supabase/README.md` "Scheduled dispatch (pg_cron)". Deployed to prod + staging 2026-07-17.
- **Run the Playwright E2E suite in CI** — shipped 2026-07-18 — non-blocking `e2e` job in the deploy workflow (staging backend, `STAGING_ENV_FILE` secret, HTML report artifact on failure). Deliberately outside `deploy`'s needs chain.

## Quality passes

- **In-app "Report a problem" widget + version/build stamp** — shipped 2026-07-17 (nav-drawer entry, 3-category email routing via the `report-problem` edge fn, console-error ring buffer, git-SHA build stamp, **image attachments** — up to 3 screenshots, client-compressed + magic-byte-validated; all live-smoke-tested).

## Feature roadmap

- **MFA/passkeys** — shipped 2026-07-17 (merged to main; migration applied staging+prod; 9 guarded edge functions deployed): TOTP opt-in (Profile), aal2-required admins (hardened `is_admin()` + step-up challenge at sign-in + the edge-function AAL guard on every privileged function), admin break-glass reset (`admin-reset-mfa`; dashboard = last-admin fallback).
- **Passkey sign-in (free feature)** — shipped 2026-07-18 — `Gate.tsx` "Sign in with a passkey" + a Profile "Passkeys" management card (`src/pages/ProfilePasskeys.tsx`), using Supabase's free Passkeys sign-in API (distinct from the paid "Advanced MFA - WebAuthn" add-on, which stays declined).

## Proposed additions

- **Multi-manager freshness** — shipped focus-refetch; realtime upgrade deferred. `src/lib/focus-refresh.ts` (`initFocusRefresh()`, wired at boot in `main.tsx`) now runs `syncFromSupabase()` when a tab returns after being hidden/blurred/offline for ≥60s AND the last sync was ≥60s ago, skipping while the write-queue is busy/offline/unconfigured.
- **Payments reconciliation admin view** — shipped 2026-07-18 — "Reconciliation" tab on `#/admin/finance` (admin + finance_admin): stuck-pending list with guarded re-run-fulfillment, on-demand Stripe refund-drift scan with mark-refunded (bookkeeping-only; server re-verifies against Stripe). Edge fn `reconcile-payments` (AAL-guarded), migration `20260718142708` (`recon_note`), staging-smoke-tested + deployed prod. Known limit: drift scan checks the newest 100 paid payments per run (honest copy when truncated).
- **Season rollover runbook/tooling** — shipped 2026-07-18 as full automation (Nate's spec): `seasons.launched_at` state + admin "Launch season" action (Seasons page); event creation blocked into unlaunched seasons (EventWizard); escalating admin nags via `scheduled-dispatch` (June 1 / June 16 / daily from June 24, continuing past July 1 until launched); automatic `current` flip on July 1 (fail-loud — never invents a season); launched future-season memberships purchasable with a "next season" warning, enforced server-side in `create-checkout-session`. Migration `20260718200055` applied staging+prod (backfill verified both).
- **User data export + delete** — shipped 2026-07-18 (admin-operated) — Profile "Data privacy" card (admin view): JSON+PDF export via pure `collectPersonData` (completeness locked by a test over every `DB` collection), and delete/anonymize via `admin-delete-person` (admin-only, AAL-guarded, staging-smoke-tested both hard-delete and tombstone paths; waiver signatures retained pending counsel). Self-serve export/delete deferred unless counsel requires it.
- **Component tests** — shipped 2026-07-18 — jsdom + Testing Library in `tests/components/` (17 tests): cart-sync removal/revert semantics (real `removeCartItemWithSync` + shared `CART_REMOVAL_MESSAGE`), RegistrationEditor change-fee derivation (real component), membership-hold badge rendering.
