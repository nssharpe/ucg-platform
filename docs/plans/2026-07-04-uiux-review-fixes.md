# UI/UX review fixes — task briefs by model class

**Source:** Live UI/UX review on 2026-07-04 (dev server, athlete + club-manager roles,
375px and 1280px, pages: Home, Events list/detail, RegistrationEditor modal, Cart →
Stripe checkout, My Registrations, Profile, Membership, Purchase History, Live
Results, Club Directory, Club Roster/Registrations). Every finding from that review
is a task below — including the minor ones.

**How to use this doc:** point a fresh session here and say which task(s) to run.
Standing rules from `CLAUDE.md` apply to every task:

- Subagent-driven execution; **one implementer at a time**, never parallel implementers.
- Implementer verifies with `npm run build` (not `tsc --noEmit`) +
  `npx eslint <touched files>` + `npx vitest run` before commit; add a vitest test for
  any new PURE logic.
- Any layout/CSS change: responsive sweep at **375 / 768 / 1280** via `preview_resize`
  + `preview_screenshot` (no horizontal overflow, topbar ≤ 2 lines, drawer works < 860px).
- Any color/text change: resolve tokens and check the actual fg/bg pair — WCAG AA
  (≥ 4.5:1 body, ≥ 3:1 large text/UI).
- Branch → implement → verify → merge to `main` → push (deploys). Don't stop to ask.
- Append a row to `docs/model-routing-log.md` after each routed task.

**Money gate (non-negotiable):** tasks marked ⚠️ touch money display/flows. Sonnet
drafts; the **controller fable-reviews the diff before merge/push** (CLAUDE.md
"Model routing" — the adversarial invariant read is not delegable).

Suggested batching: run H-tasks as one haiku session each (or pair small ones);
S1–S3 are independent; S4/S5 sequentially with the fable review at the end of each.

---

## Opus 4.8 (design / decomposition / review)

### O1 — Design the "money story" reconciliation (spec only, no code)

The review found three money surfaces that don't agree and have no connecting path:
cart said **Total $45**, checkout (server-priced) said **Subtotal $55 / Total due
$56.95**, and Purchase History shows an **UNPAID $65** invoice on a page subtitled
"Receipts processed on your account" with no way to pay it.

```
Read docs/plans/2026-07-04-uiux-review-fixes.md (tasks O1, S4, and the Purchase
History items in S6/H4) plus CLAUDE.md "Domain rules" and "Payments" sections, then
write a short design spec at docs/specs/2026-07-04-money-story-ux.md answering:

1. Cart display amounts are client-written and display-only; the server reprices at
   create-checkout-session. When may they legitimately diverge (price changed after
   the line was added, host-club $0, coupon, change-fee derivation)? Decide the UX:
   silently re-render cart lines at server prices on checkout load, or show a
   "prices were updated" notice, or both. Decide whether the cart page itself should
   recompute display prices from src/lib/pricing.ts on render instead of trusting
   stored cart_items.amount.
2. Unpaid invoices: what is an UNPAID invoice in this system (when is one created
   with no payment?), should it appear under "Purchase History", and what is the
   user's path to paying it? Options: link it back to the cart, a "Pay now" that
   rebuilds cart lines, or relabel the page "Invoices & receipts" and mark unpaid
   rows "awaiting checkout" pointing at the cart. Pick one.
3. Invoice numbering: two formats exist side by side (friendly "UCG-2026-0029" vs
   raw "UCG-I-1782503368540"). Find where each is generated (grep src/ and
   supabase/functions/ for 'UCG-I-' and 'UCG-'-prefixed id generation), decide the
   single user-facing format, and whether legacy ids get a display-side prettifier
   or a data migration.

Constraints: server-side recompute in create-checkout-session stays authoritative
(never trust client amounts); webhook fulfills from payments.lines_snapshot; no
cross-entity mega-checkout. The spec should hand S4 (below) its exact behavior and
define any Purchase History changes as a follow-up task list. Do NOT implement.
```

### O2 — Fable review gate for the ⚠️ money-display diffs

Not a dispatched task. After S4 and S5 (and S6 if its paid/pending derivation
touches `refRegIds` matching), the controller reads the full diff adversarially
before merge: look for a path where a display change becomes an authority change
(client amount trusted, `ref_line_type` trusted, paid flag flipped client-side),
for `refRegIds` heuristics, and for host-club-$0 / coupon / change-fee edge cases
rendering misleading totals. Log the review as its own row in
`docs/model-routing-log.md`.

---

## Sonnet 5 (default implementer)

### S1 — Fix the primary coral contrast token (systemic AA failure) ✅ DONE 2026-07-25

