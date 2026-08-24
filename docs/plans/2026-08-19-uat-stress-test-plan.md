# UCG Platform — Full-Feature Stress Test Plan (Nate + Julia)

**Date:** 2026-08-19 · **Testers:** Nate (PM), Julia (requirements owner)
**Target:** production — <https://nssharpe.github.io/ucg-platform/>
**Estimated effort:** ~10–13 hours each for everything; a ~3-hour priority subset is marked ⭐.

> **Why this plan is written the way it is.** The assertions below are derived from
> **Julia's own requirements documents** (`docs/specs/2026-07-06-event-management-v2-requirements.md`
> §A–§N, plus the waiver, Stripe, and registration-flow specs) — *not* from a walk-through of
> the code. A plan written from the code can only prove that what exists works; it structurally
> cannot find "we specced this and never built it." There is already at least one live example
> of that class of gap in this codebase, so the lanes below deliberately ask *"does it do what
> the spec said?"* rather than *"does the button click?"*
>
> The lane order is also deliberate: **the earliest lanes are the things only a human can
> verify.** Completing a real Stripe checkout, reading an email in a real inbox, pressing Enter
> on a real keyboard, scanning a QR code with a real camera, and two people clicking at the same
> moment are all things the automated tooling in this repo provably cannot do. Those come first
> because your time is uniquely valuable there.

---

## ⏱ Round-2 status (updated 2026-08-23 — ALL round-1 fixes are LIVE)

Every round-1 fix shipped to production 2026-08-23 (migrations, functions, frontend —
build `b9d4464`). Triage + what changed: [`2026-08-21-uat-round1-triage.md`](2026-08-21-uat-round1-triage.md).

