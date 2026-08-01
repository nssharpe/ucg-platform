# 2026-07-31 — General review, cleanup, and security pass

Scope: everything shipped since `docs/whats-next.md` was last reconciled (**2026-07-19**,
commit `693b2a8`) through `main`@`0e2757f`. That window is 147 files / +14,553 / −3,343 —
Phases 2–5 of the data-layer scale work, security-hardening Phase 3, the UI/UX review fixes,
the UCG-events/seasons work, and the steering refactor. Everything before that line was
reviewed and reconciled once already.

Method: repo-health baseline → environment reconciliation (deployed vs. repo) → dependency
audit → static read of the highest-risk surfaces → live exercise of the app → doc reconcile.

---

## 0. Baseline (all green)

| Check | Result |
| --- | --- |
| `npm run build` | ✅ exit 0 |
| `npx eslint .` | ✅ exit 0, zero findings |
| `npx vitest run` | ✅ 69 files / **1106 tests** passed |
| dev-auth firewall (PostToolUse hook) | ✅ no `VITE_DEV_AUTH`/`initDevAuth` in `dist/assets` |

So the repo is healthy on its own terms. Everything below is what those gates do not cover.

### Coverage

Anonymous paths were exercised live against **prod** (§4.1–4.4). Signed-in paths were exercised
live against **staging** via the dev-auth switcher (§4.6).

*Corrected mid-review:* this section originally said no signed-in path could be exercised,
because a stale note claimed staging's dev-auth vars were blank. **They are not** —
`.env.staging.local` carries a full athlete/manager/admin credential set, and
`npm run dev -- --mode staging` (the `ucg-staging` launch config, port 5177) auto-logs in with a
real JWT. The check that would have caught this is one grep of the env file, which is now what
§4.6 documents.

Still uncovered: a real **paid** money path. Staging has 60 payments, all `failed`/`pending`,
so no revenue figure anywhere is non-zero. Totals are proven to *gate* correctly (§4.6) but
have not been proven to *add up* against real paid rows.

---

## 1. Security — environment reconciliation

### 1.1 ✅ `verify_jwt` trio is correct on BOTH projects

The three functions that must stay `verify_jwt = false` are exactly the three that are:

```
prod    (wkyerxlgricfphopocoz): stripe-webhook, sms-webhook, notify-manager-access-denied
staging (xogpiksqtkayxwmczlbx): stripe-webhook, sms-webhook, notify-manager-access-denied
```

All other 22 functions are `verify_jwt = true` on both. No drift, no silently-reset flag.

### 1.2 ✅ `request-refund` redeploy — ALREADY DONE, the open item is stale

`CLAUDE.md` still carries a 👤 action: *"`request-refund` may still need a redeploy to
prod+staging (function deploys were classifier-blocked 2026-07-22)."* It was redeployed
**2026-07-23** to both: prod `v4`, staging `v2`. **Remove the action item.**

### 1.3 ✅ FIXED THIS SESSION — staging was missing two functions prod has

| slug | repo | prod | staging (before) | staging (now) |
| --- | --- | --- | --- | --- |
| `report-problem` | ✅ | ✅ v2 (07-17) | ❌ absent | ✅ **v1 deployed** |
| `admin-reset-mfa` | ✅ | ✅ v2 (07-18) | ❌ absent | ✅ **v1 deployed** |

Every other function existed in all three places, and nothing is deployed that isn't in the
repo. The impact was not a prod vulnerability — it was that **staging could not exercise the
in-app problem reporter or the MFA break-glass path**, so neither could be smoke-tested before
a prod change. `admin-reset-mfa` is the AAL-guarded recovery path for a locked-out admin: the
one function you least want to first exercise in prod.

Deployed under the standing authorization (zero-risk, staging only). Post-deploy verification —
the `verify_jwt` PostToolUse hook did **not** report, so it was checked by hand per the rule in
`CLAUDE.md` ("if that check reports it could not run, verify manually"):

```
STAGING total: 25   (was 23 — now matches prod exactly)
verify_jwt=FALSE: notify-manager-access-denied, sms-webhook, stripe-webhook   ← trio correct ✓
  report-problem   v1 verify_jwt=true
  admin-reset-mfa  v1 verify_jwt=true
```

Both new functions correctly landed `verify_jwt = true`, and the deploys did not disturb the
trio — which is the specific failure mode the hook exists to catch.

---

## 2. Security — dependency audit (`npm audit`)

22 vulnerabilities: 18 high, 2 moderate, 2 low. **Triage matters more than the count** —
almost all of the "high" entries are build-time-only and never reach a user's browser.

