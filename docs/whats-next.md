# What's next — the authoritative open-work list

**This is the single source of truth for open work.** Reconciled with the codebase
**2026-07-31** (review + security pass:
[specs/2026-07-31-review-and-cleanup-findings.md](specs/2026-07-31-review-and-cleanup-findings.md)).
It replaces the
"What's next" section that used to live in [`README.md`](README.md) — update THIS file
when priorities change, not rival copies. [`production-readiness.md`](production-readiness.md)
is the per-dimension gap analysis; [`../CLAUDE.md`](../CLAUDE.md) keeps only a pointer here.

Legend: 👤 = only Nate can do it · 🤖 = Claude can build it · 💬 = needs a decision first.

---

## 1. Nate-only action items (👤 — quick, unblock others)

1. **Verify the P3 refund prerequisites landed:** "UCG - Main" flagged
   `clubs.is_league_host` + `refund_manager` granted to whoever reviews refunds.
2. **Supabase Pro upgrade** (backups/PITR) — deliberately deferred 2026-07-04; a hard
   pre-flight gate in the [go-live checklist](stripe-go-live-checklist.md). Interim
   insurance: daily dumps via `scripts/backup-db.mjs` (runbook in
   [supabase/README](../supabase/README.md)).
3. **Stripe go-live** — [stripe-go-live-checklist.md](stripe-go-live-checklist.md)
   (account activation, live keys, $1 smoke + refund).
4. **Legal (longest lead time — start early):** engage counsel on waiver wording,
   privacy policy, ToS, minors/COPPA. 🤖 drafts the documents (item 2.4 below).
5. **Add a failure alert to the daily DB backup.** The "UCG DB Backup" scheduled
   task fails *silently* — proven 2026-07-24, when Supabase made the direct DB
   host IPv6-only and every run after 2026-07-23 01:00 died on `ENOTFOUND` with
   no notification. The script is fixed (IPv4 pooler fallback, re-verified live),
   but a backup job that can fail unnoticed is the one job that must not — and
   these dumps are the stated stand-in until Supabase Pro/PITR (item 2 above).
6. **Security-review option + timing** — options brief at
   [research/2026-07-17-security-review-options.md](research/2026-07-17-security-review-options.md);
   👤 Nate picks an option + timing (gates live keys). 💬 Two additions worth folding into that
   brief ([findings §7](specs/2026-07-31-review-and-cleanup-findings.md)): the **Claude Security
   plugin**'s multi-agent whole-repo scan is a cheaper first pass before paying for a human
   audit, and one `/code-review ultra` run on the money paths during the planned Max month.
7. 💬 **Decide on the `security-guidance` plugin** ([findings §7](specs/2026-07-31-review-and-cleanup-findings.md)).
   Anthropic's free first-party plugin reviews Claude's own diffs in-session; it's hooks-based,
   matching this repo's enforcement model, and takes repo-specific rules —
   **`.claude/claude-security-guidance.md` is already written and checked in** (encoding our
   real traps: `for all` granting DELETE, the upsert trap, column-revoke, `verify_jwt`
   stickiness, `mode:'preview'` purity, AAL, dev-auth firewall). It is inert until the plugin is
   installed. ⚠️ **The catch is usage, not capability:** both model-backed layers default to
   Opus 4.7 and fire on *every* file-changing turn and *every* commit — a standing tax on a Pro
   plan. Recommended start: install with `ENABLE_CODE_SECURITY_REVIEW=0`, keeping only the
   **free** per-edit pattern layer.

## 2. Launch blockers (🤖 buildable now)

