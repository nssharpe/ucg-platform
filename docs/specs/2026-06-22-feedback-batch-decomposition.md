# Feedback batch 2026-06-22 — decomposition & execution plan

> Master plan for the Nate/Julia feedback batch of 2026-06-22. Every item below maps to
> a work unit with files, approach, size (S ≤ ½ day, M ≈ 1 day, L = multi-day/needs its
> own plan), and dependencies. Phases are ordered so blocking work lands first.
>
> Companion research notes (open questions answered separately):
> - [2FA & passkeys](../research/2026-06-22-auth-2fa-passkeys.md)
> - [Password policy](../research/2026-06-22-password-policy.md)
> - [Error logging / observability](../research/2026-06-22-error-logging-observability.md)
> - [Admin-refresh flash](../research/2026-06-22-admin-refresh-flash.md)

## Legend
- **Size:** S (≤½ day) · M (≈1 day) · L (multi-day — gets its own detailed plan before code)
- **Status:** ☐ todo · ◐ in progress · ☑ done

## Progress log
- **2026-06-23:** Phase 2 complete (2.1 training-state highlight, 2.2 in-flow back button,
  2.3 athlete/coach/both pricing dropdown + `priceForTypes` helper & unit tests, 2.4
  Independent-Athlete checkbox in PersonForm + Profile, 2.5 grad-year unset/N/A). Also
  10.1 (admin-refresh `rolesLoaded` gate), 9.4 (no-coach warning removed), and 1.1 partial
  (waiver invokers now surface the real Edge error). All typecheck clean; 121/121 tests pass.
  **Still open on 1.1:** the underlying non-2xx cause (likely auth↔person link not persisted)
  — needs a live re-test to read the now-surfaced message.
- **2026-06-23 (cont.):** 1.1 adult self-sign confirmed working on the live-configured
  dev server (advances to payment; adult path sends no email by design). Remaining 1.1
  scope is the **guardian/minor** path (the "no email" = the signing-link email) — retest
  pending. 2.4 fully done: per Nate, the desired end state is an **optional club value**
  (no separate independent-student/non-student clubs as in ScoreFlippers), which is exactly
  what shipped — no prod club rename needed.
- **2026-06-23 (cont. 2):** 1.5 (modal no longer closes on drag-select-release over the
  veil — mousedown guard) and 1.6 (toasts now have a ✕, pause auto-dismiss on hover, and
  `variant:'error'` persists; write-queue retry banner gains a **Dismiss**/stop button via
  new `discardFailedWrites`). Typecheck clean.
- **2026-06-23 (cont. 3):** 1.2 Communicate club-manager filter fixed — athlete-managers
  were excluded before the manager check (rewrote to "matches any selected group"); the
  remaining "shows 0" cause is manager-row persistence (see 1.4 theme, live-DB). 4.1
  default audience now nobody. 4.2 >10-recipient confirm on email + SMS. 7.2 T&T quick-
  select renamed "All Apparatuses". Typecheck clean; 121/121 tests pass.
- **2026-06-23 — Phase 3 (invites/roster):** New `invite-account` Edge Function (deployed)
  admin-creates an account + emails a Resend set-password link (invite link, recovery
  fallback for existing users); new `#/set-password` page + `?setpw=1` boot redirect; Club
  page: "Copy invite link" → **Add athlete** modal, per-roster-row **Invite** button
  (membership link), and a **club switcher** dropdown by the page title (managed clubs /
  all for league admins). Plan: docs/plans/2026-06-23-club-invites-and-roster.md. Typecheck
  clean; 121/121 tests pass. **Needs live test** (email round-trip) + confirm the redirect
  URL is allowlisted in Supabase Auth.
- **2026-06-23 — front-end batch + New-Person tweaks:** 4.3 (test card adapts to channel;
  search/show by phone for SMS), 4.4 (Send moved to its own card with Last-send at bottom;
  Test card beside it), 10.3 (sign-up password min-length hint, min 10). 9.3 fixed properly
  (pending-waiver detection was checking `active` + no-waiver, which never matches; now keys
  on `pending-waiver` status; dead `/people/:id` links repointed). 9.2 confirmed already done
  (retire/unretire soft-delete filters new meets, keeps past). New-Person form: T-shirt
  defaults Adult S, required-field asterisks + note, grad-year already unset. Coach
  "invite by email" now creates a real account via `invite-account` (+ name fields) instead
  of an in-memory placeholder + home-page link. tsc clean; 121/121 tests.