### 2.1 ⚠️ Only ONE finding is in runtime code that ships: `react-router-dom`

Installed `7.17.0`; advisory range `6.0.0 – 8.2.0`; **npm `latest` is `7.18.2`, which is also
in the vulnerable range.** There is no fixed release to upgrade to yet. Of the five advisories,
three do not apply to this app at all (RSC error handler XSS, SSR-hydration
`deserializeErrors` constructor injection, RSC-mode CSRF — this is a static client-side SPA on
GitHub Pages with no SSR and no RSC). Two are worth reasoning about:

- **Open redirect via backslash in `<Link>`/`useNavigate`** (GHSA-wrjc-x8rr-h8h6) — only
  exploitable where a user-controlled string reaches a `to=`/`navigate()` target. See §3.1.
- **DoS via inefficient route matching** — a server-side concern; on a static SPA the only
  victim is the visitor's own tab.

**Recommendation:** do NOT chase this with `npm audit fix` (there is nothing to fix to).
Pin the watch and re-check when a patched react-router ships.

### 2.2 The other 17 highs are dev/build-only — do not "fix" them

`vite-plugin-pwa` → `workbox-build` → `ejs`/`jake`/`filelist`/`rollup-plugin-off-main-thread`,
and `exceljs` → `archiver`/`glob`/`minimatch`/`brace-expansion`/`zip-stream`/`readdir-glob`.
npm's proposed remediation for both chains is a **downgrade**
(`vite-plugin-pwa@1.2.0`, `exceljs@3.4.0`, both flagged `isSemVerMajor`). Downgrading a
working PWA build and the XLSX export to chase transitive dev-dependency advisories is a
worse trade than leaving them. `postcss`, `rimraf`, `fast-uri` do have clean non-breaking
fixes and can be picked up with a plain `npm audit fix`.

**This closes open item §3.5 ("`npm audit` + Dependabot in CI") with an actual answer**
rather than an opinion: the audit is clean of anything that ships to a user today.

---

## 3. Security — code review of the anonymous surfaces

The newest unauthenticated entry points are `judge-entry` (anonymous score writes, shipped
2026-07-19) and the no-login token flows. These get the closest read because they are the only
places an unauthenticated stranger can cause a write.

### 3.1 ✅ The react-router open redirect is NOT reachable

Every `navigate()` and `<Link to={…}>` target in the app is an internally-computed string.
The only two URL params that influence navigation are in `Profile.tsx`: `return` is compared
`=== 'membership'` (used as a boolean, never as a destination), and `season` is interpolated
into the **query string** of a hardcoded `/membership` path. No user-controlled string ever
reaches a navigation target as a path. `navHistory.ts` navigates to `pathname`s off the app's
own recorded stack. **No action needed** — and this is why §2.1 is a watch item, not a fix.

*(Nit, not a vulnerability: `/membership?season=${seasonParam}` interpolates without
`encodeURIComponent`, so a crafted `season` can append extra query params. The destination
path is fixed and nothing downstream trusts those params. Worth a one-line fix if the file is
touched anyway.)*

### 3.2 ✅ The Phase 3 `error_logs` rate limit does not blind the brute-force audit trail

Worth checking because the two shipped a week apart: `judge-entry` logs every failed unlock to
`error_logs` as its brute-force audit trail, and Phase 3 LOW-2 then capped `error_logs` inserts
at 20/min per caller. They don't collide — `guard_error_logs_rate_limit()` bypasses on
`auth.role() = 'service_role'`, and `judge-entry` logs with the service-role client. The audit
trail survives. (The migration comment calls this out explicitly and names `judge-entry`.)

### 3.3 🔴 FINDING (medium) — `judge-entry` unlock is not actually rate-limited

The 6-digit code path is protected by a `await sleep(300)` after each failed attempt, described
in the source as "a soft brake against code-guessing — 6 digits is only 1e6 combinations."
**That brake does not throttle anything.** It delays one request's own response; it does not
serialize concurrent requests, and each attempt lands in a separate Deno isolate.

**Measured against staging** (`judge-entry` v2, the same build as prod v2), invalid codes,
warm:

| concurrency | wall clock | effective rate |
| --- | --- | --- |
| 1 | 1083 ms | 0.9 / sec |
| 10 | 1364 ms | **7.3 / sec** |
| 40 | 2329 ms | **17.2 / sec** |

**The load-bearing observation is that all 40 concurrent attempts returned `401` — none was
throttled, rate-limited, or rejected.** There is no cap to hit. The per-second figures are
single samples from one client (and the 40-batch ran against an already-warmed function), so
treat them as illustrative of the *shape* — throughput rises with concurrency — not as a
calibrated attack timeline. A serious attacker distributes the requests; the point is that
nothing server-side would notice.