0. ✅ **Security hardening Phase 3 — COMPLETE 2026-07-26**
   ([plan](plans/2026-07-02-security-hardening.md) has the per-item detail and evidence).
   Every item applied to staging AND prod and verified live: **M1** coupon reservation at
   session-create (`20260726130005` — the `SELECT … FOR UPDATE` on the coupon row *is* the fix;
   proven with 10 concurrent claims → exactly 1 winner), **M2** `cart_member_clubpush` now
   membership-only, **M4** `people` self-insert-by-email branch dropped, the **invoice write
   lockdown** (not originally in the plan — any member could forge a paid invoice via
   PostgREST), and the **LOW** items (`club_managers`/`app_settings` SELECT scoped to
   `authenticated`, `error_logs` rate-limited to 20 inserts/min per caller, 256-bit tokens in
   the 3 no-login generators).

   Re-verified 2026-07-31: `verify_jwt = false` on exactly `stripe-webhook` / `sms-webhook` /
   `notify-manager-access-denied` on **both** projects; all 105 migrations applied to prod with
   zero drift.

## 3. Quality passes (pre- or just post-launch)

1. ✅ **UI/UX review fixes — COMPLETE 2026-07-26** ([task briefs](plans/2026-07-04-uiux-review-fixes.md),
  from the 2026-07-04 live review). All 14 tasks (O1, S1–S6, H1–H7) shipped to `main` and
  deployed; per-task detail and evidence live in the plan doc, not here. Headlines:
  **S1** primary-CTA/active-nav contrast (white-on-coral 2.94:1 → navy-on-coral 4.78:1,
  plus a new `--coral-400` hover step since dark text needs the hover to LIGHTEN);
  **S2/S3** Profile save bar (AA bar text + real dirty-tracking); **O1→S4** the money
  story — `create-checkout-session` gained a side-effect-free `mode:'preview'` so the
  cart shows the server's own prices and cart/checkout can no longer disagree;
  **S5/S6** live fee estimate + payment-status badges; **H1–H7** empty states,
  date/timezone formatting, Copy-link buttons, a 7-item microcopy sweep, cart CTA
  collapse, a NotFound route, and keyboard-accessible Details/Hide toggles.

  Residuals deliberately left open:
   - **Invoice numbering** (O1 spec §3) — two formats coexist; deferred to the
     pre-launch data sweep per Nate, since all current rows are test data. The
     generators derive the sequence from a row COUNT, which is not concurrency-safe.
     💬 **Recommend reclassifying this as a Stripe go-live gate rather than a quality pass**
     ([findings §6.4](specs/2026-07-31-review-and-cleanup-findings.md)): the trigger for the
     concurrency bug isn't a data sweep, it's the first two people checking out at the same
     time. Duplicate numbers on real financial records are painful to unwind and trivial to
     prevent beforehand — the fix is a DB sequence.
   - **Pre-existing 375px overflow on the admin Communicate compose-editor card** —
     found during H5–H7, proven pre-existing via `git stash`, out of scope there.
   - **Keyboard verification of the H7 toggles was click+DOM-based**, not real key
     events: the Browser pane could not deliver OS-level keystrokes this session.
     They are real `<button>`s with default `tabIndex`, so Enter/Space is spec-
     guaranteed, but a manual tab-through is worth doing once.

2. **Accessibility audit** to WCAG 2.1 AA (axe + manual keyboard/focus/ARIA pass) +
  loading/empty/error-state consistency across pages.
3. **New-club-request email** to `newclubinquiries@naigc.org` (transport exists, not wired).
4. **PWA production update path** — verify deploys reach users promptly; add a "new
  version available, reload" prompt if not.
5. **`npm audit` + Dependabot** in CI. **Audited 2026-07-31 — nothing that ships to a user is
  vulnerable today**, so this is now about automation, not a backlog of fixes. 22 findings
  (18 high), and the triage is what matters:
   - The only **runtime** dependency implicated is `react-router-dom`. Installed 7.17.0;
     advisory range `6.0.0–8.2.0`; npm `latest` is **7.18.2, also in range** — there is nothing
     to upgrade to. 3 of its 5 advisories are RSC/SSR-only and can't apply to a static SPA;
     the open-redirect one **was checked for reachability and is not reachable**
     ([findings §3.1](specs/2026-07-31-review-and-cleanup-findings.md)). Watch, don't chase.
   - The other 17 highs are **build-time only** (`vite-plugin-pwa`→`workbox-build`→`ejs`/`jake`;
     `exceljs`→`archiver`/`glob`/`minimatch`). npm's "fix" for both is a **downgrade**
     (`vite-plugin-pwa@1.2.0`, `exceljs@3.4.0`, both semver-major) — a worse trade than leaving
     them. `postcss`/`rimraf`/`fast-uri` do have clean fixes via a plain `npm audit fix`.
  ⚠️ When wiring this into CI, **fail on runtime deps only** — a blanket `npm audit --audit-level=high`
  gate would red-light every build today for dev-only transitive advisories with no upgrade path.