> Shipped: `.btn.primary`, `.btn.primary:hover`, `.nav-link.active`, `.btn:disabled`,
> `.btn.primary.small`, plus three instances the original brief missed (`::selection`,
> `.sp-chip.excluded`, `.rank-chip.r1` — all white-on-coral-500 at 2.94:1).
> Chose navy-800 text on coral-500 (**4.78:1**), matching the pairing the 2026-07-19
> rebrand had already validated on `.badge.err`. Hover had to LIGHTEN, not darken —
> with dark text every darker ramp step fails (coral-600 3.84:1, coral-700 2.41:1) —
> so a new `--coral-400` (#f57b5f, **5.41:1**) is the primary-button hover.
> Disabled is now a flat `--line` surface with `--ink` text (**9.81:1**) at opacity 1;
> the brief's suggested `--ink-soft` was only 3.80:1 and would have failed.
> Verified live at 375/768/1265 by DOM sweep of every coral-backed element
> (screenshot capture was wedged, as in the 2026-07-20 session).
> The green-badge sub-item was already closed by the rebrand.

Measured: white `#fcfcfc` text on `--coral-500: #f46949` = **2.94:1** at 12.5–14px.
This token is every primary CTA (Register, Check out, Save, View membership, Open
results) AND the active sidebar nav item. Fails WCAG AA everywhere it appears.

```
Fix the app-wide primary-button/active-nav contrast failure.

Context: src/index.css defines the brand tokens (--coral-500 #f46949, --coral-600
#e2553a, --coral-700 #b23a1e, --navy-900 #14202c, --white #fcfcfc). White-on-coral-500
measures 2.94:1 — fails AA (4.5:1 small text; also misses the 3:1 large-text bar).
Two candidate fixes, pick after checking both in the running app:
  (a) keep coral-500 backgrounds, switch button/active-nav TEXT to --navy-900
      (≈5.6:1, keeps the bright brand color), or
  (b) darken primary-button backgrounds to --coral-700 with white text (≈5.6:1).
Whichever you pick, apply it consistently: primary buttons, the active sidebar item
(Layout.tsx / index.css), and hover/active states (hover must also pass — check the
hover token, likely --coral-600 at 3.76:1 with white, which still fails).

Also in scope (same token pass):
1. Disabled primary buttons are coral at opacity 0.45 (seen on the RegistrationEditor
   Save) — reads as nearly-enabled and drops effective contrast further. Restyle
   disabled as a flat gray surface (e.g. --line background, --ink-soft text) with
   opacity 1.
2. The green "✓ ... Membership Active" topbar badge (--green-600 #2e7d52 on
   --green-100 #ddefe4) measures 4.21:1 at 11.5px — nudge --green-600 darker until
   the pair clears 4.5:1 (adjust anywhere else --green-600 is used only if it breaks).
3. While touching button styles: primary CTA labels render at 12.5px in places —
   raise the button font floor to 14px if it doesn't break topbar/card layouts.

Do NOT restyle secondary/outline buttons, the navy sidebar, or status pills beyond
the green badge above.

Verify: compute the actual contrast ratios of every fg/bg pair you produce (resolve
the CSS vars; show the math in your report). Run the app (dev auto-login) and
screenshot: home, an event detail (Register CTA), cart (Check out), sidebar active
state, a disabled Save in the registration modal — at 375px and 1280px. Then
npm run build, npx eslint <touched>, npx vitest run. Responsive sweep per CLAUDE.md.
```

### S2 — Profile sticky save bar: opaque surface + reserved space

> Shipped in two passes. Layout half (2026-07-20, commits `74ebf8e`/`ba15c4a`): opaque
> `--surface` background, `--line` border, `--shadow-lg`, rounded corners, inset from
> the card edges, required-fields message moved inside the bar with `flexWrap`.
> Contrast half (2026-07-25): the bar's "Unsaved changes"/"Required: …" text was
> `--coral-600` (`#e2553b`) on `--surface` (`#fcfcfc`) = **3.66:1, fails AA** for
> 13px/600-weight text — switched to `--coral-700` (`#b23a1f`) = **5.82:1**, verified
> live via `getComputedStyle` → `rgb(178, 58, 31)` on `rgb(252, 252, 252)`.
> Reserved space: confirmed via live geometry read (no reserved padding added) — at
> 375px, scrolled to true max scroll, the last field (Dietary notes) sits ~57px above
> the bar's top edge even with the 2-row "Unsaved changes" state; the bar never covers
> a trailing field because it's the last element in flow, not `position: fixed`. Mobile
> nav drawer (`.sidebar`/`.nav-overlay`, z-index 60/50) confirmed to stack above the
> bar (z-index 10) both in CSS and live with the drawer open.

```
Fix the Profile page's floating Save/Discard bar (src/pages/Profile.tsx, styles in
src/index.css or inline).

Bug (reproduced at 375px and 1280px, dev auto-login as athlete → Profile → "Edit
profile"): the sticky bottom bar — "Save changes" button, "Discard", "Unsaved
changes" text, and the red "Required: Date of birth, …" line — has no opaque
background and no reserved space, so it renders directly OVER form fields (at 375px
it covers the Main club input and collides with the bottom-left dev-auth panel;
form controls under it are unreadable and untappable).

Fix: give the bar a solid --surface background, top border (--line) and --shadow;
add bottom padding equal to the bar's height to the form/scroll container so no
field can sit underneath; keep the required-fields message INSIDE the bar (it
currently floats separately), wrapping to multiple lines rather than overlapping
content; ensure the bar stacks above page content but does not cover the mobile nav
drawer. Check the red required-text color against the new bar background for AA.

Verify: at 375/768/1280 — scroll the whole edit form; no element is ever occluded;
the bar never exceeds ~2 rows at 375px; screenshots of top, middle, and bottom of
the form at 375px and 1280px. npm run build, npx eslint <touched>, npx vitest run.
```

### S3 — Profile edit mode is dirty on load ("Unsaved changes" with no edits)

> Shipped 2026-07-25. Root cause was simpler than the brief guessed: there was no
> dirty check at all — the "Unsaved changes" span rendered unconditionally whenever
> `editMode` was true. Added `isProfileDirty` (`src/lib/profile-core.ts`, pure deep-equal,
> unit tested in `tests/lib/profile-core.test.ts`) and a draft snapshot taken at edit-mode
> entry — both the explicit `enterEdit()` path and the auto-edit-mode lazy initializer
> (`returnToMembership` / incomplete new profile) needed their own snapshot, since the
> latter never calls `enterEdit`. Discard clears both draft and snapshot. Verified live:
> reproduced the bug pre-fix (dev athlete, edit mode → "Unsaved changes" with zero edits),
> confirmed gone post-fix, confirmed it reappears on a real edit and clears on Discard
> (value reverted), confirmed Save still writes cleanly (no `people` write-queue errors),
> and repeated the entry-mode + dirty checks for both the athlete and manager dev users.

```
Debug and fix: entering Profile edit mode (src/pages/Profile.tsx, form logic
possibly in src/components/PersonForm.tsx) shows "Unsaved changes" immediately,
before the user touches anything. Reproduced with the dev athlete (incomplete
profile: no DOB, no phone, no t-shirt size).

Find the actual cause before fixing (likely: the form initializes/normalizes values
— default role checkbox, empty-string vs undefined, coerced numbers like gradYear 0
— and the dirty check compares normalized state against the raw loaded person).
Fix so dirty = user actually changed a field: snapshot the form state AFTER
initialization/normalization and compare against that, or make normalization
idempotent with the loaded row. "Discard" must return to the loaded values and
clear the dirty flag. Do NOT change what Save writes (pushPerson semantics,
selfAuthUserId stamping) — this is a dirty-tracking fix only.

Verify: enter edit mode → no "Unsaved changes"; change one field → appears; discard
→ gone and values restored; save still works (check the write-queue/WriteStatus).
Repeat with the manager user (complete profile). If the dirty check is extractable
as a pure function, add a vitest test. npm run build, npx eslint <touched>,
npx vitest run.
```

### S4 — ⚠️ Cart total vs server-priced checkout total mismatch — IMPLEMENTED 2026-07-25
(branch `money/s4-cart-price-agreement`, unmerged/undeployed — pending O2's fable
review before merge/push/deploy)

Blocked on O1's decision (run O1 first, or make the controller decide inline).

```
Implement the cart-reprice UX per docs/specs/2026-07-04-money-story-ux.md (from
task O1).

Observed bug: cart page (src/pages/Cart.tsx) showed "Total: $45" for one line
("UCG membership 2026–27"); clicking checkout, the server-priced summary in
src/components/CartCheckout.tsx showed Subtotal $55 + $1.95 fee = $56.95. The $45
is a stale client-written cart_items.amount; create-checkout-session recomputed $55.
The user sees two different prices for the same line with no explanation — reads as
an overcharge.

Baseline expectation (adjust to the spec): (1) the cart page derives display
amounts from src/lib/pricing.ts + current data at render time instead of trusting
stored cart_items.amount, so the cart matches what the server will charge in all
known cases (host-club $0, change fees, membership price changes); (2) if the
server-returned line set still differs from what the cart displayed, CartCheckout
shows an explicit "Prices were updated" notice listing the changed lines, and the
cart re-renders at server prices when the user goes back. UI never sums client
amounts as authoritative (existing rule — keep it).

HARD constraints: no changes to create-checkout-session's authority model; no
client-side writes to payments; classifyCartRemoval/removeCartItemWithSync semantics
unchanged; beware the in-place mutate() trap (read db.* directly each render, no
useMemo keyed on nested db paths).

Verify: exercise self cart AND a managed-club cart with the dev users; screenshot
cart vs checkout summary showing agreement; vitest tests for any new pure pricing/
diffing helpers. npm run build, npx eslint <touched>, npx vitest run.
CONTROLLER: fable review of the diff before merge (task O2).
```

### S5 — ⚠️ Live price estimate in the registration editor

> **Controller review fix (2026-07-26).** The first draft correctly found that the
> estimate must respect the change-fee WINDOW (`changeFeeApplies`), not just
> `changeIsEligible` — but folding the two together made it report "No charge for this
> change" in the case `Club.tsx:1350` actually bills as an **entry fee**: adding a
> discipline to an existing registration while the change-fee window is CLOSED.
> `registrationEstimate` now takes `eligible` and `changeFeeApplies` separately and
> mirrors the save path's precedence literally (`changeFee > 0` wins, else
> `!changeFeeApplies && entryTotal > 0`), plus `priorDisciplineCount` so an added
> discipline prices at the second-discipline rate, plus the late-registration
> surcharge the estimate had been omitting. Keep `src/lib/reg-estimate.ts` in lockstep
> with `saveRegs` — its header says so. — IMPLEMENTED 2026-07-25
(branch `ui/s5-s6-reg-money-display`, unmerged/undeployed — pending controller
fable review before merge/push, task O2)