Three things compose here, and the third is what makes it practical:

1. **No cap.** The only defense is per-request latency, which parallelism erases.
2. **Brute forcing is also an unbounded anonymous write amplifier into `error_logs`.**
   Every failed attempt inserts a row via the service role, which — per §3.2 — *deliberately
   bypasses* the 20/min rate limit. So the one anonymous endpoint that invites a million
   guesses is the one endpoint whose logging is exempt from the anti-spam limit added for
   exactly this class of abuse. It also feeds `scheduled-dispatch`'s `daily-digest`.
3. **A validity oracle lets codes be harvested outside the event window.** `unlock` returns
   `401 "Invalid or expired access code"` when no row matches (line 109), but
   `403 "This event is not open for scoring"` when a row *does* match and the event simply
   isn't `live` (line 122). An attacker can therefore enumerate valid codes at leisure — weeks
   before a meet, when nobody is watching — and use them the morning the event goes live.

**Impact:** a successful guess yields the long token, i.e. the ability to write/overwrite
scores for any athlete and apparatus at that event for as long as it is live. Not financial,
but it is competition integrity, and the `entered_by` stamp (`judge-code:<rowId>`) cannot
distinguish the real judge from the attacker — they share one code by design.

**Mitigating context:** codes are CSPRNG-generated (`crypto.getRandomValues`), one active code
per event, hosts can regenerate/revoke, and the window is only while `status = 'live'`.

**Suggested fix (cheap, no schema churn):**
- Return the **same** `401` for "event not live" as for "no match" — kills the oracle for one
  line of code.
- Add a real counter keyed on the caller (the `x-forwarded-for` first hop, same identity the
  `error_logs` trigger already computes) — e.g. 10 failed unlocks per 10 min, then hard-fail.
  Reuse the existing rate-limit pattern rather than inventing one.
- Cap the failed-unlock `error_logs` writes per caller so the audit trail can't be turned into
  a flood.

Codes are one-per-event, so a legitimate judge fails a handful of times at most; a limit this
tight costs nothing real.

*Note: this test wrote ~61 `judge-unlock-failed` rows to STAGING `error_logs`. Harmless, but
if a staging `daily-digest` fires it will report them — they are mine, not an attack.*

---

## 4. Exercising the app — what the build/lint/test gates don't cover

Done against **live prod** (`https://nssharpe.github.io/ucg-platform/`) as a true anonymous
visitor, plus direct anon-key queries against the prod REST API.

### 4.1 ✅ Phase 5's localStorage restriction is confirmed live in prod

The persisted `ucg-db-v1` snapshot on a real anon session contains exactly the intended keys:

```
seasons, levels, clubs, events, coupons, waiverDocuments, people, invoices, carts
```

`scores` and `registrations` are **absent** — Phases 2/3 moved them off global hydration, and
Phase 5's persistence allowlist is holding. `people` is 0 rows for an anon visitor (correct —
RLS hides `people` from anon entirely; that is exactly why Phase 4 wired up
`public_competitors`, which reads 2,636 rows to anon and is working).

### 4.2 ✅ Phase 4's anon-names fix is intact

`public_competitors` returns 2,636 rows to an anonymous caller; `people` returns 0. The thin
by-ids shape that fixed the blank-athlete-names bug is live and correct.

### 4.3 ✅ The `camp_survey` column-revoke trap is correctly handled

`select=*` on `registrations` as anon returns `42501 permission denied` — but the app never
does that. `REGISTRATION_COLUMNS_NO_SURVEY` in `supabase.ts:71` matches the migration's
column-scoped re-grant (`20260717205348`) **exactly**, field for field, and the app-shape query
returns 200. Worth stating plainly because a naive `select('*')` audit reads this as a broken
grant — it is the documented trap, and the code is on the right side of it.

### 4.4 🔴 FINDING (high, live in prod) — posted scores are invisible on the public Results page

**Every event's public Results page currently reads "No scores posted yet — results appear here
live as judges enter them." Three scores exist.**

```
scores on test-meet (visible to anon):
  test-meet|test-reg-mag-dev|FX          final 10.000
  test-meet|reg-1781802670413-363719|FX  final 10.700
  test-meet|reg-1782154357421-209408-WAG|UB final  9.900
```

**Root cause — not a slice regression.** All **35 anon-visible** registrations in prod have
`session_id = null`:

| event | registrations | null `session_id` |
| --- | --- | --- |
| `test-meet` | 29 | **29** |
| `meet-1782156507226` | 6 | **6** |

