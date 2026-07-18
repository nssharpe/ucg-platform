# 2026-07-18 session queue: E2E-in-CI, component tests, freshness, payments reconciliation, data export/delete, season lifecycle

Approved by Nate 2026-07-18 (clarifying Q&A in session). Build order:
**2.5 → 6.5 → 6.1 → 6.2 → 6.4 → 6.3** (whats-next numbering). One feature branch
per item, subagent-driven, verify → merge to main → push (deploys) per feature.

---

## F1 (whats-next 2.5) — Playwright E2E suite in CI, non-blocking

**Decision:** non-blocking first; flip to a blocking gate once proven stable on CI.

- New `e2e` job in `.github/workflows/deploy.yml`, parallel to `build`
  (`needs: test` is fine, but it must NOT appear in `deploy`'s `needs` chain —
  that's the non-blocking property). No `continue-on-error`: the job honestly
  shows red on failure while the deploy proceeds independently.
- Steps: checkout, setup-node 20 + npm cache, `npm ci`,
  `npx playwright install --with-deps chromium`, write `.env.staging.local`
  from a single repo secret `STAGING_ENV_FILE` (exact file content — the
  playwright config already loads this file), `npm run test:e2e`.
- Reporter: keep `list` locally; in CI also produce the HTML report
  (`--reporter=list,html`) and upload `playwright-report/` as an artifact
  (`if: failure()` is enough; upload always is also fine but noisier).
- Secret setup: `gh secret set STAGING_ENV_FILE < .env.staging.local`
  (controller does this — values live in the local gitignored file).
- The passkey spec already skips off-localhost RP ID; leave as-is. If the
  Stripe embedded-checkout spec is flaky on CI runners, quarantine that single
  spec with a CI-conditional skip + a whats-next note, not the suite.
- Failure visibility: GitHub's default workflow-failure email to Nate +
  the red job in the run. No extra notification plumbing.

**Verify:** push the branch, run the workflow via `workflow_dispatch` (or the
main push after merge), confirm the e2e job runs green against staging and the
deploy job is unaffected by an induced failure is NOT required — reading the
needs-graph suffices for the non-blocking property.

## F2 (6.5) — Component tests (jsdom + Testing Library)

- Dev deps: `jsdom`, `@testing-library/react`, `@testing-library/jest-dom`,
  `@testing-library/user-event`.
- `vitest.config.ts`: keep node default; add an environment override so
  `tests/components/**` runs under jsdom
  (`environmentMatchGlobs: [['tests/components/**', 'jsdom']]`), and the react
  plugin is NOT needed (esbuild handles TSX); add a `tests/components/setup.ts`
  (jest-dom matchers) via `setupFiles` scoped appropriately. Keep `globals: false`.
- First test targets (the hand-verified money-adjacent UI semantics):
  1. **Cart line removal** (`Cart.tsx` / `cart-sync.ts` integration at component
     level): unpaid entry line ✕ → linked reg deleted; change line with
     `prior_reg_snapshot` → regs reverted; legacy change line without snapshot →
     line removed only + toast copy.
  2. **RegistrationEditor change-fee derivation**: editing a paid reg
     (add discipline / change level / change club / swap athlete) surfaces the
     change fee; apparatus-only tweak does not; `originalClubId` prop makes a
     club-only switch chargeable.
  3. **Membership-hold rendering**: bubbles render from `membershipHolds`
     (waiver hold, payment hold, both, neither) — never from the raw enum.
- Tests run against a store seeded in-memory (no Supabase; the localStorage
  prototype store path). Mock at module boundaries (`supabase.ts` inert when
  unconfigured — prefer relying on that instead of vi.mock where possible).
- These are semantics locks, not render-snapshot tests. No snapshot files.

## F3 (6.1) — Multi-manager freshness: refetch-on-focus (realtime later)

**Decision:** refetch-on-focus now; realtime for more tables stays a
whats-next follow-up.

- New small module `src/lib/focus-refresh.ts`, initialized once at boot
  (where the store/auth wire up): listeners on `visibilitychange` (hidden →
  visible), window `focus`, and `online`.
- Trigger rule: refetch only if the document was hidden/unfocused for ≥ 60s
  AND at least 60s since the last full sync (whichever bound is stricter).
  Refetch = the existing `syncFromSupabase()`.
- Guards: skip when Supabase isn't configured; skip while the write-queue has
  pending/in-flight writes (never race a local change — check the queue's
  length, drain-then-sync already exists for the error path); skip while a
  checkout poll is active is NOT needed (payments polling reads its own row),
  but confirm `StripeCheckout` polling isn't disturbed by a concurrent
  `syncFromSupabase` (it re-reads `payments` directly — should be fine; verify).
- No UI; at most a `console.debug`. Note the realtime follow-up in
  whats-next §6.1 (replace the item body with "shipped focus-refetch; realtime
  upgrade deferred").

## F4 (6.2) — Payments reconciliation admin view + actions

**Decision:** DB view + Stripe cross-check + remediation actions.
⚠ Money paths: sonnet drafts, controller fable-reviews the full diff before
merge (standing rule). New edge functions get role gate + AAL guard.

- **Surface:** a "Reconciliation" card/section on the existing admin finance
  area (`#/admin/finance` — follow the existing page structure), visible to
  `admin` + `finance_admin`.
- **Panel A — stuck pending:** client-side query of `payments` where
  `status='pending'` and `created_at < now()-1h` (admin RLS read already
  exists for finance dashboards — verify; if not, scoped read via the edge fn
  below). Shows age, payer/club, amount, session id, `stripe_session_id`
  null-ness (free-order path rows can't be "stuck at Stripe").
- **Panel B — Stripe drift:** new edge function `reconcile-payments`
  (verify_jwt true; gate: `admin` or `finance_admin`; then
  `requireAalForEnrolledCaller`). Action `scan`: for `payments` with status
  `paid` in the last N days (default 90, param), fetch the Stripe
  PaymentIntent/Charge refund state; return rows where Stripe shows a
  refund/partial refund that our `payments.status` + approved
  `refund_requests` don't account for. Read-only against Stripe.
- **Actions (same edge function, separate ops):**
  - `refulfill` (Panel A): for a pending payment WITH a Stripe session,
    re-check the session server-side; if Stripe says paid, run the shared
    `_shared/fulfill.ts` `fulfillPayment` core (idempotent by design). If
    Stripe says unpaid/expired, report that instead — never fulfill an unpaid
    session. For `stripe_session_id: null` free-order rows, re-run the core
    directly.
  - `mark-refunded` (Panel B): reflect a confirmed Stripe-side refund into
    `payments.status` (+ a note column or reuse existing fields — inspect the
    payments schema; add a migration only if there's no sensible place). Does
    NOT touch registrations/memberships — it's bookkeeping alignment, and the
    UI copy must say so (Dashboard refunds bypass in-app reversal semantics).
- Action failures log to `error_logs`; successes just render their result in
  the UI (no new audit-trail table for now).
- FE invoker in `src/lib/supabase.ts` per the `edgeErrorMessage` pattern.
- Tests: pure drift-classification logic (given payment row + refund_request
  rows + stripe refund summary → drift verdict) extracted to a pure module
  with vitest coverage.

## F5 (6.4) — User data export + delete (admin-operated)

**Decision:** admin-operated now; self-serve later only if counsel requires.

- **Where:** admin people management (the existing admin person view/list).
- **Export:** client-side (admin session RLS already reads these tables):
  gather the person's `people` row, memberships (+waiver state), registrations,
  scores, cart items, invoices/invoice_items where they're the billed person,
  payments (their `person_id`), refund requests, sms/email consent state,
  guardians/guardian links, club affiliations. Download as JSON (exact rows)
  + a human-readable PDF (jsPDF, matching existing receipt/waiver patterns).
  A pure `collectPersonData(db, personId)` module + vitest test for inclusion
  completeness (walks every DB collection with a person-shaped FK and asserts
  it's either collected or explicitly excluded with a reason).
- **Delete/anonymize:** new edge function `admin-delete-person`
  (verify_jwt true; `admin` role gate + AAL guard; NOT finance_admin):
  - **Scores and paid registrations are competition/financial history — retain
    but anonymize.** The implementer inspects which retained rows carry
    denormalized name/email fields and the function scrubs those in place.
    Unpaid registrations and cart items are simply deleted.
  - Retain-but-anonymize: `invoices`/`invoice_items`/`payments`/approved
    `refund_requests` (financial records) — strip PII linkage: repoint to a
    tombstone person row (`deleted-<id>`, name "Deleted user") rather than
    breaking FK columns; amounts and dates keep their integrity.
  - Deletes the auth user (service role `auth.admin.deleteUser`) and the
    person-owned rows without financial significance (cart items, sms consent,
    guardian links, waiver signatures? — waiver proofs may have legal retention
    value: KEEP waiver signature records, anonymization question flagged in
    the runbook for counsel; default KEEP as-is pending counsel).
  - Response returns a summary manifest of what was deleted vs anonymized.
  - UI: type-the-person's-name confirmation dialog; irreversible warning.
  - ⚠ fable review before merge (auth + financial integrity).
- Document the retention decisions in the spec/runbook section for counsel
  (§2.4 privacy-policy work will reference it).

## F6 (6.3) — Season lifecycle automation

Seasons follow the UCG fiscal year: **July 1 → June 30**. Event's season is
dictated by the event **start date** (existing `seasonForDate` semantics).

- **"Launched" state:** add `launched_at timestamptz` (null = not launched) to
  `seasons` (migration; staging first, then prod). A season is *launched* when
  an admin has finished its details and flips it live; launched ⇒ its
  memberships are purchasable.
- **Event-creation guard:** creating an event whose start date falls in a
  season that is not launched (or has no season row at all) is blocked in the
  event wizard with a clear message ("The <year> season hasn't been set up
  yet — an admin must launch it before events in it can be created"). Gate in
  the shared validation path (pure function + vitest), enforced wherever
  events are created (EventWizard + any clone/copy path).
- **Escalating admin nags** (`scheduled-dispatch`, new kind `season-launch-nag`):
  while the NEXT season (the one starting the upcoming July 1) has no launched
  row: email all `admin`-role users on June 1, June 16, and daily June 24–30.
  Idempotent per-day (the dispatch's existing once-per-day guard pattern);
  emails via `renderEmail` layout with a CTA to the season admin page.
- **Automatic rollover:** in the same `scheduled-dispatch` sweep: on/after
  July 1, if a season row exists whose `[startsOn, endsOn]` window contains
  today and it isn't `current`, flip `current` to it (single-row transaction:
  clear old flag, set new) — idempotent, runs harmlessly every 15 min. If no
  such row exists (admins ignored every nag), nothing flips and the nag
  continues daily past July 1 — **fail loud, never auto-create a season**.
- **Future-season membership purchase:** once a future season is launched, the
  membership purchase flow (`Membership.tsx` + club-membership paths) offers
  it alongside the current season, with an unmissable notice: "Please be aware
  that you are purchasing a membership for **next** season (<label>, starts
  <date>)." Server side: `create-checkout-session` membership pricing must
  price by the TARGET season and accept only current-or-launched-future
  seasons (reject unlaunched/past).
- **Admin season management:** whatever admin UI exists for seasons today gets
  the "Launch season" action (sets `launched_at`, with a checklist-style
  confirm: dates set, pricing set). Implementer inspects the existing admin
  seasons surface and extends it minimally.
- ⚠ Membership pricing touches money ⇒ fable review on the
  `create-checkout-session` diff.

---

## Cross-cutting

- Each feature: branch `feat/<slug>`, subagent implements (sonnet default;
  haiku for the CI-yaml mechanical parts), verification protocol in every
  brief (`npm run build` + `npx eslint <touched>` + `npx vitest run`, evidence
  required), controller reviews inline, merge + push per feature.
- Migrations (F4 note-column if needed, F6 `launched_at`): staging first, then
  prod; controller applies, batched per feature.
- Edge function deploys: controller, after merge; `supabase functions list`
  check after any deploy touching the no-verify-jwt trio (none planned here).
- Doc sweep per feature: whats-next.md status, supabase/README.md for
  migrations/functions, CLAUDE.md only for operative new rules.
