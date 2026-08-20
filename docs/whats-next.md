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

1. 🟡 **P3 refund prerequisites:** "UCG - Main" `is_league_host` ✅ verified by Nate
   2026-08-19 (and the flagged club is now hidden from the member-facing Club Directory /
   Profile pickers — it isn't a real club). Still open: grant `refund_manager` to whoever
   reviews refunds. (`finance_admin` for Julia ✅ confirmed 2026-08-19.)
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
7. ✅ **`security-guidance` plugin — INSTALLED + CONFIGURED 2026-07-31.** Enabled at
   PROJECT scope (so it covers cloud sessions and clones — user scope covers neither).
   The decision was cost, not capability: both model-backed layers default to Opus 4.7 and fire
   on every file-changing turn and every commit. Configured as **free pattern layer ON**,
   **per-turn Stop review OFF**, **commit review ON** (matching the existing verify-before-commit
   gate — review at the gate that matters, once per commit), both model layers routed to Sonnet.
   Repo-specific rules live in `.claude/claude-security-guidance.md` (prose, for the model
   layers) + `.claude/security-patterns.json` (14 deterministic rules on the free layer);
   verified 14 declared / 14 loaded / 0 skipped through the plugin's own loader. 💬 If you want
   the per-turn review back, drop `ENABLE_STOP_REVIEW` from `.claude/settings.json`.

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
     **Julia decided 2026-08-19 (UAT D-4):** wipe the whole record before go-live and keep
     the latest format, `UCG-YYYY-XXXX`. The format question is closed; the DB-sequence
     concurrency fix below is unchanged.
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
     **Partly resolved 2026-08-04** (a11y audit §6.3): the Browser pane *does* now deliver
     **trusted** key events — Tab moves focus and `:focus-visible` applies, so focus order IS
     testable. Activation still is not: the synthesized keys don't trigger default button
     activation (a "Return" press arrived with an empty `key`). So the manual tab-through is
     still the only way to confirm Enter/Space.

2. 🟡 **Accessibility audit to WCAG 2.1 AA — AUDIT DONE + 6 of 8 findings FIXED 2026-08-04.**
  Full report: [`specs/2026-08-04-accessibility-audit-wcag-aa.md`](specs/2026-08-04-accessibility-audit-wcag-aa.md)
  (axe-core 4.12.1 over 12 routes as athlete AND admin, plus manual keyboard/focus/ARIA and a
  375px reflow pass). Fixed and re-verified: **A1** `Field` rendered a visible label that was
  programmatically inert — 19 of 33 controls on `/me` had NO accessible name; fixing the one
  shared component wired all ~248 `<Field>` call sites and took `/me` from 13 critical axe
  violations to **0**. **A2** nav group labels 3.58:1 → 5.21:1 (every page). **A3** validation
  text 3.66:1 → 5.24:1 via a new `--coral-text` token (`--coral-600` stays put — it's an approved
  *fill*). **A4** `Modal` had no `role="dialog"`, no Esc, and no focus trap — proven by tabbing to
  the nav *behind* an open modal; now traps, labels, and restores focus (33 call sites).
  **A5** judge score stepper had `outline:none` with no replacement. **A6** the 375px Communicate
  overflow — root-caused to an **inline** `1fr 1fr` grid a media query can't override (and `1fr`'s
  `min-width:auto`); scrollWidth 536 → 375.
  **Still open:** **A7** loading states aren't announced (35 hand-rolled `Loading…` sites, no live
  region — WCAG 4.1.3) and the **loading/empty/error-state consistency** half: there is no shared
  `EmptyState`/`LoadingState` at all, ~30 inconsistent empty-state phrasings. Deliberately
  deferred as cleanup — see the report's §3 for the recommended components.
  ⚠️ Two things the report records that will otherwise be re-learned the hard way: a naive axe
  sweep **under-reports** (1.2 s settle = "0 violations" on `/me`; 3 s = 13), and sampling during
  CSS transitions **invents** contrast failures. It also lists 3 rejected non-findings.
  ⚠️ `eslint-plugin-jsx-a11y` **could not be installed** — no release supports eslint 10 (repo is
  on 10.8.0). Re-check later; it's the cheapest way to stop A1-class regressions at the source.