*(These are the rows RLS exposes to an anonymous caller. A privileged total could not be
obtained — the `SUPABASE_SERVICE_ROLE_KEY` in the local `.env.local` is rejected as
`Invalid API key`, presumably rotated; it appears unused by any script, since `seed-scale.mjs`
reads `STAGING_SUPABASE_SERVICE_ROLE_KEY` and `backup-db.mjs` uses a Postgres connection
string. Worth deleting the dead value rather than leaving a stale credential in the file.)*

`sessionResults()` (`src/lib/scoring.ts:29-30`) filters both registrations and scores strictly
on `sessionId === <selected session>`. The Results page always has a session selected
(`Results.tsx:75` falls back to `event.sessions[0]`), so a null-session registration matches no
session and is dropped — along with its scores. Verified by switching the selector across all
three of `test-meet`'s sessions: all empty.

**How rows end up null — partly verified, partly open.**

*Verified:* both events are `registration_mode: 'by-discipline'` (not `by-session`), and both
currently have `event_sessions` rows covering every discipline they run (MAG/WAG/TNT). On that
path `RegistrationEditor.tsx:611-615` assigns the first session matching the discipline, so a
registration written **today** against either event would get a session. The `sessionsMissing`
Save gate (`:787-793`) is a by-session-only guard and is not involved here.

*Also verified:* **nothing backfills.** `pushEvent`/`pushEventSessions` (`supabase.ts:999-1016`)
`remoteReplace` the `event_sessions` rows and update registrations' `squad_id`, but never touch
`registrations.session_id`. So once a row is null it stays null, and — because `remoteReplace`
deletes and reinserts sessions — a session whose **id** changes on an edit silently orphans
every registration pointing at the old id, with the same invisible-scores consequence.

*Open:* whether these particular rows were written before the sessions existed, or by a
non-editor path (seed/import/dev fixtures). **This cannot be settled from the data** —
`event_sessions` has no `created_at` column, so the two creation events can't be ordered. I had
initially written "sessions were added later" as the cause; that was inference, not evidence,
and it is withdrawn. It does not change the remedy.

emv2 **§L.2 (the deferred session-assignment tool)** is the systematic remedy for reassigning
sessions in bulk; the consequence for the public Results page was not previously written down.

**Why it matters more than the test data suggests.** On meet day this failure mode is silent
and inverted: judges post scores, the public page says none exist, and nothing anywhere —
public or admin — reports "N scores are posted but not attached to any session." A host would
reasonably conclude that scoring or the judge devices are broken.

**Two separate fixes, both worth doing:**

1. **Data (immediate, prod):** assign sessions to the scored registrations via the host roster
   editor, which already has a per-row session dropdown (`Events.tsx:1541`). This is the
   existing manual path and is sufficient today; it does not need §L.2.
2. **Product (small, real):** make the empty state tell the truth. In `Results.tsx`, when
   `eventScores.length > 0` but the session-filtered result is empty, say so — e.g. *"3 scores
   are posted but not assigned to a session"* — instead of `NO_SCORES_MSG`. One conditional,
   and it converts a silent meet-day failure into a self-diagnosing one. A matching admin-side
   warning on the host roster page would close the loop.

*Caveat on method: two anon count-queries (`Prefer: count=exact`) transiently returned 401/500
on first run and 200/206 on re-run. That was a cold-start blip, not a finding — re-verified
clean. Flagging it because a single-shot probe here would have produced a false alarm, which is
the third such false environment alarm this month.*

### 4.5 ✅ The `status === 'ready'` gating discipline held up under audit

Phases 2–5 applied this gate by hand across ~36 files, which is exactly the shape that rots.
It didn't. Every consumer of a scoped or admin slice was cross-checked against whether it
gates before computing:

- **Gated correctly** — Finance (`invoicesStatus === 'ready'`, and the export button is
  `disabled` until ready), AdminClubs (`peopleReady`/`membershipsReady`, renders `…` not `0`
  for not-yet-ready counts), Cart, Club, Home, AdminMembers, RefundReview, Communicate,
  Nationals, Results, Judge, Events, EventCheckinCard, NationalsDashboard.
- **Ungated but correctly so** — `ClubForm`, `UserRoles`, `Promos`, `Sanction`,
  `FinalsLineupEditor`. Each uses its slice purely as a **name-lookup / picker list**
  (`.find(p => p.id === …)` for display), never as an aggregate. A partial list here shows a
  shorter dropdown for a moment; it cannot produce a silently wrong number.

