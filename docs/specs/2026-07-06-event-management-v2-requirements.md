# Event Management v2 — Julia's requirements, digested + gap-mapped (2026-07-06)

**Source of truth for wording:** Julia's raw spec at
[`../reference/Reg & Scoring Platform Specification - Event Management.md`](../reference/Reg%20&%20Scoring%20Platform%20Specification%20-%20Event%20Management.md)
plus the legacy Nationals reg/check-in tools and their sheet backends
(indexed in [`../reference/README.md`](../reference/README.md)).
This doc organizes those requirements, maps each area to what the platform
already has (verified against the codebase 2026-07-06), flags conflicts and
open decisions, and proposes a build phasing. **Nothing here is scheduled yet**
— prioritization happens in [`../README.md`](../README.md) → What's next.

Julia explicitly marked TBD / skip-for-now: session-setup detail, rotations,
squads, scoring, results, competition exports, and the sanctioning task-checklist
detail. Don't build ahead of those sections.

## How this relates to what's shipped

The 2026-06-18 event-management subsystem
([spec](2026-06-18-event-management.md)) shipped the foundation this v2 spec
extends: event entity (camp/competition, nationals kind), sanction request form
+ ⅔ voting + auto event creation + sanction IDs, registration editor
(disciplines/levels/apparatus, T&T per-apparatus levels, synchro partners),
club-manager + self registration, change fees, add-ons (t-shirt/banquet/banner/
camp leo), sessions + squad builder, CSV exports, league-level Communicate.
Julia's v2 spec is roughly **⅓ already built, ⅓ extensions to built areas,
⅓ net-new subsystems** (host dashboard, refunds, capacity/waitlists, nationals
check-in, finance).

---

## A. Event setup — field/config extensions (EXTENDS existing)

Current `Event` already has: name, slug, status, kind (standard/nationals),
eventType (competition/camp), hostClubId, city/state/timezone, start/end dates,
regOpens/regCloses (datetime), lastDateToEdit, entryFee/secondDisciplineFee,
changeFee{amount, startsAt}, disciplines, sessions, privateRegCode, add-on
config (banquet/tshirt/banner, camp leoAddon), campConfig (overnight survey,
director, ageCalcAt), nationalsConfig, sanctionId.

Julia asks for (gaps in **bold**):
- **Street address + venue on the Event itself** (today address lives only in
  the sanction-request payload). Nice-to-have: address autocomplete filling
  city/state/country.
- **Country** field (today city/state only).
- **Late registration**: offered-checkbox + **late-reg window start
  (date/time/tz)** + **late fee** ("original fee plus late fee"). Today
  `privateRegCode` exists but no late window/fee concept.
- Correction deadline — exists (`lastDateToEdit`).
- **Age-calculation datetime for competitions** (today camp-only `ageCalcAt`).
- **Per-event confirmation email**: rich-text + raw-HTML editor with preview;
  body is included in every cart-processed confirmation. Today: only the
  generic webhook receipt email. **From-address resolved (Julia 2026-07-06):**
  always send from a verified-domain address with a custom display name
  (from-alias); the host/director address goes in **reply-to** — applies
  everywhere Julia's doc says "from email" (§I, §J).
- **Director name/email + "cc director on confirmation emails"** for
  competitions (today camp-only).
- **Hotel block link** as a real field (today free-text overnight description
  on sanction payload only).
- **Schedule attachment** (pdf/jpg/png) — needs file storage; nothing today.
- **Max participants**: total, **per-level or per-discipline caps** for
  WAG/MAG (T&T discipline-level cap only). Today: no caps at all.
- **Registration mode: by-discipline vs by-session** (see §F).
- **Add-on purchase deadlines** ("last date to purchase", allowed to be after
  reg close and change deadline) + **quantity + per-unit size** on t-shirts/
  leos/banquet tickets (see §E3).
- All of the above editable on the event details page by sanctioning team +
  league admins (sanctioned events included).

## B. Sanction workflow deltas (EXTENDS existing)

Shipped: request form (matches Julia's field list closely, incl. accessibility
gate, insurance, fee collection/payout, awards + ribbon ranking, banner, hotel
block, certification), voting page, `tallyVotes` (⅔ or majority-at-deadline),
auto event creation, `YYYY_ST_###` sanction ID, notify-sanction emails
(submitted → team; approved/rejected → requester).

