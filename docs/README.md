# docs/

Project documentation. The top-level [`README.md`](../README.md) is the overview;
this folder holds design **specs**, implementation **plans**, and **research** notes.
Live build/tooling notes live in [`../CLAUDE.md`](../CLAUDE.md); open work is the
[What's next](#whats-next--the-authoritative-list) list below.

> **Status legend:** ✅ shipped to `main` (live) · 🟡 partial / on a branch ·
> 📘 reference (ongoing) · 📓 research (informational, not a commitment).
> Last reconciled with the codebase: **2026-07-04**.

## Reference docs
- [`production-readiness.md`](production-readiness.md) — **gap analysis by dimension**
  (UX, security, reliability, observability, legal) with steps split between Nate and
  Claude; refreshed 2026-07-04. The ordered list of what to do next is the
  [What's next](#whats-next--the-authoritative-list) section below.
- [`hosting-and-launch.md`](hosting-and-launch.md) — hosting model, production target
  (`registration.unitedgymnastics.org`), pre-launch hardening checklist.
- [`../supabase/README.md`](../supabase/README.md) — backend schema, RLS model, and
  migration / project-standup steps.
- [`../CLAUDE.md`](../CLAUDE.md) — build/tooling gotchas, test command, deferred work
  (operative rules only since 2026-07-02; the full historical version is archived at
  [`archive/CLAUDE-md-as-of-2026-07-02.md`](archive/CLAUDE-md-as-of-2026-07-02.md)).
- [`model-routing-log.md`](model-routing-log.md) — observational log of which model
  tier handled which task (feeds the CLAUDE.md "Model routing" rules).
- [`reference/`](reference/README.md) — **source materials from Julia** (received
  2026-07-06): her event-management requirements spec + the legacy Apps-Script
  Nationals reg/check-in tools and their xlsx sheet backends. Digested into
  [`specs/2026-07-06-event-management-v2-requirements.md`](specs/2026-07-06-event-management-v2-requirements.md).

## Specs (`specs/`) — validated designs, written before implementation

| Spec | Subject | Status |
|------|---------|--------|
| [account-role-foundation-design](specs/2026-06-12-account-role-foundation-design.md) | Sub-project A: capability-driven auth, account↔person claim, club management | ✅ shipped |
| [nationals-qual-awards](specs/2026-06-13-nationals-qual-awards.md) | Authoritative finals-qualification & awards ruleset for the TS port | 📘 reference |
| [auth-email-setup](specs/2026-06-16-auth-email-setup.md) | Supabase Auth + email dashboard configuration steps | 📘 ops runbook (auth live) |
| [event-management](specs/2026-06-18-event-management.md) | Net-new event/sanctioning subsystem (Wave 4 of the 6/18 batch) | ✅ shipped (merged to `main`) |
| [feedback-batch-decomposition](specs/2026-06-18-feedback-batch-decomposition.md) | Decomposition of the 6/18 feedback batch into waves | ✅ shipped (all waves merged) |
| [digital-waiver-esign-design](specs/2026-06-20-digital-waiver-esign-design.md) | Clickwrap e-signature: versioned text, signature evidence, guardian path | ✅ shipped |
| [resend-email-transport-design](specs/2026-06-22-resend-email-transport-design.md) | Swap email transport from Gmail SMTP to Resend | ✅ shipped |
| [feedback-batch-decomposition (6/22)](specs/2026-06-22-feedback-batch-decomposition.md) | Master decomposition of the 6/22–6/23 feedback batch (10 phases + decisions) | ✅ shipped (all phases live) |
| [topbar-responsive-and-mobile-nav-design](specs/2026-06-24-topbar-responsive-and-mobile-nav-design.md) | One-line topbar badges, measurement-driven degradation, mobile drawer nav, mobile dev pipeline | ✅ shipped |
| [dev-test-auth](specs/2026-06-25-dev-test-auth.md) | Dev-only real auto-login of a seeded Supabase test user (`.env.local`-gated) so authenticated UI is exercisable locally | ✅ shipped |
| [stripe-integration](specs/2026-06-25-stripe-integration.md) | Stripe Embedded Checkout architecture (S1–S5) | ✅ shipped |
| [security-review-findings (7/02)](specs/2026-07-02-security-review-findings.md) | Deep review of the money paths: RLS, edge functions, cart state machine — verified findings by severity | 🟡 findings logged; fixes planned |
| [event-management-v2-requirements](specs/2026-07-06-event-management-v2-requirements.md) | Julia's full event-management requirements (7/06) digested + gap-mapped: host dashboard, refunds, capacity/waitlists, add-ons v2, nationals ops, finance dashboards — phasing V2-P0…P6 | 🟡 validated (phasing approved, §N7 answered); **P0–P3 shipped** (P0 foundations/scheduler, P1 host experience, P2 add-ons & camps, P3 in-app refunds — 2026-07-11); **P4 (capacity/waitlists & by-session reg) next** |

## Plans (`plans/`) — step-by-step implementation records

| Plan | Subject | Status |
|------|---------|--------|
| [supabase-wiring](plans/2026-06-11-supabase-wiring.md) | Make the live Supabase project the real data layer (write-through + realtime) | ✅ shipped |
| [native-score-entry](plans/2026-06-12-native-score-entry.md) | Replace iframe calculators with native TS scoring engines | ✅ shipped |
| [account-role-foundation](plans/2026-06-12-account-role-foundation.md) | Sub-project A implementation | ✅ shipped (merged) |
| [nationals-qual-awards-implementation](plans/2026-06-13-nationals-qual-awards-implementation.md) | Build the nationals engine (Phases 0–5 + adapter) | ✅ engine built & test-verified; end-user UI surfacing ongoing |
| [digital-waiver-esign](plans/2026-06-20-digital-waiver-esign.md) | Build the clickwrap e-signature system | ✅ shipped |
| [resend-email-and-stubs](plans/2026-06-22-resend-email-and-stubs.md) | Resend transport swap + stub fixes | ✅ shipped |
| [sms-telnyx-implementation](plans/2026-06-22-sms-telnyx-implementation.md) | Communicate text channel via Telnyx | ✅ shipped |
| [club-invites-and-roster](plans/2026-06-23-club-invites-and-roster.md) | Admin-create invites + set-password, Add-athlete, roster club switcher (Phase 3) | ✅ shipped |
| [topbar-responsive-and-mobile-nav](plans/2026-06-24-topbar-responsive-and-mobile-nav.md) | Topbar one-line badges + measurement degradation + mobile drawer nav | ✅ shipped |
| [playwright-responsive-tests](plans/2026-06-24-playwright-responsive-tests.md) | Proposed (not built) Playwright responsive screenshot tests in CI | 📓 proposed |
| [unified-cart-b2](plans/2026-07-02-unified-cart-b2.md) | Unified personal + managed-club `/cart` + cart-registration mutation sync | ✅ shipped |
| [welcome-email-stripe-path](plans/2026-07-02-welcome-email-stripe-path.md) | Fire the first-membership welcome email from `stripe-webhook` fulfillment | ✅ shipped |
| [security-hardening](plans/2026-07-02-security-hardening.md) | Fixes for the 7/02 security findings: RLS guard triggers, token exposure, checkout ref validation, retryable fulfillment | 🟡 Phase 1 + 2 shipped & deployed (verified live); Phase 3 TODO |
| [cart-state-fixes](plans/2026-07-02-cart-state-fixes.md) | Fixes for the 7/02 client cart/registration state-machine findings (C5, H5–H8, M6–M9) | ✅ shipped (2 minor residuals noted) |
| [feedback-tracker](plans/2026-06-28-feedback-tracker.md) | 6/27 Gemini-organized feedback batch, cohorted A + B1–B8 | 🟡 Cohort A + B1–B4 + B6 + B7 + B8 shipped; **B5 open** (see [CLAUDE.md](../CLAUDE.md) Deferred/TODO) |

## Research (`research/`) — informational, not commitments

| Note | Subject | Status |
|------|---------|--------|
| [sms-providers](research/2026-06-18-sms-providers.md) | Bulk-SMS provider options for the Communicate tool | 📓 research (Telnyx shipped) |
| [stripe-plan](research/2026-06-18-stripe-plan.md) | Real payments: membership/meet/banquet, card-on-file, club cart | 📓 research → **shipped (S1–S5; see [stripe-integration spec](specs/2026-06-25-stripe-integration.md) + [go-live checklist](stripe-go-live-checklist.md))** |
| [auth-2fa-passkeys](research/2026-06-22-auth-2fa-passkeys.md) | 2FA/passkey options (Supabase MFA: TOTP/SMS/WebAuthn) + phased recommendation | 📓 research |
| [password-policy](research/2026-06-22-password-policy.md) | Password best practice (NIST) + Supabase policy settings | 📓 research |
| [error-logging-observability](research/2026-06-22-error-logging-observability.md) | Error-log strategy (DB + admin search; Sentry optional) | 📓 research → **shipped (error_logs)** |
| [admin-refresh-flash](research/2026-06-22-admin-refresh-flash.md) | Diagnosis + fix for the admin-page "access denied" flash on refresh | 📓 research → **shipped (rolesLoaded)** |

## What's next — the authoritative list

**This is the single source of truth for open work** (reconciled 2026-07-04).
[`production-readiness.md`](production-readiness.md) is the per-dimension gap
analysis, [`plans/2026-06-28-feedback-tracker.md`](plans/2026-06-28-feedback-tracker.md)
the feedback-item history, and [`../CLAUDE.md`](../CLAUDE.md) keeps only a pointer
here — update THIS list when priorities change, not rival copies.

### Launch blockers (ordered by leverage; 👤 = only Nate can do it)
1. 👤 **Supabase Pro + backups/PITR** — **DEFERRED (decided 2026-07-04)** to later in
   development; recorded as a hard pre-flight gate in the
   [go-live checklist](stripe-go-live-checklist.md) so it can't be missed before real money.
2. 👤 ~~Uptime monitor + alerting~~ **done 2026-07-04** (UptimeRobot, 5-min checks,
   email alerts: live site + Supabase auth health) · 🤖 still open: a daily digest
   of new `error_logs` / stuck `pending` payments (scheduled function).
3. 👤 **Stripe go-live** — [stripe-go-live-checklist.md](stripe-go-live-checklist.md)
   (live keys, $1 smoke + refund).
4. 👤 **Legal** (longest lead time — start early): counsel review of waiver,
   privacy policy, ToS, minors/COPPA. 🤖 drafts the policy docs.
5. ~~Staging Supabase project + Playwright smoke E2E~~ **done 2026-07-04**
   (`ucg-staging` fully stood up + seeded, 5 smoke specs green incl. live
   checkout-session → Stripe render; runbook in
   [supabase/README](../supabase/README.md)). Still open: run E2E in CI.
6. 🤖 **Security hardening Phase 3** ([plan](plans/2026-07-02-security-hardening.md))
   + **rate limiting/CAPTCHA** on sign-up and the public email-sending functions.

### Quality passes (pre- or just post-launch)
- 🤖 **UI/UX review fixes** ([task briefs by model class](plans/2026-07-04-uiux-review-fixes.md),
  from the 2026-07-04 live review) — coral-CTA contrast (AA fail), Profile save-bar
  overlap, cart-vs-checkout price mismatch, payment-status badges, plus a polish batch.
- 🤖 Accessibility audit to WCAG AA + loading/empty/error state consistency.
- 🤖 In-app "Report a problem" widget + version stamp (`error_logs` is passive today).
- 🤖 In-app admin refunds (Dashboard-only today; sketch in the go-live checklist —
  full requirements now in the [event-management v2 spec §H](specs/2026-07-06-event-management-v2-requirements.md)).
- 🤖 New-club-request email to `newclubinquiries@naigc.org` (transport exists, not wired).
- 🤖 Verify the PWA production update path (stale service-worker bundle → add an
  update prompt if needed).

### Feature roadmap (as prioritized)
- **Event management v2** — Julia's 2026-07-06 requirements, digested + gap-mapped in
  [specs/2026-07-06-event-management-v2-requirements.md](specs/2026-07-06-event-management-v2-requirements.md).
  **Phasing approved by Nate 2026-07-06:** V2-P0 foundations/scheduler →
  P1 host experience → P2 add-ons & camps → P3 refunds → P4 capacity/waitlists &
  by-session reg → P5 nationals ops/check-in → P6 finance dashboards.
  **P1 (host experience) is now fully shipped** — see Tasks 1, 3–8 below. **P2 (add-ons
  & camps) is now fully shipped** (Tasks 1–7). **P3 (refunds, §H) is now fully shipped
  (2026-07-11)** — see "P3 shipped" below; P4 (capacity & sessions) is next. **Task 1** (per-unit add-on cart/invoice line fields, `addon_size`/
  `addon_assignee`) and **Task 2** (server-side per-unit add-on pricing + purchase
  deadlines + banquet-assignment validation in `create-checkout-session`) shipped, plus
  **Task 3** (individual self-cart per-unit add-on purchase UI: registration-popup add-on
  step reworked to quantity steppers + per-unit size/assignee pickers, camp shirt/leo
  forced to an explicit choice, and a new standalone post-registration "Add-ons" dialog
  on the event page usable past `regCloses` via each type's `lastPurchaseAt`). **Task 4
  shipped:** the club-manager Add-ons card (§E3) on Club.tsx's event-registration page —
  t-shirt quantity+size (reusing the picker, now extracted to
  `src/components/AddonPickers.tsx`), banquet tickets assigned to any roster
  athlete/coach via a new `ClubBanquetPicker` (max-1-assigned-per-person checked against
  the draft, the club cart, AND already-purchased invoice lines), and a locked-once-added
  club banner text field. Pushes one cart line per unit to the CLUB cart.
  **Task 5 shipped:** camp club-membership gate carve-out + overnight-accommodations
  survey UI (§G). Camps waive the *club*-membership gate at every registration entry
  point (`clubHasActiveMembershipForEvent`/`clubMembershipGateApplies`,
  `capabilities-core.ts`) — the individual-membership check (`caps.canRegister`) still
  applies unchanged, and a club's own hosting-eligibility gate is untouched. The
  registration popup (`SelfRegModal`) now asks a bedtime/noise-level/cabin-gender-pref/
  roommate-request survey LAST, after add-ons, when `campConfig.overnightSurvey` is on
  — persisted on `Registration.campSurvey` ↔ `registrations.camp_survey` (new pure
  helpers in `pricing.ts`: `CampSurveyDraft`/`campSurveyValid`/`campSurveyToStored`/
  `campSurveySummary`); a brand-new entry cart line's label summarizes add-ons + survey
  answers. Survey answers are editable any time before the edit deadline via a new
  block in `MyRegistrations.tsx`'s `EditRegistrationModal` — always free, never a
  change fee. Also fixed a T1 bug where Sanction.tsx's approval mapping dropped
  `p.leoAddon` (and `overnightSurvey`) instead of copying them onto
  `event.campConfig`. The finance-side add-ons export and the "no discipline/level/
  apparatus in camp registration" popup simplification (§G) remain open — the camp
  registration popup still reuses the full per-discipline `RegistrationEditor`.
  **Task 6 shipped:** camp confirmation email (§G) — `stripe-webhook`'s receipt now
  appends a camp-details block for any purchased CAMP event: each registered
  athlete's `camp_survey` answers (human labels, omitted per-athlete when unanswered)
  plus this payment's purchased add-ons (shirt/leo sizes, banquet assignee — reused
  verbatim from the already-human-readable cart-line label), with a link to
  `/#/me/registrations` to edit. Pure HTML-building lives in
  `_shared/camp-confirmation.ts` (Deno + vitest dual-import, mirrors the `event-comm.ts`
  pattern) and is wrapped in its own try/catch, isolated from the existing per-event
  confirmation-config block, so a failure there can't break the receipt or fulfillment.
  **Task 7 shipped (final P2 task):** the host workbook's deferred purchased-add-on
  sheets + a camp roster sheet (`src/lib/host-export.ts`). Adds Shirts (purchased),
  Leo sizes, and Banquet sheets (each omitted, not emitted empty, unless its add-on is
  BOTH configured and has at least one purchased unit) sourced from a new
  `event_host_addons` RPC — an RLS exception mirroring `event_host_roster` so a host
  sees purchased units across every competing club, not just their own. Adds a Camp
  roster sheet for camp events: one row per athlete (birthday, gender, profile vs.
  purchased shirt size, purchased leo size, all four overnight-survey answers with
  human labels, date registered) — required extending `event_host_roster` with
  `dob`/`gender`/`camp_survey`/`created_at`. The migration
  (`20260710151638_event_host_addons_and_camp_detail.sql`) is applied. **P2 (add-ons &
  camps) is now fully shipped** (Tasks 1–7).
  **P3 (refunds, §H) shipped 2026-07-11**, plus 4 bug fixes found/fixed along the way:
  (1) `EventWizard` datetime-local fields were blanked on load by `timestamptz` values
  (`toDatetimeLocalValue`, `events-core.ts`); (2) the Edit-event button now gates to
  admin/sanctioning, matching `events` RLS (hosts were silently rejected on save);
  (3) `normalizeExternalUrl` (`src/lib/url.ts`) applied to `hotelLink` + medal
  `trackingLink` at save/render; (4) **$0-total checkout** — a coupon-fully-covered cart
  now skips Stripe entirely and fulfills directly via the new shared
  `_shared/fulfill.ts` (`fulfillPayment`, extracted from `stripe-webhook` with unchanged
  semantics), with inline retry + `error_logs` on failure so a free order never strands
  unfulfilled; FE `CartCheckout.tsx` gained a `'free'` polling stage. The refund system
  itself: `refund_manager` role + `clubs.is_league_host` flag (only UCG-hosted, i.e.
  league-club-hosted, events are refund-eligible) + `refund_requests` table; self-serve
  (`MyRegistrations.tsx`) and club-manager (`Club.tsx`) request dialogs → edge fn
  `request-refund` (ownership/eligibility/duplicate validation, notifies requester +
  refund managers); review page `#/admin/refunds` → edge fn `process-refund` (reject =
  email only; approve = 100% at-or-before `lastDateToEdit` else 75% of the post-coupon
  `paid_cents` base, capped at the payment's remaining subtotal, Stripe refund on the
  original payment intent, atomic claim-before-Stripe with revert-on-failure). On-time
  approval deletes the registration; post-deadline keeps it `refunded`+`keep_listed`
  with apparatus blanked (still shows in event materials, un-recheckable except by an
  admin with a confirm). Refund receipts (jsPDF) appear in Purchase History. A hotfix
  migration (`20260711023234`) closed an RLS policy-recursion regression (42P17) the
  review-reads migration introduced, which briefly broke all `invoice_items` reads.
  **P4 (capacity & sessions — waitlists, by-session registration) is next.**
  **P0 Task 1 shipped:** pg_cron/pg_net scheduler infra (`notification_log` +
  `scheduled-dispatch-15min` job + `scheduled-dispatch` Edge Function, service-role-only
  auth) with its first consumer — 3d/1d/closed sanction-vote reminder emails, idempotent
  via `notification_log`. Runbook in `supabase/README.md` → "Scheduled dispatch (pg_cron)"
  (the two Vault secrets still need manual per-environment setup before the cron job can
  actually fire).
  **P0 Task 2 shipped:** event entity field extensions (spec §A) — venue/street/country/
  hotel-block link, age-calc date, late registration config (`Event.lateReg`), a general
  (not camp-only) director contact, capacity config (stored, not enforced yet), and a
  confirmation-email override with an HTML preview in EventWizard. Migration backfilled
  `camp_config`'s director/age-calc keys onto the new event-level fields. Sanction.tsx's
  approval mapping carries venue/street/country/late-reg into the created event.
  **P0 Task 3 shipped:** late-registration fee pricing — the surcharge applies once per
  athlete per event (not per-discipline), waived for host-club regs, never affecting
  change fees, and attaching ONLY to the purchase line that contains the athlete's
  EARLIEST-created registration for that event (`lateFeeAnchor`, id tie-break — the
  controller-review fix that stops repeat purchases / second saves from re-adding the
  fee). `registrationEntryFee`/`newRegistrationEntryTotal` (`src/lib/pricing.ts`) take
  an optional `late` param; `create-checkout-session` recomputes server-side from
  `late_reg` + `created_at` (mirrored in `_shared/stripe.ts`, same pattern as the
  service fee).
  **P0 Task 4 shipped:** per-event confirmation email — `stripe-webhook`'s receipt now
  renders each purchased event's `confirmation_email.bodyHtml` above the receipt table,
  cc's the event director when `ccOnConfirmation`, and applies reply-to / from-alias
  when exactly one distinct value exists across the cart's events (`_shared/resend.ts`
  gained `reply_to` + display-name-only `fromName`).
  **P0 deploy state (2026-07-07):** staging fully deployed + E2E green (5/5).
  Prod is PENDING Nate: vault secrets (both envs), prod `supabase db push`, the three
  prod function deploys (`stripe-webhook` with `--no-verify-jwt`!), then merge to main.
  **P1 Task 1 shipped:** event-owner assignment + task checklist (§B3-4) —
  `events.owner`/`owner_checklist` jsonb columns; sanctioning-team members can now
  UPDATE events (new `sanctioning_update` RLS policy, alongside admin) via
  `list_sanctioning_team()` RPC for the assign-owner dropdown; pure due-date +
  escalating-reminder-stage logic in `supabase/functions/_shared/owner-checklist.ts`
  (`ownerTaskDueDate`/`ownerReminderStage`, unit-tested, no Deno imports — ready for
  the scheduler to consume once reminder emails are built, a later task); UI on the
  event page (owner field + 7-item checklist with payload inputs) gated on
  `isSanctioning`, and a red "No owner assigned" badge on the Sanctioning Queue's
  decided list linking to the event.
  **P1 Task 3 shipped:** per-event admin grants (§C) — `event_admins` table (per-event
  ACL, unique `(event_id, user_id)`), read-only RLS with all writes through
  `grant_event_admin` (exact-account-email lookup — deliberately no name search, PII
  decision) / `revoke_event_admin` SECURITY DEFINER RPCs (authorized: admins, host-club
  managers, existing event admins of that event); `isEventHost()` now honors
  auth-uid-scoped grants (new `eventAdminEventIds` param on `deriveCapabilities`);
  "Event admins" card on the event page (add by account email / remove) for anyone
  with host-level access.
  **P1 Task 4 shipped:** private `event-files` Storage bucket (first RLS'd bucket in the
  project) for owner-checklist file uploads — currently insurance certificates
  (`insurance/<event_id>/<filename>`); the owner checklist's insurance task now uploads
  + resolves a signed view link (`uploadInsuranceCertificate`/`insuranceCertificateUrl`,
  `InsuranceCertificateLink`) instead of a free-text path.
  **P1 Task 5 shipped:** event host viewing page (§C) at `/events/:slug/host` —
  status card (owner contact, hotel block, insurance link, medal order/tracking with a
  host "Mark received" action, onsite rep, payment status incl. collected-so-far and a
  post-event unpaid-host warning) plus a per-level registration summary (participating
  clubs + athletes per apparatus, `summarizeRoster` in `src/lib/host-page.ts`, unit-
  tested). Three new SECURITY DEFINER RPCs (`event_host_roster`,
  `event_collected_total`, `mark_medals_received`) give hosts/event-admins/sanctioning
  the event-scoped read (and one scoped write) their own RLS wouldn't otherwise allow.
  "Host dashboard →" link on the event page for anyone with host-level access or
  sanctioning.
  **P1 Task 6 shipped:** Excel registration workbook (§C/§K) — "Download registration
  workbook (.xlsx)" card on the host page, built from the same shared host roster:
  Athletes (one row per registration — apparatus codes overlap MAG/WAG so a
  multi-discipline athlete gets one row per discipline rather than a clashing merged
  row), Counts (level × club × apparatus with a totals row), Shirt sizes (profile)
  (profile-size tally, explicitly labeled as not purchased-shirt quantities). Sheet
  shaping is pure + unit-tested (`src/lib/host-export.ts`); `exceljs` is dynamically
  imported so it ships as its own chunk, not the entry bundle. **P2 Task 7 extended
  this** (below) with the purchased-add-on sheets P1 deferred, plus a camp roster
  sheet.
  **P1 Task 7 shipped:** event-scoped communication (§J) — `/events/:slug/communicate`
  lets hosts, event admins, sanctioning, and admins email one event's registrants,
  filtered by role (athletes/managers/club emails) + session/level/discipline, via the
  new `send-event-email` Edge Function (recipients resolved server-side, never
  client-supplied; test sends go only to the caller's own account email). **Deviation
  from spec (controller/Nate decision 2026-07-09):** hosts get EMAIL ONLY — SMS stays
  league-admin-only, exposed as an admin-only channel toggle on the same page reusing
  the existing `send-sms` path. `comm_log.event_id` (new column) scopes the page's
  per-event sent log.
  **P1 Task 8 shipped (final P1 task):** scoped post-regCloses host editing (§C +
  Nate's 2026-07-09 scope answer) — once `now > event.regCloses`, the host page's new
  "Competition setup" section links to sessions/squads (`/events/:slug/manage`) plus a
  "Roster tools" card (grouped-by-club level/apparatus/session edits, remove, and
  "add athlete by email"), gated behind a one-time-per-visit warning modal that a
  removal is NOT a refund and an add is NOT a charge. Writes go through two new
  SECURITY DEFINER RPCs (`host_upsert_registration`/`host_delete_registration`) —
  `registrations` RLS itself stays untouched, so hosts never get a blanket reg-write
  grant; a host-added registration lands `paid:true` with no cart line (mirrors the
  existing host-club-$0 rule). Also closed a review-flagged gap: an `event_admins`
  grantee (no club management) could see the `EventManage`/scoring UI but every save
  silently failed RLS — new `is_event_host()` helper + policies on
  `event_sessions`/`squads`/`scores` fix it. Hosts still get NO refunds, NO fee/pricing
  config, NO event creation — those stay admin/sanctioning-only. Full migration
  contents in `supabase/README.md`.
  §N7 open questions **all answered by Julia 2026-07-06** (recorded in the spec;
  every phase is unblocked — only the §F partial-fit capacity design wants a
  confirm at P4 kickoff). This absorbs several
  older roadmap items: **B5 finance dashboards** (now fully spec'd, §M), in-app
  refunds (§H), banquet tickets/add-ons v2 (§E3), finals rosters (§L),
  server-emailed PDF receipts (§I/§N4). Naming: every "NAIGC" in Julia's raw
  doc reads as UCG (confirmed by Nate).
- B typed memberships + per-season waiver → C multi-club registration picker →
  D codeless judge access (URL / 6-digit / QR) → E scoring config (1-vs-2 panels,
  calculator vs. simple entry).
- Further out: MFA/passkeys, PDF certs, external API.

### Architecture watch-list
Not gaps yet — trigger conditions and known warts are written down in
[`production-readiness.md`](production-readiness.md#architecture-watch-list-not-gaps-yet--written-down-so-they-dont-surprise-us):
data-layer `loadAll` scaling cliff, realtime-only-on-scores staleness, the
`record-waiver-signature` stale-hold wart.

## Branches
All feature work is merged to `main` — there are no outstanding feature branches. (The
6/18 event-management and feedback branches were fully merged and have been deleted.)