A first pass grepping for the literal `status === 'ready'` found only 3 sites and looked
alarming — the real gates are mostly bound to intermediate variables (`peopleReady`,
`invoicesStatus`). Recording that so the next audit doesn't re-raise the false alarm.

### 4.6 ✅ Money surfaces verified SIGNED-IN and live (staging, dev-auth admin)

The gap §0 originally flagged is now closed. Run against staging on `ucg-staging` (port 5177),
auto-logged-in as the seeded league admin with a real JWT — so RLS, roles, and the slice layer
all behaved as they do for a real admin.

The question that mattered: **is a `$0` on a money page a real zero, or an unready slice
rendering as zero?** Statically indistinguishable; live it is decidable.

| surface | result |
| --- | --- |
| **Finance** | Renders. **Export button ENABLED** — and it is `disabled={… \|\| invoicesStatus !== 'ready'}` (`Finance.tsx:243`), so this is direct proof the slice reached `ready`. Totals $0. |
| **AdminClubs** | Roster counts render as **real numbers** (10, 9, 11, 12, …), not the `…` placeholder shown while not ready — so `peopleReady && membershipsReady` both resolved. Active = 0. |
| **AdminMembers** | **84 people** — matches the documented staging baseline exactly. All memberships `NONE`. |
| **RefundReview** | Renders; 0 pending, empty history. |
| **Home admin dashboard** | 0 active members · **9 clubs** · 0 clubs-with-members · 4 events. |
| **Console** | **Zero errors** across every page above. |

**And the zeros are genuine, not swallowed failures.** Queried staging's money tables directly
with the same admin JWT: 14 invoices, 14 invoice_items, 70 memberships, and **60 payments of
which every single one is `failed` or `pending` — none `paid`**. `buildFinanceTxns`
(`finance.ts:135`) skips any payment that isn't `paid`/`refunded`. So $0 is arithmetically
correct, and every cross-surface number agrees (0 active memberships ⇒ 0 clubs-with-members ⇒
all `NONE` on Members).

Both halves had to hold to call this verified: the slice reaching `ready` **and** the total
being right given the data. A ready slice with a wrong total, or a correct-looking zero from an
unready slice, would each have looked fine in isolation.

**What this does not prove:** no revenue figure on staging is non-zero, so the totals are
proven to *gate* correctly but not to *add up*. That needs either a paid payment on staging or
the same sweep against prod after Stripe go-live.

---

## 5. Repo hygiene

### 5.1 ✅ Migration state is fully reconciled

`supabase migration list --linked` shows **every** local migration applied to prod and **no**
remote-only rows — 105 migrations, local and remote identical through `20260728015930`. No
drift in either direction.

### 5.2 ✅ `fix/invoices-delete-admin-only` is obsolete, not a dangling security fix

This is the only local branch not merged into `main`, and it *looks* alarming: a single commit
carrying `20260724212606_invoices_delete_admin_only.sql`, whose own header documents a
live-probed staging exploit (a club manager could `DELETE` their own club's `invoices` rows —
permanent financial records — straight from PostgREST).

**It was superseded, not forgotten.** The shipped `20260724211801_invoice_write_lockdown.sql`
goes further and explicitly cleans up after it: it drops `invoice_admin` *and* the branch's own
`invoice_admin_insert`/`_update`/`_delete` policy names (its comment notes they had been pushed
to staging out of band), then creates `invoices_delete … using (is_admin())` plus admin-only
insert/update, and the same for `invoice_items`. `20260724211801` is applied to prod. The
DELETE hole is closed and closed harder than the branch would have closed it.

**So the branch is safe to delete.** Verified rather than assumed, because "unmerged branch
containing a security migration" is exactly the shape that should not be deleted on vibes.

### 5.3 Branch cleanup — 32 local branches are safe to delete (needs a nod)

31 are fully merged into `main`; the 32nd is §5.2's superseded one. Nothing else is unmerged.

```
agy/fix-squad-fk            feat/emv2-p2                feat/ucg-event-feedback-2
agy/smoke                   feat/emv2-p3                feat/ucg-rebrand
claude/charming-jones-f469b4 feat/emv2-p4               feedback-2026-06-24-phase6-my-registrations
feat/batch-2026-07-17       feat/emv2-p5                fix/digest-staging-webauthn
feat/component-tests        feat/emv2-p6                fix/event-host-roster-null-host-club
feat/data-export-delete     feat/focus-refresh          sec/hardening-phase3
feat/dev-test-auth          feat/passkey-skips-totp     stripe-s2-backend-payment-loop
feat/e2e-ci                 feat/payments-recon         stripe-s3-fe-checkout
feat/emv2-p0                feat/season-lifecycle       stripe-s3-server-total
feat/emv2-p1                feat/season-ucg-events      stripe-s4
feat/ucg-event-creation-feedback                        fix/invoices-delete-admin-only  ← §5.2
```