Gaps:
1. **Voting reminder emails** to non-voters 3 days and 1 day before the 7-day
   deadline — needs a **scheduler** (see §N cross-cutting).
2. **Sanction management page**: card of "events you need to vote on" + card
   of approved events (filter "owned by me"); vote notes logged on the event
   page. Today there's a queue; verify layout matches.
3. **Event owner** (a sanctioning-team member assigned per approved event):
   field at top of approved-event page; unassigned = red highlight on the list.
   Net-new concept.
4. **Event-owner task checklist + timeline** with escalating emails (1 week
   before due, 1 day before, then daily while overdue): establish contact
   (+1wk), hotel-block link (by reg open), medals ordered (+1wk) → tracking
   (+2wk after order), insurance certificate upload (+2wk), onsite rep
   (−2wk before event), pay host (+1wk after event, check/PayPal). Detail
   beyond this list is marked TBD by Julia.

## C. Event Host Viewing Page (NET-NEW)

A host-facing dashboard per sanctioned event (read-only on event config until
registration closes, then a link to the details edit page for competition
setup):
- Status card: UCG event-owner contact; hotel-block link (or "waiting");
  insurance policy download (or "waiting"); medal order status (waiting /
  ordered date / tracking link / host marks received); onsite rep ("assigned
  2 weeks before" or name+email); payment status ("not collecting fees" or
  running total collected **excluding processing fees**, then "payment will be
  sent 1 week after event" in red, then "sent via check/PayPal on [date]").
- Registration summary: per level, participating clubs + athletes per
  apparatus; **Excel downloads** (full athlete detail 1-line-per-athlete;
  level×club×apparatus counts; t-shirt sizes; leo sizes; banquet quantities).
- Host tools: **email registrants** (rich text + HTML, from address/alias) —
  see §J.
- **Event admin grants**: host enters account emails (search by name) to give
  others the same host-level access. Net-new (per-event ACL, not a club role).

**P1 decisions (Nate 2026-07-09, shipped with V2-P1):** host post-close edit
scope = meet organization (sessions/schedule), meet scoring, and add/remove
athletes + level/apparatus edits **with a warning** — never refunds or
fees/pricing config. Host roster edits never touch payment state: host-added
regs are created `paid:true` with no cart line (host-club $0 rule extended);
removals do NOT refund (refunds are P3). Event-admin grants are exact-account-
email only (no name search — PII decision; Julia's "search by name" deferred).
Excel exports ship as ONE workbook with Athletes / Counts / Shirt-sizes
(profile) sheets; leo-size and banquet-quantity sheets wait for the P2 add-on
model (no purchased-unit size/quantity data exists yet).

**P2 decisions (Nate 2026-07-10, shipped with V2-P2):** (1) ONE cart/invoice
line per unit for ALL quantity add-ons (banquet/shirt/leo), each carrying its
size (`addon_size`) or banquet assignee (`addon_assignee`: person id or
`'extra'`) — uniform, refund-ready for P3. (2) Purchase deadlines are PER
add-on type (`lastPurchaseAt` on each config); unset ⇒ purchasable only while
registration is open — so a stale add-on cart line for a closed event now
fails checkout by design. (3) Standalone add-on purchase shipped: event page
(self cart, post-registration) + club Add-ons card (§E3), both live until each
type's window closes, including past regCloses. (4) The camp confirmation's
"receipt attached" is DEFERRED to P3's server-side receipt rendering — the P2
camp email carries survey + add-on summary + an edit link instead. (5) The
carry-over gap recorded here — camp registration reusing the full
per-discipline editor — was **closed 2026-07-23** by commit `4e05fb8`; see §G.

## D. Registration page & flow deltas (EXTENDS existing)

- Unique registration page per event + easy link copy — exists (slug); add
  copy-link affordance.
- **Late registration via private code** (resolved 2026-07-06): today's
  `privateRegCode` approach — a code known only to people we tell, entered on
  the normal event page — is acceptable; no separate hidden URL needed. Still
  required: the code **stops working after `lastDateToEdit`** (then league
  admins only) — verify/add that expiry.
- **Login-return**: registration page requires login and returns you to it
  after auth. Verify with HashRouter redirect handling.
- **Membership gating message**: non-member sees "you can't register until
  season membership is purchased" + link to membership purchase **pre-set to
  the event's season (even if not the current season)**. Club-manager
  equivalent for club membership. Today the gate exists
  (`clubHasActiveMembership`/`seasonForDate`); the season-targeted purchase
  link is new.
- Registration popup: shipped and close to spec (discipline checkboxes, level,
  apparatus checkboxes, all-around, T&T default level + per-apparatus levels,
  synchro partner picker from any active member).
- **Synchro partner automations** (net-new email logic):
  - "Partner unknown" athletes get an email **1 week before the change
    deadline** with an edit link, only if nobody has selected them meanwhile.
    Partner edits are free. Deadline = event change deadline; admins/managers/
    event admins can edit until a score is entered.
  - If someone re-picks a different partner, the jilted athlete's field
    reverts to unknown + they're emailed with a link and the deadline.
  - (Auto-link of mutual partners already shipped, B4.4.)
- Survey questions (camp housing, nationals session requests) come **last** in
  the popup; add-on + survey answers summarized on the athlete's line item.
- **Only competition details incur the change fee** — add-ons and survey
  answers don't (but all respect the change deadline). Matches shipped
  `changeIsEligible` for competition details; verify add-on edits are
  fee-free.

## E. Club-manager registration page (EXTENDS heavily)

Julia's target layout is 3–5 cards; today `Club.tsx` has the reg grid +
editor. Deltas:

1. **Registered-athletes card** with status bubbles — green "Registered",
   yellow "In Cart", orange "Pending Changes" (unpaid change fee), purple
   "Updated Registration" (differs from confirmation email). Maps to shipped
   `paid`/`updatedPending`/cart states; needs the explicit bubble UX. Swap-
   athlete-in-edit (dropdown of eligible members) — shipped. Swap incurs
   change fee — shipped.
2. **Per-athlete/per-item refund requests** from this card (see §H).
3. **Add-ons card**: banquet tickets **assigned to an athlete/coach or
   "EXTRA"**, max 1 *assigned* per account, each its own refundable line;
   individuals may likewise buy multiple tickets so long as extras are
   unassigned/EXTRA, at most one tied to themself (Julia 2026-07-06);
   t-shirts/leos unassigned, **quantity + size per unit**; club banner
   1-per-club with exact-name text box. Today: banquet/tshirt/banner config exists but
   assignment, quantities, per-unit sizes, and EXTRA don't.
4. **Nationals session-request card**: 1 survey per registered level (see §L);
   cart checkout for the event **blocks until all required surveys are
   answered** (including levels newly added by in-cart athletes); answers
   editable until the change deadline.
5. **Members-without-membership card**: edit info + "send membership invite"
   email (deep link to purchase membership for the event's season),
   re-sendable with "last sent [date]" note; "create new athlete"
   (first/last/email) → account-invite email. Today: club invites +
   invite-account exist; the per-event framing, season-targeted link, and
   last-sent note are new.
6. **Set Competition Order** — ONE feature (Julia 2026-07-06: her "Set
   Lineup" and "Set Competition Order" descriptions were the same thing
   written twice). MAG/WAG only (not T&T): pick a level → one column per
   apparatus → drag athlete names into competing order; athletes appear only
   in columns they're registered for; auto-save; **section dividers capping
   12 WAG / 15 MAG per section**, club controls the split. Event-settings
   checkbox to **lock competition orders** (clubs then view-only). Net-new
   (squad builder exists admin-side, but this is club-facing ordering).
7. **Finals roster** (nationals events): select up to 4 athletes; separate
   event-settings lock; after lock only admins edit. Net-new UI (see §L for
   the timing/reminder rules).

## F. Capacity, waitlists, by-session registration (NET-NEW)

- Caps: max total participants; per-level or per-discipline caps (WAG/MAG),
  discipline cap (T&T). No cap enforcement exists today.
  **Caps block registration in real time** (Julia 2026-07-06), in both modes.
  **Proposed design for the partial-fit case** ("14 spots left, club wants to
  register 15") — Julia is open to suggestions; confirm at P4 kickoff:
  - **All-or-nothing per club per level** at checkout (keeps teams together,
    mirrors her by-session waitlist rule): if the group doesn't fit, checkout
    blocks with an error naming the level/apparatus and the overage ("Level 5
    is 1 over capacity"), and offers (a) waitlist the whole level group,
    (b) a different session where offered, or (c) the club explicitly splits —
    register the 14 who fit, waitlist the rest — as a deliberate choice, never
    silently.
  - **Enforce server-side in `create-checkout-session`** (client checks are
    advisory): capacity = paid regs + regs on *pending* payments younger than
    ~30 min (a soft hold), so two simultaneous checkouts can't oversell and an
    abandoned checkout releases its spots automatically.
  - **Waitlist auto-notifies** (email) when refunds/withdrawals/cap raises
    free enough space for the whole waitlisted group; league admins can
    override caps case-by-case.
- **By-session registration mode**: sessions created before reg opens (name,
  levels, times, max routines per apparatus); athletes/clubs pick a session at
  registration. **Checkout errors when a selected session lacks space**,
  saying which session/level/apparatus is over and by how much; full sessions
  unselectable but offer a **waitlist**; waitlisted teams keep the level
  together and get notified when space opens. Registration-edit page offers
  session moves (normal change fee); a level change forces a fitting session
  change.
- **By-discipline mode** (default; today's behavior): sessions built after
  close; nationals session-request survey optional (§L).

## G. Camps/clinics deltas (EXTENDS existing)

- Individual self-registration only (no club-manager reg) — shipped intent;
  **club membership is NOT required for camps** — **shipped emv2 P2 T5**:
  `clubHasActiveMembershipForEvent`/`clubMembershipGateApplies`
  (`capabilities-core.ts`) waive the gate for `eventType:'camp'` at every
  registration entry point. **Individual membership IS required** (for the
  season the camp occurs in) — answered by Julia 2026-07-06, unchanged
  (`caps.canRegister` already applies regardless of event type).
- No discipline/level/apparatus in camp registration — simpler popup.
  **SHIPPED 2026-07-23** (commit `4e05fb8`). `RegistrationEditor` is still the
  shared component, but it now branches on `event.eventType === 'camp'`: the
  per-discipline checkbox sections are replaced by a single confirmation line
  ("*X* will be registered for *event*"), and a brand-new camp registration
  saves exactly ONE row — `discipline: event.disciplines[0]` (fallback `'MAG'`),
  `levelId: ''`, `apparatus: []`, `sessionId: null`. The discipline value exists
  only to satisfy the NOT NULL enum column; it is never shown or asked about.
  The requirement (no discipline/level/apparatus step) is therefore met at every
  caller — `SelfRegModal`, `MyRegistrations`'s `EditRegistrationModal`, and
  `Club.tsx` — since the branch lives inside the shared editor. Legacy
  multi-row camp registrations (pre-2026-07-23) are edited in place without
  delete/re-add churn. Constraints for future work:
  `.claude/rules/registrations-and-camps.md`.
  ⚠️ Separately still true: the **club-manager path is not blocked** for camps.
  `Club.tsx`'s `openEvents` selector does not filter `eventType === 'camp'`, so a
  manager can pick a camp and register athletes; the club-membership gate is
  correctly waived there, and the editor renders camp mode, so nothing is
  *broken* — but "individual self-registration only" is intent, not enforcement.
- **Overnight-accommodations survey UI** (bedtime / noise level / cabin gender
  pref / roommate free-text) asked per athlete at checkout when enabled —
  **shipped emv2 P2 T5**: asked LAST in `SelfRegModal`, after add-ons;
  editable any time before the edit deadline via `MyRegistrations.tsx`
  (free, never a change fee). `camp_survey` ↔ `Registration.campSurvey`
  plumbed in `supabase.ts`; pure draft/validation/summary helpers in
  `pricing.ts`.
- Add-ons: size must be chosen, $0 price allowed, explicit "no shirt/leo"
  options.
- Confirmation email: survey answers + add-on summary, nicely formatted HTML,
  receipt attached, **link to a unique per-event registration-edit page**.
- Camp export (1 line per athlete): name, club, birthday, gender, profile
  shirt size, purchased shirt/leo size, all 4 survey answers, date registered.

## H. Refunds (NET-NEW system; policy is specific)

> **SHIPPED 2026-07-11 (P3).** Built substantially as specified below, with a few
> concrete decisions: eligibility is driven by a new `clubs.is_league_host` boolean
> flag (admin-set on the league's own club) rather than a hardcoded club name match;
> refunds are **item-price-only** — computed from the purchased line's own post-coupon
> amount (capped at the payment's remaining subtotal), not a whole-order recompute; a
> coupon-fully-covered ($0-total) order gets its own non-Stripe checkout/fulfillment
> path so it can still be refunded (as a $0 no-op) through the same flow; banquet-ticket
> move/mark-EXTRA stays in the existing P2 assignment UI rather than being rebuilt into
> the refund review page. Full narrative: `supabase/README.md`'s migration table
> (`20260710212354`–`20260711023234`) and `CLAUDE.md`'s "Refunds (in-app, shipped emv2
> P3)" bullet.

Only for **UCG-hosted events** (host club "UCG - Main"). Both self-serve
(individual popup) and club-manager (per line-item) request paths:
- Request = confirm dialog (removal warning) + reason dropdown (Injury /
  Illness / Bereavement / Other+explain) → "request received" email to
  requester + summary email to a **new "Refund managers" league role** with a
  review-page link.
- Review page: **Approve** or **Reject** (reject = "invalid reason" email,
  refund admins cc'd, no reg change).
- Approve **before** `lastDateToEdit`: full refund, registration fully
  removed, processed email (+refund receipt, visible under MY UCG purchases).
- Approve **after** `lastDateToEdit`: **75% of funds before processing fees**;
  all apparatus unchecked and un-recheckable except by league admins (with a
  "refunded, cannot participate" warning popup); name still appears in meet
  materials; same emails/receipt.
- Banquet tickets: refund just the ticket, move to another athlete, or mark
  EXTRA; other add-ons individually refundable.
- **Orders must be structured so individual item refunds don't disturb the
  original receipt**; refund receipts generated on approval.

**Club-paid registrations refund to the club** — the original payment method
(Julia 2026-07-06; also Stripe's constraint).

Current state: `refunded`/`refundRequested`/`keepListed` fields exist on
registrations; **no request UI, no review flow, no Stripe refund call, no
refund receipts** (refunds are Stripe-Dashboard-manual today, and a Dashboard
refund doesn't reflect into `payments.status`). This supersedes the vague
"in-app refunds" what's-next item with concrete requirements. Needs: Stripe
Refunds API integration on the payment intent, partial (75%) refunds, refund
records + receipt PDFs, `refund_manager` role (app_role enum addition — own
migration file per enum gotcha).

## I. Confirmation emails & receipts (EXTENDS existing)

Every cart processing sends the logged-in account a confirmation: per-event
message (from §A config) + attached receipt. Receipt spec: UCG logo, "United
Club Gymnastics" in brand font/color, auto receipt number + date, itemized:
new regs (athlete, disciplines, levels, apparatus), updated regs (athlete +
change summary; swaps say "NEW replaced [OLD]" + changes), one line per
banquet ticket (who it's for), per shirt (size), per leo (size), banner
(exact text). Today: webhook `emailReceipt()` sends a receipt; itemization
per this spec, per-event message, director-cc, and from-alias are new.
Note receipts today are client-side jsPDF on demand; an *attached* receipt
means server-side rendering in the webhook path — architectural change worth
calling out.

## J. Event-scoped communication (NET-NEW surface, reuses league infra)

League admins + sanctioning team + **host-club managers** can email AND text
all registered athletes of an event. Mirrors league Communicate (rich text/
HTML + preview, recipient-list view, test send by name search, sent log with
recipients) plus per-email subject / reply-to / from email / from alias /
cc(s). Competition filters: role (athlete/coach/club manager/club email),
**session, level, discipline** (checkboxes). League Communicate shipped;
event scoping, host access (a non-admin sending email — auth model needs
care), from/reply-to config, and the session/level/discipline filters are new.

**P1 decision (Nate 2026-07-09, deviation to revisit with Julia):** hosts get
**email only** — SMS from the event page stays league-admin-only (send-sms
remains admin-gated; each text bills UCG's Telnyx). Test sends go to the
caller's own account email only (no arbitrary-address test surface for
hosts); cc capped at 5 and delivered as ONE copy message.

## K. Exports (EXTENDS existing)

CSV roster + scores exports exist. Julia asks for **Excel** files (host page
downloads are described as multi-file/multi-sheet — see §C and §G; the legacy
masters in `docs/reference/` show the exact shapes: per-discipline athlete
data with one column per apparatus, team summaries, add-on summaries,
session request/assignment summaries, coach summary). Competition-wide
exports beyond the host downloads are marked TBD.

## L. Nationals: session requests, summary dashboard, check-in (NET-NEW)

Replaces the sheet + Apps Script + WordPress pipeline (see
[`../reference/README.md`](../reference/README.md)).

1. **Session-request survey** (by-discipline events with the toggle on): per
   WAG level + one for all MAG + one for all T&T, per club: arrival window,
   preferred sessions (multi), separate-gyms preference, free-text. Answered/
   edited on the club registration page; required before event cart checkout.
   Independent-club athletes answer an individual variant per discipline
   (arrival day, preferred sessions, free-text incl. "who do you want to be
   with").
2. **Session-assignment tool** (admin): table one line per club×level (MAG
   combined, T&T combined): club, level, other disciplines, location
   (auto from level), per-apparatus athlete counts, survey answers, available
   sessions (defaulted from arrival answer — Tue/Wed=all, Thu-before-noon=Thu
   eve+Fri, Thu-before-8=Fri, Fri=last Fri session), UCG-volunteer flag,
   assigned-session dropdown; manual overrides highlighted yellow.
   ⚠ Inside the section Julia marked *incomplete — skip for now*; capture,
   don't build.
3. **Nationals summary dashboard** (per club / per independent athlete):
   - **Eligible teams table** (discipline, level, placement category) — a team
     = ≥3 athletes per apparatus, same club+level+placement category.
     Placement categories per Julia's gender/placement-override matrix
     (matches shipped profile fields: gender, per-discipline men+/women+
     override, student status).
   - **Finals lineup editor** per eligible team: pick 4 per apparatus + drag
     order; opens 8pm on day 1; reminder email 5 min after the team's session
     ends (or Fri 10am for last-session teams) with a 9pm Friday deadline;
     9pm: email+text club managers listing missing lineups; 10pm: hard lock.
   - Decathlon/omnithon summary (WAG+MAG AA athletes; +Omnithon if all T&T).
   - Club coach list (Independent club's coaches shown to independents);
     warning when none.
   - Banquet-ticket gap list (registrants without an associated ticket).
   - Assigned-sessions table once sessions leave draft ("(partial)" when a
     level spans sessions).
4. **Check-in flow**: league/meet admins set a club to "complete check-in" →
   club admin (or independent athlete) sees the confirmation checkbox ("all
   information is correct, I counted all items"), signs name, confirms via
   "are you sure — you can't claim missing items later" popup → "Your club is
   checked in". Check-in page also shows total athlete count (= athlete-gift
   count). Admins can **view the page as any club/athlete**.

Current state: nationals scoring engine, placement categories, quals, and
prelim/final sessions exist; **every dashboard/lineup/check-in surface above
is net-new**, as are the timed reminder emails.

## M. Finance dashboards (was feedback-tracker B5 — now fully spec'd)

One master league-wide dashboard + one per event, all filterable by date range
(smart defaults: reg-open → event+1wk for events; previous month for the
aggregate):
- **Summary tab**: line per revenue type **with accounting code**: net
  revenue, gross revenue, refunds, merchant fees collected, merchant fees
  paid. Events add **host payout**: amount owed (+calculation), payment-info
  entry (date, check#/PayPal/ACH); aggregate adds totals paid to hosts and
  merchant-fee collected/paid/"profit". Fully filterable + fully exportable.
- **Invoices/Transactions tab**: every payment/refund with full detail (date,
  name, email, club, transaction id, invoice/refund #, item description,
  notes); click-through from summary lines; filterable + exportable.
- **Accounting-code management**: assign codes to purchase-item types; codes
  appear as summary columns.

⚠ Julia describes the *current* PaySimple/ScoreFlippers monthly-reconciliation
pain; the platform is Stripe-native, so build directly on
`payments`/`invoices`/`invoice_items` (real per-transaction `stripe_fee` is
already captured) rather than replicating the lump-sum-splitting workflow.
Nothing exists today (B5 open).

## N. Cross-cutting prerequisites & decisions

1. **Scheduler** (Supabase cron / scheduled Edge Function) is a prerequisite
   for at least five features: sanction-vote reminders, event-owner task
   escalations, synchro-partner reminders, finals-lineup reminders, and the
   what's-next error-digest item. Build once, generically (a `scheduled_jobs`
   pattern or pg_cron + one dispatcher function).
2. **File storage** (Supabase Storage) for schedule attachments + insurance
   certificates — first real storage use; PDFs today are client-side on
   demand.
3. **New roles/ACLs**: `refund_manager` app_role; per-event admin grants
   (host-delegated); sanctioning "event owner" assignment. Enum additions get
   their own migration files.
4. **Server-side receipt rendering** for email attachment (today jsPDF
   client-side only).
5. **Quantity/multi-unit add-ons** change the cart line model (one line per
   unit for banquet; qty+size per unit for shirts/leos) — touches
   `create-checkout-session` server pricing; money-path review rules apply.
6. **Branding — RESOLVED (Nate, 2026-07-06)**: every "NAIGC" in Julia's doc
   reads as **UCG** (she's not used to the new name yet) — so "NAIGC-hosted" =
   UCG-hosted, "NAIGC - Main" = the UCG league host club, etc. Operational
   email stays on the verified naigc.org Resend domain until that changes.
7. **Open questions — ALL ANSWERED by Julia 2026-07-06** (sections updated in
   place; kept here as the decision record):
   1. Camp *individual*-membership (§G): **required** — individual membership
      for the season the camp occurs in; only the *club* gate is waived.
   2. Late-reg link (§D): **today's private-code approach is acceptable** — a
      code known only to people we tell, on the normal page. (Code still stops
      working after `lastDateToEdit`.)
   3. "Set Lineup" / "Set Competition Order" (§E6): **one feature**, described
      twice by accident. The 12-WAG/15-MAG section dividers ARE part of it.
   4. Club-paid refunds (§H): **refund to the club** (original payment
      method — matches Stripe's constraint).
   5. Caps in by-discipline mode (§F): **block registration in real time**;
      Julia is open to suggestions on the partial-fit case (14 spots left,
      club of 15) — proposed design recorded in §F.
   6. From-address (§A/§I): **approved** — always send from a verified-domain
      address with a custom display name (alias); host's address goes in
      reply-to.
   7. Banquet quantities (§E3/§G): **confirmed** — individuals may buy
      multiple tickets as long as extras are unassigned/EXTRA; at most one
      tied to the buyer themself.

## O. Phasing (**approved by Nate 2026-07-06** — sequence in docs/README "What's next")

- **V2-P0 Foundations**: scheduler infra; Event field extensions (§A);
  per-event confirmation email + director cc (§I minus attached receipt);
  sanction-vote reminders (§B1).
- **V2-P1 Host experience**: host viewing page + Excel exports (§C, §K);
  event-scoped communication (§J); event-owner assignment + task checklist
  (§B3–4); event admin grants.
- **V2-P2 Add-ons & camps**: quantity/assignment add-on model + purchase
  deadlines (§E3, money-path review); camp survey UI + camp club-gate
  carve-out + camp confirmation email/export (§G).
- **V2-P3 Refunds** (§H): role, request/review flows, Stripe refund calls,
  refund receipts. High-risk money path — fable-tier review mandatory.
- **V2-P4 Capacity & sessions**: caps, by-session registration, waitlists,
  session-move changes (§F).
- **V2-P5 Nationals ops**: session-request surveys, summary dashboard, finals
  lineups + competition order + locks, check-in (§L, §E6–7). Session-
  assignment tool last (Julia's section incomplete).
- **V2-P6 Finance dashboards** (§M) — supersedes/absorbs B5.

Sequencing rationale: P0 unblocks four later phases; P1–P2 deliver visible
value to hosts/clubs for the fall season; refunds (P3) before nationals ops
(P5) because nationals is where refund volume concentrates; finance last
(admin-facing, no athlete deadline).