- **2026-06-23 — overnight batch (branch feat/feedback-2026-06-22-pt2):**
  7.1 synchro partner auto-link; 7.3 synchro partner in summaries; 5.1/5.2 downloadable
  proof-of-signature (print-to-PDF, full timestamp+tz) on League list + Profile; 1.3
  empty-list cross-season hint; 9.1 account-restricted promo codes (+migration applied to
  live DB); 7.6 My Registrations page; Phase 6 Purchase History page + printable receipts.
  Production build verified; tsc + 121 tests green.
  **Deferred (with reasons) — NOT shipped:** server-generated emailed PDF receipts/proofs
  (need visual verification of a Deno PDF lib); Phase 8 club-membership lifecycle (gates
  registration — too risky to ship unverified overnight; needs its own spec + live test);
  7.4 View Cart, 7.5 swap-athlete-on-reg, 4.5 comms log, 10.2 error-log DB, 1.4 merge
  persistence (each medium/large; queued for a focused session with live verification).
- **2026-06-22:** Research notes + this plan written; 4 decisions resolved (see below).

---

## Phase 1 — Blocking bugs & data-loss (do first)

These either block testing of other items or actively lose user data/trust.

### 1.1 Waiver "Sign & continue" → "Edge Function returned a non-2xx status" — S ☐
- **Symptom:** signing (self or guardian) errors with the generic supabase-js message;
  no email received. Blocks membership + cart-item testing.
- **Root cause #1 (confirmed):** `recordWaiverSignature` and `requestGuardianWaiver`
  (`src/lib/supabase.ts:613,624`) return `error.message` directly instead of
  `await edgeErrorMessage(error)` like every other invoker — so the real reason
  (404 no published waiver / 409 hash mismatch / 500 insert) is hidden.
- **Root cause #2 (to confirm at execution):** the underlying non-2xx. Most likely the
  self path has no published `waiver_documents` row for the season+type, or a
  content-hash mismatch, or the membership-activation update erroring. Reproduce, read
  the now-surfaced error, fix the actual cause.
- **Files:** `src/lib/supabase.ts` (use `edgeErrorMessage`), `supabase/functions/record-waiver-signature/index.ts`, `src/pages/Membership.tsx` (self-sign path), maybe seed `waiver_documents`.
- **Email note:** confirm `record-waiver-signature` is *supposed* to send confirmation;
  if so, wire via `_shared/resend.ts`. (Currently it sends none.)

### 1.2 Communicate "Club Managers" filter shows 0 recipients — S ☐
- **Symptom:** Nate & Julia are MIT managers but the "Club Managers" audience says 0.
- **Likely cause:** club-manager rows not persisted (temporary/in-memory) OR the audience
  query filters on a role/table that the manager assignment didn't write to. Tie-in with
  item 4.x (merge/temp persistence) and the club-manager data model.
- **Files:** `src/pages/Admin.tsx` (Communicate audience builder), `src/lib/capabilities*.ts`, club_managers table/query.

### 1.3 League → Waivers list shows no signed waivers — S ☐
- **Symptom:** signed-waivers list empty though tooltip says ≥1 signed.
- **Likely cause:** the list reads a different source than the tooltip (e.g. tooltip uses
  membership pointer `waiver_signed_at`; list queries `waiver_signatures` with a filter
  that excludes self-signed, or an RLS/admin-read gap, or season filter mismatch).
- **Files:** `src/pages/Admin.tsx` (League controls → Waivers), `src/lib/supabase.ts` waiver-signature reads.
- **Pairs with 5.2** (download PDF of e-signature) — same screen.

### 1.4 Merge account runs in temp, not persisted to DB — M ☐
- **Symptom:** account merge works in the in-memory snapshot but doesn't write through.
- **Action:** find the merge flow (`Admin.tsx` / `Profile.tsx`), make it persist
  (reassign memberships/registrations/roles from the duplicate person to the keeper,
  delete/redirect the duplicate) via Supabase, not just `mutate()`.
- **Files:** merge handler + a likely new Edge Function or RPC (service role to reassign
  rows + delete the dup safely). **Needs a short design before code.**

### 1.5 Form data-loss on right-to-left drag-select — S ☐
- **Symptom:** highlighting a prefilled number right-to-left and releasing the mouse
  *outside* the input closes the modal/window and wipes all entered form data.
- **Likely cause:** a backdrop/overlay `onClick` (or `onMouseUp`) treats the mouseup as
  an outside-click dismiss when the drag started inside the input and ended on the
  backdrop. Fix: dismiss only on `mousedown` that *starts* on the backdrop (track
  pointer-down target), not on `mouseup`/`click`. Audit modal components.
- **Files:** `src/components/ui.tsx` (Modal/Dialog), any custom overlay handlers.