Deliberately **not** deleted in this session — branch deletion is cheap to do and annoying to
undo, so it wants an explicit yes. `git branch -d` (not `-D`) will refuse anything unmerged, so
the 31 are safe by construction; `fix/invoices-delete-admin-only` needs `-D` and the §5.2
reasoning.

---

## 6. What to build next — a recommendation, for triage

Framing: the platform's *feature* surface is essentially complete for a first season. emv2 is
shipped, money works, scoring works, waivers work. What's thin is everything around **running a
real meet day** and **knowing when something is wrong**. Both of this review's live findings
(§3.3, §4.4) are instances of that, not coincidences — which is why the recommendation below is
weighted toward operations rather than new surface area.

### 6.1 Elevate emv2 §L.2 (session assignment) from "deferred" to next-up — it is now correctness

§L.2 was deferred as a scheduling convenience. **§4.4 changes what it is.** Registrations
without a `session_id` don't merely lack a schedule — their scores are invisible on the public
Results page, silently, with an empty state that says the opposite. Today the only remedy is
per-row dropdowns in the host roster editor, and nothing detects the condition.

Minimum useful scope (much smaller than the full §L.2 tool):
- **Detect and surface orphans.** "12 registrations in this event have no session" on the host
  page, and the truthful Results empty state from §4.4(b).
- **Bulk assign** by discipline/level — the 80% case, and what makes the detector actionable.
- **Protect the invariant on edit.** `pushEvent` deletes and reinserts `event_sessions`; a
  changed session id orphans registrations with no warning. Either preserve ids or reassign.

The per-team session-timed finals reminders — the part Julia actually deferred — can stay
deferred. This is the substrate underneath them, and it has its own justification now.

### 6.2 A meet-day operations console

Everything a host needs at 8am on competition day exists, but scattered across check-ins,
roster, judge access, scoring, and results. One screen answering: who's checked in, which
sessions are underway, how many scores are in vs. expected, what's stuck (unassigned sessions,
missing apparatus, unflashed scores), and where the judge access code is.

This is the highest-leverage build for the fall season because meet day is when the product is
judged by people who did not choose it. It is mostly **composition of existing data**, not new
capability — the read models already exist post-Phase-2/3.

### 6.3 Operational alerting — one initiative, not three scattered ones

There is a pattern worth naming: **the platform cannot tell anyone when it is failing.**

- The daily DB backup fails **silently** (`whats-next` §1.5) — proven, and it is the stated
  stand-in until Supabase Pro/PITR.
- A `judge-entry` brute force would be invisible (§3.3) — it writes audit rows nobody reads.
- Unassigned-session scores are invisible (§4.4).
- `scheduled-dispatch`'s `daily-digest` exists and is the natural home for all of it, but today
  it only covers new `error_logs` + stuck-pending payments.

Treat these as **one** initiative: extend the digest into a real health check (backup
succeeded/failed, anomalous `error_logs` kinds and rates, orphaned scores, stuck payments,
coupon-reservation leaks), and make failure of the *check itself* loud. This is cheap relative
to its value and it retires several separate open items at once. The proposed
Sentry/analytics work (`whats-next` §6.2) is the external-facing half of the same idea.

### 6.4 Reclassify invoice numbering as a launch blocker, not a quality pass

Currently a residual under §3.1, deferred to "the pre-launch data sweep… since all current rows
are test data." But the stated defect is that **the generators derive the sequence from a row
COUNT, which is not concurrency-safe** — and the trigger for that isn't a data sweep, it's the
first two people checking out simultaneously. Duplicate invoice numbers on real financial
records are painful to unwind after the fact and trivial to prevent before. It belongs with the
Stripe go-live gates, and the fix (a DB sequence) is small.

### 6.5 Lower priority than they look

- **PDF certificates** — genuine value, zero urgency; nothing depends on it.
- **External API** — premature. No external consumer exists, and it would freeze interfaces
  that are still moving.
- **In-app help / host guides** (`whats-next` §6.1) — real, but 6.2's console removes more
  support load per unit effort by making the product self-evident rather than documented.

---

## 7. Current Anthropic guidance, and the tooling actually worth adopting here

Researched against Anthropic's own docs rather than answered from memory. Most published
"Claude Code security" advice is about securing *the agent* (permissions, sandboxing, deny
rules, MCP allowlisting) — largely already satisfied here by the destructive-command-guard
PreToolUse hook and this repo's permission setup. The genuinely new and applicable thing is
one plugin.

