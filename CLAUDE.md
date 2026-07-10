# UCG Registration & Scoring Platform

React + TypeScript + Vite. Live: https://nssharpe.github.io/ucg-platform/
Supabase backend (env-gated). Deploys via GitHub Actions on push to `main`.

**Keep this file lean.** It's loaded into every session AND every subagent.
Operative rules only — feature history/narratives go in `docs/specs/`, `docs/plans/`,
and git history (full pre-trim version: `docs/archive/CLAUDE-md-as-of-2026-07-02.md`).
When the post-commit doc sweep touches this file, UPDATE-in-place or move detail out;
never append changelog paragraphs.

## Working style (Nate = PM, not hands-on)
Do as much as possible directly. When a step is blocked only on a one-time setup or a
permission grant, ask for *just that unblock*, then execute the step yourself. Nate has
standing authorization to run `supabase db push` / apply migrations / deploy functions /
edit `.env.local` (granted 2026-06-18). Still confirm genuinely destructive prod actions
and show what will apply first.

When executing a written implementation plan, **default to subagent-driven execution**
(`superpowers:subagent-driven-development` — fresh subagent per task + review between
tasks). Don't ask which execution mode to use (decided 2026-06-24).

**After finishing dev work, always merge the feature branch back to `main` and push
(which deploys live) — don't stop to ask** (standing instruction, 2026-06-24):
branch → implement → verify (tests + lint + responsive sweep) → merge → push.
Run the suite, `npx eslint` the touched files, and confirm the build before pushing.

### Context/usage-optimized execution (standing rules)
- **Keep the controller out of the editor.** Delegate reading/editing to subagents;
  the controller reads only what it needs to write a precise brief.
- **One implementer subagent per task/cohesive group; never run implementers in
  parallel** (working-tree conflicts). Read-only reviewers MAY run in parallel.
- **Dispatch straight from the spec** — skip redundant per-phase plan docs.
- **Review subagent reports inline**; don't spin up separate reviewer subagents for
  routine work.
- **Subagents MUST verify with `npm run build`, not `tsc --noEmit`** (`tsc -b` catches
  errors `--noEmit` misses — caused real rework). Require `npm run build` +
  `npx eslint <touched files, incl. supabase/functions/**>` + `npx vitest run`
  (+ a vitest test for any new PURE logic) before commit.
- **Controller owns side-effects, batched at phase end:** one `supabase db push` for a
  phase's migrations (sandbox disabled) + one loop deploying touched edge functions.
  Subagents write migrations/edge-fn code but never push/deploy.
- **Front-load clarifying questions per phase**; prefer a fresh session per phase with a
  LEAN kickoff prompt that leans on these rules instead of repeating them.
- **Don't reach for Workflow/`ultracode` to save usage** — one implementer per task is
  the cheap path.

### Model routing (adopted 2026-07-02 — adjust from the log)
- **haiku:** mechanical work with an explicit verify checklist — renames, the DB-plumbing
  recipe, doc sweeps, comment/label fixes.
- **sonnet (default implementer):** well-specified feature tasks, UI work, test writing.
- **opus/fable-tier:** design/decomposition, review of anything touching money/auth/RLS,
  migrations design, debugging weird failures. Effort: low for mechanical, default
  otherwise, high only for review/debug/design.
- **Money/auth/RLS/cart implementation → sonnet DRAFTS, controller ALWAYS fable-reviews
  the diff before merge/push/apply** (learned 2026-07-02 across 2 tasks). Sonnet is
  reliably good at the mechanical fix + enumeration + tests, but missed a real defect
  each time on the money-invariant: a 2-step trigger-staging bypass, a PUBLIC-grant
  no-op, a free-membership "clear the hold", an over-charge edge. The adversarial
  invariant read is not delegable; budget for it.
- After each routed task, append a row to `docs/model-routing-log.md` (task type, model,
  first-try outcome, tokens if known). Periodically distill the log back into these rules.
- `node scripts/usage-report.mjs [--days N] [--json]` reports this project's per-session
  token use by model from local transcripts. Remaining plan quota is NOT visible locally —
  only `/usage` in the app shows it.

