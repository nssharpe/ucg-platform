# 2026-06-18 Feedback Batch — Decomposition & Design

Scope decided with Nate (2026-06-18):
- **Build + ship this push:** the "ship-now slice" (all pure-frontend fixes, admin
  $0 payment override, in-app push-to-club-cart) **plus start the Event Management
  subsystem**.
- **Research/plan only (no code this push):** Stripe card-on-file & real charging,
  SMS/texting provider, real transactional email. These become deliverable docs.
- **Live = GitHub Pages on push to `main`.** Schema-dependent work ships behind
  migrations that **Nate must apply to the live Supabase DB** (agent cannot).

## Standing blockers (Nate-only, independent of this batch)
1. **`0006_nationals.sql` is still not applied to live.** `supabase.ts` already
   upserts nationals columns, so meet-save / score-post may be failing on live now.
   Every new migration in this batch stacks on top of 0006.
2. Leftover scratch files in the tree (`*.full`, `*.mineonly`, `_split_stage.py`) —
   `rm` is deny-ruled for the agent; delete by hand.

## Architecture constraints (carried from prior batches)
- Data layer: in-memory `db` snapshot is UI source of truth; every mutation also
  fires a `push*` helper in `src/lib/supabase.ts` (fire-and-forget, env-gated).
- Parallel subagents get **file-disjoint ownership**. Shared files (`types.ts`,
  `supabase.ts`, new migrations, `index.css`) are owned by the **coordinator (main
  session)** — agents request schema/type/CSS additions; coordinator merges.
- Tests: Vitest node env. New **pure** logic (cart math, dual-membership rules,
  promo validity, sanction-vote tally, capability changes) gets unit tests.

---

## Wave 1 — Frontend-only, zero schema (ships immediately, no Nate action)

### W1. Global nav & chrome — `components/Layout.tsx`
- Back navigation everywhere (iOS-style "← back to <prev>"); a small nav-history
  hook (`src/lib/navHistory.ts`).
- Fix nav highlight: "Club Cart & Invoices" active state shouldn't keep "Roster &
  meet reg" highlighted (exact-match / non-overlapping route matching).
- "VIEW AS (ADMIN)" widget: darken username text color; reposition the results
  popover to open **upward/right** so it stays on-screen; keep highlight color.

### W2. Profile page chrome — `pages/Profile.tsx`
- Header upper-left "me" → "Profile".
- When arriving from membership with missing required fields, **highlight those
  fields in red** (pass `?missing=` / state through).
- After "edit profile first" from membership, return to membership purchase on save
  **only when the user came from membership** (else normal save). (Pairs w/ W6.)

### W3. Scoring helper text — `pages/Judge.tsx` (+ `src/scoring/*` display only)
- Start-value helper must **exclude** neutral deductions: "Base value 10.00 +
  Skills 0.60 + EG bonus 1.50" (no "− Neutral deductions").
- Neutral deductions must NOT reduce start value anywhere.
- Total-deductions label always reads "Total deductions (execution + neutral)".
- Score/final helper text shows "Execution = 10 − execution deductions …" and lives
  **near the final score**, not under start value.
- (T&T "needs work" is vague → tracked separately, see Deferred.)

### W4. Home page rebuild — `pages/Home.tsx`
Role-aware dashboards:
- General user: membership-CTA if none for current season; view-Profile link;
  meets-registered list w/ edit links; events-available-to-register list; club-info
  (view-only) links.
- Club manager: above + per-club cards (meets the club is in, edit reg); club
  details links (edit + admin highlight); "Needs attention": under-18 pending
  waivers in club, pending cart items.
- League admin: summary tiles (Active members, Clubs, Clubs w/ membership, Meets this
  season); "Needs attention" (all-clubs under-18 waivers, refund requests, pending
  carts) filterable; events list.

### W5. Communicate polish — `pages/Admin.tsx` (Communicate tab only)
- Message type = text → list shows **phone numbers** instead of emails.
- Send confirmation: show "sent to N recipients" + recipient list after send
  (in-app log; real delivery still stubbed).
- Club managers added in-session should appear in the filtered recipient list
  (read managers from live `db.clubs[].managerIds`, not a stale snapshot).

---

## Wave 2 — Cart, registration & meet UX (mostly frontend; some schema)