6. **Fix the `record-waiver-signature` stale-hold wart** — it can re-assert a
  club-payment hold if the club paid before the guardian signed (documented in
  CLAUDE.md; small, known fix).
7. 🔴 **Public Results page hides posted scores when registrations have no session**
  (found 2026-07-31, live in prod —
  [findings §4.4](specs/2026-07-31-review-and-cleanup-findings.md)). All 35 anon-visible prod
  registrations have `session_id = null`; `sessionResults()` filters strictly on session, so the
  3 scores that exist on `test-meet` are unreachable and every event reads *"No scores posted
  yet."* Two fixes: **(a)** assign sessions to the scored registrations via the host roster
  editor's per-row dropdown (`Events.tsx:1541`) — 👤 data fix, no code; **(b)** 🤖 make the empty
  state truthful — when `eventScores.length > 0` but the session filter yields none, say *"N
  scores are posted but not assigned to a session"* instead of `NO_SCORES_MSG`. (b) converts a
  silent meet-day failure into a self-diagnosing one and is a one-conditional change.
  Note `pushEvent` never backfills `session_id`, so a session whose **id** changes on an edit
  orphans its registrations the same way.
8. 🔴 **`judge-entry` unlock has no real rate limit** (found 2026-07-31 —
  [findings §3.3](specs/2026-07-31-review-and-cleanup-findings.md)). The 6-digit code path's
  only defense is a per-request `sleep(300)`, which parallelism erases: 40 concurrent invalid
  codes against staging all returned 401, none throttled. A guess yields score-write access to a
  live event. Compounding: failed attempts log to `error_logs` via the **service role**, which
  deliberately bypasses the 20/min limit — so the one anonymous endpoint that invites a million
  guesses is exempt from the anti-spam limit added for exactly this. And a validity **oracle**
  (401 for no-match vs 403 for "event not live") lets codes be harvested weeks ahead.
  Fix = same-401 for not-live + a real per-caller counter + capped failure logging.
  ⚠️ **Reviewer-tier design review before shipping** — a limit that's wrong in the
  "locks out a real judge mid-meet" direction is worse than today's state.
9. ✅ **`report-problem` + `admin-reset-mfa` deployed to staging — DONE 2026-07-31.** They
  existed in the repo and prod but not in staging, so neither the in-app problem reporter nor
  the MFA break-glass could be smoke-tested before a prod change. Staging is now at 25
  functions, matching prod exactly; `verify_jwt` trio re-verified by hand
  ([findings §1.3](specs/2026-07-31-review-and-cleanup-findings.md)).

## 4. Event-management v2 residuals (deferred by design)

emv2 P0–P6 is complete ([spec](specs/2026-07-06-event-management-v2-requirements.md));
these were explicitly deferred, not dropped:

- **§L.2 session-assignment tool** + the per-team session-timed finals reminders that
  depend on it ("5 min after session ends" / Fri-10am) — Julia marked her section
  incomplete; only the admin-set `finals_lineup_deadline_at` nag + 10pm lock shipped.
  ⚠️ **The assignment half is no longer just a convenience** — §3.7 above shows an unassigned
  `session_id` silently hides that registration's scores from the public Results page. The
  detect + bulk-assign subset is now correctness work and is recommended as next-up
  ([findings §6.1](specs/2026-07-31-review-and-cleanup-findings.md)); the *reminders* half is
  what Julia deferred and can stay deferred.