## Brand (2026 toolkit, applied 2026-07-08)
Authoritative rules + palette + approved fg/bg pairings: `docs/specs/2026-07-08-ucg-rebrand.md`.
Operative bits: exact hexes live as tokens in `src/index.css` (pale accents `--bluegreen`/
`--purple`/`--gold` are FILLS ONLY, never text on light); display type = Greed Condensed
Bold ALL CAPS, body = Suisse Intl. **Licensed woff2 files are served from the public
`brand` Supabase Storage bucket (prod) and must NEVER be committed to this public repo**
(EULA — web serving OK, repo redistribution not); @fontsource Archivo Black/Instrument
Sans stay installed as fallbacks. Logos/discipline icons: `src/assets/brand/`
(`DisciplineIcon.tsx` maps MAG/WAG/TNT). Toolkit source:
`C:\Users\nssha\Steinsharpe Dropbox\...\2026 UCG Brand Toolkit` (fonts, PDFs, photography).

## Naming: the Meet→Event rename (2026-06-27)
"Meet" → **Event** everywhere, and gymnastics apparatus (previously also "events") →
**apparatus**. When grepping or writing code:
- **DB:** `events`, `event_sessions`, `event_id`, `ref_event_id`, `created_event_id`,
  `registrations.apparatus` (+ `apparatus_levels`), `scores.apparatus`, enum `event_status`.
- **TS:** `Event`, `EventSession`, `EventWizard`, `src/pages/Events.tsx`, `eventId`,
  `isEventHost`, `refEventId`; `APPARATUS` const, `Registration.apparatus`/
  `apparatusLevels`, `Score.apparatus`, nationals engine `Apparatus*` types,
  calculator prop `apparatusCode`, TNT `TntApparatus`.
- **PRESERVED (not renamed):** `'meet-entry'` invoice_item_kind, `meet-host` app_role,
  `meet_kind` enum, persisted `NationalsConfig.cutoffs.event` jsonb key, opaque id-value
  prefixes (`meet-…` seed ids, `scores.id` composite), DOM/realtime `event`s.
- **Routes:** `/meets*` → `/events*` with slug-preserving `<Navigate replace>` redirects
  (the standard idiom for retired routes — `/club/:id/cart` → `/cart` uses it too).
- Older docs/specs predate the rename — mentally map `meet`/`ref_meet_id`/etc.
  Details: `docs/specs/2026-06-26-events-rename-and-registration-flow.md`.

## Supabase / migrations
- Project ref `wkyerxlgricfphopocoz` (org NAIGC); CLI linked. Migrations in
  `supabase/migrations/` — **the authoritative migration list + per-migration narrative +
  schema/RLS model is `supabase/README.md`**; keep its table updated with every migration
  (detail goes THERE, not here). All migrations through
  `20260710024630_addon_unit_fields.sql` are applied. Security hardening:
  Phase 1+2 applied; Phase 3 TODO (`docs/plans/2026-07-02-security-hardening.md`).
- New migrations: `supabase migration new <name>` (timestamp filename format is required).
  Apply via `supabase db push` — network is sandbox-blocked, run with sandbox disabled.
- **Staging project `xogpiksqtkayxwmczlbx`** (`ucg-staging`, since 2026-07-04): the CLI
  stays linked to PROD — target staging explicitly via `--project-ref`/`--db-url`
  (creds under `STAGING_*` in `.env.local`; full runbook in `supabase/README.md`).
  Apply new migrations to staging FIRST, then prod.
- **Enum gotcha:** `ALTER TYPE ... ADD VALUE` can't be referenced in the same
  transaction — put each enum addition in its OWN migration file.
- Ids are app-generated **text**, not uuids (incl. FK cols like `payments.person_id`).
- **Upsert-trigger trap:** the app writes whole-row upserts (`INSERT ... ON CONFLICT DO
  UPDATE`), so BEFORE INSERT triggers fire with `tg_op='INSERT'`/`OLD=NULL` even when the
  row exists — guard triggers must re-SELECT the pre-write row by `id`, never trust
  `tg_op`/`OLD` (bit us live: `20260703034325`).
- **RLS upsert trap:** an upsert must pass an INSERT policy's WITH CHECK even on the
  conflict-update path — a manager-editable table needs BOTH insert+update policies.
  Prefer separate insert/update policies over `for all` (which silently grants DELETE).
- **RLS self-reference trap:** never client-side delete-then-insert rows the caller's
  own permission derives from (e.g. `club_managers`) — the delete revokes the actor's
  right to re-insert. Use a security-definer RPC that authorizes ONCE up front
  (`replace_club_managers` is the pattern; write-queue op kind `'rpc'`).