3. **New-club-request email** to `newclubinquiries@naigc.org` (transport exists, not wired).
4. 🤖 **Add-on refund policy per Julia (UAT D-5, 2026-08-19) — code diverges from policy.**
  Policy: an add-on refunds **in full until that add-on type's order deadline
  (`lastPurchaseAt`), and not at all after it**. Today `process-refund` applies the
  registration rule (100% at-or-before `last_date_to_edit`, else 75%) to `kind:'addon'`
  requests too (index.ts §"computedRefundCents"). Needs: per-add-on deadline lookup in
  `process-refund`, matching request-dialog messaging, and a refusal path for
  past-deadline add-on requests. **Money path — sonnet drafts, reviewer-tier reviews the
  diff before merge** per the CLAUDE.md routing rule.
5. **PWA production update path** — verify deploys reach users promptly; add a "new
  version available, reload" prompt if not.
6. **`npm audit` + Dependabot** in CI. **Audited 2026-07-31 — nothing that ships to a user is
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
7. ✅ **`record-waiver-signature` stale-hold wart — FIXED 2026-08-04** (staging + prod v13, no
  migration needed). **It was bigger than "small, known fix" implied.** Recorded as a stale
  *badge*; it was actually a stale badge **plus a dead end**. The function split its two UPDATEs
  on `paid_via='club'`, and the activate arm carried `.neq('paid_via','club')` — so a membership
  the club had already paid for could never reach `active` through the only pending-waiver →
  active transition that exists. A guard on the second UPDATE alone (the obvious reading of the
  old note) would have left those rows stuck in `pending-waiver` forever.
  Both arms now key on **`club_cart_pending`** — "is a payment outstanding?" rather than "who was
  going to pay?" — which is the same fact `membershipHolds` derives client-side. This also closed
  a latent hole: `paid_via` is nullable and `<> 'club'` evaluates to NULL, not true, so a row with
  an unset `paid_via` matched *neither* arm and stranded permanently.
  **Proven on staging against the deployed function**, not just unit-tested: the exact failure
  state (club paid, `club_cart_pending=false`, waiver still open) now lands `active` with
  `pendingPayment:false`, while the genuinely-unpaid case still lands `pending-club-payment` with
  `pendingPayment:true` — 6/6 assertions, fixtures cleaned up to zero rows. Column nullability was
  checked against **both live databases** rather than trusted from the migration text
  (`add column if not exists` is a no-op if the column already existed): `club_cart_pending` is
  `not null default false` on prod and staging, 0 NULL rows, and 0 rows are currently stranded, so
  no backfill is needed. User-visible: WaiverSign told such a guardian the membership "activates
  once their club pays" — a false statement — and now correctly says it is active.
8. ✅ **Public Results page hid posted scores — FIXED 2026-07-31.** The root cause was deeper
  than first recorded: `sessionResults()` scoped scores by `score.sessionId`, a snapshot taken
  at write time that does **not** follow a registration's session reassignment. So assigning
  sessions (the data fix) made the athletes appear but their scores still didn't — the score
  rows still carried `session_id = null`. Scores are now scoped by the **registration set**,
  which can't drift. `nationals-adapter.ts` had the identical pattern and got the identical fix
  (higher stakes there — it feeds rank/award math, so a dropped score is a wrong placement, not
  a missing row). The empty state is now truthful too (`unplacedScoreCount`). Verified live:
  all 3 prod scores render across 2 sessions with correct ranks.
  ⚠️ **Still true and worth designing around:** nothing back-fills `session_id`, and
  `pushEvent` deletes/reinserts `event_sessions`, so a session whose **id** changes on an edit
  still orphans its registrations — see §4's §L.2 note.
9. ✅ **`judge-entry` unlock rate limit — SHIPPED 2026-07-31** (staging + prod, migration
  `20260731180000`, `judge-entry` prod v3). The 6-digit code path's only defense was a
  per-request `sleep(300)`, which parallelism erases — 40 concurrent invalid codes all returned
  401, none throttled. Now capped at **15 failures per 5 min per caller** via
  `judge_unlock_attempts`. Design points, all proven live on staging: the **token/QR path is
  deliberately exempt** (160-bit, unguessable) so a locked-out judge always has a way in; a
  **successful unlock clears the counter**, which is what stops a shared-NAT venue locking
  itself out on its own judges' fumbles; a rate-limited request **writes nothing**, so refused
  traffic can't become the write amplifier this closes; and the count **fails open**, because
  locking a whole meet out over a hiccuped query is the worse failure. Also collapsed the
  **validity oracle** — no-match / code-collision / event-not-live all return the same 401 and
  message now, so codes can't be confirmed ahead of an event going live. Proven: 20 sequential
  bad codes → exactly 15×401 then 5×429; **40 concurrent → 40/40 blocked**; token path from the
  same locked-out caller still 401 not 429; a different key at 20 rows didn't block an unrelated
  caller. Full narrative: `supabase/README.md`'s `20260731180000` row.
