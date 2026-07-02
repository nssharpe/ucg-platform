# UCG Registration & Scoring Platform

React + TypeScript + Vite. Live: https://nssharpe.github.io/ucg-platform/
Supabase backend (env-gated). Deploys via GitHub Actions on push to `main`.

## Working style (Nate = PM, not hands-on)
Do as much as possible directly. When a step is technically doable but blocked only
on a one-time setup or a permission grant, ask for *just that unblock*, then execute
the step yourself — don't hand the whole step back to Nate as instructions. Nate has
standing authorization to run `supabase db push` / apply migrations to the live DB
(granted 2026-06-18). Still confirm genuinely destructive prod actions and show what
will apply first.

When executing a written implementation plan, **default to subagent-driven execution**
(`superpowers:subagent-driven-development` — fresh subagent per task + review between
tasks). Nate prefers this; don't ask which execution mode to use (decided 2026-06-24).

### Context/usage-optimized execution (standing rules — learned 2026-06-25)
These keep the controller's context lean across big multi-task batches. Apply by default:
- **Keep the controller out of the editor.** A subagent's final report costs ~2k tokens
  regardless of how much it reads internally, but the controller's OWN file reads/edits are
  what balloon context. So *delegate reading to subagents* — point them at the right files and
  let them read. The controller reads only the few key sections it needs to write a precise
  brief, never whole files "to be safe."
- **One implementer subagent per task/cohesive group; never run implementers in parallel**
  (they conflict on the working tree). Group items that touch the same files into one subagent.
- **Dispatch straight from the spec; skip redundant per-phase plan docs.** If a decomposition
  spec already states the requirements + file mappings, brief subagents from it directly rather
  than writing a second full TDD plan doc (saves a lot of context for the same result).
- **Review subagent reports inline; do NOT spin up separate spec + quality reviewer subagents**
  for this kind of work — that triples subagent calls. Read the report, spot-check the diff if
  needed, move on.