- **Fail-closed SQL:** in SECURITY DEFINER functions, wrap auth predicates in
  `coalesce(..., false)` — for an anon caller an OR-chain over NULL evaluates to NULL
  and `if not NULL` does NOT raise (bit us: `20260704133502`). Also revoke the default
  PUBLIC execute grant on new functions.

## Build / tooling gotchas
- Keep the working copy at `C:\dev\ucg-platform` (short, space-free, outside Dropbox —
  the old Dropbox path broke npm shims and locked `dist/`; never move it back).
- Verify a build by grepping for "files generated" AND confirming `dist/index.html`'s
  script refs exist under `dist/assets` — never trust the piped exit code alone.
- Launch configs (`.claude/launch.json`): `ucg-dev` (5173), `ucg-preview` (5176,
  `--strictPort`), `ucg-staging` (5177, `--mode staging` → the staging Supabase
  project via `.env.staging.local`). If you run `vite preview` (serves `dist/`):
  rebuild first and clear the service worker or it serves the previous bundle.
- `npm run lint` is fully clean project-wide as of 2026-07-03 (the last 3 warnings were
  fixed then) — keep it that way; still lint touched files before pushing rather than
  relying on this staying true implicitly.
- **CI gate:** the deploy workflow runs `npm run lint` and fails on any lint **error**
  (existing warnings tolerated). `npm run build` does NOT run eslint — a clean build can
  still break the deploy. ALWAYS `npx eslint <touched files>` before pushing. ESLint also
  covers `supabase/functions/**`.
- **ESLint traps:** no component defined inside another component's render (extract to
  module scope); no synchronous `setState` in a `useEffect` body.
- **Responsive verification:** any layout/CSS/topbar/nav change MUST be verified at
  **375px / 768px / 1280px** (spot-check 1440) via `preview_resize` + `preview_screenshot`:
  no horizontal overflow (`scrollWidth` ≤ `clientWidth`), topbar ≤ 2 lines, legible
  contrast, and below **860px** the nav drawer opens/closes (hamburger → overlay → Esc →
  link-tap). Breakpoint lives in `Layout.tsx` + `index.css` `@media (max-width: 860px)`.
  - Topbar membership badges self-fit by **direct layout observation** (`TopbarMembership`
    + ResizeObserver): render inline, stack only if the user chip wrapped
    (`name.top - crumb.top > 6`). Width *estimation* was tried and abandoned — do NOT
    reintroduce it. Stacked pinning is coach-left/athlete-right via CSS `order`.
  - With dev auto-login active the badges render normally — verify directly. Only when
    `VITE_DEV_AUTH_*` are blank, inject a worst-case topbar via `preview_eval` instead.

## Tests
- Vitest, **node environment** (`vitest.config.ts`, no app plugins). Tests in
  `tests/**/*.test.ts` cover the **pure** logic: scoring engines (`src/scoring/*`),
  `src/lib/capabilities-core.ts` (split from React hooks so it imports zero runtime
  deps), `src/lib/pricing.ts`. Run: `npm test` / `npx vitest run`.
- Scoring tests encode ground-truth values from the original NAIGC calculators — they
  lock in port correctness. No DOM/component tests yet (would need jsdom + @testing-library).