10. ✅ **`report-problem` + `admin-reset-mfa` deployed to staging — DONE 2026-07-31.** They
  existed in the repo and prod but not in staging, so neither the in-app problem reporter nor
  the MFA break-glass could be smoke-tested before a prod change. Staging is now at 25
  functions, matching prod exactly; `verify_jwt` trio re-verified by hand
  ([findings §1.3](specs/2026-07-31-review-and-cleanup-findings.md)).

11. ✅ **Concurrent refund approvals could exceed the cap — FIXED 2026-07-31** (staging + prod,
  migration `20260731210000`, `process-refund` prod v6). `claim_refund_approval` now takes
  `select … for update` on the `payments` row and does the sum + cap + claim in one
  transaction — the same idiom `reserve_coupon` used. **Proven on staging:** the exact failure
  scenario (two concurrent $51 approvals against a $100 subtotal) now grants $51 + $49 = exactly
  $100, with the second call reading the first's committed total instead of a stale zero;
  sequential over-requests cap to the remainder rather than being refused; single-request
  idempotency intact; missing payment fails closed; anon cannot execute the RPC on either
  project. Full detail: `supabase/README.md`'s `20260731210000` row and
  [findings §8.1](specs/2026-07-31-review-and-cleanup-findings.md).

## 4. Event-management v2 residuals (deferred by design)

emv2 P0–P6 is complete ([spec](specs/2026-07-06-event-management-v2-requirements.md));
these were explicitly deferred, not dropped:

- **§L.2 session-assignment tool** + the per-team session-timed finals reminders that
  depend on it ("5 min after session ends" / Fri-10am) — Julia marked her section
  incomplete; only the admin-set `finals_lineup_deadline_at` nag + 10pm lock shipped.
  ⚠️ **The assignment half is no longer just a convenience** — §3.8 above shows an unassigned
  `session_id` silently hides that registration's scores from the public Results page. The
  detect + bulk-assign subset is now correctness work and is recommended as next-up
  ([findings §6.1](specs/2026-07-31-review-and-cleanup-findings.md)); the *reminders* half is
  what Julia deferred and can stay deferred.
- **Server-rendered receipt PDF attached** to the confirmation email (§I/§N4) —
  receipts today are client-side jsPDF on demand.
- ✅ **Camp registration popup simplification (§G) — SHIPPED 2026-07-23**, commit `4e05fb8`;
  this list and the spec were simply never updated (verified against the code 2026-08-04).
  `RegistrationEditor` is still shared, but it branches on `eventType === 'camp'`: no
  discipline/level/apparatus step, just a single confirmation line, and a new camp reg saves
  ONE row with a placeholder `discipline` (NOT NULL enum), empty `levelId`/`apparatus`, null
  `sessionId`. The branch lives *inside* the shared editor, so all three callers
  (`SelfRegModal`, `EditRegistrationModal`, `Club.tsx`) get it.
  ✅ **Residual CLOSED 2026-08-19:** Julia answered the open question (UAT Decisions D-1):
  camps are individual self-registration only — **"block it outright."** Shipped same day:
  `Club.tsx`'s `openEvents` picker now filters `eventType === 'camp'`, so managers can't
  register athletes for camps (or see camp regs from the club page). Rule recorded in
  `.claude/rules/registrations-and-camps.md`.
- **Host-payout formula** — 💬 needs a business decision (what a host club is paid out of an
  event's entry fees, and when). No implementation is blocked on anything technical. *The old
  "see Nate item 1.3" pointer here was dangling — §1.3 is Stripe go-live; there has been no
  host-payout item in §1 for some time.*

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
`loadAll` scaling cliff, realtime-only-on-scores staleness (→ proposal 6.1 above).
(The `record-waiver-signature` stale-hold wart left this list 2026-08-04 — fixed, §3.7.)
