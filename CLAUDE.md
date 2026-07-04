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
  `supabase/migrations/` — **the authoritative, current migration list + schema/RLS model
  is `supabase/README.md`**; keep its table updated with every migration. All migrations
  through `20260703223152_clubs_manager_no_delete.sql` are applied. The 182709–182714
  batch is security-hardening Phase 1 (DB guard triggers + policy lockdowns); 201710 is
  Phase 2 (the fulfillment snapshot). See `docs/plans/2026-07-02-security-hardening.md`.
  `20260703034325` (2026-07-03) fixes a bug in the 182711 guard trigger — it trusted
  `tg_op`/`OLD` to detect "is this an update," but the app's writes are always whole-row
  upserts, so Postgres fires the BEFORE INSERT phase unconditionally and the trigger's
  snapshot-revert/no-op-transition allowances were unreachable. Now re-resolves the
  pre-write row by `id` explicitly. `20260703035157` adds `email_has_account` (B8, no-
  login RPC for the sign-in gate). `20260703132252` adds an `invoice_item_kind` enum
  value `'fee'` so `stripe-webhook` can persist the Stripe service fee as its own
  Purchase-History/receipt line (previously shown at checkout/in the receipt email only,
  never saved — receipts always looked whole-dollar). **`20260703221303` +
  `20260703221855` + `20260703222142`** fix two real bugs discovered live while
  consolidating the club edit UI (B8): (1) `pushClub`'s old client-side
  delete-then-insert of `club_managers` under RLS was self-referential — a non-admin
  manager's own permission depended on the row the delete had just removed, silently
  wiping every manager off the club (fixed via a security-definer
  `replace_club_managers` RPC, checked once up front); (2) `clubs` had NO write policy
  at all for a non-admin manager (only `admin_all`), so "Edit club details" never
  actually persisted for its main non-admin audience — fixed with a `manager_all`
  policy scoped to `manages_club(id)` (needs BOTH insert+update, not just update, since
  `pushClub` upserts and Postgres RLS still runs the INSERT policy's check on the
  conflict-update path — split into separate `manager_insert`/`manager_update` policies
  rather than `for all`, so a manager isn't also granted DELETE on their own club).
- New migrations: `supabase migration new <name>` (timestamp filename format is required).
  Apply via `supabase db push` — network is sandbox-blocked, run with sandbox disabled.
- **Enum gotcha:** `ALTER TYPE ... ADD VALUE` can't be referenced in the same
  transaction — put each enum addition in its OWN migration file.
- Ids are app-generated **text**, not uuids (incl. FK cols like `payments.person_id`).

## Build / tooling gotchas
- Keep the working copy at `C:\dev\ucg-platform` (short, space-free, outside Dropbox —
  the old Dropbox path broke npm shims and locked `dist/`; never move it back).
- Verify a build by grepping for "files generated" AND confirming `dist/index.html`'s
  script refs exist under `dist/assets` — never trust the piped exit code alone.
- Launch configs (`.claude/launch.json`): `ucg-dev` (5173), `ucg-preview` (5176,
  `--strictPort`). If you run `vite preview` (serves `dist/`): rebuild first and clear
  the service worker or it serves the previous bundle.
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

## Docs
- `README.md` overview; `docs/README.md` index + roadmap; `supabase/README.md` backend
  schema/RLS/migration table; `docs/specs/` design specs; `docs/plans/` implementation
  plans (do NOT recreate `docs/superpowers/`); `docs/stripe-go-live-checklist.md`.
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
- Shared helper `supabase/functions/_shared/resend.ts` (`sendOne`/`sendBatch`, optional
  `cc`). Secrets: `RESEND_API_KEY`, `RESEND_FROM` (naigc.org is verified), `APP_PUBLIC_URL`.
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
  `notify-sanction`, `send-receipt` (caller self-receipt only). Notify-style functions
  allow any signed-in caller and resolve recipients server-side; only
  `send-email`/`send-sms` are admin-gated.

## Deferred / TODO
Roadmap lives in `docs/README.md`; feedback tracker in
`docs/plans/2026-06-28-feedback-tracker.md` (Cohort A + B1–B3 shipped; **B4–B8 still
open**, see below). Notable open items:
- **In-app admin refunds** (Dashboard-only today; sketch in the go-live checklist).
- **New-club-request email** to `newclubinquiries@naigc.org` (transport exists, not wired).
- **MFA/passkeys** (`docs/research/2026-06-22-auth-2fa-passkeys.md`).
- Per-season typed waivers, codeless judge access, multi-judge + score-entry-mode config,
  PDF certs, finals rosters, server-emailed PDF receipt attachments.
- **Feedback tracker B4** — Meet management (RLS/roles/money): Draft/Live-only +
  timestamp-driven open/close, `Last date to edit` + role-gated lockout, club-transfer
  change-fee/roster/pending flag, synchronized-trampoline same-level backend check.
- **Feedback tracker B5** — Finance dashboards (whole epic): event/org tiers, date
  defaults, Summary/Invoices tabs, account codes. Flagged "likely defer given budget."
- **Feedback tracker B6** — Email/state regressions: memberships-checkout confirmation
  email+PDF (still open). The other 5 items were investigated 2026-07-03: 4 read as
  already-correct/false-positive in current code (waiver-checkout "email sent" toast,
  in-cart membership bubble conflict, admin-access routing, denial-email not firing); the
  welcome-email gap was real and is ✅ fixed (see feedback-tracker.md B6 notes).
- **Feedback tracker B7** — Verify-by-eye: Confirm-My-Account nav flash, hard-refresh
  flash, transactional-email styling polish.
- **Feedback tracker B8** — ✅ all items done 2026-07-03 (Save-vs-Add-to-Cart for no-fee
  changes, the unknown-email login alert, the profile-refresh double-submit glitch, and
  the club-membership edit screen fields — see feedback-tracker.md for details,
  including two real RLS bugs found+fixed along the way).