- **Server-rendered receipt PDF attached** to the confirmation email (§I/§N4) —
  receipts today are client-side jsPDF on demand.
- **Camp registration popup simplification** (§G) — camp events still reuse the full
  per-discipline `RegistrationEditor`; spec wants no discipline/level/apparatus step.
- **Host-payout formula** — see Nate item 1.3.

## 5. Feature roadmap

~~B, C, D, E~~ — ✅ **ALL SHIPPED 2026-07-19** (merged to main; migrations
`20260719120000_judge_access_codes` + `20260719130000_event_scoring_config`
applied staging + prod; `judge-entry` deployed both): **B** athlete-gated
registration + per-type admin grant/revoke (single General waiver confirmed
final); **C** was already complete; **D** codeless judge access (one code per
event, URL/6-digit/QR, host "Judge access" card, public unlock page, anonymous
score writes via `judge-entry`); **E** per-event scoring config (1-or-2 judge
panels with averaged execution + calculator-vs-simple default entry mode).
Residual 👤: happy-path smoke of D on staging (generate a code on a live
event, unlock on a second device, enter a score).

**Next major additions — recommendation 2026-07-31, 💬 Nate to triage.** Full reasoning in
[findings §6](specs/2026-07-31-review-and-cleanup-findings.md). The short version: the *feature*
surface is essentially complete for a first season; what's thin is **running a real meet day**
and **knowing when something is wrong**, and both of this review's live findings are instances
of that rather than coincidences.

1. **Session assignment — detect orphans + bulk assign** (the §L.2 subset above). Now
   correctness-bearing, not convenience. Smallest of the three and unblocks the others.
2. **Meet-day operations console** — one host screen for check-ins, sessions underway, scores
   in vs. expected, and what's stuck. Mostly *composition of existing read models* (cheap
   post-Phase-2/3), and meet day is when the product is judged by people who didn't choose it.
3. **Operational alerting as ONE initiative** — the backup fails silently, a judge-code brute
   force would be invisible, orphaned scores are invisible. `scheduled-dispatch`'s
   `daily-digest` already exists and is the natural home; extend it into a real health check and
   make failure of the check itself loud. Retires several separate open items at once, and is
   the internal half of the analytics/Sentry idea in §6.2 below.

**Further out (lower priority than they look):**
- **PDF certificates** — real value, zero urgency; nothing depends on it.
- **External API** — premature; no external consumer exists and it would freeze interfaces that
  are still moving.

**Residual from shipped work:**
- ~~Enroll TOTP factors~~ ✅ **done 2026-07-19** — Nate + Julia both enrolled; admin
  accounts now get the aal2 protection.

## 6. Proposed additions (Claude, 2026-07-16 — NOT yet committed; Nate to triage)

Suggested from a post-emv2 read of the platform; some have shipped, others are pending:

1. **In-app help / host & manager guides.** The feature surface is now large (hosting,
  waitlists, add-ons, refunds, finance). Short task-oriented docs (or contextual help
  links) reduce Julia-as-support and make fall-season onboarding of hosts cheaper.
2. **Privacy-friendly analytics + Web Vitals** (Plausible/PostHog) once real users
  arrive; optional Sentry for stack traces with releases.