### 1.6 Toasts: persistent + dismissible; error banner needs a "stop/close" — S ☐
- **Symptom:** error toasts auto-dismiss too fast to read/screenshot; the bottom-left
  retry banner has "Retry now" but no way to stop/close it.
- **Action:** make error toasts persistent (no auto-timeout) with an ✕ close button;
  add a "Dismiss"/"Stop trying" control to the write-queue retry banner.
- **Files:** `src/components/ui.tsx` (ToastProvider/Toast), `src/components/WriteStatus.tsx`.

---

## Phase 2 — Account setup & membership polish (small, high-value)

### 2.1 Training-state missing-field highlight — S ☐
- Profile "missing key info" highlighting must include empty **training state**.
- **Files:** `src/pages/Profile.tsx` (missing-field logic), maybe `PersonForm.tsx`.

### 2.2 Membership-purchase back button placement — S ☐
- Move the in-wizard back button to the **upper-right** of the step box (with "Step 1 of
  3" upper-left) so it reads as "previous step," not "leave the page."
- **Files:** `src/pages/Membership.tsx`.

### 2.3 Coach+athlete pricing → single dropdown — S ☐
- Replace the "add coach / add athlete" model with one dropdown: **Athlete ($50) /
  Coach ($40) / Both ($50)**. "Both" charges the athlete price only (the bug today:
  selecting both up front charges $0). Define pricing in `src/lib/pricing.ts`.
- **Files:** `src/lib/pricing.ts`, `src/pages/Membership.tsx`.

### 2.4 Default club = none + "Independent Athlete" checkbox; rename club — S ☐
- New-account club selector defaults to **nothing selected**. Add checkbox "No club — I
  am an Independent Athlete" that makes club selection not required and assigns the
  Independent club behind the scenes. Rename the club "Independent (No Club)" →
  **"Independent Athlete"**, shortname **"Ind"**.
- **Files:** `src/pages/Gate.tsx` (sign-up), `src/components/PersonForm.tsx`, club seed/data (rename via migration or admin edit).

### 2.5 Graduation year default unfilled, force a choice — S ☐
- New-account grad year defaults to empty; require the user to enter a year or click
  "NA" explicitly (no silent NA default).
- **Files:** `src/components/PersonForm.tsx` / Gate sign-up.

---

## Phase 3 — Clubs, roster & invites

### 3.1 "Send Invite" creates the account + set-password link — M ☐
- Clicking Send Invite should pre-create the account for the email on file; the emailed
  link goes to a **set-password** page; setting the password triggers the existing
  account-confirmation email. Invite links must land on **create-account / set-password**,
  not the home page.
- **Files:** `supabase/functions/send-club-invite/index.ts` (create auth user via
  `auth.admin.createUser` or invite), new set-password route/page, `src/App.tsx` route,
  `src/lib/supabase.ts`.
- **Depends on:** decision on Supabase invite vs. admin-create + reset link (see Open
  decisions). **Short design before code.**

### 3.2 Roster: "Add athlete" button (replaces "Copy invite link") — M ☐
- Top of "Roster & meet reg" becomes **Add athlete** (First/Last/Email) → creates an
  account with the manager's club as main club; athlete gets a set-password email; after
  login lands on `#/membership`.
- **Files:** `src/pages/Club.tsx`, `send-club-invite` (or a new fn), set-password flow (3.1).

### 3.3 Per-athlete "Invite" button on the roster — S ☐
- Each rostered athlete gets an **Invite** button emailing a link to `#/membership`
  (so after login they can buy membership or push to club cart).
- **Files:** `src/pages/Club.tsx`, `send-club-invite` (kind:'membership' already exists).

### 3.4 Club selector dropdown next to roster page title — M ☐
- On "Roster & meet reg", a searchable (type-ahead) dropdown next to the
  `h1.page-title` lists clubs the user manages; **league admins see all clubs**. Switches
  the viewed club.
- **Files:** `src/pages/Club.tsx`, `src/lib/capabilities*.ts` (managed-clubs list), `src/components/ui.tsx` (typeahead select if none exists).

---

## Phase 4 — Communicate revamp

### 4.1 Default audience = nobody — S ☐
- Arriving at Communicate selects **no recipients** (was: all athletes in org) to avoid
  accidental org-wide sends.
- **Files:** `src/pages/Admin.tsx` (Communicate).

### 4.2 Confirmation dialog for >10 recipients — S ☐
- "Are you sure you want to send {email/text} to XX people?" when recipients > 10.
- **Files:** Communicate send handler + `ui.tsx` confirm dialog.

### 4.3 Test card adapts to channel; search by name/phone — S ☐
- "Send Test Email" → "Send Test Text Message" when Channel = Text. Test-recipient
  search by name **or phone**, and selected people show **name + phone**.
- **Files:** Communicate test card.

### 4.4 Regroup the UI — M ☐
- Move "Send to XX →" onto its own card (with "Last send …" at the bottom of that card),
  separate from Audience/Message; put "Send test" on a card next to/below it. Clarify
  that the test sends the composed message.
- **Files:** Communicate layout. **Pairs with a quick design sketch / screenshot check.**

### 4.5 Communications log + send confirmation — L ☐
- Persist every send (date/time, channel, #recipients, message, recipient list, per-
  recipient success) to a `comm_log` table; add a detailed **log view** filtered to the
  logged-in sender. Show confirmation of what was sent and to whom.
- **Files:** new migration (`comm_log`), `send-email`/`send-sms` functions (write log
  rows), Communicate log UI. **Needs its own plan.**
- **Note:** 1.2 (club-manager audience) should be fixed first so logs reflect correct
  recipients.

---

## Phase 5 — Waivers (legal proof)

### 5.1 Tooltip: add time + timezone; PDF download of signature — M ☐
- Signed-waiver hover shows date **+ time + timezone**. Clicking downloads a **PDF**
  proof (signer name, signature/consent, timestamp w/ tz, IP, document version/hash).
- **Files:** waiver-status UI (`Profile.tsx` / `Admin.tsx`), a PDF generator
  (client-side `pdf-lib`/`jspdf`, or an Edge Function). **Pick PDF approach (Open
  decisions).**

### 5.2 League → Waivers: list signed waivers + download proof — S/M ☐
- Same screen as 1.3: once the list renders, add a per-signature **download proof PDF**
  (name, date, time, timezone). Reuses 5.1's generator.
- **Files:** `src/pages/Admin.tsx`, shared PDF generator.

---

## Phase 6 — Receipts & history (depends on payments being a stub)

### 6.1 Membership receipt: generate, email (PDF attached), store — L ☐
- On membership purchase (or admin override), generate a receipt PDF (who it's for,
  total paid / override), email it (Resend attachment), and store it.
- **Files:** receipt PDF generator, `send-email`/new fn with attachment support, new
  `receipts`/`purchases` table + storage. **Needs its own plan.** Coordinate with the
  deferred Stripe work (payment itself is still a stub — see CLAUDE.md "Still over-claim").

### 6.2 "Purchases History" page in MY UCG — M ☐
- New left-nav page under MY UCG listing all membership **and** meet receipts for the
  account, each downloadable.
- **Files:** new route/page, nav (`src/components/Layout.tsx`), reads `receipts` table.
- **Depends on:** 6.1.

---

## Phase 7 — Meet registration

### 7.1 Synchro tramp partner auto-link — M ☐
- When A names B as synchro partner, then B adds synchro tramp, B's partner auto-fills
  to A.
- **Files:** `src/components/RegistrationEditor.tsx`, registration data model.

### 7.2 Rename T&T "All Around" → "All Apparatuses" — S ☐
- **Files:** grep for the T&T AA label (`src/scoring/tnt.ts`, `src/nationals/*`, reg UI).

### 7.3 Cart summary includes synchro partner name — S ☐
- **Files:** cart summary rendering (`Club.tsx` / `Membership.tsx` / registration cart).

### 7.4 View Cart in topbar + per-line "return to registration"; flexible checkout — L ☐
- Add a **View Cart** button by `topbar-user`. Cart groups a card per event /
  "memberships," each with a "return to registration/membership" link. Allow purchasing:
  one event's cart, all memberships, or everything.
- **Files:** topbar (`Layout.tsx`), new cart page/route, cart model + checkout. **Needs
  its own plan.** Overlaps with 6.x receipts and 7.5/7.6 edits.

### 7.5 Edit club-member registration: swap athlete — M ☐
- In the edit screen for a club athlete, allow swapping in another club athlete **who has
  membership**. If after reg close but before the change deadline, apply the change fee.
- **Files:** `src/components/RegistrationEditor.tsx`, fee logic.

### 7.6 "My Registrations" page (MY UCG) — L ☐
- New page: tabs **Upcoming / Past**; searchable/filterable event list; each event
  expandable to details + my-registration summary; edit (upcoming) including **changing
  which affiliated club I'm registered with** for that competition.
- **Files:** new route/page, nav, registration reads + edit. **Needs its own plan.**
  Shares the club-change edit with 7.5.

---

## Phase 8 — Club membership lifecycle (largest; needs its own spec)

### 8.1 Club membership purchase + status + season + gating — L ☐
Requirements (from "General reminder about club membership"):
- Any active club manager can **purchase club membership** from the club management page;
  a visible **status indicator** on the club page.
- Purchasing each year **requires reviewing all club settings/details** first.
- Membership valid **Jul 1 – Jun 30**; purchasable early for the next season, with the
  **season made explicit** when it's not the current one.
- **Gating:** no athlete may register for a competition, and no club may host, unless the
  club has active membership for that event's season.
- **League admin** can **grant/revoke** club membership for any season from the club page.
- **Files:** new migration (club membership table / season validity), `src/pages/Club.tsx`,
  `Admin.tsx`, registration + sanction gating, `capabilities*.ts`. **Write a full spec +
  plan before code.**

---

## Phase 9 — Smaller standalone features & fixes

### 9.1 Promo code restricted to a specific account — M ☐
- Coupon form gets "Only usable by a specific account?" checkbox → reveals an account
  search/dropdown; redemption enforces the bound account.
- **Files:** coupons table (migration: `restricted_to_person_id`), coupon admin UI
  (`Admin.tsx`), redemption check (`src/lib/pricing.ts` / cart).

### 9.2 Delete a level: keep it on past meets, remove only from future — M ☐
- Deleting a level (League controls) should **soft-remove** (hide from future meet
  config) without breaking levels already used by past meets.
- **Files:** levels data model (soft-delete/`archived_at`), `Admin.tsx` league controls,
  meet config filters. Test by confirming a past meet retains the level after delete.

### 9.3 Home "Needs attention" — club manager — M ☐
- For club managers: surface athletes with **pending under-18 waivers** and **pending
  cart items**.
- **Files:** `src/pages/Home.tsx`, capabilities/queries. **Depends on 1.1** (waiver) for
  testing.

### 9.4 Home — league admin: remove "club has no coach with active membership" warnings — S ☐
- Having a coach is **not** required; remove those warnings entirely for league admins.
- **Files:** `src/pages/Home.tsx`.

---

## Phase 10 — Cross-cutting (informed by research notes)

### 10.1 Admin-refresh flash fix — S ☐
- Implement Option A from the [admin-refresh research note](../research/2026-06-22-admin-refresh-flash.md):
  add `rolesLoaded` to `auth.ts`, gate `RequireAdmin`/role screens on it.
- **Files:** `src/lib/auth.ts`, `src/App.tsx`, `src/pages/Sanction.tsx`.

### 10.2 Error-log database + admin search — L ☐
- Implement Option 2 from the [observability note](../research/2026-06-22-error-logging-observability.md):
  `error_logs` table + `log_client_error` fn + forward from `report-error.ts` +
  `window.onerror`/`onunhandledrejection` + admin "Error Log" page (search by name/email).
- **Files:** new migration, new Edge Function, `report-error.ts`, `main.tsx`, `Admin.tsx`.
  **Needs its own plan.**

### 10.3 Password policy — S ☐
- Raise Supabase min length to 10; enable leaked-password protection if on Pro; show
  min-length hint + surface policy errors on the Gate sign-up form. See
  [password note](../research/2026-06-22-password-policy.md).
- **Files:** Supabase dashboard/config, `src/pages/Gate.tsx`.

### 10.4 MFA / passkeys — L ☐ (deferred, phased)
- Per the [2FA note](../research/2026-06-22-auth-2fa-passkeys.md): Phase A TOTP opt-in on
  Profile first; require aal2 for admins; passkeys later. **Own plan when scheduled.**

---

## Decisions (resolved 2026-06-22)
1. **Invite mechanism (3.1/3.2):** ✅ **Admin-create + Resend set-password link.** Create
   the auth user server-side (`auth.admin.createUser`), email a branded set-password link
   via Resend; setting the password triggers the confirmation email.
2. **PDF generation (5.1/6.1):** ✅ **Edge Function, server-side** — consistent,
   server-stamped, attachable to emails, tamper-resistant for legal proof.
3. **Receipts storage (6.x):** ✅ **Regenerate on demand from a `receipts` table** — store
   the receipt data, render the PDF when downloaded. One source of truth, no file storage.
4. **Supabase plan (10.3):** ✅ **Free tier for now** — keep all work within free-tier
   features; leaked-password protection (Pro) flagged as a later upgrade.

## Suggested execution order
Phase 1 → 2 → 10.1/10.3 (cheap cross-cutting) → 3 → 4 (4.5 later) → 5 → 7 (7.2/7.3 now,
rest later) → 9 → 6 → 8 → 10.2 → 4.5 → 10.4. L items each get a dedicated plan in
`docs/plans/` when reached.