| Do now | Still on hold |
|---|---|
| Everything previously green **plus**: **R** refunds (new per-registration model — one request, change fees non-refundable, reject asks for a reason) · **G-20** · **C-14** · **C-15** + the **M re-test** (coupons now scoped + on receipts; $0 checkout confirms; cart/purchases are separate pages with a club switcher) · **Z-02 / Z-04 / Z-06 re-tests** (duplicate guard, refund grouping, score-conflict dialog) · **A-11 / A-07 / A-06 re-tests** | **P** capacity/waitlists + **Z-03** — the redesign is at the prototype stage: [play with the clickable prototype](https://claude.ai/code/artifact/c236e9d2-cc25-488f-9f55-5e0324e13fa4) and comment; the build starts after your feedback |

Don't re-file anything already in the triage doc. New symptoms on the same screens are welcome.

# 0. Read this first — the 8 things that matter

1. **Test on production.** Stripe is still in **test mode** on prod, so no real money can move.
   Staging is *not* a substitute: every staging payment row is `failed`/`pending`, so all money
   surfaces legitimately read **$0** there and cannot prove arithmetic. Use staging only where a
   step explicitly says so.
2. **Prefix every piece of test data you create with `ZZTEST-`.** Person names, club names,
   event names, banner text — everything. Example: `ZZTEST-Ripcord Gymnastics`,
   `ZZTEST-Fall Invitational`. Two people stress-testing will add a lot of rows to the
   production database, and the pre-launch data sweep needs to be a search-and-delete, not an
   archaeological dig. **If you forget the prefix, say so in the Notes column** so it can still
   be found later.
3. **File broken things in-app, immediately.** The **"Report a problem"** widget captures the
   current route, the build SHA, and a *ring buffer of recent console errors* — that buffer is
   overwritten as you keep clicking, so a report filed five screens later has lost the evidence.
   See §2 for how to split reports between the widget and the spreadsheet.
4. **Before you file "it didn't update," hard-reload once** (Ctrl+Shift+R / Cmd+Shift+R on
   desktop; on mobile, fully close and reopen the tab/app). Live updates are wired for
   **scores only** — most other cross-device changes legitimately need a refresh. The
   spreadsheet has a column for this and it saves a triage cycle every single time.
5. **Record the local time of anything that misbehaves.** Timestamps are what make a finding
   correlatable with the server logs and the admin Error Log.
6. **"Missing" is a finding.** If a step describes behavior that simply does not exist, mark it
   `MISSING` — don't assume you misread. Some are known deferrals (Appendix A lists them so you
   don't waste time); anything missing that is *not* in Appendix A is genuinely worth knowing.
7. **Disagreeing with the design is a finding too.** Julia especially: if something *works* but
   isn't what you meant when you wrote the requirement, that is the most valuable feedback in
   this whole exercise, and it is far cheaper to hear now than after launch. Mark it `D`
   (decision needed) rather than a bug.
8. **Don't fix each other's findings mid-session.** Log it and move on. Batched triage is
   faster, and one person's workaround can hide a bug from the other.

**Cleanup:** everything you create is disposable, but do **not** delete as you go — a broken row
is often the evidence. The sweep happens after triage, keyed on `ZZTEST-`.

---

## 1. Setup — do this before Day 1 (Nate, ~30 min)

These are prerequisites that will otherwise dead-end whole lanes. Three are already-open
Nate-only items from `docs/whats-next.md` §1.

| # | Item | Why it blocks | ☐ |
|---|------|---------------|---|
| S-01 | ✅ **DONE 2026-08-19** — Julia already holds `finance_admin` | Lane **F** is unblocked | ✅ |
| S-02 | Grant Julia — or a second account — **`refund_manager`** | Lane **R** needs a reviewer who is *not* the requester, to prove the two-party flow | ☐ |
| S-03 | ✅ **DONE 2026-08-19** — flag verified by Nate. Side effect fixed the same day: UCG - Main no longer appears in the member-facing Club Directory or the Profile club pickers (it isn't a real club; admin surfaces still show it) | Lane **R** eligibility works | ✅ |
| S-04 | Confirm the **`sanctioning`** role exists on at least one account | Lane **H** needs a voter | ☐ |
| S-05 | Create a **third, role-less athlete account** (`ZZTEST-` named) | Half of lane **G** is about what a *plain member* sees. Testing as an admin silently hides every permission bug | ☐ |
| S-06 | Confirm email will actually deliver to the addresses you'll check | Lane **E** is worthless if mail lands somewhere neither of you reads. Check spam folders once up front | ☐ |
| S-07 | Have a **second physical device** ready (phone or tablet — not a resized window) | Lanes **J**, **D**, **Z** need it | ☐ |
| S-08 | ✅ **Nothing to do** — the build stamp (`v<sha> · date`, the small line at the bottom of the nav) identifies the build, and every in-app report attaches it automatically. Glance at it only if you're curious | Findings pin to builds by themselves | ✅ |

### Stripe test cards — use more than 4242

Copy these somewhere handy; lane **M** uses all of them. Any future expiry, any CVC, any ZIP.

| Purpose | Number |
|---|---|
| Succeeds immediately | `4242 4242 4242 4242` |
| **Requires 3-D Secure challenge** | `4000 0025 0000 3155` |
| **Declined (generic)** | `4000 0000 0000 0002` |
| **Declined (insufficient funds)** | `4000 0000 0000 9995` |
| Succeeds, then disputes | `4000 0000 0000 0259` |

### Personas

| Persona | Who | Lanes |
|---|---|---|
| League admin | Nate | F, H, R, N, Y, A |
| Finance admin (non-admin) | Julia, after S-01 | F |
| Refund manager | Julia, after S-02 | R |
| Club manager | Julia | C, P, N, W |
| Plain athlete, no roles | S-05 account | G, K, W, M |
| Guest / anonymous | Any incognito window | X |
| Anonymous judge device | Second device, not logged in | J |

---

## 2. How to send feedback

Two channels. The split matters — use the wrong one and either the evidence or the structure
is lost.

### Channel 1 — In-app "Report a problem" (for anything BROKEN)

Use it **the moment something errors, crashes, shows a wrong number, or does nothing.** Do it
before navigating away.

- It automatically attaches the current route, the build SHA, and the recent-console-error
  buffer. That buffer is the single most useful diagnostic artifact and it is **transient**.
- It takes up to **3 screenshots**, and you can **paste straight into the text box**
  (Win+Shift+S then Ctrl+V, or Cmd+Shift+4 then Cmd+V) — no file juggling.
- **Start the description with the finding ID and your initials**, then a blank line, then
  prose:

  ```
  M-07-01 (JB)

  Clicked "Check out all" with two events in the cart. Spinner ran about
  5 seconds, then it dropped back to the cart with no error and nothing
  appeared in Stripe. Cart still shows both events.
  ```

- Then add **one row** in your spreadsheet with the same ID and `Reported in-app? = Y`. Don't
  retype the description — the email already has it.

### Channel 2 — The shared Google Sheet (for EVERYTHING, including passes)

The Sheet is the coverage record. Its job is to answer *"did anyone actually try this?"* —
which the in-app reports cannot. Work only in **your own Findings tab**. Fill a Result for **every step**, including the ones that pass; a
`PASS` row takes two seconds and is what makes the untested gaps visible.

Use the Sheet as the **only** channel for: UX and wording feedback, "this works but it's
wrong," design opinions, requirement disagreements, and questions.

**One shared Google Sheet — [UCG Preflight Feedback](https://docs.google.com/spreadsheets/d/1tBHmut8OCmJXrcH3zaY0g0_GcHvj0T44DDfu1YAIcq0/edit)** — with a Findings tab per tester
(**Julia Findings** / **Nate Findings**), a README, and the answered Decisions tab. Google
Sheets handles simultaneous editing natively, so one file is fine as long as each of you stays
in your own tab. *(The repo keeps the generated template at
`docs/uat/ucg-preflight-feedback.xlsx` — built by `docs/uat/build-feedback-workbook.py` from
this plan's markdown; the live copy is the Sheet.)*

### The ID scheme

- **Step ID** = `<LANE>-<NN>` — e.g. `M-07` is lane M (Money), step 7. Every step below has one.
- **Finding ID** = `<step ID>-<NN>` — `M-07-01` is the first finding on that step, `M-07-02` the
  second. For something you noticed in passing that belongs to no step, use `X`: `M-X-01`.

### Screenshots

**Filename:** `<finding ID>_<seq>_<initials>.png` — e.g. `M-07-01_01_JB.png`, then
`M-07-01_02_JB.png` for the second shot of the same finding.

- **Include the browser address bar** whenever you can — the URL hash *is* the route, and it
  answers half of all "where was this?" questions for free.
- **Annotate anything not self-evident.** A red box or arrow on the exact element. Windows
  Snipping Tool, macOS Preview markup, or your phone's built-in markup are all fine. An
  un-annotated full-page shot of a dense admin table costs a round-trip to interpret.
- **A short screen recording beats a screenshot for anything with motion** — a flash, a layout
  jump, a spinner that never resolves, a toast that vanishes before you can read it. Same
  naming, `.mp4`. Win+Alt+R (Xbox Game Bar), Cmd+Shift+5 on macOS, or Control Center /
  quick-settings screen record on phones.
- **For money and math, capture the whole number, not the region.** A wrong total needs the
  line items *and* the total in one frame or it can't be checked.
- One flat folder each — `screenshots-nate/`, `screenshots-julia/`. No subfolders; the filename
  already carries the structure.

### Severity

| Code | Means | Example |
|---|---|---|
| **S1** | Blocker — a core flow can't be completed, or money/data is wrong | Checkout fails; a total is wrong; a registration vanishes |
| **S2** | Major — a feature is broken or badly wrong, but there's a workaround | An export is missing a column; a filter returns nothing |
| **S3** | Minor — works, but wrong in a way a user would notice | Wrong date format; a stale badge; a confusing label |
| **S4** | Polish — cosmetic | Spacing, alignment, an awkward line break |
| **Q** | Question — you can't tell whether it's wrong | "Should this even be here?" |
| **D** | Decision needed — works as built, but is it what we want? | Requirement disagreements. **Julia's highest-value column** |

### Result codes

`PASS` · `FAIL` · `MISSING` (described behavior doesn't exist) · `UNCLEAR` (couldn't tell) ·
`BLOCKED` (couldn't get to it) · `N/A` (doesn't apply to you)

### Spreadsheet columns

| Column | Notes |
|---|---|
| Step ID | From this plan, e.g. `M-07` |
| Lane | Auto-derived from the step ID |
| Result | PASS / FAIL / MISSING / UNCLEAR / BLOCKED / N/A |
| Finding ID | Only when it isn't a plain PASS |
| Severity | S1–S4 / Q / D |
| What you expected | One line |
| What actually happened | One line. **Exact** error text, verbatim — not paraphrased |
| **Timestamp** | Local date + time **with time zone**, e.g. `2026-08-19 14:32 PT`. This is what correlates a finding to the server logs |
| **Hard reload fix it?** | `Y` / `N` / `N/A`. Only relevant to "it didn't update" findings — but fill it in; cheapest triage input there is |
| Device / browser | e.g. `iPhone 15 / Safari`, `Win 11 / Chrome 141` |
| Signed in as | Which persona |
| Screenshot(s) | Filenames, comma separated |
| Reported in-app? | Y / N |
| Notes | Anything else — including "forgot the ZZTEST- prefix" |

---

## 3. Suggested schedule

Lanes are independent; you can reorder. But **Z (concurrency) must be booked as a joint
session**, and **M before R** (a refund needs something paid).

| Block | Lanes | Who | Time |
|---|---|---|---|
| **Day 1 AM** ⭐ | **A** Auth · **M** Money & checkout | Both, separately | ~2.5 h |
| **Day 1 PM** ⭐ | **Z** Concurrency (joint, ~45 min) → **E** Email & SMS | Both together, then apart | ~2 h |
| **Day 2 AM** ⭐ | **G** Athlete registration · **W** Membership & waivers · **K** Camps | Julia leads; Nate mirrors on the role-less account | ~2.5 h |
| **Day 2 PM** | **C** Club manager · **P** Capacity & waitlists | Julia | ~2 h |
| **Day 3 AM** | **H** Sanction & host · **N** Nationals | Julia + Nate | ~2.5 h |
| **Day 3 PM** | **R** Refunds · **F** Finance & admin | Nate + Julia | ~2 h |
| **Day 4** | **J** Judge day (2 devices) · **D** Devices & PWA · **X** Public · **Y** Keyboard | Both | ~2.5 h |

**If you only have 3 hours:** do the ⭐ blocks — A, M, Z, and the first half of G. Those cover
every path where a defect costs real money or blocks a real registration.

---

# The test lanes

Each step is: **what to do** → *what should happen*. Where a step traces to a written
requirement, the section is cited so a disagreement can be settled against the source.

---

## Lane A — Accounts, auth & security ⭐

*Only you can do this: real email links, real authenticator apps, real hardware biometrics.*

| ID | Do this | Expected |
|---|---|---|
| A-01 | Sign up a brand-new account from scratch (`ZZTEST-` name, an address you can read) | Confirmation email arrives; the link signs you in; you land somewhere sensible |
| A-02 | While signed out, go directly to `#/admin/league` | You get the sign-in gate — **not** an admin page, and **not** a blank flash of admin UI first |
| A-03 | Sign in as the role-less athlete (S-05), then go to `#/admin/league`, `#/admin/finance`, `#/admin/refunds` | Three distinct "access required" messages. **Watch closely for a flash of the real page before the block** — that's a finding |
| A-04 | Refresh the page while signed in as an admin, on an admin page | No "access denied" flash before the page loads. Do it 3× — it's a race, so it may not reproduce first try |
| A-05 | Sign out, then use the browser Back button | You do not end up on a signed-in page with live data |
| A-06 | Forgot-password flow end to end | Email arrives, link works, new password works, old password doesn't |
| A-07 | Admin sends an **account invite**: `#/admin/members` → open a person who has **no account** → **Send account invite**. (NOT "+ New Person" — that only creates the profile; A-07-01 was partly this step's wording.) Recipient clicks the link | Lands on Set Password, sets one, is signed in and linked to the right person — **not** a new duplicate person |
| A-08 | Enroll **TOTP** on a fresh account with a real authenticator app | QR scans; code accepted; recovery guidance is clear about what happens if the phone is lost |
| A-09 | Sign out, sign back in with TOTP | You're challenged for the code; a wrong code is refused with a readable message; the right one gets in |
| A-10 | Enroll a **passkey** on real hardware (Face ID / Touch ID / Windows Hello) | Enrolls; a subsequent passkey sign-in does **not** additionally demand TOTP |
| A-11 | Sign in as an admin **without** MFA enrolled | You get the MFA nag. Note whether it's dismissible and whether that feels right |
| A-12 | Nate: exercise the **admin MFA reset** break-glass on the test account | The locked-out account regains access; the path is documented enough that you'd trust it at 11pm before a meet |
| A-13 | Try `#/profile` (a route that doesn't exist) | The "Page not found" card — not a silent redirect to Home |
| A-14 | Sign in on your phone **and** desktop at once; change your name on one | The other reflects it after a refresh. Record whether a refresh was needed (expected: yes) |

---

## Lane M — Cart, pricing & Stripe checkout ⭐

*Only you can do this: the automated tooling cannot script inside Stripe's payment iframe. This
lane is the single highest-value block in the plan.*

**Before you start:** open the Stripe Dashboard (test mode) in another tab. Several steps ask
you to compare what the app says against what Stripe actually recorded.

| ID | Do this | Expected |
|---|---|---|
| M-01 | Add one event registration to the cart. **Write down every number** on the cart page: line item, subtotal, service fee, total | — |
| M-02 | Click through to checkout. Compare the Stripe page's numbers against M-01, to the cent | **They must match exactly.** The server recomputes prices independently; a disagreement here is an S1 |
| M-03 | Pay with `4242…`. Watch what happens after the payment completes | Redirects back; registration turns **paid**; a receipt is available; the cart is empty |
| M-04 | Check the confirmation email against the receipt in-app | Same total, same items, same invoice number |
| M-05 | Open the invoice/receipt PDF and actually **print it** (or print-to-PDF) | Renders correctly on paper — logo, brand font, itemization per spec §I: athlete, disciplines, levels, apparatus; one line per banquet ticket with who it's for; per shirt with size; per leo with size; banner with exact text |
| M-06 | Repeat a checkout with the **decline** card `4000…0002` | A clear, human error message. Cart intact. Nothing marked paid. **No** orphaned registration |
| M-07 | Repeat with the **3-D Secure** card `4000 0025 0000 3155` | The challenge appears and completes; then behaves like M-03 |
| M-08 | Start a checkout and **abandon it** — close the tab mid-payment. Wait 2 minutes, come back | Cart is intact, nothing marked paid, and you can check out again cleanly |
| M-09 | Use the browser **Back button** from inside Stripe checkout | Returns to a sane cart state — no duplicate cart lines, no stuck spinner |
| M-10 | Build a cart with **registration + add-ons + a change fee** together | Every line is itemized separately; the total adds up by hand |
| M-11 | Apply a **promo/coupon code** | Discount is visible in the cart **and** carried into Stripe's number |
| M-12 | Apply a coupon that covers **100%** of the total | Checkout still completes as a $0 order; a receipt still exists |
| M-13 | Try an **invalid** and an **expired** coupon code | Refused with a message that says which |
| M-14 | Remove a cart line for a **new** registration you'd added | The registration is removed entirely and the athlete becomes re-registerable |
| M-15 | Remove a cart line for a **change fee** | The registration reverts to its pre-change state. Verify the athlete's details actually rolled back |
| M-16 | Julia (club manager): fill the club cart, **Print Invoice before paying** | A pre-payment invoice PDF downloads and is legible |
| M-17 | Check the **service fee** on several different totals | Always ≥ Stripe's actual fee — never a cent short. Compare against the Stripe Dashboard's recorded fee |
| M-18 | Personal cart **and** a club cart populated at once | Two clearly separated sections, each with its own checkout. Confirm you can't accidentally pay for one thinking it's the other |
| M-19 | `#/me/purchases` after all the above | Every payment listed, **dates in your local timezone** (not UTC), receipts downloadable |
| M-20 | Compare `#/me/purchases` against the Stripe Dashboard test payments | Same count, same amounts, same order |

---

## Lane Z — Two-person concurrency (JOINT SESSION — book it) ⭐

*Only you two can do this. Both steps target defects that are known-live or unproven; be on a
call together and count down out loud.*

| ID | Do this | Expected |
|---|---|---|
| Z-01 | **Simultaneous checkout.** Both of you get a cart ready with a *different* item. Count down 3-2-1 and click Pay at the same moment. **Then write down both invoice numbers, verbatim, exactly as shown.** | Two payments, two receipts, **two different invoice numbers**. ⚠️ Invoice numbers are currently derived from a row count, which is not concurrency-safe — **a duplicate here is the reproduction we want**, and it is exactly the failure that matters on the first busy morning of registration. Repeat this 3 times |
| Z-02 | **Simultaneous registration of the same athlete.** Nate (as admin) and Julia (as club manager) both register the *same* athlete for the *same* event at the same moment | Exactly one registration, or a clear conflict message. Not two |
| Z-03 | ⏸ **HOLD until the capacity rework ships** (your Z-03-02/03 decisions). Then: **simultaneous capacity fill** — set a cap where you'll collide, both check out at once | The cap holds. Total registered never exceeds it. The loser gets an error naming the level and the overage (spec §F) |
| Z-04 | **Simultaneous refund approval.** Both approve the same refund request at the same moment | One refund. Not two. Total refunded never exceeds what was paid |
| Z-05 | **Edit collision.** Both open the same event's settings and save different changes | Last-write-wins is acceptable — **silent data loss with no warning is not**. Note what actually happened |
| Z-06 | **Judge collision.** Both enter a different score for the same athlete/apparatus at the same time | One wins visibly, or you're warned. Note which |

---

## Lane E — Email & SMS deliverability

*Only you can do this: reading real mail in a real client, checking spam placement, seeing how
it renders on a phone.*

For every email in this lane, check **four** things: (1) it arrived, (2) it's not in spam,
(3) the **from name, from address, and reply-to** are right, (4) it renders correctly **on your
phone**, not just desktop.

| ID | Do this | Expected |
|---|---|---|
| E-01 | Trigger each of these and check all four points: signup confirmation, password reset, account invite, club invite, membership welcome, payment/registration confirmation, waiver request, guardian waiver request, sanction submitted, sanction approved, refund requested, refund approved, refund rejected | All arrive. **Log the ones that don't — that list is the deliverable here** |
| E-02 | Per-event confirmation email: set a custom body on an event, then register for it (spec §A/§I) | Your custom message appears in the confirmation |
| E-03 | Set a **from-alias** and **reply-to** on an event, then trigger its confirmation | Sends from the verified domain with your display name; **reply-to** is the host/director address. Hit Reply and confirm where it goes (spec §A) |
| E-04 | Turn on **cc the director** and register | The director address is copied |
| E-05 | Admin Communicate: send an email to a filtered group | The recipient-list preview matches who actually receives it |
| E-06 | Admin Communicate: use the **test send** | Goes to your own account address only |
| E-07 | Event Communicate as a **host** (not an admin) | You can send **email**; SMS is admin-only by design (§J P1 decision). Confirm that reads as intentional rather than broken |
| E-08 | Event Communicate: filter by **session, level, discipline** | Recipient list changes correctly for each |
| E-09 | Send an **SMS** to yourself from admin Communicate | Arrives; sender number is right; length/segmentation sane; **reply to it** and check the reply is captured |
| E-10 | Reply **STOP** to that SMS, then try to send to that number again | Opt-out is honored |
| E-11 | Check the **sent log** after E-05 and E-09 | Shows what was sent and to whom |
| E-12 | Open the three most important emails on a **phone** | No horizontal scroll, no tiny text, buttons tappable |
| E-13 | Check whether any of the above landed in **spam or Promotions** | Note which — this is a launch-blocking class of problem and is invisible from inside the app |

---

## Lane G — Athlete self-service registration ⭐

*Julia leads; Nate mirrors on the role-less account so permission bugs can't hide.*

| ID | Do this | Expected |
|---|---|---|
| G-01 | As a **non-member**, open an event and try to register | Blocked with a message that a season membership is needed, plus a link to buy it. ⚠️ The spec §D "pre-set to the event's season" half is a **known gap** (Appendix A) — test the gate + link, and note where the link actually lands |
| G-02 | Buy the membership through that link, return, register | Works, and lands you back where you were |
| G-03 | Register while **signed out** | You're asked to sign in and **returned to the event page** afterwards, not dumped on Home (spec §D) |
| G-04 | Registration popup: choose disciplines, level, apparatus, all-around | Matches what you'd expect from the paper form. Only apparatus valid for the discipline are offered |
| G-05 | **T&T**: register for multiple disciplines with per-apparatus levels | Per-discipline default level works; per-apparatus overrides work |
| G-06 | **T&T**: try to remove your *last* remaining discipline | Blocked with an explanatory message; removing a non-last one works |
| G-07 | **Synchro**: pick a partner from the member list | Picker searches all active members; the pairing is recorded |
| G-08 | Have your partner pick **someone else** | ⚠️ The spec §D automation (revert your field to "unknown" + email you an edit link) is **not built** — verified in code, Appendix A. Observe what actually happens to your registration and log it; the mutual partner auto-link/level-sync is the only partner automation that exists |
| G-09 | Add-ons in the popup (banquet / t-shirt / leo / banner) | Sizes required where applicable; quantities work; the banner has an exact-text box |
| G-10 | **Banquet tickets**: buy 2 for yourself | At most **one** may be assigned to you; extras must be unassigned/EXTRA (spec §E3). Confirm the rule is enforced, not just documented |
| G-11 | Survey questions (where enabled) | Asked **last**, after add-ons (spec §D) |
| G-12 | Check `#/me/registrations` | Everything you entered, summarized on the athlete's line item — add-ons and survey answers included |
| G-13 | **Edit a competition detail** after paying | A change fee applies, per the event's change-fee config |
| G-14 | **Edit an add-on or a survey answer** after paying | **No change fee** (spec §D) — but the change deadline is still respected |
| G-15 | Try to edit **after** the change deadline | Blocked, with a message that says when the deadline was |
| G-16 | Register during the **late-registration window** (at or after the event's late-reg start time) | The **late fee is added on top** of the entry fee automatically — it's date-triggered, no code involved (spec §A) |
| G-17 | Look for the **private registration code** path (spec §D) | ⚠️ Known gap (Appendix A) — the field exists in the data model but nothing consumes it, and the "Private reg link" button on the manage page is a demo stub. Confirm and move on |
| G-18 | Copy the event link with the **copy-link** button, open it in incognito | Goes to the right event |
| G-19 | Register for an event in a **different timezone** than yours | Dates/times displayed unambiguously. Note whether it's clear *whose* timezone is shown |
| G-20 | Request a **refund** on one of your registrations (self-serve popup) | Confirm dialog warns about removal; reason dropdown offers Injury / Illness / Bereavement / Other+explain; you get a "request received" email (spec §H). *Approval is lane R* |

---

## Lane W — Membership & waivers

| ID | Do this | Expected |
|---|---|---|
| W-01 | Buy an **athlete** membership end to end | Activates; the topbar badge updates; it appears in Purchase History |
| W-02 | Buy a **coach** membership | Same, with coach-appropriate fields |
| W-03 | Sign the waiver **inline** during purchase | Full text is readable before you agree; you can't agree without scrolling/acknowledging |
| W-04 | Sign via the **emailed direct link** as an adult | The link works, and it forces the **same athlete-name match** as the inline flow |
| W-05 | **Guardian path**: a minor's membership triggers a guardian waiver request | The guardian gets an email and can sign for the minor |
| W-06 | Try signing with the **wrong name** on the direct link | Refused with a clear message |
| W-07 | Membership where the **club is paying**: buy while the club cart is unpaid | Membership shows a **pending-club-payment** hold, with honest wording |
| W-08 | Same membership after the **club pays** | Flips to **active**. ⚠️ **Please confirm this one specifically** — a wrong-status bug here was fixed on 2026-08-04 and verified by automation only. It used to tell you "activates once their club pays" when it was already paid |
| W-09 | A membership with **both** a waiver hold and a club-payment hold | **Two distinct status bubbles**, not one merged/ambiguous one |
| W-10 | Admin view of who has signed which waiver version (`#/admin/league` → Waivers) | Signature evidence is there: who, when, which version |
| W-11 | Publish a **new waiver version**, then check an existing signature | Old signatures stay pinned to the version actually signed — they don't silently re-point at the new text |
| W-12 | Buy a membership for a **past/future season** | The season selector works and the membership lands in the right season |

---

## Lane K — Camps ⭐ (Julia)

*Camps pivoted hard right after shipping. Worth a careful pass.*

| ID | Do this | Expected |
|---|---|---|
| K-01 | Open a camp event as an athlete and register | **No discipline / level / apparatus step** — just a single confirmation line ("*X* will be registered for *event*") (spec §G) |
| K-02 | Register for a camp **without a club membership** | Allowed — the club-membership gate is waived for camps (spec §G) |
| K-03 | Register for a camp **without an individual membership** | Blocked — individual membership **is** required for the camp's season (spec §G) |
| K-04 | Fill in the **overnight survey** (bedtime / noise / cabin gender / roommate) | Asked **last**, after add-ons; required questions enforced |
| K-05 | Edit the survey after registering | Free — never a change fee — up to the edit deadline |
| K-06 | Camp add-ons (leo/shirt) | A size must be chosen; $0 price is allowed; explicit "no shirt / no leo" options exist |
| K-07 | Camp confirmation email | Survey answers + add-on summary + an edit link, formatted readably |
| K-08 | Camp export (admin/host) | One line per athlete: name, club, birthday, gender, profile shirt size, purchased shirt/leo size, all survey answers, date registered (spec §G) |
| K-09 | **As a club manager**, look at the club page's event picker | Camps no longer appear at all — Julia decided "block it outright" (2026-08-19) and it shipped the same day. Managers can't register athletes for camps or see camp registrations from the club page; athletes use My Registrations |
| K-10 | Edit a camp registration made **before 2026-07-23** if any exist | Edits in place, no duplicate rows |

---

## Lane C — Club manager

| ID | Do this | Expected |
|---|---|---|
| C-01 | Club roster: add an athlete, edit one, remove one | All three work; changes visible to that athlete |
| C-02 | Send a **club invite**; accept it from the other side | Invitee joins the right club, linked to the right person |
| C-03 | Registered-athletes card: check the **status bubbles** | Green "Registered", yellow "In Cart", orange "Pending Changes", purple "Updated Registration" — each appears in the right state (spec §E1) |
| C-04 | **Swap an athlete** in an existing registration | Dropdown offers only eligible members; the swap applies **and incurs a change fee** (spec §E1) |
| C-05 | Register several athletes at once and check out as the club | One invoice, all athletes itemized |
| C-06 | **Add-ons card**: assign banquet tickets to specific athletes/coaches and to "EXTRA" | Max **1 assigned per account**; extras must be EXTRA/unassigned; each is its own refundable line (spec §E3) |
| C-07 | T-shirts/leos: **quantity + size per unit** | One line per unit, each carrying its own size (spec §E3, P2 decision) |
| C-08 | **Club banner**: 1 per club with an exact-name text box | Exactly one; the text you typed is what appears on the invoice |
| C-09 | **Members-without-membership card** | Lists them; "send membership invite" emails a season-targeted purchase link; re-sending shows "last sent [date]" (spec §E5) |
| C-10 | "Create new athlete" (first/last/email) from that card | Sends an account invite; the athlete appears on the roster |
| C-11 | **Set Competition Order** (MAG/WAG only, not T&T) | Pick a level → one column per apparatus → drag names into order; athletes appear only in columns they're registered for; **auto-saves**; section dividers cap **12 WAG / 15 MAG** per section (spec §E6) |
| C-12 | Admin ticks the **lock competition orders** checkbox; look again as the club | View-only. Only admins can still edit |
| C-13 | Try to view **another club's** roster or registrations by editing the URL | Refused |
| C-14 | Per-line **refund request** from the registered-athletes card | Same dialog/reason flow as G-20 (spec §E2) |
| C-15 | Club Cart & Receipts | Past receipts downloadable; the club's own history is complete and separate from your personal one |

---

## Lane P — Capacity, waitlists & by-session registration

*Set up a small test event with tight caps (2–3) so you can hit the limits without bulk data.*

| ID | Do this | Expected |
|---|---|---|
| P-01 | Set a **total participant cap**; fill it | Registration blocks in real time once full (spec §F) — one athlete counts once, however many apparatus they enter |
| P-02 | Set a **per-level cap** (WAG/MAG); fill it | Blocks. Note: per-level caps count **routines** (apparatus entries), so one athlete on 4 apparatus consumes 4 |
| P-03 | Set a **per-discipline cap** (T&T); fill it | Blocks |
| P-04 | **Partial fit**: cap has 2 spots, try to register 3 athletes at one level | Checkout blocks with an error **naming the level and the overage** ("Level 5 is 1 over capacity") and offers: waitlist the whole group, a different session, or an explicit split. Never silently partial (spec §F) |
| P-05 | Choose "waitlist the group" | The whole level group is waitlisted together |
| P-06 | **Free up space** (refund/withdraw/raise the cap) | Waitlisted group is auto-notified by email when enough space exists **for the whole group** (spec §F). Allow up to ~15 min — promotion runs on a scheduled sweep, not instantly |
| P-07 | Admin **overrides** a cap for one case | Allowed for league admins |
| P-08 | Switch the event to **by-session** mode; create sessions with per-apparatus routine caps | Athletes/clubs pick a session at registration |
| P-09 | Try to register into a **full session** | Unselectable, but a **waitlist** is offered |
| P-10 | Checkout when a selected session lacks space | Error says **which session/level/apparatus** is over and **by how much** (spec §F) |
| P-11 | Edit a registration to **move sessions** | Allowed; normal change fee applies |
| P-12 | Change an athlete's **level** to one that doesn't fit their session | Forces a session change rather than leaving an invalid combination |
| P-13 | Start a checkout that reserves capacity, then **abandon** it. Wait ~30 min | The soft hold releases and the spots come back (spec §F) |

---

## Lane H — Sanctioning & event hosting

| ID | Do this | Expected |
|---|---|---|
| H-01 | Submit a **sanction request** with the full field set | Saves; submission email goes to the sanctioning team |
| H-02 | Vote on it from the **sanctioning queue** | Vote records; the tally rule (⅔, or majority at the deadline) behaves |
| H-03 | Approve it | Event is auto-created; `YYYY_ST_###` sanction ID assigned; approval email to the requester |
| H-04 | **Reject** a different request | Rejection email; no event created |
| H-05 | Check for **voting reminder emails** to non-voters at 3 days and 1 day before the deadline | These **are implemented** (a 15-minutely scheduled job) — expect them, with ±15 min timing tolerance (spec §B1) |
| H-06 | Assign an **event owner** to an approved event | Field at the top of the page; **unassigned events are red-highlighted** in the list (spec §B3) |
| H-07 | Walk the **event-owner checklist**: contact, hotel link, medals ordered → tracking, insurance cert, onsite rep, pay host | All 7 items present with sane due dates (spec §B4) |
| H-08 | Let a checklist item go **overdue** | Escalating reminder emails: 1 week before due, 1 day before, then daily while overdue (spec §B4). If absent, mark `MISSING` |
| H-09 | **Event wizard**: create an event using every field — venue, street address, country, hotel link, age-calc datetime, late-reg window + fee, director + cc, per-event confirmation email, caps, registration mode, scoring config | Each saves and survives a reload |
| H-10 | Try to upload a **schedule attachment** (pdf/jpg/png) (spec §A) | Known gap — see Appendix A. Confirm and move on |
| H-11 | Open the **Event Host page** as the host club manager | Status card shows: UCG owner contact, hotel link (or "waiting"), insurance download (or "waiting"), medal status, onsite rep, payment status (spec §C) |
| H-12 | Host page **payment status** with real paid registrations | Running total collected **excluding processing fees**; then "payment will be sent 1 week after event" in red; then sent-via/date once marked (spec §C) |
| H-13 | Host page **registration summary** | Per level: participating clubs and athletes per apparatus |
| H-14 | Host page **Excel download** — open it in Excel | Athletes sheet (1 line per athlete, full detail), Counts sheet (level × club × apparatus), Shirt-sizes sheet. Columns readable, no `#####`, no mangled dates |
| H-15 | **Event admin grant**: host adds another account's email | That account gets the same host-level access. Exact-email only by design — no name search |
| H-16 | Sign in as that granted account | You see the host page for **that event only**, nothing else |
| H-17 | **Post-close host edits**: after registration closes, edit sessions/schedule, scoring, add/remove athletes and levels/apparatus | Allowed **with a warning**. Never refunds or pricing config. Host-added registrations are created paid with no cart line; removals do **not** refund (spec §C, P1 decisions) |
| H-18 | Event **status transitions**: draft → published → reg open → reg closed → complete | Each transition changes what registrants can see and do |
| H-19 | "Publish dates and location only" (listing-only) | Lists on the Events page with **no Details button** |

---

## Lane N — Nationals (Julia)

*All of this is gated on the event being nationals-kind.*

| ID | Do this | Expected |
|---|---|---|
| N-01 | **Session-request survey** as a club: one per WAG level, one for all MAG, one for all T&T | Asks arrival window, preferred sessions (multi), separate-gyms preference, free text (spec §L1) |
| N-02 | Try to check out the event cart with a **survey unanswered** | Blocked until all required surveys are answered — **including levels newly added by in-cart athletes** (spec §E4) |
| N-03 | Independent athlete variant of the survey | Individual variant per discipline: arrival day, preferred sessions, free text |
| N-04 | Edit a survey answer before the change deadline | Allowed, free |
| N-05 | **Eligible teams table** | A team = ≥3 athletes per apparatus, same club + level + placement category. Verify against a roster you know by hand |
| N-06 | **Placement categories** against the gender / override / student-status matrix | Athletes land in the categories you'd expect. Try an athlete with a per-discipline override |
| N-07 | **Finals lineup editor**: pick 4 per apparatus, drag to order | Saves; only eligible athletes offered |
| N-08 | Admin sets `finals_lineup_deadline_at`; let it approach | The nag fires. ⚠️ The per-team session-timed reminders ("5 min after session ends") are **deliberately deferred** — see Appendix A |
| N-09 | 10pm **hard lock** | Club managers become view-only; only admins can edit |
| N-10 | **Decathlon/omnithon summary** | WAG+MAG all-around athletes listed; Omnithon when all T&T |
| N-11 | **Club coach list** | Shown; a warning appears when a club has none |
| N-12 | **Banquet-ticket gap list** | Registrants with no associated ticket are listed |
| N-13 | **Assigned-sessions table** once sessions leave draft | Shows "(partial)" when a level spans sessions |
| N-14 | **Check-in flow**: admin marks a club ready → club admin sees the confirmation checkbox, signs their name, confirms through the "are you sure" popup | Ends at "Your club is checked in" (spec §L4) |
| N-15 | Check-in page **athlete count** | Equals the athlete-gift count |
| N-16 | Admin **views the check-in page as** another club / an independent athlete | Works, and it's obvious you're impersonating a view |
| N-17 | Nationals scoring: prelim vs finals sessions, qualification, awards | Ranks and awards match the ruleset. **Check one placement by hand** |

---

## Lane R — Refunds

*Do this after lane M — you need something actually paid. Requester and approver must be
different people (that's the point).*

| ID | Do this | Expected |
|---|---|---|
| R-01 | Request a refund on a **non-UCG-hosted** event | Correctly unavailable — refunds are UCG-hosted-only (spec §H) |
| R-02 | Request one on a **UCG-hosted** event, **before** `lastDateToEdit` | "Request received" email to you; summary email to refund managers with a review link |
| R-03 | Approve it as the refund manager | **Full refund**; registration **fully removed**; processed email + refund receipt; receipt visible under Purchase History |
| R-04 | Verify the refund in the **Stripe Dashboard** | Amount matches to the cent; refunded to the original payment method |
| R-05 | Request another **after** `lastDateToEdit`, and approve | **75% of funds before processing fees.** Check the arithmetic by hand |
| R-06 | Look at the athlete after an after-deadline refund | All apparatus unchecked and **un-recheckable** except by league admins, who get a "refunded, cannot participate" warning. The **name still appears in meet materials** (spec §H) |
| R-07 | **Reject** a request | "Invalid reason" email to requester, refund admins cc'd, **no registration change** |
| R-08 | Refund a **single banquet ticket** | Just that ticket refunds; other lines untouched. ⚠️ Policy note (Julia 2026-08-19): add-ons should refund **in full until that add-on's order deadline, not at all after** — but the code currently applies the registration 100%/75% `lastDateToEdit` rule to add-ons too. Test what's built; the policy change is tracked in whats-next |
| R-09 | **Move** a banquet ticket to another athlete / mark it EXTRA | Works without a refund |
| R-10 | Refund one add-on out of a multi-item order | Only that item. **Open the original receipt afterward — it must be undisturbed** (spec §H). Same D-5 policy note as R-08 applies to the amount |
| R-11 | Refund a **club-paid** registration | Refunds **to the club**, not the athlete (spec §H) |
| R-12 | Refund an order that a coupon covered **100%** | Processes as a $0 no-op through the same flow, with a receipt |
| R-13 | Request more than remains refundable | Capped at the remainder, not refused outright |
| R-14 | Check `#/admin/finance` after all refunds | Refund totals reflect every one of the above |
| R-15 | **NEW (2026-08-24): Withdraw** from a UCG-hosted event where your registration cost **$0** (100% promo), **before** `lastDateToEdit` — the Withdraw button replaces the refund option on My Registrations | Confirm dialog → you are **removed from the event entirely**; you get a confirmation email; the event host gets a withdrawal notification |
| R-16 | **NEW: Withdraw after** `lastDateToEdit` (any withdrawable registration) | You **stay registered with all apparatus scratched** and a "Withdrawn" badge; the email says you remain listed due to the late timing and still get any event freebies (attend or send a friend) |
| R-17 | **NEW: Withdraw from a NON-UCG event** (refunds are handled off-platform by the host club) | Withdraw is always offered there (never a refund button). Your email includes "to request a refund, contact the host club at <their email>" — **unless you compete for the host club**, in which case that sentence is omitted. Host gets notified either way |
| R-18 | **NEW: Check the refund-vs-withdraw button logic** across your registrations | UCG event + paid > $0 → **Request a refund** only. UCG event + $0 → **Withdraw** only. Non-UCG event → **Withdraw** only. Never both |

---

## Lane F — Finance & admin (Nate + Julia as finance_admin)

| ID | Do this | Expected |
|---|---|---|
| F-01 | Julia opens `#/admin/finance` **as finance_admin, not admin** | It loads. If it doesn't, S-01 didn't take |
| F-02 | **Summary tab**: one line per revenue type with its accounting code | Net revenue, gross revenue, refunds, merchant fees collected, merchant fees paid (spec §M) |
| F-03 | **Check the arithmetic by hand** against the Stripe Dashboard for one day | Gross, fees, and net all tie out |
| F-04 | **Date-range filter**, including the smart defaults (reg-open → event+1wk per event; previous month for the aggregate) | Numbers change correctly; defaults are the ones described |
| F-05 | **Per-event** finance dashboard | Same shape as the league one, scoped to the event |
| F-06 | **Host payout** on an event: amount owed + the calculation shown | Gross collected — registrations plus add-ons, **before service and admin fees**. **Refunds are NOT deducted** (Julia, 2026-07-17). League-hosted events get **no** payout |
| F-07 | Enter host **payment info** (date, check# / PayPal / ACH) | Saves and shows on the host page |
| F-08 | **Invoices/Transactions tab** | Every payment and refund with date, name, email, club, transaction id, invoice/refund #, item description, notes |
| F-09 | **Click through** from a summary line to its transactions | Lands on the matching filtered set |
| F-10 | **Export** both tabs; open in Excel | Complete, correctly typed, opens without a repair prompt |
| F-11 | **Accounting-code management**: assign codes to purchase-item types | Codes appear as summary columns |
| F-12 | `#/admin/members`: search, open a profile, edit it, export a person's data, delete a person | All work. Deletion asks for real confirmation |
| F-13 | `#/admin/clubs`: create, edit, manage managers | Works; a manager change takes effect for that user |
| F-14 | `#/admin/league`: seasons, levels, regions, promos, waivers, user roles | Each sub-tab loads and saves |
| F-15 | Grant and then **revoke** a role; have that person refresh | Access appears and disappears correctly |
| F-16 | `#/admin/errors` | Errors from this whole test round are there. **Correlate one against your spreadsheet timestamp** — that's the round-trip we want to prove works |
| F-17 | **Payments reconciliation** tool | Runs; flags anything genuinely mismatched between Stripe and the database |
| F-18 | Manager-access request → review flow | Requester gets a link; reviewer approves/denies; the denial notification fires |

---

## Lane J — Judge & meet day (2 devices required)

*The codeless judge path has never had a real two-device smoke test. That's this lane.*

| ID | Do this | Expected |
|---|---|---|
| J-01 | Admin/host: generate a **judge access code** for a live event | You get a URL, a **6-digit code**, and a **QR code** |
| J-02 | On **device 2**, signed out, **scan the QR with the real camera** | Opens the unlock page and unlocks. (This is the step nothing but a real camera can prove) |
| J-03 | On device 2, sign out / clear, then unlock with the **6-digit code** | Unlocks |
| J-04 | Enter a **wrong** 6-digit code | Refused. Enter ~16 wrong codes in a row → you should be **rate-limited** after 15 within 5 minutes. ⚠️ **Please confirm this** — it was verified by automation only |
| J-05 | After being rate-limited, unlock with the **URL/QR token** instead | Still works — the token path is deliberately exempt so a judge is never locked out entirely |
| J-06 | After a successful unlock, try a few bad codes again | The counter was cleared by the success |
| J-07 | **Enter a real score** from the anonymous device | Saves; appears on the results/score list |
| J-08 | Watch that score appear on **device 1 without refreshing** | Scores are the one thing with live updates — it should just appear |
| J-09 | Use the **calculator** entry mode | Math is right. Check one routine by hand |
| J-10 | Use the **simple** entry mode | Same score, entered directly |
| J-11 | Event configured for a **2-judge panel** | Execution scores are averaged correctly |
| J-12 | Enter scores for **each discipline you support** (MAG, WAG, T&T, and the specialty calculators) | Each engine's math checks out on at least one routine |
| J-13 | **Edit** a posted score | Updates everywhere, including the public results |
| J-14 | Open a **score detail** page | Full breakdown, correct athlete |
| J-15 | Try score entry on a device with **no unlock** and no privileged account | Refused |
| J-16 | Judge on a phone in **both portrait and landscape**, one-handed, on venue-grade wifi — every control reachable in portrait without sideways scrolling (Nate's Z-06 finding) | Usable. This is the real meet-day condition — note anything that would be miserable at 8am with a line of gymnasts waiting |
| J-17 | Turn wifi **off** mid-entry, then back on | Something sane happens — a queued write, or an honest error. Not silent loss |

---

## Lane X — Public & anonymous surfaces

*Use a fresh incognito window. Never sign in during this lane.*

| ID | Do this | Expected |
|---|---|---|
| X-01 | Public **Results** index and an event's results | Loads; **athlete names are visible** (they used to be blank for anonymous visitors) |
| X-02 | Results for an event with scores across **multiple sessions** | All posted scores appear with correct ranks. ⚠️ **Please confirm** — a bug that hid scores was fixed 2026-07-31 and verified by automation only |
| X-03 | Results for an event where some registrations have **no session assigned** | Scores still appear, and the empty state is honest about anything unplaced |
| X-04 | Public **Events** list and an event detail page | Everything a prospective registrant needs is visible without an account |
| X-05 | Home page while signed out | Sensible. Nothing admin-ish leaks |
| X-06 | Try `#/me`, `#/cart`, `#/admin/members` while signed out | Sign-in gate every time |
| X-07 | Open a **judge access URL** you weren't given (guess a token) | Refused |
| X-08 | **Share an event link** to yourself via text/Slack and open it from there | Loads correctly from a cold, external context |
| X-09 | Public pages on a **phone** | Readable, tappable, no horizontal scroll |

---

## Lane D — Devices, responsive & PWA

*Real devices only. A resized desktop window does not reproduce iOS Safari.*

| ID | Do this | Expected |
|---|---|---|
| D-01 | Full pass on an **iPhone (Safari)** — sign in, register, cart, profile | Nothing clipped, nothing untappable |
| D-02 | Full pass on an **Android (Chrome)** | Same |
| D-03 | **Tablet**, both orientations | Layout adapts |
| D-04 | The **mobile nav drawer**: open, navigate, close | Works, including from deep pages |
| D-05 | Every **modal** on a phone — registration popup, refund dialog, report-a-problem | Fully visible, scrollable, closable. No content trapped off-screen |
| D-06 | **Wide tables** on a phone — admin members, finance transactions, host summary | Scroll horizontally *inside* their own container; the page itself doesn't scroll sideways |
| D-07 | **Install the PWA** ("Add to Home Screen") on iOS and Android | Installs; launches; icon and name are right |
| D-08 | Use the installed PWA for a full registration flow | Works the same as the browser |
| D-09 | **PWA update path**: with the PWA installed, wait for the next deploy, then reopen it | Do you get the new version, and how long did it take? ⚠️ **This is unverified — whatever you observe is the finding.** Note the wall-clock delay |
| D-10 | **Dark mode** (OS-level) on a few pages | Readable. **Flag any text you can barely see** — same-colour-on-same-colour is a recurring trap |
| D-11 | **Browser zoom to 200%** on desktop | Still usable |
| D-12 | Rotate the phone mid-form | Nothing lost |
| D-13 | Firefox and Edge, one flow each | No browser-specific breakage |

---

## Lane Y — Keyboard & accessibility (Nate)

*One specific thing here can only be verified by a human: the test tooling in this repo can move
focus with Tab but **cannot** deliver a real Enter/Space activation. That has never been
confirmed by a person.*

| ID | Do this | Expected |
|---|---|---|
| Y-01 | **Unplug the mouse.** Complete one full registration + checkout using only the keyboard | Possible. Note every point where you got stuck |
| Y-02 | Tab through a page — is the focus ring always **visible**? | Yes, on every interactive element |
| Y-03 | **Press Enter and Space on buttons** — especially Details/Hide toggles, the judge score stepper, Copy-link buttons | They activate. ⚠️ **This is the never-verified one.** Whatever you find here is new information |
| Y-04 | Open a modal, then press **Tab repeatedly** | Focus stays **inside** the modal — it must not reach the nav behind it |
| Y-05 | Press **Escape** in a modal with unsaved changes | You're warned rather than silently losing the edit |
| Y-06 | Press **Escape** with two dialogs stacked | Closes only the top one |
| Y-07 | Close a modal | Focus returns to whatever opened it |
| Y-08 | Tab order on a long form (Profile) | Follows the visual order |
| Y-09 | Squint-test every screen for **low-contrast text** | Flag anything hard to read, especially validation messages, nav group labels, and hover/disabled states |
| Y-10 | If you have VoiceOver/Narrator, skim the Profile page | Fields announce their labels |

---

# Appendix A — Known gaps: please DON'T file these

These are already tracked. Confirming them costs nothing; filing them costs a triage cycle.
**If you feel strongly that one should be prioritized, say so in the `D` column** — that's
useful. Just don't file it as a bug.

| Thing you'll notice | Status |
|---|---|
| **Loading states aren't announced to screen readers**; ~35 hand-rolled "Loading…" spots | Known (a11y audit A7), deferred |
| **Empty states are worded inconsistently** across the app (~30 variations); no shared empty/loading component | Known, deferred cleanup |
| **Two different invoice-number formats** coexist | Known. ⚠️ But see **Z-01** — the concurrency risk is real and we want that test run |
| **No session-assignment tool** for nationals (§L.2) | Deliberately deferred by Julia. **Consequence you'll hit:** a registration with no session assigned used to hide its scores from public Results. The score-hiding half is fixed; the *assignment tool* is not built |
| Editing an event's sessions can **orphan registrations** from their session | Known, related to the above |
| **New-club-request email** to `newclubinquiries@naigc.org` isn't wired up | Known |
| **Receipt PDFs are generated on demand, not attached** to confirmation emails | Known deferral (spec §I) |
| **Schedule-file attachment** on an event (pdf/jpg/png) | Not built — needs file storage |
| **PWA update path unverified** | That's exactly what **D-09** is for — please do run it |
| **Nationals session-timed finals reminders** ("5 min after session ends") | Deliberately deferred; only the admin-set deadline nag + 10pm lock shipped |
| ~~Camps: club managers aren't blocked~~ | ✅ **Resolved + shipped 2026-08-19** — Julia chose "block it outright"; camps are filtered from the club-page event picker (**K-09** now verifies the block) |
| **Synchro partner automations** — the "partner unknown" reminder email and the jilted-athlete revert + email (spec §D) | Not built (verified in code 2026-08-19). The mutual partner auto-link/level-sync IS built. **G-08** asks you to observe actual behavior |
| **Private registration code** — the field exists but nothing validates it; the "Private reg link" button is a demo stub | Not built. Late registration works by date window + automatic late fee instead (**G-16**) |
| **Season-preset on the membership gate link** (spec §D) | Not built — gate links go to the membership page generically. The page supports `?season=` but nothing passes it (**G-01**) |

---

# Appendix B — Three fixes verified by automation only

Each of these was root-caused and fixed, and proven by scripted tests against the live
backend — but **no human has watched them work**. Human confirmation is cheap and high-value,
because each was a case where the obvious reading of the bug was wrong.

| Fix | Confirm with | What it used to do |
|---|---|---|
| **Membership stuck after the club pays** (2026-08-04) | **W-08** | Told a guardian the membership "activates once their club pays" when the club had already paid — and the membership could never reach active through that path at all |
| **Public results hid posted scores** (2026-07-31) | **X-02**, **X-03** | Scores existed but didn't render for athletes whose registration carried no session id — and assigning sessions didn't fix it |
| **Judge unlock had no real rate limit** (2026-07-31) | **J-04**, **J-05**, **J-06** | 40 simultaneous wrong codes were all merely refused, never throttled |

---

# Appendix C — Questions for Julia — ✅ ALL ANSWERED 2026-08-19

| # | Question | Julia's answer | Follow-up |
|---|---|---|---|
| D-1 | Camps and club managers | **Block it outright** | ✅ Shipped same day — camps filtered from the club-page event picker (K-09 verifies) |
| D-2 | Host payout timing | **Yes — 1 week after the event is the policy** | None; the host-page wording is correct |
| D-3 | Hosts and SMS | **Yes — email only for hosts stays right** | None |
| D-4 | Invoice numbering format | **All current rows are test data; wipe the record before go-live. Use the latest format, `UCG-YYYY-XXXX`** | Recorded in whats-next. The Z-01 concurrency test still matters — the sequence fix remains a go-live gate |
| D-5 | Add-on refund policy | **Full refund until each add-on's order deadline; no refunds after** | ⚠️ NOT what's built (code applies the 100%/75% `lastDateToEdit` rule to add-ons). New open item in whats-next §3; R-08/R-10 annotated |
| D-6 | Anything in Appendix A that shouldn't wait | **Nothing at this time** | None |

---

# Appendix D — Where to send it all

Findings live in the shared Google Sheet — nothing to send there. After each block (don't
wait until the very end):

1. Zip your screenshots folder (or drop it in a Drive folder next to the Sheet).
2. Send it over with a one-line note on which lanes are covered and anything that felt wrong
   but that you couldn't pin to a step.

Partial is fine and genuinely useful — a completed lane A + M is worth more than four
half-finished lanes. And **anything that made you say "huh?" is worth writing down even if you
can't articulate why.** Those are usually the real findings.