### 7.1 The `security-guidance` plugin — recommended, with a real cost caveat

Anthropic shipped a free first-party plugin (2026-05-26) that reviews Claude's *own* code
changes for vulnerabilities in-session. It fits this repo unusually well because it is built
entirely on **hooks** — the same "enforcement, not reminders" model `CLAUDE.md` already commits
to — and because it takes **repo-specific rules**.

Three layers:

| layer | when | cost |
| --- | --- | --- |
| per-edit pattern match (~25 patterns: `eval`, `innerHTML`, `dangerouslySetInnerHTML`, unsafe deserialization, `.github/workflows/` edits) | every `Edit`/`Write` | **free** — no model call |
| end-of-turn diff review (authz bypass, IDOR, injection, SSRF, weak crypto) | every turn that changes files | a model call |
| agentic commit/push review (reads callers and sanitizers to kill false positives) | every `git commit`/`git push` Claude runs | several model turns |

**⚠️ The cost caveat is the decision, not the capability.** Both model-backed layers default to
**Opus 4.7**, and they fire on *every* file-changing turn and *every* commit. On a Pro plan
with an explicitly usage-optimized workflow, that is a material standing tax on all work, not
just security work. Three ways to take the value without the full bill:

- `ENABLE_PATTERN_RULES` only (`ENABLE_CODE_SECURITY_REVIEW=0`) — keeps the **free** layer,
  drops both model layers. **This is the recommended starting point.**
- `SECURITY_REVIEW_MODEL` / `SG_AGENTIC_MODEL` to route the reviews to a cheaper tier.
- `ENABLE_STOP_REVIEW=0`, keeping only the commit review — reviews once per commit instead of
  once per turn, which matches this repo's existing "verify before commit" gate.

Not enabled in this session: it costs usage on every future turn, which is Nate's call, and
`CLAUDE.md`'s routing rules are emphatic about not spending tokens by default.

```bash
/plugin install security-guidance@claude-plugins-official
```

Project-scoped enablement (so it applies to cloud sessions and anyone who clones) is
`enabledPlugins` in `.claude/settings.json`; user scope is per-machine and does **not** carry
into Claude Code on the web.

### 7.2 Repo-specific rules are written and checked in — `.claude/claude-security-guidance.md`

The plugin's extension points are the reason it's worth more here than a generic scanner:

- `.claude/claude-security-guidance.md` — prose threat model fed to the model-backed reviews.
- `.claude/security-patterns.yaml|.json` — deterministic regex/substring rules on the free
  per-edit layer. *(YAML needs PyYAML importable; JSON always works.)*

**Written this session and checked in.** It encodes the traps this repo has actually hit rather
than a generic OWASP list — `for all` silently granting DELETE, the RLS upsert trap, the
`coalesce(is_admin(), false)` fail-closed rule, the column-revoke no-op, the "don't wrap a slow
RLS subquery in SECURITY DEFINER" dead end, `--no-verify-jwt` not being sticky, never trusting
caller identity from a payload, `mode:'preview'` staying side-effect-free, the AAL guard, the
256-bit token rule, and the dev-auth firewall.

The file is **inert without the plugin**, so checking it in costs nothing and means the rules
exist and are reviewable independently of the enable/don't-enable decision. It also doubles as
a security checklist a human or a reviewer-tier subagent can read directly.

### 7.3 The rest of the stack, for completeness

- **`/security-review`** — built-in, covers only *changes on the current branch*. It had nothing
  to operate on here (clean tree on `main`), which is why this review used its methodology
  against standing surface instead of invoking it.
- **`/code-review ultra`** — user-triggered and billed; I can't launch it. Worth Nate spending
  one run on the money paths during the planned Max month.
- **Claude Security plugin** — multi-agent whole-repo scan. This is the closest match to the
  "deep external security review" option in
  `research/2026-07-17-security-review-options.md` (`whats-next` §1.6) and is worth adding to
  that brief as a cheaper first pass before paying for a human audit.
- **CI** — `npm audit` (see §2, and the fail-on-runtime-deps-only caveat).

---

## 8. Money-path security review (requested 2026-07-31)

Adversarial read of the ~4,400 lines under the `money-invariants` rule: checkout,
webhook fulfillment, the shared fulfillment core, both refund functions, the Stripe helpers,
and `pricing.ts`. Attacked the stated invariants rather than reading for style.

### 8.1 🟠 FINDING (low severity, real invariant violation) — concurrent refund approvals can exceed the cap, and can refund part of the service fee

