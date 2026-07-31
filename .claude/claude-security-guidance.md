# Security guidance for the UCG platform

Repo-specific threat model and review checklist. Loaded as additional context by the
`security-guidance` plugin's model-backed reviews (end-of-turn diff review and commit review)
**if that plugin is installed** — see `docs/specs/2026-07-31-review-and-cleanup-findings.md` §7.

This file is inert without the plugin. It is checked in so the rules are ready and reviewable
independently of the decision to enable it.

Every rule below is a trap this repo has actually hit, not a generic checklist. Sources:
`CLAUDE.md`, `.claude/rules/*.md`, `supabase/README.md`, and the security-review specs.

## Row-level security

- **Never write a `for all` RLS policy.** It silently grants DELETE. Always write explicit
  `for insert` / `for update` / `for delete` policies. This has bitten `invoices`,
  `invoice_items`, `memberships`, and `invoice_items_owner_write` — a club manager could DELETE
  permanent financial records via PostgREST.
- **A whole-row upsert must satisfy BOTH the INSERT policy's `with check` AND the UPDATE
  policy** on the conflict path. Splitting a `for all` into separate policies without carrying
  the predicate into both breaks upserts at runtime, not at deploy.
- **Wrap every `SECURITY DEFINER` helper result in `coalesce(..., false)`.** A NULL must never
  read as a grant. `is_admin()` in particular.
- **A column-level `revoke` is a NO-OP against a table-level grant.** To restrict a column you
  must `revoke select on <table>` entirely, then `grant select (<explicit column list>)` back.
  If you do this, the app's own column list must be updated in lockstep — see
  `REGISTRATION_COLUMNS_NO_SURVEY` in `src/lib/supabase.ts` and migration `20260717205348`.
- **Don't "fix" a slow RLS policy by wrapping its subquery in a SECURITY DEFINER function.**
  Measured twice in this repo, worse both times: Postgres can hash-materialize a raw correlated
  `EXISTS` into one semi-join scan, but a function call is opaque to the planner. Scope the
  QUERY instead. See `whats-next.md` §7.

## Edge functions

- **`--no-verify-jwt` is not sticky.** A bare redeploy silently resets `verify_jwt = true`, and
  the gateway then rejects callers *before* the function runs — no logs, invisible failure.
  Exactly three functions must stay false: `stripe-webhook`, `sms-webhook`,
  `notify-manager-access-denied`. Flag any change that adds a fourth or drops one.
- **Never trust caller identity from the request payload.** Resolve it server-side from the JWT
  (`report-problem` and `send-event-email` are the reference implementations). Flag any function
  that reads a person id, email, role, or recipient list out of the body.
- **Anonymous endpoints need a real rate limit, not a `sleep()`.** A per-request delay does not
  serialize concurrent callers and is not a throttle. (Open finding against `judge-entry`.)
- **Service-role writes bypass guard triggers.** `error_logs`' 20/min rate limit exempts
  `service_role` by design — so an edge function that logs per failed attempt on an anonymous
  endpoint is an unbounded write amplifier. Cap it in the function.
- **Don't leak a validity oracle.** Distinguishing "no such token" (401) from "valid token, but
  not usable right now" (403) lets an attacker enumerate valid secrets off-peak. Return the same
  response for both.

## Money

- Money paths get an adversarial read, always: `create-checkout-session`, `stripe-webhook`,
  `request-refund`, `process-refund`, `reconcile-payments`, the cart, and coupon handling.
- **The server is the only authority on price.** The client must never send an amount. The cart
  displays the server's own numbers via `create-checkout-session`'s side-effect-free
  `mode: 'preview'`.
- **`mode: 'preview'` must stay side-effect-free** — no coupon reservation, no payment row, no
  Stripe session. Flag any write added on that branch.
- **Refund approval must claim the request atomically before calling Stripe**, and revert the
  claim on failure, or a concurrent retry double-refunds.
- **Anything deriving a sequence from a row COUNT is not concurrency-safe.** Invoice numbering
  currently does this; flag any new instance.
- Free/$0 and fully-couponed orders are a real branch, not an edge case — check them.

## Auth

- **AAL guard on every admin-privileged function.** An MFA-enrolled admin presenting an `aal1`
  JWT must get 403, or the stolen-aal1 → strip-own-factors → pass-`is_admin()` bypass reopens.
  `_shared/jwt-aal.ts` is the shared implementation; it must stay in lockstep with
  `mfa-core.ts` and the `is_admin()` migration.
- **No-login tokens must be CSPRNG-generated with ≥128 bits.** Use `_shared/token.ts`'s
  `randomToken()` (256-bit). Flag `Math.random()`, timestamps, or sequential ids in any token,
  access code, or link path.

## Client

- **Never place personal data in a URL or query string** — it lands in history and logs.
- **Text must never sit on a same-or-near-same background.** Resolve theme tokens to real values
  and check the pair; WCAG AA (4.5:1 body, 3:1 large/UI). Watch hover, disabled, and dark-mode
  overrides.
- Flag any user-controlled string reaching a `navigate()` / `<Link to>` target, `innerHTML`, or
  `dangerouslySetInnerHTML`. HTML that must be rendered goes through DOMPurify.
- **The dev-auth path must never reach a production bundle.** A PostToolUse hook greps
  `dist/assets` for `VITE_DEV_AUTH`/`initDevAuth` after every build; treat a failure as blocking.