### W6. Membership purchase flow — `pages/Membership.tsx`
- Back button through the purchase steps.
- Highlight missing required fields in red (drives W2 via query/state).
- "Admin Payment Override": on any payment page an admin views, offer **Pay with
  card** *or* **Admin Payment Override** → completes the same invoice at **$0**
  (`paidVia: 'comp'`, `activatedByAdmin: true`). No Stripe needed.
- Push membership to **club cart** when club allows it (`Club.allowClubPay`): adds
  invoice items to `carts[clubId]`; **club managers get an in-app notification**
  ("X added items to your cart" + link). Email notification = stubbed.
- "Store card on file" checkbox → **UI only, disabled w/ 'coming soon'** (real
  storage is Stripe, research-only this push).

### W7. Cart & invoices view — `pages/Club.tsx` cart section + new `components/CartView.tsx`
- Cart line per athlete shows **registered level + events per discipline** on the
  next line(s), e.g. multi-line summary in the spec example.
- "View Cart" page: one **card per event or "Memberships"**, each with a "Return to
  registration / membership purchasing" button.
- Club-cart notifications surface here for managers.

### W8. Meet registration restructure — `pages/Meets.tsx` (+ `components/MeetRegister.tsx`)
- Add **All-Around in one click** (selects all events for the discipline).
- **Multi-discipline in a single cart**: one person can register WAG+MAG+T&T in one
  pass (remove the top-level single-discipline dropdown; each member shows a section
  per offered discipline).
- Three-card layout: (1) **already-registered** club members w/ per-athlete Edit
  (change level/apparatus/swap athlete **if meet open for updates**); changes appear
  in a **highlighted color** until paid; if a change fee is configured, closing the
  edit requires "Add change to cart". (2) members **with membership, not registered**.
  (3) members **without membership** + "invite to purchase membership" email button
  (stubbed email).
- **Individual self-registration** for a meet.
- Edit which club an individual competes for (per event).
- Refund request per athlete.

### W9. Meet creation/edit — `components/MeetWizard.tsx` + new edit entry on `pages/Meets.tsx`
- Edit meet details as host/admin (dates, reg status, sessions, levels, cost).
- **Timezone setting** for reg start/close (display "(EST)" etc.).
- Add-ons: **t-shirt** (price + sizes) and **club banner** (price; club enters
  banner text at reg). (Banquet already exists.)
- **Change fee** config (amount + start datetime) — feeds W8.

---

## Wave 3 — Schema-dependent features (build now; **Nate applies migration** to go live)

New migration `0007_feedback_2026_06_18.sql`. Owned by coordinator.

### W10. Coach/Athlete/Both identity + dual memberships
- `Athlete.kind` → keep, add `roles: { athlete: boolean; coach: boolean }`
  (migration backfills from `kind`). Profile gets athlete/coach/both selector;
  drives which membership types are offered.
- Coach profile: connect to a **main club + other clubs** (already have
  mainClubId/altClubIds — expose for coaches).
- **A person can hold both coach and athlete membership in the same season.**
  `Membership` gains `type: 'athlete' | 'coach'` (migration backfills `'athlete'`;
  id becomes `${personId}:${seasonId}:${type}`). Rules:
  - Athlete-then-coach add: coach membership for **$0**.
  - Coach-then-athlete add: charge the **difference** (athleteFee − coachFee).
  - League admins can **grant/revoke** either independently.
- Tests: dual-membership pricing + grant/revoke in `capabilities`/pricing core.

### W11. Club settings & directory — `pages/Club.tsx`, `pages/Admin.tsx`
- New club fields: `access: 'open' | 'affiliates' | 'any-student' | 'any-undergrad'
  | 'any-affiliated-student' | 'any-affiliated-undergrad'`; keep `allowClubPay`.
- **Public club directory** (any logged-in user) — list all clubs + view-only
  details. New `pages/Clubs.tsx` route.
- Club switcher dropdown (type-to-search) for multi-club managers **and** admins.
- Split **first/last name** columns in roster; sortable by any column (first, last,
  MAG level, WAG level, T&T level, student status).
- Invite link → goes **directly to account-creation page** (not home).

### W12. League controls — `pages/Admin.tsx`
- **User Roles** section: roles `Full League Admin` (only role that can emulate
  users) and `Sanctioning Team` (sees meets-to-vote-on). Migration: `user_roles`
  already exists as text role; add `'sanctioning'` handling + capability wiring.
- Seasons & fees: add **CLUB FEE** column (current $109) between Coach Fee and
  Purchasable; `Season.clubFee` (backfill 109).