3. ✅ **Data-layer scale path — Phases 0–5 ALL DONE**
  ([spec](specs/2026-07-24-data-layer-scale.md) — measurements, danger lists, and the
  per-phase narrative live there, not here).

  | phase | what moved | measured win |
  |---|---|---|
  | 0 | silent 1000-row truncation fixed | correctness |
  | 1 | staging `scripts/seed-scale.mjs` + boot instrumentation | baseline: **21.1 s** cold boot, **28.95 MB** localStorage at 50k regs / 52k scores |
  | 2 | `scores` → scoped slice (`slice-cache.ts`, `scores-slice.ts`) | −14.46 s / −21.7 MB from boot; per-event refetch ~0.78 s |
  | 3 | `registrations` → scoped slice (~61 consumers) | −22.9 s / −24.7 MB from boot; per-event refetch ~0.4 s |
  | 4 | `people` → scope which ROWS load (5 on-demand shapes + `public_competitors`) | boot read is self + managed-club rosters only |
  | 5 | localStorage restricted to Tier 1 + small Tier 2 | 28.95 MB → **~53 KB** |

  Two things worth remembering because they cost real time:
  - **Phase 4 was rewritten mid-flight.** The original plan ("slim the `people` projection")
    was found wrong in both directions by a 2026-07-26 recon, with a danger list running
    through membership pricing, synchro eligibility, and nationals categorization. Scoping
    which ROWS load sidesteps all of it — every row returned is still complete.
  - **Phase 4 fixed a real pre-existing bug:** anonymous visitors to the public Results page
    saw blank athlete names. Verified live against prod, then confirmed fixed. (Re-verified
    still fixed 2026-07-31 — `public_competitors` serves 2,636 rows to anon.)

## 7. ✅ RESOLVED 2026-07-28 — expensive Tier-2 reads on `memberships` / `invoices` / `invoice_items`

Scale-seeding surfaced these three Tier-2 tables timing out (`canceling statement due to
statement timeout`) under ANON/AUTHENTICATED past ~10k rows. **Fixed by scoping the QUERY, not
the policy:** `loadAll` resolves the caller's person id + managed-club ids first, then reads
only what RLS already permitted that caller. Authorization is unchanged; anon skips these
fetches entirely. League-wide consumers moved to on-demand admin slices that gate every
computed total on `status === 'ready'`.

Measured on 0.5×-scale staging, real club-manager JWT: `memberships` ~5.3 s → **455 ms**,
`invoices` ~5.5 s → **277 ms**, `invoice_items` ~7.4 s → **365 ms** (10–20×, clear of the
timeout). Merged to `main`.

⚠️ **A policy-shape rewrite was tried first and MEASURED-REJECTED — do not retry it.** Wrapping
the cross-table RLS subqueries in SECURITY DEFINER helpers made `invoice_items` *worse*
(7.4 s → 11.4 s): Postgres hash-materializes a raw correlated `EXISTS` into one semi-join scan,
but a function call is opaque to the planner and pays ~0.9 ms per outer row. Migration
`20260728015930` kept only the hygiene win (one SELECT policy instead of two identical ones;
explicit insert/update/delete replacing a `for all` that silently granted DELETE) — justified
as correctness, **not** performance. Second time an "obviously correct" RLS-predicate theory
lost to measurement here (see `20260711023234`).

Full narrative, both attempts' data, and the exact query shapes:
[`specs/2026-07-24-data-layer-scale.md`](specs/2026-07-24-data-layer-scale.md) (Tier 2 section)
and `supabase/README.md`'s entry for `20260728015930_tier2_rls_policy_cost.sql`.

**Residual — `payments` still carries the same risk, unscoped.** It is fetched via a plain
unscoped `fetchAllRows` in `loadAll` — the exact shape the three tables above had before this
fix. Cold-boot `syncFromSupabase()` at 0.5×-scale (9,000 payments) took 2.4–7.9 s; not
re-measured in isolation. **Give it the same self + managed-club query scoping before a real
season pushes it past 10k rows.** Current prod volume is small (invoices 43, invoice_items 69,
memberships 39), so this is not urgent — but it is the one known remaining hole in the tiering
assumption.

## Architecture watch-list

Not gaps yet — trigger conditions live in
[`production-readiness.md`](production-readiness.md#architecture-watch-list-not-gaps-yet--written-down-so-they-dont-surprise-us):
`loadAll` scaling cliff, realtime-only-on-scores staleness (→ proposal 6.1 above),
the `record-waiver-signature` stale-hold wart (→ quality pass 3.7).