- **E2E (Playwright, since 2026-07-04):** `npm run test:e2e` — smoke specs in `e2e/`
  (kept OUT of `tests/` so vitest doesn't pick them up) run chromium against a vite
  server in `--mode staging` on port 5178 (auto-started; reuses if running). Covers
  real Gate sign-in (incl. the no-account message), the seeded athlete cart, live
  `create-checkout-session` → Stripe Embedded render, and events pages. Tests
  suppress dev auto-login via `sessionStorage['ucg-dev-signed-out']`. Staging seeded
  state is documented in `supabase/README.md`; keep specs in sync with it.

## Docs
- `README.md` overview; `docs/README.md` index + **the authoritative "What's next"
  list**; `supabase/README.md` backend schema/RLS/migration table; `docs/specs/` design
  specs; `docs/plans/` implementation plans (do NOT recreate `docs/superpowers/`);
  `docs/stripe-go-live-checklist.md`.
- **Keep docs current after every commit** — a `PostToolUse` hook fires after `git commit`
  reminding you to sweep README/CLAUDE.md/docs/supabase-README in the same session.
  For THIS file that means update-in-place, keep it lean, push detail into specs/plans.

## Auth patterns
- **Dev test-auth (seeded auto-login):** `src/lib/dev-auth.ts` does a real
  `signInWithPassword` of a seeded test user on dev boot (real JWT → RLS/Edge
  Functions/member/club/admin/checkout UI all work locally). Bottom-left switcher flips
  athlete/manager/admin (persists in `sessionStorage['ucg-dev-role']`); sign-out sets
  `ucg-dev-signed-out` so it isn't undone by re-login. **Firewall:** loaded only via
  dynamic `import('./dev-auth')` behind `if (import.meta.env.DEV)` in `auth.ts` — after
  any build, grep `dist/assets` for `VITE_DEV_AUTH`/`initDevAuth` (must be NONE).
  Credentials in gitignored `.env.local` (`VITE_DEV_AUTH_{ATHLETE,MANAGER,ADMIN}_{EMAIL,PASSWORD}`);
  seeded emails in `docs/specs/2026-06-25-dev-test-auth.md`. If the vars are blank (fresh
  clone/CI) the dev server is unauthenticated — rely on build/eslint/vitest + console
  smoke test and flag auth flows for manual check.
- **HashRouter vs Supabase implicit flow:** auth tokens arrive in the URL hash (clashes
  with HashRouter). Invite/set-password links use `redirectTo` = app base + `?setpw=1`
  (query survives hash-stripping); `App.tsx` detects it and routes `#/set-password`;
  `SetPassword.tsx` waits ~2.5s for the async session. **Dashboard requirement:** redirect
  URLs must include `https://nssharpe.github.io/ucg-platform/**` and
  `http://localhost:5173/**` wildcards or the query is dropped. `Gate.tsx` also offers
  forgot-password (same `?setpw=1` landing) and OTP magic-link sign-in.
- **`rolesLoaded` gate:** roles load async after the session; `RequireAdmin`/role screens
  must wait on `useRolesLoaded()` or they flash "access denied" on refresh. Reset on
  sign-out/new user (`auth.ts`).
- **Initial-paint auth flash (App.tsx):** `!session && authLoading && (hasLikelySession()
  || hasAuthCallbackInUrl())` gates the very first render behind `<PageFallback/>` so
  the app never paints in guest mode right before a session resolves.
  `hasLikelySession()` covers a RETURNING session (refresh); `hasAuthCallbackInUrl()`
  (added 2026-07-03, B7) covers a BRAND NEW one being established from a
  signup-confirmation/magic-link/recovery URL token — `hasLikelySession()` alone misses
  that case (no prior localStorage entry yet), which is exactly what caused the
  "confirm my account → flashes a page" report.
- **App roles** (`user_roles.role`, enum `app_role`): `admin`, `sanctioning`,
  `regional_rep` (region via `regional_rep_regions`), `finance_admin`. Capabilities:
  `isSanctioning`/`isRegionalRep`/`isFinanceAdmin` — admins are NOT implicitly either.
- **Self profile save stamps `auth_user_id`:** `pushPerson(p, { selfAuthUserId })` only
  when saving one's OWN row (passes the `people` self-INSERT RLS branch); admin/manager
  creation of others omits it.

## Domain rules (registration / membership / cart)
- **Club-membership gate is ON:** a club needs an active `club_memberships` row for a
  season before its athletes can register or it can host — enforced at every registration
  entry point via `clubHasActiveMembership`/`seasonForDate` (`capabilities-core.ts`).
  New registration paths MUST apply this gate.
- **Registration paid-state:** `Registration.paid` is the explicit entry-fee flag; new
  regs land `paid:false` ("Pending Purchase"). The link between a cart/invoice line and
  the reg(s) it pays is `refRegIds` — always match on it, never a heuristic; webhook
  fulfillment flips exactly those regs. `updatedPending` marks a paid reg edited back to
  pending by a change fee. **Host-club $0:** competing-for club == event host ⇒ fees $0
  (`registrationEntryFee`/`registrationChangeFee`, pure, unit-tested) and regs are created
  `paid:true` with NO cart line. **Cross-club lock:** `paidRegistrationClub` blocks
  registering an athlete already paid-registered under another club for the same event
  (pending regs don't lock). **Change eligibility:** `changeIsEligible(before,after)`
  (`pricing.ts`) gates "Add change to cart" (add discipline / change level / change club /
  swap athlete — NOT apparatus tweaks within a discipline).
- **Member self-edit (`MyRegistrations.tsx`)** embeds the shared `RegistrationEditor`,
  targets the member's OWN cart, same paid/`updatedPending` semantics as `Club.tsx`.
  **CRITICAL divergence:** the member side NEVER deletes a registration — a fully
  deselected discipline is retained-but-blanked; deletion stays a refund action.
  `RegistrationEditor`'s optional `originalClubId` prop makes a club-only switch
  chargeable (other callers omit it).
- **Membership holds are INDEPENDENT** (waiver + club-payment can co-exist): derive via
  `membershipHolds(m)` (`capabilities-core.ts`) — `waiverHold = !waiverSignedAt`,
  `paymentHold = clubCartPending || status === 'pending-club-payment'`. Render bubbles
  off `membershipHolds`, never the raw enum. `clubCartPending` is set on club-cart push
  and cleared server-side by `stripe-webhook` fulfillment. KNOWN WART: the
  `record-waiver-signature` function still flips club-pay rows to
  `pending-club-payment` on signing without touching `clubCartPending` — if the club paid
  before the guardian signed, a stale hold can be re-asserted.
- **Unified cart:** `/cart` (`Cart.tsx`) renders the person's own cart PLUS a section per
  managed club (shared `groupCartItems`/`CartCard`/`CartScope`/`ReceiptsSection`).
  One payer entity per Stripe session (self OR one club) — no cross-entity mega-checkout.
  Each line has a ✕ (`removeCartItemWithSync`, `src/lib/cart-sync.ts`): unpaid **entry**
  line → delete the linked reg(s); **change** line with `prior_reg_snapshot` → revert
  them; change line without snapshot (legacy) → remove line only + honest toast; anything
  else → remove line only. Classifier is pure: `classifyCartRemoval` (`pricing.ts`);
  its no-`refRegIds` ⇒ remove-only guard is the legacy-row safety net.
  `downloadCartInvoice` (`receipt.ts`) is the pre-payment jsPDF estimate (NOT a receipt).
- **In-place mutation trap:** `mutate()` (`store.ts`) mutates the shared `db` object
  in place — a `useMemo`/`useEffect` keyed on a nested `db.*` path NEVER sees local
  mutations (only a full `syncFromSupabase()` reload reassigns). Read `db.*` directly
  each render; audit for this trap when touching store consumers.
- **New DB collection plumbing:** add to `types.ts` (`DB.<x>`), `rowTo<X>` +
  `push<X>`/`delete<X>` in `supabase.ts`, and the `loadAll` Promise.all + map +
  conditional spread. `from('<new_table>')` typechecks even if absent from `database.types`.
- **Toasts:** `useToast()(msg, { variant?: 'info'|'error', persist? })` — use
  `{ variant: 'error' }` for failures (persist until closed).
- **PDFs are client-side (jsPDF), on demand** (waiver proof, receipts, cart invoice) —
  no server PDF/storage; regenerate from data.

## Payments (Stripe — test mode; go-live checklist is Nate's action)
All money flows through **Stripe Embedded Checkout** via two Edge Functions sharing
`_shared/stripe.ts` (see `docs/specs/2026-06-25-stripe-integration.md` +
`docs/specs/2026-06-26-stripe-s4-decomposition.md` for the build story):
- `create-checkout-session` (auth'd; caller must own the cart items or manage the club):
  **recomputes every line server-side** — cart `amount`s are display-only and NEVER
  trusted. Handles all line kinds (memberships incl. club/member-targeted, event entries,
  change fees, addons; honors host-club $0). **Entry-vs-change is derived from the
  referenced registrations' STATE (`paid`/`updated_pending`), NOT the client
  `ref_line_type` tag** (C4 fix — a brand-new reg can't be tagged 'change' to pay a cheap
  change fee; a line is 'change' only when EVERY referenced reg is already
  purchased/re-pended). **Ownership (H4):** every `ref_reg_ids` reg must belong to the
  payer (self cart) or the club (club cart); membership `ref_user_id` must be the payer or
  a club-affiliated person — else 403. Service fee = 3% + $0.30 rounded UP (`Math.ceil`,
  mirrored in `src/lib/pricing.ts`). Coupons: client sends only a code; server validates +
  reduces eligible lines per `appliesTo` scope (floor 0). Inserts a `pending` `payments`
  row (money cols CENTS) with **`lines_snapshot`** — the validated, server-priced line set
  frozen onto the row so the webhook fulfills from it, not from re-read (client-writable)
  `cart_items` (closes the TOCTOU where a line's refs could be mutated post-create).
- `stripe-webhook` (deploy `--no-verify-jwt`; signature via `constructEventAsync`,
  fail-closed): fulfills **from `payments.lines_snapshot`** (falls back to live
  `cart_items` only for pre-2026-07-02 pending payments with no snapshot). Because
  fulfillment no longer depends on `cart_items`, the **atomic idempotency claim is at the
  END** — all writes (membership activate, `registrations.paid` flip via `ref_reg_ids`,
  invoice + `invoice_items` from snapshot amounts, `cart_items` delete) are idempotent
  deterministic-id upserts, so a mid-fulfillment failure leaves `fulfilled_at` NULL and
  Stripe's retry re-runs cleanly (H1 — no more permanently-stuck partial fulfillment); a
  losing concurrent delivery redoes the same idempotent rows and only the claim WINNER
  redeems the coupon (`redeem_coupon(code, payer)`) + emails the receipt. **M5:** before
  fulfilling, asserts `session.amount_total === amount_subtotal + service_fee`; on mismatch
  it logs to `error_logs` and does NOT fulfill (leaves the payment pending for review).
  Club-billed for club carts (`invoices.club_id`), else payer; real `stripe_fee` from the
  balance txn. Trusts the server-written `payments`/snapshot amounts, never the client.
- FE: `StripeCheckout.tsx` (embedded form + poll `payments` self-read until
  `paid`/`failed`, ~60s cap, never falsely claims success; `loadStripe` once at module
  scope) inside shared `CartCheckout.tsx` (promo input + server-returned
  Subtotal/Coupon/Fee/Total — UI never sums client amounts as authoritative).
- **Refunds:** manual in the Stripe Dashboard for now; a Dashboard refund does NOT
  reflect back into `payments.status` — in-app refund path is deferred.
- **Stripe CLI** (logged in, account "UCG", test mode): `stripe trigger <event>` fires a
  signed test event; verify via `stripe events list` (`pending_webhooks: 0` ⇒ all 2xx —
  but wait ~20s after triggering, checking immediately is a false-positive trap). Stuck
  event recipe: `stripe events resend <event-id> --webhook-endpoint <id> --confirm`.
  Supabase has NO remote function-logs CLI — use the Stripe dashboard side or temp logs.
  Look up API syntax with `stripe docs search|api|events ... -N --format=compact`
  (always `-N` + a format flag) instead of guessing.

## Email / Edge Functions (Resend)
- Shared helper `supabase/functions/_shared/resend.ts` (`sendOne`/`sendBatch`; optional
  `cc`, `reply_to`, and `fromName` — the last swaps ONLY the sender display name, the
  address always stays `RESEND_FROM`'s verified one; per-event "from" = alias+reply-to
  by design). Secrets: `RESEND_API_KEY`, `RESEND_FROM` (naigc.org is verified),
  `APP_PUBLIC_URL`.
- All transactional emails render through `_shared/email-layout.ts` (`renderEmail({
  heading, bodyHtml, cta?, footnoteHtml? })`) — the branded navy-header/white-card/
  orange-CTA wrapper matching Supabase's magic-link email. New email-sending functions
  should use it rather than composing bare `<p>` HTML. Exception: `send-email` (admin
  free-text broadcast — caller controls the full body). Supabase Auth's own templates
  (confirmation/invite/magic-link/recovery/…) are repo-managed since 2026-07-08 and
  render from the SAME layout: `scripts/render-auth-email-templates.mts` →
  `supabase/templates/*.html` → `supabase config push` (prod only — staging is free-tier
  and 400s template pushes). ⚠ `config push` pushes DEFAULTS for undeclared `[auth]`
  keys and AUTO-CONFIRMS under agent detection (closed stdin also defaults the prompt
  to Yes) — dry-run with `echo n | supabase config push --agent no` and read the diff
  first; keep every config.toml key deliberate.
  Full runbook + traps: `supabase/README.md` "Auth email templates".
- Deploy: `supabase functions deploy <name> --project-ref wkyerxlgricfphopocoz`
  (sandbox disabled; no Docker; `_shared/` bundles automatically).
- **CRITICAL — `--no-verify-jwt` is NOT sticky.** A bare redeploy silently resets
  `verify_jwt=true` and Supabase's gateway then rejects the caller BEFORE the function
  runs (no logs, invisible failure — a real customer charge sat unfulfilled 2026-07-02).
  Three functions need the flag: **`stripe-webhook`, `sms-webhook`,
  `notify-manager-access-denied`**. Before AND after touching any of them:
  `supabase functions list --project-ref wkyerxlgricfphopocoz` → `verify_jwt: false`
  for exactly those three.
- **Invokers unwrap errors via `edgeErrorMessage(error)`** (the real JSON message), not
  `error.message`. All invokers live in `src/lib/supabase.ts` — match the pattern.
- Function inventory (all in `supabase/functions/`): `send-email` (admin-only broadcast),
  `send-sms` (admin-only, Telnyx) + `sms-webhook` (Telnyx DLRs/inbound/STOP, Ed25519
  verified, fail-closed), `request-guardian-waiver` / `record-waiver-signature` /
  `create-waiver-link` (no-login waiver signing links), `notify-club-cart`,
  `send-membership-welcome` (first no-club membership; CCs the regional team address only;
  once-only guard is CLIENT-side in `Membership.tsx`), `send-club-invite`,
  `invite-account` (admin-create auth user + set-password link), `request-manager-access`
  / `notify-manager-access-denied` (no-login manager-access review),
  `notify-sanction`, `send-event-email` (event-scoped email to registrants, emv2 P1 §J:
  authorized for admin/sanctioning/host-club managers/event-admin grantees; recipients
  resolved SERVER-side, hosts get no SMS, test-send = caller only, cc = one copy message;
  verify_jwt true), `scheduled-dispatch` (pg_cron every 15 min; sanction-vote
  reminders + event-owner task escalations (`owner-task` kind, emv2 P1 §B4);
  verify_jwt STAYS true + requires the `x-cron-secret` header matching its
  `CRON_SECRET` secret — the runtime's env service key ≠ the legacy JWT, bit us
  2026-07-08; runbook in `supabase/README.md`). Notify-style functions allow any signed-in caller and resolve
  recipients server-side; only `send-email`/`send-sms` are admin-gated. (`send-receipt`
  was removed 2026-07-04 — dead code, never called from `src/`; `stripe-webhook`'s own
  `emailReceipt()` is the actual live receipt path — since emv2 P0 it also renders each
  purchased event's `confirmation_email.bodyHtml` above the receipt, cc's the event
  director when `ccOnConfirmation`, and applies reply-to/from-alias when unambiguous.)
- **SMS consent is opt-OUT, not opt-in** (changed 2026-07-04): `people.sms_consent`
  defaults to `true` — SMS is covered by the liability waiver signed at registration
  (confirmed with Julia), so there's no Profile.tsx checkbox anymore. A STOP-family
  reply (`sms-webhook`, unchanged) is the ONLY way to become ineligible —
  `partitionByConsent` (`src/lib/sms-send.ts`) excludes only explicit `false`, treating
  `undefined`/`true` as eligible. Migration `20260704015417` backfilled everyone to
  `true` EXCEPT anyone who'd already sent a STOP reply (matched against `sms_messages`).

## Deferred / TODO
**The single authoritative open-work list is `docs/README.md` → "What's next"** —
update it there; don't grow a rival list here. Operative notes only:
- Feedback tracker (`docs/plans/2026-06-28-feedback-tracker.md`): Cohort A + B1–B4, B6,
  B7, B8 all shipped; **B5** (finance dashboards) is absorbed by event-management v2.
- **Event management v2** (Julia's 2026-07-06 requirements): digest + gap analysis in
  `docs/specs/2026-07-06-event-management-v2-requirements.md`; raw materials in
  `docs/reference/` (every "NAIGC" there reads as UCG — Nate 2026-07-06). Phasing
  V2-P0…P6 approved + all §N7 questions answered by Julia 2026-07-06. P0–P2 shipped
  (P2 = per-unit add-ons + camps, 2026-07-10 — decisions in spec §E3/§G); next is
  P3 refunds (money-critical, fable review mandatory).
- Refunds are Stripe-Dashboard-only today; a Dashboard refund does NOT reflect back
  into `payments.status` (full in-app refund requirements: v2 spec §H).