`process-refund`'s `handleApprove` runs, in order:

1. read every **approved** `refund_requests.refund_amount_cents` for this payment → `priorRefundedCents`
2. `availableCents = payment.amount_subtotal − priorRefundedCents`
3. `refundCents = min(computed, max(0, availableCents))`
4. **atomic claim** — `update … where id = <thisRequest> and status = 'pending'`
5. `stripe.refunds.create(...)`

The claim at step 4 is keyed on **this request's own id**. It correctly prevents the *same*
request being processed twice. It does **not** serialize two *different* pending requests
against the *same payment*: both can complete step 1 before either reaches step 4, so both
compute `availableCents` from the same stale baseline.

**Why it doesn't become a large over-refund:** Stripe enforces its own cumulative ceiling per
charge, so a genuinely excessive second refund fails and `revertClaim` puts the request back to
`pending`. The money is protected — **by Stripe, not by this code.**

**Where it does leak.** Stripe's ceiling is the *charge*, which per M5 is
`amount_subtotal + service_fee`. Our cap is `amount_subtotal` alone, because
**the service fee is never refunded**. Stripe's ceiling is therefore strictly *higher* than
ours, and the gap is exactly the fee — so a concurrent pair whose total lands in that gap
succeeds at Stripe while violating our invariant.

Concrete: subtotal **$100**, fee **$3.30**, charge **$103.30**. Two pending requests of **$51**
each, approved concurrently. Both read `priorRefunded = 0` → both compute `available = $100` →
both pass the cap → both claim (different rows) → Stripe sees $102 ≤ $103.30 and allows both.
Net: **$102 refunded against a $100 subtotal — $2 of service fee refunded.**

**Severity is genuinely low** and I want to be accurate about why: it needs two *distinct*
pending requests against one payment, approved inside a sub-second read-then-write window, by a
`refund_manager`/`admin` — a manually reviewed queue, not an attacker-reachable path. A
double-click on one request is already blocked by the claim. The ceiling on the leak is the
service fee (3% + $0.30). Nothing here lets an outsider extract money.

**Suggested fix — the repo already has the right idiom.** `reserve_coupon` solved the identical
shape (concurrent claims against one shared budget) with `SELECT … FOR UPDATE` — *the lock is
the fix*. Do the same: a SECURITY DEFINER RPC that locks the `payments` row, sums approved
refunds, computes the cap, and claims the request **in one transaction**. That makes the
DB the authority instead of leaning on Stripe's ceiling as an accidental backstop.

⚠️ Per `money-invariants.md`, that change needs a reviewer-tier adversarial read before it
ships — it is not a mechanical edit.

### 8.2 ✅ Verified sound — the invariants that matter most

Checked by attacking them, not by reading comments:

- **C4 (entry priced as change).** `isChange = refRegs.every(r => r.paid || r.updated_pending)` —
  one brand-new reg in the line forces full entry pricing. I probed the obvious bypass, padding
  `ref_reg_ids` with unresolvable ids so the `every()` sees only paid regs: **closed**, because
  an explicit `missingRef` check rejects any id that doesn't resolve *before* pricing runs.
- **H4 (cross-account registration flip).** Every `ref_reg_ids` entry is checked against
  `athlete_id === personId` (self cart) or `club_id === clubId` (club cart), and membership/
  banquet targets get the equivalent check. A crafted line cannot make the webhook flip a
  victim's registration to paid.
- **Service-fee mirror.** `processingFee` is byte-identical in `pricing.ts` and
  `_shared/stripe.ts` (`Math.ceil(subtotal * 0.03) + 30`). No drift.
- **Preview stays side-effect-free.** The `PREVIEW BRANCH POINT` returns above every write; the
  single write above it (capacity hold-refresh) is individually `if (!isPreview)` guarded, and
  coupon reservation sits strictly below it.
- **Refund base and cap** use post-coupon `paid_cents` from `lines_snapshot`, and the service
  fee is excluded from `availableCents` — correct, and the reason §8.1's gap exists at all.
- **Stripe-failure handling** reverts the claim and, if the revert *also* fails, logs an
  explicitly-worded stuck-state entry to `error_logs` rather than failing silently.

### 8.3 Not covered by this review

Static analysis only — no live money moved. A real paid payment has never existed on staging
(§4.6: all 60 payments are `failed`/`pending`), so the fulfillment path, the M5 assertion, and
the refund math have not been exercised end-to-end against real Stripe state. **The $1 smoke +
refund in the [go-live checklist](../stripe-go-live-checklist.md) is what closes that**, and it
should be treated as a verification step this review depends on, not a formality.

---