> New pure selector `src/lib/reg-estimate.ts` (`registrationEstimate` +
> `registrationEstimateLabel`) orchestrates `newRegistrationEntryTotal`/
> `registrationChangeFee` — no fee math in the component. Host-club-free takes
> priority over every other case (matches pricing.ts's own guard, since host
> fees are $0 for entry AND change). Camps pass `newDisciplineCount: 1` (flat
> fee, never per-discipline). **Correction found during live verification:**
> the brief's "edit where changeIsEligible → show the change fee" is
> incomplete — `saveRegs` only actually charges the change fee when the
> event's `changeFee.startsAt` window has ALSO opened (`changeFeeApplies`,
> already a prop on `RegistrationEditorProps`). The estimate now ANDs
> `eligible && changeFeeApplies` before pricing a change, or it would show a
> dollar amount the real save wouldn't charge — confirmed live against
> "Scoring Test Meet" (window not yet open → correctly "No charge for this
> change") vs. exercising the raw-eligible path pre-fix (incorrectly showed
> $15). The Save button's own "Add change to cart" label is untouched
> (pre-existing behavior, out of scope) — it can now legitimately disagree
> with a "No charge" estimate, which is the accurate side to be wrong on.
> Live-verified: new-registration ($0 with nothing selected → $60 once a
> level+All-Around is picked, matching the club cart's line exactly),
> edit-existing chargeable ($15) and non-chargeable ("No charge"). Host-club
> and $0-secondary-discipline cases covered by 9 unit tests
> (`tests/lib/reg-estimate.test.ts`) only — no seeded event has dev-club as
> host. Contrast: estimate line `--ink` on `--surface` white measures
> **14.05:1**; the "Estimated — …" footnote `--ink-soft` measures **5.42:1**
> at 12px — both clear AA. No responsive regression (S5/S6 additions render
> at 375/768/1280 with zero added overflow — see S6 note below for a
> pre-existing, unrelated table overflow found at 375px).

```
Add a running cost estimate to src/components/RegistrationEditor.tsx.

Today the modal (event page → Register, or My Registrations → Edit) lets the user
tick disciplines/levels/apparatus with no price feedback; the event card elsewhere
says "$10 / discipline · $1 each additional"; costs only appear later in the cart.
For a change to an already-paid registration the user can't predict the change fee
at all.

Add a single estimate line above the Save/Cancel row, derived ONLY from the
existing pure helpers in src/lib/pricing.ts (registrationEntryFee,
registrationChangeFee, changeIsEligible) — do not duplicate fee math in the
component. Cases: new registration → "Estimated entry fee: $N — added to your cart
on save"; host-club (competing club == event host) → "Free — host club" and no cart
line (existing behavior, just surface it); edit of a paid registration where
changeIsEligible → "Change fee: $N will be added to your cart"; edit that is NOT
chargeable (apparatus tweaks within a discipline) → "No charge for this change";
member self-edit path (MyRegistrations embeds this editor) must show the same
numbers. Label everything "estimated" — the server reprices at checkout. Update the
estimate live as checkboxes/levels change. Keep the existing explanatory footnote.

Mind the mutate()/render trap (compute from current db reads each render). Check
text contrast for any new muted/colored text (AA).

Verify: manually exercise new-reg, paid-reg-edit (chargeable and non-chargeable),
and host-club cases with dev users; numbers must match what the cart then shows
(S4 world) for the same action; vitest test for any new pure helper (e.g. an
estimate-label selector) in tests/. npm run build, npx eslint <touched>,
npx vitest run. CONTROLLER: fable review of the diff before merge (task O2).
```

### S6 — Payment status surfaced on My Registrations — IMPLEMENTED 2026-07-25
(branch `ui/s5-s6-reg-money-display`, unmerged/undeployed — pending controller
fable review before merge/push, task O2)

> New pure selector `src/lib/registration-status.ts`
> (`registrationGroupPaymentStatus`/`regGroupPaymentStatusInfo`) derives
> strictly off each row's `paid`/`updatedPending` — no `refRegIds` heuristic.
> **Correction from the brief:** `--amber-600`/`--amber-100` are retired
> (2026-07-19 rebrand) — used the existing AA-verified `.badge.ok` (paid) /
> `.badge.warn` (pending/change-pending) classes instead, matching the
> REG OPEN/DEV TEST pill pattern as instructed. A card can hold several
> registration rows (one per discipline); status is computed over the
> still-active (non-refunded) rows, falling back to the full set only if
> every row is refunded-but-kept, so a kept-but-refunded discipline can't
> drag an otherwise-paid card into a misleading state. The expanded-details
> line now reads the same status label instead of raw `event.status`; the
> date next to it is untouched raw ISO per H2's scope. Live-verified both
> badge states (`Pending purchase — in your cart`, `Change pending purchase`)
> and the status line, with computed colors read via `getComputedStyle`:
> `rgb(30,43,56)` text on `rgb(246,195,40)` (gold) background, independently
> recomputed at **8.76:1** (matches CLAUDE's documented 8.8:1). Could not
> live-produce a "Paid" badge without completing a real Stripe payment or a
> host-club-hosted seeded event — covered instead by 12 unit tests
> (`tests/lib/registration-status.test.ts`) including the host-club
> `paid:true` case and mixed-row priority ordering. **Found, not fixed (out
> of scope):** at 375px, a pre-existing `<table class="tbl">` layout in this
> same expanded-details section overflows the viewport when a row's status
> cell renders "Refund requested" (150px pill in a narrow column) —
> reproduced on "Scoring Test Meet" (which has 3 refund-requested rows),
> absent on a card with no refund-requested rows, and absent at 768px+;
> confirmed via `scrollWidth`/`clientWidth` before and after this diff — the
> table code itself is untouched by S5/S6.
> **RESOLVED 2026-07-26** on branch `ui/h1-h4-display-polish` (H4, same fix
> as H4.7's Clubs.tsx table) — see that section.

```
Surface paid/pending state on src/pages/MyRegistrations.tsx cards.

Today a registration card shows event name/date/club badge and (expanded)
disciplines — but NOT whether the entry is paid, pending purchase, or re-pended by
an edit, even though Registration.paid and updatedPending are first-class domain
state (CLAUDE.md "Registration paid-state"). Users can't tell if they're done or
still owe payment.

Add a status badge to each card header row: paid && !updatedPending → green "Paid";
!paid → amber "Pending purchase — in your cart" (it IS linked to a cart line via
refRegIds at creation); updatedPending → amber "Change pending purchase". Derive
strictly from the registration's own paid/updatedPending fields — do NOT invent a
refRegIds-scanning heuristic (the reg fields are the read model; refRegIds matching
belongs to checkout/webhook only). Host-club $0 regs are created paid:true and will
correctly show "Paid". Use the existing pill/badge styles (match the REG OPEN/DEV
TEST pills); check AA contrast on the amber pair (--amber-600 on --amber-100).
In the expanded details, replace the internal "Status: live" line with the same
user-facing status wording (H2 handles the date formatting on that line).

Verify: dev athlete has one paid and one pending-ish reg — screenshot both states
(force variants via the dev data if needed); 375px + 1280px. npm run build,
npx eslint <touched>, npx vitest run. If the badge derivation is written as a pure
function, unit-test it. CONTROLLER: quick fable pass per O2 (cheap — display-only,
but it renders money state).
```

---

## Haiku 4.5 (mechanical, explicit checklists)

### H1 — Live Results empty state — IMPLEMENTED 2026-07-26
(branch `ui/h1-h4-display-polish`, unmerged/undeployed)

> All three tabs (All-Around, By apparatus, Team) render one of the two
> specified messages when empty; AA computes a total-shown count across all
> level groups first (rather than each group independently returning
> `null`), so an all-filtered-out AA tab shows the message once instead of
> rendering nothing. "By apparatus" keeps its existing per-apparatus-card
> empty row but now uses the same two messages/styling instead of a bare
> "No scores yet." Live-verified all three tabs both unfiltered (UCG
> Nationals 2027, no scores yet) and with an active search filter (Julia's
> First Sanction Request, garbage search term) — exact copy confirmed in
> both states. `--ink-soft` on the white/off-white card background
> independently recomputed at **5.43:1** (exceeds the 4.5:1 body-text
> floor) — same token already used by Club.tsx's empty state.

```
src/pages/Results.tsx (session results view, route #/results/<slug>): when a
session has no posted scores the area below the search/filter row renders literally
nothing — looks broken.

1. Locate the score-list render for the All-Around / By apparatus / Team tabs.
2. When the (filtered) list is empty AND a search/level filter is active, render
   "No athletes match your search." When empty with no filter, render "No scores
   posted yet — results appear here live as judges enter them."
3. Use the existing muted empty-state styling used on Club.tsx "READY TO REGISTER
   (0)" ("Active members not yet registered…") — same tone, same classes.
4. All three tabs get the message.

Checklist before commit: [ ] open #/results/test-meet — message visible on every
tab; [ ] type a garbage search — the "no match" variant shows; [ ] text color vs
background ≥ 4.5:1 (resolve the actual token values); [ ] npm run build;
[ ] npx eslint src/pages/Results.tsx; [ ] npx vitest run.
```

### H2 — Human-readable dates, timezones, and status words — IMPLEMENTED 2026-07-26
(branch `ui/h1-h4-display-polish`, unmerged/undeployed)

> Item 2 (raw `(America/New_York)` on the Events detail header) was already
> fixed by `0e18ee4` before this pass. Item 1: `MyRegistrations.tsx`'s
> "Registration closes" line now shows date + time + zone abbreviation
> (e.g. "Jul 11, 2026, 9:46 AM (EDT)"), built from the SAME two existing
> helpers instead of a new one — `useFmtDate` for the date portion and
> `tzAbbrev` (lifted out of `Events.tsx` into `src/lib/timezone.ts` so it's
> shared, not copy-pasted) for the zone label; the time portion reuses the
> ad hoc `toLocaleTimeString` pattern already used elsewhere (e.g.
> `ErrorLog.tsx`). No conversion happens anywhere in this chain —
> `regOpens`/`regCloses` are naive local wall-clock strings in the event's
> own zone, and `tzAbbrev` only labels which zone that is. Live-verified:
> "Registration closes Jul 11, 2026, 9:46 AM (EDT)" on a real seeded reg.
> Item 3 sweep (`grep -rn "America/New_York\|toISOString\|timezone"
> src/pages src/components`) found a handful of admin-only/DOB instances
> beyond item 1/2 — `FinalsLineupEditor.tsx` (nationals engine, explicitly
> out of scope), `admin/league/Promos.tsx` and `Sanction.tsx` (admin-only
> raw dates in dropdown/detail rows), `Membership.tsx`/`Profile.tsx` (raw
> DOB, no time-of-day ambiguity), and `EventWizard.tsx`'s intentional
> "Pacific Time (America/Los_Angeles)" explainer copy — left unchanged as
> minor/out-of-scope; flagged for a PM call rather than silently fixed.

```
Three raw-internals leaks, all display-only formatting:

1. src/pages/MyRegistrations.tsx expanded details: "Status: live · Registration
   closes 2026-07-11T13:46:00+00:00". Replace the ISO string with the app's
   standard formatted date+time in the event's timezone (find the existing
   date-format helper — grep src/lib for toLocale/format usage on event dates —
   and reuse it; e.g. "Jul 11, 2026, 9:46 AM EDT"). Map internal event statuses to
   user words: live → "Open", plus whatever other event_status values exist
   (grep the enum) — draft → "Draft", completed/past → "Completed". Note: if S6 has
   already replaced the "Status:" line with a payment badge, only the date part of
   this item remains there.
2. src/pages/Events.tsx event detail header: "(America/New_York)" raw IANA zone in
   the date line. Render the short zone name instead (Intl.DateTimeFormat with
   timeZoneName: 'short' → "ET"/"EDT").
3. Check for the same two patterns anywhere else user-visible:
   grep -rn "America/New_York\|toISOString\|timezone" src/pages src/components —
   fix user-facing instances only; do NOT touch data writes, comparisons, or the
   nationals engine.

Checklist: [ ] screenshots of both fixed spots; [ ] no raw ISO or IANA strings
user-visible on Events/MyRegistrations; [ ] npm run build; [ ] npx eslint <touched>;
[ ] npx vitest run (do not break scoring tests).
```

### H3 — Replace raw route text with a Copy-link button — IMPLEMENTED 2026-07-26
(branch `ui/h1-h4-display-polish`, unmerged/undeployed)

> The raw `#/events/<slug>` text on Events.tsx was already gone (removed
> incidentally by `0e18ee4`) but no Copy-link button existed anywhere yet —
> added one to both `Events.tsx` (EventDetail) and `Results.tsx`
> (EventResults), and removed the remaining raw `#/results/{slug}` text
> from Results.tsx. New `appBaseUrl()`/`copyToClipboard()` in
> `src/lib/url.ts` (mirroring the app-base pattern already used by
> `JudgeAccessCard`'s QR link) build the absolute URL and copy with a
> `prompt()` fallback. On Results, `sessionId` is local component state
> only (not part of the route/query), so per the brief the copied link is
> the page URL as-is — nothing session-specific to fold in. Live-verified
> both buttons via an instrumented `navigator.clipboard.writeText`/
> `window.prompt` override: `http://localhost:5173/ucg-platform/#/results/
> julia-s-first-sanction-request` and `.../#/events/test-meet` — both
> correctly include the GitHub Pages `/ucg-platform/` subpath.

```
Two pages print internal hash routes as text meant to be "the shareable link":
- src/pages/Events.tsx detail header: "… hosted by X · #/events/<slug>"
- src/pages/Results.tsx: "Unique URL per event & session: #/results/<slug>"

1. Remove the raw route text from both.
2. Add a small secondary/outline "Copy link" button (existing button styles) that
   copies the FULL absolute URL (window.location.origin + pathname + '#/…' — build
   from the app base so it works under the GitHub Pages subpath, then under any
   future host) via navigator.clipboard.writeText.
3. On success show the existing toast: useToast()('Link copied'). On clipboard
   failure show the URL in a prompt() fallback so it's still copyable.
4. On Results, the copied link should reflect the currently selected session if
   the session is part of the route/query; otherwise copy the page URL as-is.

Checklist: [ ] click both buttons, paste the result — full URL opens the right
page; [ ] toast appears; [ ] no raw "#/…" text remains on either page;
[ ] npm run build; [ ] npx eslint <touched>; [ ] npx vitest run.
```

### H4 — Microcopy and formatting sweep (7 small fixes) — IMPLEMENTED 2026-07-26
(branch `ui/h1-h4-display-polish`, unmerged/undeployed)

> All 7 done. #5 (breadcrumb): `navHistory.ts` gained `resolveLabel(pathname,
> db)` — resolves `/results/:slug` to the event's real `name` (looked up the
> same way every event detail page already does, `db.events.find(e =>
> e.slug === slug)`) instead of the raw-slug generic fallback;
> `labelFor` itself stays pure/path-only, `Layout.tsx` now threads `db`
> through. Live-verified: the breadcrumb on Julia's First Sanction Request's
> results page now reads "Julia's First Sanction Request" instead of
> "Results / Julia-s-first-sanction-request". #4 (PurchaseHistory fallback)
> live-verified on a real $0 seeded invoice: shows "Purchase on Jun 26,
> 2026" instead of bare "Purchase". #7 (Clubs.tsx): wrapped the table in its
> own `overflowX:'auto'` scroller (same technique as `.events-table-wrap`)
> — live-verified at 800px the Region badge is no longer clipped (wrapper
> scrolls internally, `wrapScrollWidth` 1093 > `wrapClientWidth` 755) while
> `document.documentElement.scrollWidth` stays equal to `clientWidth` at
> 375/768/800/1280 (no page-level overflow introduced). **Also fixed the
> same-family issue S6 found and left out of scope**: MyRegistrations.tsx's
> expanded registration-details table (raw-`<table class="tbl">`, no
> wrapper) overflowed at 375px on a row with a longer status badge
> (e.g. "Refund requested") — wrapped it the same way; confirmed via
> `scrollWidth`/`clientWidth` on a real seeded reg at 375/768/800/1280.

```
All display-only string fixes; change nothing about behavior or data.

1. src/pages/Membership.tsx: "Waiver signed by on 2026-06-25" — when the signer
   name is empty, render "Waiver signed on <date>" (conditional, no dangling "by").
2. src/pages/Profile.tsx view mode: "GRAD YEAR 0" — render "—" when gradYear is 0,
   null, or undefined (display only; do not change stored values or the N/A logic).
3. Checkout-verb consistency: grep -rn "Checkout\|Check out\|Click for details"
   src/. Standardize buttons/links to "Check out" as the verb ("Check out
   everything →", "Check out memberships →") and "View details →" instead of
   "Click for details →" (src/pages/PurchaseHistory.tsx). Don't rename code
   identifiers or routes — user-visible strings only.
4. src/pages/PurchaseHistory.tsx: the $0 invoice renders bare description
   "Purchase" — fall back to "Purchase — <date>" or the invoice's line summary if
   one exists; pick whatever data is already loaded, no new queries.
5. Breadcrumb on results detail shows the slug ("Results / Test-meet") — pass the
   event's display title to the breadcrumb instead (find the breadcrumb source in
   src/components/Layout.tsx; if it derives from the route, give the page a way to
   set the label the way other detail pages do — copy the existing pattern).
6. src/pages/MyRegistrations.tsx helper line "Use Edit above to change your
   disciplines, levels, events." → "…disciplines, levels, and apparatus."
   (post-rename vocabulary; CLAUDE.md "Naming").
7. Club Directory (src/pages/Clubs.tsx): the REGION pill ("MID-ATLANTIC") clips at
   the table's right edge around 800px viewport width. Reproduce (~800px wide),
   then fix: allow the pill to shrink/wrap or give the column min-width — no
   horizontal page overflow allowed.

Checklist: [ ] screenshot each of the 7 fixes; [ ] grep confirms no remaining
"Click for details" / "Checkout " (with trailing space, as a verb) user strings;
[ ] Club Directory at 375/768/800/1280 — no clipped pills, scrollWidth ≤
clientWidth; [ ] npm run build; [ ] npx eslint <touched>; [ ] npx vitest run.
```

### H5 — Cart: collapse the redundant CTAs when only one section exists

```
src/pages/Cart.tsx: with a single cart section the page shows SIX actions for one
line — "Total / Print Invoice / Check out everything →" bars at BOTH top and
bottom, plus the section's own "Check out <section> →" button and header link.

1. Render the "everything" total bar ONLY when 2+ sections (own cart + ≥1 club
   section, or multiple club sections) have items — with one section, its own
   subtotal row + checkout button is the only CTA set.
2. When the everything-bar does render, show it once: top position only.
3. Leave per-section rows, the ✕ removal flow, Print Invoice per section, and the
   "Billed to …" copy logic alone — except: the checkout view currently renders
   "Billed to Dev Athlete." twice stacked (page subtitle + section header); drop
   the duplicate in the checkout state.

Checklist: [ ] one-section cart (dev athlete) shows exactly one checkout button +
one Print Invoice; [ ] multi-section cart (switch to Club mgr with a club line, or
temporarily seed one) shows the single top everything-bar plus per-section buttons;
[ ] no duplicated "Billed to" line in checkout state; [ ] removal ✕ still works;
[ ] npm run build; [ ] npx eslint src/pages/Cart.tsx; [ ] npx vitest run.
```

### H6 — Not-found route instead of silent Home fallback

```
Unknown hash routes (e.g. #/profile — the real route is #/me) silently render the
Home page, so typos/stale links look like the app ignored the click.

1. Find the router config (App.tsx) — there is likely a catch-all route to Home or
   an index fallback.
2. Add a NotFound view for unmatched paths: page-style heading "Page not found",
   one line "That link doesn't exist — it may be old or mistyped.", and a "Go to
   Home →" primary link. Match existing page layout (Layout children, card
   styles).
3. PRESERVE all intentional redirects: /meets* → /events* slug-preserving
   <Navigate replace>, /club/:id/cart → /cart, and the ?setpw=1 → #/set-password
   handling must keep working exactly (CLAUDE.md "Naming" + "Auth patterns").
   List the existing redirect/fallback routes in your report to prove you checked.

Checklist: [ ] #/profile and #/garbage show NotFound; [ ] #/meets and a
#/meets/<slug> URL still land on the events pages; [ ] #/ still renders Home;
[ ] auth ?setpw=1 flow untouched (code-inspect, don't run auth); [ ] npm run build;
[ ] npx eslint <touched>; [ ] npx vitest run.
```

### H7 — "Details"/"Hide" toggles are plain spans (keyboard/SR inaccessible)

```
The expand/collapse toggles on registration cards are styled <span>s inside a
clickable row, not buttons — invisible to keyboard and screen-reader users.
Known instances: src/pages/MyRegistrations.tsx:331 and
src/pages/admin/Communicate.tsx:653 ("{open ? 'Hide' : 'Details'}").

1. Convert each toggle to a real <button type="button"> with the existing
   text-link styling (keep the visual identical — reuse or add a minimal
   .linklike-button class with background:none, border:0, same color/font).
2. Add aria-expanded={open} to the button.
3. If the whole card row is the actual click target, keep that behavior but make
   the button the focusable control (row click AND button both toggle; no nested
   interactive elements inside the button).
4. Grep for other same-pattern toggles: grep -rn "'Hide' : 'Details'\|'Details' :
   'Hide'" src/ and fix all hits the same way. (Waivers.tsx uses <summary> — fine,
   leave it.)
5. Tab-navigate: the toggle is reachable, Enter/Space toggles, focus outline
   visible.

Checklist: [ ] keyboard-only expand/collapse works on My Registrations and admin
Communicate; [ ] visual unchanged (screenshot before/after); [ ] aria-expanded
present; [ ] npm run build; [ ] npx eslint <touched>; [ ] npx vitest run.
```

---

## Priority order (if running the lot)

| Order | Task | Why first |
|-------|------|-----------|
| 1 | S1 | AA failure on every CTA; single-token leverage; Nate's hard contrast rule |
| 2 | S2 | Most-broken screen, blocks members completing required profile fields |
| 3 | O1 → S4 | Biggest trust risk (money numbers disagree) |
| 4 | S3, S6 | Profile trust + payment-state visibility |
| 5 | S5 | Price transparency at the decision point |
| 6 | H1–H7 | Polish batch — cheap, high count |

After each merged task: update this file's task with a ✅ + date, log the routing
row, and let the post-commit doc sweep reconcile `docs/README.md` "What's next"
(which points here).