- Regions: editable region→states mapping (drag states between regions); store
  overrides in DB (`region_states` or a `settings` row) instead of the hardcoded
  `STATE_REGIONS`.
- Delete-a-level: only removes it from **future** meets; keep on past meets (soft
  delete via `Level.retired` flag; filtering at meet-create only).
- Membership activation order: **Current (labeled) then newest→oldest**.

### W13. Members admin — `pages/Admin.tsx`
- **Create account for an athlete without one**: sends setup email (real email
  stubbed; generates an invite token row). Single-athlete now; bulk migration later.
- Revoke membership → **extra confirmation page** (already pulls from future regs).
- Per-athlete **waivers on file** list (year/type/signed-at) or "no waivers" notice.
- "Email waiver" → choose **which waiver (year + type)**; actually queue send
  (stubbed delivery, logged).

### W14. Promo codes — `pages/Admin.tsx` (Promo tab)
- `Coupon` gains `startsAt?`, `endsAt?`, `maxUses?` (null = unlimited), `usedCount`.
- Validity enforced at apply time. **"Generate random code"** button.

### W15. Synchro & T&T registration — `types.ts`, `pages/Meets.tsx`
- Add **Synchro Trampoline** event to TNT (`SY`). Registration: select **partner**
  (any athlete w/ membership) or "partner unknown"; meet **cannot go live** until all
  synchro entries have partners. `Registration.partnerAthleteId?`.
- **T&T per-event level** (level per event, default = main T&T level) + event
  checkboxes. DB shape allows per-event levels for all disciplines (future-proof
  MAG/WAG); only T&T exposes it now. `Registration.eventLevels?: Record<string,string>`.
- **T&T All-Around** added.

---

## Wave 4 — Event Management subsystem (BUILD, not live this push)

Net-new. Gets its **own sub-spec** before coding:
`docs/specs/2026-06-18-event-management.md`. Summary of what it covers:
- **Camp** (NAIGC-hosted; individual-only registration) — admin/sanctioning create
  flow with the full required+extra field set (dates w/ tz, location, add-ons,
  overnight-accommodations survey, confirmation email config).
- **Competition** — NAIGC-hosted setup + **sanctioned request form** (club-manager
  submits) with the full field set incl. levels offered/caps, awards (places,
  medals vs sticker-backs, **ribbon color picker** from the big A-1 list), insurance,
  fee-collection/payout method, banner, hotel block.
- **Sanction voting workflow**: on submit → email Sanctioning Team a vote link →
  page with event details + vote → **2/3 approve OR voting closes (1 wk)** with
  majority approve → host notified, meet created (editable by sanctioning + full
  admins), **Sanction ID** auto-set `YYYY_ST_###`. Reminder emails 3 days & 1 day
  before deadline to non-voters.
- Data: `SanctionRequest`, `SanctionVote`, `Event` (camp) types + migration.
- **Blocked for "live":** the reminder/notify emails need the transactional-email
  provider (research-only this push) and a scheduler (Supabase cron / Edge Function).
  We build the forms, in-app vote tally, and meet-creation; emails are stubbed and
  the timed reminders are documented as the remaining wiring.

---

## Research deliverables (no code)
- `docs/research/2026-06-18-sms-providers.md` — Twilio / Telnyx / AWS SNS /
  MessageBird etc.: per-segment cost, throughput for ~2000-message blasts, 10DLC/
  toll-free registration, **character limits (160 GSM-7 / 70 UCS-2; segmentation)**.
  Recommend enforcing the limit in the Communicate tool.
- `docs/research/2026-06-18-stripe-plan.md` — card-on-file (SetupIntents + saved
  PaymentMethods), payment flow via Supabase Edge Functions, $0 admin override
  coexistence, club-cart payment, fee handling.

## Informational (already answered, no work)
- T-shirt size is **not** in non-reg SF exports → cannot autofill; **default shirt
  to unfilled** so it must be set on profile edit (small change, folded into W2).

---

## Suggested execution order
1. Wave 1 (5 agents, file-disjoint) → verify → **push live** (no migration needed).
2. Wave 2 (4 agents) → verify → push (W6/W7/W8 frontend live; change-fee/addon data
   in 0007).
3. Wave 3 (schema): coordinator writes `0007`, agents build features → verify →
   push → **Nate applies 0007** → live-verify.
4. Research docs (parallel, any time).
5. Wave 4: write Event-Management sub-spec → approve → build → push (not live until
   email/scheduler wired).