- **Subagents MUST verify with `npm run build`, not `tsc --noEmit`.** `npm run build` runs
  `tsc -b` (project references), which catches errors `tsc --noEmit` silently misses — this trap
  caused real rework. Require `npm run build` + `npx eslint <touched files, incl. any
  `supabase/functions/**`>` + `npx vitest run` (+ a vitest test for any new PURE logic) before commit.
- **Controller owns the side-effects, batched at phase end:** one `supabase db push` for all of
  a phase's migrations (sandbox disabled) and one loop to deploy all touched edge functions —
  fewer round-trips, one pending-migration diff to review. Subagents create migration files and
  edge-fn code but never push/deploy.
- **Dev auto-login (seeded test user) — authenticated UI IS exercisable locally:** when the
  `VITE_DEV_AUTH_*` vars are set in `.env.local`, the dev server (`ucg-dev` 5173 / `ucg-preview`
  5176, both `import.meta.env.DEV`) boots already signed in as a **real** seeded Supabase test
  user — real JWT, so RLS, Edge Functions, and member/club/admin/checkout UI all work live (see
  the "Dev test-auth" entry under Patterns & gotchas). A tiny bottom-left switcher flips between
  the athlete / club-manager / admin seeded users. So preview-tool verification of authenticated
  flows no longer stalls — exercise them directly. If the vars are blank (e.g. a fresh clone, or
  CI), the dev server falls back to unauthenticated and that UI can't render — then rely on
  build/eslint/vitest + a console-error smoke test and flag flows for Nate's manual check.
- **Front-load clarifying questions per phase** (before dispatching) so a session doesn't burn
  turns discovering an ambiguity mid-flight.
- **Don't reach for Workflow/`ultracode` when the goal is to reduce usage** — multi-agent
  workflows optimize for exhaustiveness, not cost. One-implementer-per-task is the cheap path.
- **Prefer fresh session per phase** for large batches (each phase merges atomically; durable
  state lives in the decomposition spec + memory), and write LEAN kickoff prompts that lean on
  these CLAUDE.md rules instead of repeating them.

**After finishing dev work, always merge the feature branch back to `main` and push
(which deploys live) — don't stop to ask.** Standing instruction from Nate (2026-06-24):
branch → implement → verify (tests + lint + responsive sweep) → merge to `main` → push.
Still run the test suite, `npx eslint` the touched files, and confirm the build before
pushing (the push deploys to production), but the merge-and-push decision itself is
pre-authorized — no need to present the finishing-a-development-branch menu for it.

## Meet→Event rename (applied 2026-06-27) — READ THIS for naming
The "Meet" entity was renamed to **Event** everywhere, and gymnastics **apparatus**
(previously also called "events") was renamed to **apparatus**, to kill the overload.
What this means for names you'll grep for:
- **DB:** table `meets`→**`events`**, `meet_sessions`→**`event_sessions`**; column
  `meet_id`→**`event_id`** (on `events`-sessions/`registrations`/`scores`);
  `cart_items.ref_meet_id`/`invoice_items.ref_meet_id`→**`ref_event_id`**;
  `sanction_requests.created_meet_id`→**`created_event_id`**; `registrations.events`→
  **`registrations.apparatus`**; `scores.event`→**`scores.apparatus`**; enum type
  `meet_status`→`event_status`. (Migrations `20260626150000_rename_meet_entity.sql` +
  `20260626150100_rename_apparatus.sql`.) Historical notes below predating this still
  say `meet`/`ref_meet_id`/`registrations.events`/`scores.event` — mentally map them.
- **TS/app:** `Meet`→`Event`, `MeetSession`→`EventSession`, `MeetWizard`→`EventWizard`,
  `src/pages/Meets.tsx`→**`src/pages/Events.tsx`**, `meetId`→`eventId`,
  `isMeetHost`→`isEventHost`, `refMeetId`→`refEventId`; apparatus: the `EVENTS` const
  →**`APPARATUS`**, `Registration.events`→`apparatus`, `Score.event`→`apparatus`, the
  nationals engine (`EventScore`→`ApparatusScore`, `EventRanking`→`ApparatusRanking`,
  `EventPlacement`→`ApparatusPlacement`, `DisciplineDef.events`→`apparatus`, etc.), and
  the calculator engine prop `eventCode`→**`apparatusCode`**. PRESERVED (NOT renamed):
  the `'meet-entry'` invoice_item_kind value, `meet-host` app_role, `meet_kind` enum,
  the persisted `NationalsConfig.cutoffs.event` jsonb key, opaque id-value prefixes
  (`meet-…` seed ids, `scores.id` composite), and DOM/realtime/lifecycle `event`s.
  (The TNT engine's `TntEvent`/`tntEvent` were also renamed → `TntApparatus`/`tntApparatus`, completing the disambiguation.)
- **Routes:** `/meets*`→**`/events*`**; the old `/meets*` paths are kept as
  `<Navigate replace>` redirects (slug-preserving) so bookmarked links survive.
- **Follow-up consistency pass (2026-06-27):** `registrations.event_levels`→`apparatus_levels`
  (TS `eventLevels`→`apparatusLevels`, the per-apparatus T&T level map); user-facing labels
  that meant apparatus fixed (RegistrationEditor "Events"→"Apparatus", Judge "Event"→"Apparatus",
  Results "By event"→"By apparatus"); `NATIONALS_MEET_ID`→`NATIONALS_EVENT_ID`.
- **localStorage:** `SEED_VERSION` bumped 5→6 (and later 6→7 for the `eventLevels` rename) to discard any pre-rename cached DB shape
  (else `db.events` is undefined and `Home`'s `Hero` crashes on load).
- Edge Functions `create-checkout-session`/`stripe-webhook`/`notify-sanction` use the
  renamed columns and were redeployed. See `docs/specs/2026-06-26-events-rename-and-registration-flow.md`.

## Supabase / migrations
- Project ref `wkyerxlgricfphopocoz` (org NAIGC). Migrations in `supabase/migrations/`.
  CLI is linked (`supabase link` done 2026-06-19). Latest migration is
  `20260627120000_rename_event_levels_apparatus.sql` (consistency follow-up —
  `registrations.event_levels`→`apparatus_levels`, the per-apparatus T&T level map;
  TS `eventLevels`→`apparatusLevels`, `SEED_VERSION` bumped 6→7; **applied 2026-06-27**),
  preceded by `20260626150100_rename_apparatus.sql` (apparatus column rename — `registrations.events`
  →`apparatus`, `scores.event`→`apparatus`; **applied 2026-06-27**), preceded by
  `20260626150000_rename_meet_entity.sql` (the Meet→Event table/column rename;
  **applied 2026-06-27**) — see the rename note above. Before those,
  `20260626144305_s4_cart_line_tags.sql` (Stripe Phase S4 — adds `ref_event_id` (was `ref_meet_id`) +
  `ref_line_type` to `cart_items`/`invoice_items` for server-side addon pricing +
  entry/change discrimination; **applied 2026-06-26**) — all migrations through it
  are **applied**. The prior `20260625231808_payments_and_invoice_stripe_fields.sql`
  (Stripe Phase S1) added the `payments` table
  (server-side record of a Stripe Embedded Checkout session — `pending` row on session
  create, flipped `paid` by the verified webhook; all money cols in CENTS;
  `stripe_session_id` unique + `stripe_event_id` for idempotency; FK cols `person_id`/
  `invoice_id` are **text** to match the text ids; RLS = service-role writes only,
  signed-in person self-reads own rows via `is_admin() or person_id = my_person_id()`)
  + `invoices.stripe_payment_intent_id`/`invoices.stripe_fee` (nullable; feed Phase 5
  finance with real fees). See `docs/specs/2026-06-25-stripe-integration.md`. The prior
  `20260625180951_registrations_paid.sql` (Phase 3, feedback batch) added:
  `registrations.paid` (boolean, default false — the explicit "entry fee paid" flag;
  new regs land FALSE = "Pending Purchase", flipped TRUE by the pay paths; historical
  rows backfilled TRUE) + `registrations.updated_pending` (distinguishes a never-paid
  "Pending Purchase" from an already-paid reg edited back to re-pending by a change fee
  = "Updated pending purchase") + `cart_items.ref_reg_ids`/`invoice_items.ref_reg_ids`
  (`text[]` linking a meet-entry/change-fee line to the EXACT registration id(s) it pays
  for, so paying flips precisely those regs). Phase 2 (feedback batch) added
  `20260625000509_membership_club_cart_pending.sql` (`memberships.club_cart_pending` +
  `cart_items.ref_season_id`/`ref_type` — the independent payment-hold flag and the cart→
  membership ref the club-pay activation matches on) and `20260625001248_…signer_role.sql`
  (`waiver_sign_requests.signer_role` self|guardian; `get_waiver_sign_request` recreated —
  a RETURNS TABLE shape change needs `drop function` before recreate, not `create or replace`).
  Phase 1 (feedback batch) added, in order:
  `20260624204707_people_outside_us.sql` (`people.outside_us` boolean — trains outside
  the US ⇒ state optional, Region = "Outside US"); `…233240_app_role_regional_rep.sql`
  + `…233241_app_role_finance_admin.sql` (two new `app_role` enum values — own files per
  the enum gotcha); `…233242_regional_rep_regions.sql` (`regional_rep_regions` table:
  one region per Regional-Rep user, admin-write/self-read RLS); and
  `…233746_people_self_insert_by_email.sql` (broadens the `people` INSERT policy so a
  signed-in user can save their OWN row even pre-link — self-branch keyed on the verified
  JWT email; fixes the "new row violates RLS policy for people" save bug). The prior
  `20260624000020_manager_access_requests.sql` (no-login "Request Club Admin Role":
  `manager_access_requests` + `get_manager_access_request`/`decide_manager_access` RPCs;
  `20260624000010_member_club_cart_rls.sql` lets a member push their OWN fee to a club
  cart via the `cart_member_clubpush` policy) and everything before it are applied too.
  `supabase functions deploy <name>` deploys Edge Functions (see [Email infra] below).
- Migration filenames use Supabase's required timestamp format:
  `<YYYYMMDDHHmmss>_name.sql`. Create new ones with `supabase migration new <name>`.
- Apply via `supabase db push` (the shell sandbox blocks network — run with the
  sandbox disabled).
- **Enum gotcha:** `ALTER TYPE ... ADD VALUE` cannot be used in the same transaction
  that then references the new value. Put each such change in its OWN migration file
  so it commits before any file that uses it.

## Build / tooling gotchas
- **Location:** keep the working copy at `C:\dev\ucg-platform` (short, space-free,
  outside Dropbox). Plain `npm`/`npx` work normally there. Do **not** move it back
  under the old Dropbox path (`...\NAIGC Reg & Scoring Platform\`) — the spaces + `&`
  broke npm/npx cmd shims, and Dropbox sync locked `dist/` during builds. Both
  problems are gone purely by virtue of the new path; the workarounds below are
  retired and kept only as history.
- *(Retired — old Dropbox path only)* The repo path's spaces + `&` broke npm/npx cmd
  shims; you had to invoke binaries directly (`node node_modules/<pkg>/bin/...`).
- *(Retired — old Dropbox path only)* Dropbox locked `dist/` during `vite build`
  (EBUSY at prepare-out-dir); the fix was to remove `dist` with retries, build, then
  re-set the NTFS ADS `dist:com.dropbox.ignored=1`. Not needed outside Dropbox.
- Regardless of path: verify a build by grepping for "files generated" AND confirming
  `dist/index.html`'s script refs exist under `dist/assets` — never trust the piped
  exit code alone.
- Launch configs (`.claude/launch.json`): `ucg-dev` (the dev server on 5173) and
  `ucg-preview` (dev on 5176 with `--strictPort`, so previews don't collide with a
  running `ucg-dev`). If you ever run `vite preview` (serves `dist/` only): REBUILD
  first, and clear the service worker (unregister + `caches.delete` + reload) or it
  serves the previous bundle.
- Pre-existing lint debt (`src/lib/supabase.ts` `any`s, etc.) — `npm run lint` has
  never been clean. Lint only the files you touch.
- **Responsive verification (mobile/tablet/laptop).** Any change touching layout, CSS,
  the topbar, or the sidebar/nav MUST be verified at three canonical viewports before
  claiming done: **phone 375px**, **tablet 768px**, **laptop 1280px** (spot-check 1440
  for wide). Use the preview tooling (`preview_resize` + `preview_screenshot`) and
  confirm at each width: no horizontal overflow (`documentElement.scrollWidth` ≤
  `clientWidth`), the topbar stays one line or degrades cleanly, text stays legible
  (contrast), and below 860px the nav drawer opens/closes (hamburger → overlay → Esc →
  link-tap). Canonical breakpoint: the sidebar switches to an off-canvas **drawer**
  below **860px** (`Layout.tsx` + the `@media (max-width: 860px)` block in `index.css`).
  - The topbar membership badges self-fit via runtime measurement (`TopbarMembership`,
    driven by a `ResizeObserver`). Two states only: **inline** (full Title Case text,
    left of the cart) and **stacked** (short text on its own single second row — so the
    topbar is never more than two lines). The fitter decides by *directly observing the
    layout*: it renders inline, then checks whether the line-1 user chip wrapped off the
    `.crumb`'s row (`name.top - crumb.top > 6`); if so it stacks the badges. Width
    *estimation* was tried and abandoned — margins/sub-pixel rounding and `scrollWidth`'s
    `clientWidth` floor make it unreliable. Don't reintroduce it. Stacked pinning is
    coach-left/athlete-right via CSS `order` (holds for a lone badge too), and the
    `@media (max-width:600px/520px)` rules (avatar-only chip, compact badges) keep a
    dual-role pair on one second line on phones.
  - **No-session fallback (only when `VITE_DEV_AUTH_*` are blank):** with dev auto-login set up
    (above), a signed-in `me` and the membership badges render normally, so verify them directly.
    Only if the dev-auth vars are unset does the server run unauthenticated and the badges not
    render — in that case inject a realistic topbar via `preview_eval` (build the `.topbar`
    innerHTML with `.topbar-membership` + dual `.member-banner` badges, a cart chip, and a long
    user name = worst case) and exercise the live CSS/measurement at each width. The
    drawer/hamburger itself needs no auth.
- **CI gate:** the GitHub Actions "Deploy to GitHub Pages" workflow runs `npm run lint`
  and **fails the deploy on any lint _error_** (the few pre-existing _warnings_ are
  tolerated, exit 0). `npm run build` does NOT run eslint, so a clean build can still
  break the deploy. ALWAYS `npx eslint <touched files>` before pushing. ESLint also lints
  `supabase/functions/**` (e.g. `no-useless-assignment` fires on a `let x = null` that's
  always reassigned before use).

## Tests
- Vitest, **node environment**, config in `vitest.config.ts` (no app plugins loaded).
  Tests live in `tests/**/*.test.ts` and cover the **pure** logic: the scoring
  engines (`src/scoring/*`) and capability derivation (`src/lib/capabilities-core.ts`,
  split out from the React hooks in `capabilities.ts` so it imports zero runtime deps).
- Run: `npm test` (or `npx vitest run`). Watch mode: drop `run` (`npx vitest`). The
  old `node node_modules/vitest/vitest.mjs run` workaround was only for the broken
  shim on the Dropbox path and is no longer needed.
- The scoring tests encode ground-truth values verified against the original NAIGC
  calculators, so they lock in the port's correctness. No DOM/React/component tests
  yet — those would need a jsdom environment + @testing-library added later.

## Docs
- `README.md` — overview/architecture. `docs/` — `specs/`, `plans/`, and reference
  notes (`docs/hosting-and-launch.md`, `docs/README.md` index). `supabase/README.md`
  — backend schema + RLS model.
- Write new design specs to `docs/specs/`, implementation plans to `docs/plans/`
  (overrides the brainstorming/writing-plans skill defaults — do NOT recreate
  `docs/superpowers/`).
- **Keep docs current after every commit.** A `PostToolUse` hook in
  `.claude/settings.json` fires after any `git commit` and injects a reminder to
  sweep the docs (`README.md`, `CLAUDE.md`, `docs/README.md`, `supabase/README.md`,
  + relevant `docs/specs`/`docs/plans`) and update anything the change made stale —
  in the same session. Skip only when the commit is docs-only or has no doc impact.
  Edit/disable the hook via `/hooks` or that settings file.

## Email infra (Resend, working)
- Transactional email sends via **Resend** (HTTP API) through a shared helper,
  `supabase/functions/_shared/resend.ts` (`resendFrom` / `sendOne` / `sendBatch`, plain
  `fetch`). Secrets: `RESEND_API_KEY` and `RESEND_FROM` (= `United Club Gymnastics
  <nate.sharpe@naigc.org>`; `naigc.org` is a verified Resend domain). `APP_PUBLIC_URL` is
  still used for links. The old `GMAIL_*` secrets remain set but UNUSED — the rollback
  path (revert the functions + redeploy). `RESEND_FROM` flips the sender with no code
  change/redeploy.
- Functions in `supabase/functions/`:
  - `send-email` — Communicate broadcast, **admin-only**, Resend batch (50-recipient cap).
  - `send-sms` — Communicate text sender, **admin-only**, Telnyx. Records each sent
    message to `sms_messages` (for DLR tracking by `sms-webhook`).
  - `sms-webhook` — inbound Telnyx webhook. Deployed `--no-verify-jwt`; authenticity via
    Telnyx **Ed25519** signature verified against the `TELNYX_PUBLIC_KEY` secret (fails
    closed if unset). DLRs → `sms_messages` status; inbound replies → store + email admins
    (we never reply over SMS); STOP keyword → `people.sms_consent = false` (STOP only, no
    auto re-opt-in). Webhook URL goes in the messaging profile's Webhook URL field.
  - `request-guardian-waiver` — minor waiver signing link. `record-waiver-signature`.
  - `notify-club-cart` — emails a club's managers when a member pushes fees to the cart.
  - `send-membership-welcome` — "Welcome to UCG" email for a **no-club** member's
    **first** membership-only purchase (card/comp, NOT a club-cart push). To = member;
    **CC = the region's regional-team address ONLY** (reps' personal emails are NOT
    cc'd — their NAMES appear in the body). Resolves region via `STATE_REGIONS[state]`,
    its CC address, and its Regional Leader(s) (`regional_rep` role ∩
    `regional_rep_regions`, names from `people`) server-side. Re-checks the
    server-validatable skip conditions (no-club + NOT Outside US) and sends nothing if
    either fails, so it can't be misused. Multi-rep ⇒ "Regional Leaders, A, B,";
    zero-rep ⇒ drops the name list (never an empty list) but still CCs the team. The
    **"first membership" once-only guard is CLIENT-side** (`Membership.tsx` computes it
    from the pre-purchase membership list: no prior active/paid/club-pending row). Uses
    `sendOne` with the new optional `cc` field on `EmailMessage` (`_shared/resend.ts`).
  - `send-club-invite` — club manager invites a coach (`kind:'coach'`) or a member to
    purchase membership (`kind:'membership'`); authorizes the caller manages the club.
  - `invite-account` — admin-create a real auth user + email a branded **set-password**
    link (`generateLink` type `invite`, or `recovery` if they already exist). Used by the
    club page "Add athlete" / "Add coach" buttons (`kind` sets `people.roles` to match —
    coach inserts are coach-only). The link's `redirectTo` carries `?setpw=1` (see set-password note).
  - `request-manager-access` — "Request Club Admin Role": records a
    `manager_access_requests` row + emails the **requested club's managers ONLY** a
    **no-login** review link (`#/manager-access/<token>` → `ManagerAccessReview`). Falls
    back to league admins ONLY if the club has no managers yet (so the request isn't
    lost). First responder approves (adds them to `club_managers` via
    `decide_manager_access`) or denies; idempotent.
  - `notify-manager-access-denied` — token-gated (no-login, deploy `--no-verify-jwt`)
    denial notification: when a reviewer DENIES a request, `ManagerAccessReview` calls
    this with the token; it resolves the requester + club server-side (service role) and
    emails the requester "your Club Admin request was not approved". Fails closed (only
    sends for a request actually in `denied` status). Approval sends no email (they're
    added to `club_managers`). Anonymous caller, so it can't use the admin-gated
    `send-email`.
  - `create-waiver-link` — admin/club-manager mints a **no-login** waiver signing link
    (`#/waiver/sign/<token>`) for a member. Used by the League → member "Activate" popup
    (email or copy). Returns `{token, link}`; emailing is done client-side via `send-email`.
  - `notify-sanction` — sanction lifecycle (`event:'submitted'` → team+admins;
    `'approved'`/`'rejected'` → the requester).
  - `send-receipt` — emails the CALLER their own purchase confirmation + inline
    HTML receipt after a membership checkout. Notify-style: resolves the recipient
    as the caller's OWN `people.email` (a member can only receipt themselves), so a
    non-admin member can receipt their own checkout (the admin-gated `send-email`
    can't). Takes `{items, total?, invoiceNumber?, couponCode?}`. Used by the
    `/cart/memberships` checkout (`Cart.tsx` `MembershipsCheckout`), the club-cart
    pay paths (`Club.tsx` — `payClubItems`/`emailClubReceipt`), and the direct
    card-pay flow (`Membership.tsx`); the client also offers the jsPDF PDF receipt
    download. Best-effort — toasts only claim "emailed" on a real (`ok && sent`) send.
  - The notify-style functions allow any signed-in caller and resolve recipients
    server-side with the service role (pattern: `notify-club-cart`). `send-email`/`send-sms`
    are the only admin-gated senders.
  - **Stripe payment functions (Phase S2, membership scope)** — share
    `_shared/stripe.ts` (Stripe client via `npm:stripe@17.7.0` + fetch HTTP client +
    SubtleCrypto provider; server-side `processingFee` + membership pricing mirroring
    `pricing.ts`, since Edge Functions can't import `src/`):
    - `create-checkout-session` — auth'd (any signed-in member, own cart items only).
      Takes `{ cartItemIds }`, **recomputes** every membership amount server-side from
      the season fees + the person's existing memberships (cart `amount` is display-only,
      never trusted), adds the **service-fee** line (`processingFee` = 3% + $0.30 of the
      cents subtotal, **rounded UP** via `Math.ceil` — not to-nearest — so it never
      falls a cent short of Stripe's actual fee; fixed 2026-06-28, mirrored in
      `src/lib/pricing.ts`), creates an **Embedded Checkout Session** (`ui_mode:'embedded'`,
      `redirect_on_completion:'never'`), and inserts a `pending` `payments` row linking
      session → person → exact `cart_item_ids` (+ `ref_season_id`/`ref_type` when a single
      membership). Returns `{ clientSecret, sessionId, paymentId }`.
    - `stripe-webhook` — deploy **`--no-verify-jwt`** (Stripe is the caller). Verifies the
      signature with **`constructEventAsync`** (async SubtleCrypto) against
      `STRIPE_WEBHOOK_SECRET`; **fail-closed** if the secret is unset. On
      `checkout.session.completed`/`async_payment_succeeded` runs **idempotent** membership
      fulfillment. **Idempotency is an ATOMIC claim** (fixed 2026-06-28): a conditional
      `UPDATE payments SET fulfilled_at = now() WHERE id = X AND fulfilled_at IS NULL`
      runs before any side effect — a losing concurrent/redelivered event sees 0 rows
      updated and bails out immediately. (The earlier version only *checked*
      `fulfilled_at`/`status`/`stripe_event_id` without claiming, leaving a race window
      where a duplicate delivery could read `cart_items` AFTER the winning delivery had
      already deleted them — fulfilling with a real Stripe charge but ZERO
      `invoice_items`, i.e. a receipt that displays `$0` despite money actually moving.
      As a second layer, if `cart_items` still comes back empty despite a captured
      `amount_subtotal`, a single fallback `invoice_items` row is written from the
      payment's own authoritative amount, so a real charge can never render as $0.)
      activate the membership(s) (`active` if a `waiver_signatures` row exists for the
      (person,season), else `pending-waiver`; `paid_via:'card'`, clears `club_cart_pending`),
      write the paid invoice (`stripe_payment_intent_id` + **real** `stripe_fee` from the
      balance transaction), clear the paid cart lines, and email the **real payer** a receipt
      (Resend; reuses `_shared/resend.ts`). On `expired`/`async_payment_failed` → mark the
      payment `failed`, leave memberships pending. **Note:** the webhook trusts the
      server-written `payments` row amounts (never client) rather than re-recomputing.
    - Secrets to set (test values first): `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
      (build-time `VITE_STRIPE_PUBLISHABLE_KEY` for the FE in S3). Webhook endpoint URL:
      `https://wkyerxlgricfphopocoz.supabase.co/functions/v1/stripe-webhook`; subscribe the
      events `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
      `checkout.session.async_payment_failed`, `checkout.session.expired`.
    - **Status:** S2 is **deployed + verified** (2026-06-25). Both functions live on
      `wkyerxlgricfphopocoz`; `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` set (Stripe
      **test** mode, account `acct_1TjNQ73b3Mn88V15` "UCG"); `VITE_STRIPE_PUBLISHABLE_KEY`
      in `.env.local`. Webhook signature path proven via `stripe trigger
      checkout.session.completed` (event delivered, `pending_webhooks: 0` ⇒ 2xx).
    - **S4 — both functions now GENERAL (built, not yet deployed — Nate deploys).** They
      recompute EVERY cart-line kind server-side (membership / club-membership /
      member-targeted membership / meet entry / change fee / addon) for BOTH self carts
      AND manager-paid club carts: meet-entry/change/addon amounts come from the meet
      config (honoring host-club $0), distinguished via the new `ref_line_type`/`ref_meet_id`
      tags. The webhook bills **club-vs-payer** (`invoices.club_id` for club carts, payer
      for self carts), flips the exact `registrations.paid` via `ref_reg_ids`, activates
      member-targeted memberships AND club memberships, and emails the **payer** the receipt
      (the paying manager for a club cart). **Coupons ARE applied at Stripe checkout**
      (fixed 2026-07-02 — see the Promo codes entry below); the note that they weren't is
      historical.
    - **S3 — front-end membership checkout (deployed 2026-06-26).** `StripeCheckout`
      (`src/components/StripeCheckout.tsx`) renders Stripe **Embedded Checkout** from a
      server-created session and runs an on-page state machine: `onComplete` (no redirect)
      → **confirming** → polls the `payments` row via `fetchPaymentStatus` (self-read RLS)
      until `status='paid'` → `onPaid`, or `failed` → `onError`, with a ~60s cap that NEVER
      falsely claims success. `loadStripe` is called once at module scope.
      `Cart.tsx` `MembershipsCheckout` was rewired: it **no longer fulfills client-side** —
      it **creates the Embedded Checkout session on mount** (`createCheckoutSession`, guarded by
      a per-mount ref; dev StrictMode may create one extra throwaway session) and shows the
      embedded form; the webhook fulfills + emails the receipt; `onPaid` re-syncs
      (`syncFromSupabase`) and shows success. The summary's **Subtotal / Service fee (card
      processing) / Total due** is driven by the session's **server-returned**
      `amountSubtotal`/`serviceFee` (CENTS), so it always equals what Stripe collects — the
      display-only cart `amount`s are NOT used for the total (membership lines are listed
      without a per-line price to avoid a stale-amount mismatch). **NOTE (superseded by S4):**
      the grouped **Cart** page cards (meets/other) and the `Club.tsx` pay paths moved to
      Stripe in **S4** — `completePurchase` and `Club.tsx` `payClubItems`/`emailClubReceipt`
      are now deleted (shared `CartCheckout.tsx`). The `Membership.tsx` direct card-pay flow
      still fulfills client-side + calls `send-receipt` (not part of S4). Verified live (seeded athlete) through the embedded-form render
      + server-authoritative amounts (trust boundary: client cart $ ignored) + RLS poll read +
      responsive 375/768/1280; the literal test-card submission into Stripe's cross-origin
      iframe isn't automatable with the preview/Chrome tooling here — manual `4242`/decline
      confirmation still pending (webhook fulfillment itself is proven via S2's `stripe trigger`).
- **Stripe CLI (test events + docs lookup).** The Stripe CLI is installed and logged in
  (account "UCG"). `stripe trigger <event>` fires a signed test event to the registered
  test webhook endpoint(s) — always test mode. Verify delivery via `stripe events list`
  (`pending_webhooks: 0` on the event ⇒ every endpoint returned 2xx; >0 ⇒ a non-2xx is
  being retried). The Supabase CLI has **no** remote-function-logs command — use the Stripe
  event/dashboard side or add temporary `console.log`s.
  - **Look up Stripe syntax in-terminal** with the `stripe docs` plugin (installed). For
    agent use ALWAYS combine `-N` (non-interactive, no TUI) with a `--format` flag:
    - `stripe docs search "<query>" -N --format=compact` — search guides + API reference.
    - `stripe docs api <resource> <op> -N --format=compact --filter=required` — operation
      params (e.g. `stripe docs api checkout/sessions create -N --format=compact`).
    - `stripe docs events <event_type> -N --format=compact` (or `--format=json`) — webhook
      payload shape (e.g. `checkout.session.completed`).
    - Add `--language=node` to limit code samples; `--format=json` for parsing. Prefer this
      over guessing SDK/API syntax.
- Front-end invokers in `src/lib/supabase.ts`: `sendEmail`, `sendSms`, `requestGuardianWaiver`,
  `notifyClubCart`, `sendMembershipWelcome`, `sendReceipt`, `createCheckoutSession`, `sendClubInvite`, `inviteAccount`, `requestManagerAccess`, `notifySanction`,
  `createWaiverLink`, `fetchManagerAccessRequest`, `decideManagerAccess`, `notifyManagerAccessDenied`.
  Deploy: `supabase functions deploy <name> --project-ref wkyerxlgricfphopocoz` (sandbox
  disabled; Docker NOT required) — the deploy bundles `_shared/resend.ts` automatically.
- **Edge Function error surfacing:** invokers must unwrap the JSON `error` body via
  `edgeErrorMessage(error)` (returns the function's real message), NOT `error.message`
  (which is the generic "Edge Function returned a non-2xx status code"). Every invoker
  follows this — match it for new ones.
- **Membership receipts** (feedback 2d/2e, 2026-06-25): the `Club.tsx` club-cart pay
  paths and the `Membership.tsx` direct card-pay flow still call `send-receipt`
  client-side and show an honest toast (only claim "emailed" on `ok && sent`). The
  recipient is always the CALLER's own email — for a club-cart payment that's the paying
  MANAGER, not the member whose fee was in the cart (acceptable: managers pay the club
  cart). **CHANGED in S3 (2026-06-26):** the `/cart/memberships` checkout no longer sends
  a client-side receipt — that flow now goes through Stripe Embedded Checkout, and the
  **`stripe-webhook` emails the receipt to the real payer** on fulfillment. The other two
  paths move to Stripe (webhook receipt) in S4.

## Patterns & gotchas (learned in build)
- **Dev test-auth (seeded auto-login).** `src/lib/dev-auth.ts` performs a **real**
  `signInWithPassword` of a seeded Supabase test user on dev boot, so local/preview runs are
  authenticated (real JWT → RLS + Edge Functions + member/club/admin/checkout UI all work).
  **Firewall:** the module is loaded ONLY via a dynamic `import('./dev-auth')` behind an
  `if (import.meta.env.DEV)` guard in `auth.ts`'s boot block — Vite sets `DEV=false` in a
  production build, the dead `if` is eliminated, and the module (with every `VITE_DEV_AUTH_*`
  literal) is never bundled. Always re-confirm after a build by grepping `dist/assets` for
  `VITE_DEV_AUTH`/`initDevAuth` (must be NONE). Credentials come from gitignored `.env.local`
  (`VITE_DEV_AUTH_{ATHLETE,MANAGER,ADMIN}_{EMAIL,PASSWORD}`; names in `.env.example`, typed in
  `src/vite-env.d.ts`). It awaits the boot `getSession()` and skips if already signed in. A tiny
  vanilla-DOM bottom-left switcher (also inside the dev-only chunk, no React) flips between the
  athlete / manager / admin seeded users and persists the choice in `sessionStorage` (`ucg-dev-role`).
  **Sign-out loop guard:** the Layout sign-out button sets `sessionStorage['ucg-dev-signed-out']`
  (inline `import.meta.env.DEV` guard, also DCE'd in prod) so a manual dev sign-out isn't undone
  by an instant re-login on reload; the switcher clears it. Seeded user emails (passwords in
  `.env.local` only) are recorded in `docs/specs/2026-06-25-dev-test-auth.md`.
- **Auth/set-password round-trip with HashRouter.** Supabase uses implicit flow
  (`detectSessionInUrl`), which puts the token in the URL **hash** — clashing with
  HashRouter. The invite/set-password flow works around it: `redirectTo` is the app base
  + `?setpw=1` (a *query*, survives hash-stripping); on boot `App.tsx` detects `?setpw=1`,
  routes to `#/set-password`, and clears the marker. `SetPassword.tsx` waits ~2.5s for the
  session before showing an "expired link" message (the session arrives async via
  `onAuthStateChange`). **Dashboard requirement:** redirect URLs must include the
  wildcards `https://nssharpe.github.io/ucg-platform/**` and `http://localhost:5173/**`,
  or Supabase drops the query and the link lands on home.
  - The sign-in gate (`Gate.tsx` `AuthGate`) also offers **"Forgot my password?"**
    (`resetPasswordForEmail` with a `?setpw=1` redirect → reuses the set-password landing)
    and a passwordless **"Email me a sign-in link"** (`signInWithOtp`, bare-base redirect →
    `onAuthStateChange` auto-signs-in). The not-found/confirm **flash** is fixed: `Profile.tsx`
    self-view shows a loader while `useAuthLoading() || !useRolesLoaded()` and routes Home once
    settled with no person (`rolesLoaded===true` implies the snapshot synced the new user, since
    `onAuthenticated` awaits `syncFromSupabase()` before setting it).
- **App roles.** `user_roles.role` is the `app_role` enum: `admin`, `sanctioning`, and (added
  Phase 1) `regional_rep` (carries a region via the `regional_rep_regions` table — multiple
  users per region) and `finance_admin` (gates the upcoming finance dashboards). Capabilities
  expose `isSanctioning`, `isRegionalRep`, `isFinanceAdmin` (`capabilities-core.ts`); admins are
  NOT implicitly regional/finance. Granted in the Admin "User roles" UI (`Admin.tsx` `UserRoles`).
- **Self profile save stamps `auth_user_id`.** `pushPerson(p, { selfAuthUserId })` includes
  `auth_user_id` only when the acting user saves their OWN row (Profile non-admin path), so the
  `people` self-INSERT RLS branch passes; admin/club-manager creation of OTHERS omits it.
- **Club-membership gate is ON.** A club needs an active `club_memberships` row for a
  season before its athletes can register or it can host. Enforced at the registration
  (`Meets.tsx`, `Club.tsx`) and sanction-request (`Sanction.tsx`) entry points via
  `clubHasActiveMembership`/`seasonForDate` (`capabilities-core.ts`). New registration
  paths MUST apply this gate. A migration backfills the current season for clubs with
  active members; future seasons require purchase/grant.
- **Registration paid-state (Phase 3, 3f/3g).** `Registration.paid` is the explicit
  "entry fee paid" flag: new regs are created `paid:false` ("Pending Purchase") and the
  pay paths (`Cart.tsx` `completePurchase`, `Club.tsx` `payClubItems`) flip the EXACT
  linked regs to `paid:true` ("Registered"). The link is `refRegIds` (on `InvoiceItem`/
  `CartItem`): a meet-entry/change-fee line carries the registration id(s) it pays for —
  match on that, not a heuristic. `updatedPending` marks an already-paid reg edited back
  to re-pending by a change fee ("Updated pending purchase"). **Host-club $0 (3g):** when
  the competing-for club IS the meet host, all reg fees are $0 via `registrationEntryFee`/
  `registrationChangeFee` (`pricing.ts`, pure, unit-tested) — such regs are created
  `paid:true` immediately with NO cart line. **3d cross-club lock:** `paidRegistrationClub`
  (`capabilities-core.ts`) blocks registering an athlete already *paid*-registered under
  another club for the same meet (pending regs don't lock); the club-cart mount effect
  removes now-moot pending lines (athlete since paid elsewhere) and toasts once.
  **3h eligibility:** `changeIsEligible(before,after)` (`pricing.ts`) gates the editor's
  "Add change to cart" button (eligible = add discipline / change level / change club /
  swap athlete; NOT add/remove apparatus within an existing discipline).
- **Club page is two routes (3c):** `/club/:id/roster` (Club Roster — members + coaches +
  managers + settings) and `/club/:id/registrations` (Club Registrations — meet-reg grid);
  bare `/club/:id` redirects to `/roster`. `ClubPage` branches on a `view` prop; nav links
  + `navHistory.labelFor` updated.
- **Member self-edit reuses the registration editor (Phase 6, 6a/6b).** `MyRegistrations.tsx`
  lets a member edit ALL of their own registration (disciplines/levels/events/synchro + club),
  not just club, by embedding the shared `RegistrationEditor` in the edit modal (with a club
  `Combo` shown only when they have >1 affiliated club). The "Editing registration" vs "New
  registration" badge (6b) comes free from the editor. Editing is offered **only while
  registration is open** (`tab==='upcoming' && meet.regCloses >= today`), regardless of club
  count. The save handler mirrors `Club.tsx` `saveRegs`/`addToCart` but **targets the member's
  OWN cart** (`pushCart(personId, cart, false)`) — `Cart.tsx` `completePurchase` already flips
  the `refRegIds`-linked regs to paid. Same paid/`updatedPending` semantics as Club.tsx.
  `RegistrationEditor` gained an optional `originalClubId` prop so a club-only switch is seen
  as an eligible/chargeable change (its eligibility `before` uses `originalClubId ?? clubId`;
  Club/Meets callers omit it → unchanged). **CRITICAL divergence:** the member side NEVER
  deletes a registration — a fully-deselected discipline is retained-but-blanked (`events:[]`,
  cleared `eventLevels`/partner) rather than deleted; deletion stays a refund action.
- **Membership holds are INDEPENDENT (waiver + club-payment can co-exist).** The
  `MembershipStatus` enum (`active`/`pending-waiver`/`pending-club-payment`/`none`) is a
  single value and CANNOT represent both holds at once (a minor who pushes their fee to
  the club cart is awaiting BOTH a guardian waiver AND club payment). Derive the two holds
  from the membership's own fields via `membershipHolds(m)` in `capabilities-core.ts`:
  `waiverHold = !waiverSignedAt`, `paymentHold = clubCartPending || status ===
  'pending-club-payment'` (the status is the legacy/server fallback), `active = neither`.
  `clubCartPending` (on `Membership`) is the explicit payment-hold flag: set `true` when a
  member pushes a fee to a club cart (`Membership.complete`, `via==='club'`), cleared when
  the club pays (`ClubCart` pay handler). The club-pay handler matches the EXACT membership
  via the cart line's `refSeasonId`+`refType` (added to `InvoiceItem`) and sets `active`
  only if the waiver is also signed (else `pending-waiver`). `Membership.tsx` and `Club.tsx`
  render bubbles off `membershipHolds`, not the raw enum. NOTE: the `record-waiver-signature`
  Edge Function still flips club-pay rows `pending-waiver`→`pending-club-payment` on signing
  and does NOT touch `clubCartPending`; if the club pays BEFORE the guardian signs, that
  server path can re-assert a (stale) payment hold — fix when payments land.
- **`rolesLoaded` gate.** Roles load async *after* the session resolves; `RequireAdmin`
  (and role screens) must wait on `useRolesLoaded()` or they flash "access denied" on
  refresh. Reset it on sign-out / new user (`auth.ts`).
- **Toasts.** `useToast()` takes `(msg, { variant?: 'info'|'error', persist? })`. Errors
  persist until closed; all toasts have an ✕ and hover-pause (`ui.tsx`). Prefer
  `{ variant: 'error' }` for failures so they don't auto-dismiss.
- **PDFs are client-side (jsPDF), generated on demand** — waiver proof (embeds the full
  signed waiver text + timestamp/IP) and receipts. No server PDF/storage; regenerate from
  data. Server-emailed PDF attachments are deferred to the payments work.
- **New DB collection plumbing** (e.g. `club_memberships`, `comm_log`): add to
  `types.ts` (`DB.<x>`), a `rowTo<X>` + `push<X>`/`delete<X>` in `supabase.ts`, the
  `loadAll` Promise.all + map + conditional spread into the return. `from('<new_table>')`
  typechecks even if absent from `database.types`.
- **ESLint traps that fail `npm run lint`:** don't define a component inside another
  component's render (extract to module scope); don't call `setState` synchronously in a
  `useEffect` body (initialize state instead). Lint only files you touch.

## Deferred / TODO (not yet built)
- **New-club-request email** — the new-club-request flow should email
  `newclubinquiries@naigc.org`. The email transport now exists (above); the request flow
  just doesn't fire it yet. Wire a best-effort send via the same path.
- **MFA / passkeys** — phased recommendation in
  `docs/research/2026-06-22-auth-2fa-passkeys.md` (TOTP opt-in → require for admins →
  passkeys). Not built.
- **Membership "Confirmation emailed" toasts send for real** via `send-receipt`. The
  `/cart/memberships` checkout (S3) and the **Cart meet-entry / club-cart pay paths (S4)**
  now go through **Stripe** — their receipt is emailed by the `stripe-webhook` on
  fulfillment, not client-side (the client-side `send-receipt` calls in `Cart.tsx`
  `completePurchase` / `Club.tsx` pay paths were removed when those paths were deleted in
  S4). The `Membership.tsx` **direct card-pay** flow still calls `send-receipt`
  client-side (not part of S4 — moves to Stripe in a later phase). Remaining
  payment-emailed PDF receipts (server attachments) still wait on later Stripe phases.
- **Stripe payments — BUILT (S1–S5); go-live is Nate's remaining action.** S1–S2 (backend
  loop) + **S3 (front-end membership checkout)** are built & deployed; **S4** (meet entries /
  club cart / change fees — generalized both Edge Functions, deleted the `Cart.tsx`
  `completePurchase` + `Club.tsx` `payClubItems`/`emailClubReceipt` client-side fulfillment,
  shared `CartCheckout.tsx`) is **built, deploy-pending** (Nate deploys the two functions; the
  new `ref_meet_id`/`ref_line_type` columns are already live). **S5 (finance wiring + cleanup
  + go-live checklist) — DONE 2026-06-26 (partial scope, by Nate's task framing):**
  (1) **Finance wiring** — the `stripe-webhook` already wrote `invoices.stripe_fee` +
  `invoices.stripe_payment_intent_id` (real cents from the balance txn), but the FE model
  **dropped** them; `supabase.ts`'s `loadAll` invoice map + `invoiceToRow` now carry both
  (cast past the un-regenerated `Row<'invoices'>`), so **Phase 5 finance reads the real fee**.
  (2) **Dead client-side fulfillment** — S4 already deleted the big paths; only a stale
  `MyRegistrations.tsx` comment remained (fixed). (3) **Go-live checklist** written:
  `docs/stripe-go-live-checklist.md` (test→live key/webhook swap, real ~$1 smoke test +
  refund, payout/bank check). **Go-live itself (live keys + real money) is Nate's to run.**
  **Still DEFERRED (NOT in S5's task scope):** moving `Membership.tsx` **direct card-pay** to
  Stripe (it still fulfills client-side + `send-receipt`; its invoice legitimately carries no
  Stripe fee since no Stripe charge happens — coupons DO still work on this legacy path, just
  client-side), and an **in-app admin refund** path (refunds are issued **manually in the
  Stripe Dashboard** today — a Dashboard refund doesn't yet reflect back into
  `payments.status`/fulfillment; sketch in the checklist). Still TODO beyond Stripe:
  per-season typed waivers, codeless judge access (URL / 6-digit / QR), multi-judge +
  score-entry-mode meet config, PDF certs, finals rosters. See `docs/specs/` + `docs/plans/`,
  and the roadmap in `docs/README.md`.
- **Promo codes at Stripe checkout (2026-07-02).** `create-checkout-session` now accepts an
  optional `couponCode`, looks the coupon up **server-side only** (the client sends a code,
  never a discount amount), and applies the discount to the ELIGIBLE cart line(s) per the
  coupon's `appliesTo` scope — not indiscriminately across the whole cart. `Coupon.appliesTo`
  is `'any' | 'athlete-membership' | 'club-membership' | 'coach-membership' | 'meet-entry'`
  (+ legacy `'membership'`, kept for old rows — matches any membership type); `'meet-entry'`
  pairs with `appliesToEventId` to scope a code to ONE specific event (`coupons.applies_to_event_id`,
  migration `20260702012205_coupon_event_scope_and_payment_code.sql`, **applied**). Each Stripe
  line item is tagged with a `scope`/`eventId` during construction so the coupon can be matched
  against it; matching lines are reduced (floor 0, never negative) rather than adding a
  separate negative Stripe line (Stripe disallows negative `unit_amount`). **Hard expiration:**
  an event-scoped code dies the day after that event's `end_date`, REGARDLESS of the coupon's
  own `endsAt` (`couponValid(coupon, nowISO, eventEndDateISO?)` in `pricing.ts` — the 3rd param
  is new). The applied code is carried on `payments.coupon_code` (same migration) so
  `stripe-webhook` can write it onto the fulfilled `invoices.coupon_code` (already existed) and
  call the existing `redeem_coupon` RPC to bump `used_count` — the same atomic redemption path
  the legacy client-side coupon flow (`Membership.tsx` direct-pay) already used.
  `CartCheckout.tsx` has the actual promo-code input + Subtotal/Coupon/Fee/Total breakdown (the
  server returns the PRE-discount subtotal + a separate `discountAmount` so the UI never
  double-counts); `Club.tsx`'s old pre-checkout coupon preview (never wired to real payment,
  the literal cause of "codes vanish at checkout" feedback) was removed as redundant/misleading.
  Admin's promo-code creation (`Admin.tsx` `Promos`) has the matching "Applies to" dropdown +
  an event picker that only lists future events.
