# Event Management Subsystem — Spec (2026-06-18)

Net-new subsystem (Wave 4 of the 2026-06-18 batch). **Built, not live this push**
— the voting reminders + approval/host emails need the transactional-email provider
(research-only this push) and a scheduler. We build the data model, the forms, the
in-app vote tally, and meet/event creation; emails are stubbed and timed reminders
are documented as the remaining wiring.

Scope source: the "Event Management" section of the 2026-06-18 feedback doc.

## Two event kinds
1. **Camp** — NAIGC-hosted only. **Individual registration only** (no club-manager
   registration). Admin/Sanctioning Team create it directly.
2. **Competition** — either:
   - **NAIGC-hosted** — admin/Sanctioning Team create directly (today's MeetWizard,
     extended), OR
   - **Sanctioned** — a **club manager submits a sanction request form**; the
     Sanctioning Team votes; on approval the platform creates the meet.

Camps are a new `Event` concept; competitions reuse/extend the existing `Meet`.

## Data model (migration `0008_event_management.sql`)
- `Meet.eventType?: 'competition' | 'camp'` (default 'competition'); camps may
  reuse Meet with `eventType: 'camp'` + camp-only fields, OR a separate `camps`
  table. **Decision: reuse `meets`** with `event_type` + a `camp_config jsonb`
  (overnight-survey toggle, director cc, leo add-on, etc.) to avoid a parallel
  registration stack. Camp registration uses the existing individual-reg path with
  `eventType==='camp'` gating out club-manager registration.
- New table `sanction_requests`:
  `id, host_club_id, requester_person_id, status (draft|submitted|voting|approved|
  rejected|withdrawn), payload jsonb (the full form), event_kind (competition|camp),
  submitted_at, deadline_at (submitted_at + 7d), decided_at, created_meet_id,
  sanction_id (YYYY_ST_###)`.
- New table `sanction_votes`:
  `id, request_id, voter_user_id, vote (approve|reject|abstain), comment, voted_at`,
  unique(request_id, voter_user_id).
- `Meet.sanctionId?: string` — `YYYY_ST_###` (year of event, 2-letter host state,
  3-digit sequence per state per year, starting 001).
- RLS: sanction_requests — host club managers see their own + Sanctioning Team/admin
  see all; sanction_votes — Sanctioning Team/admin write, request owner reads tallies.

## Sanction request form (club-manager) — fields
Required, per the feedback doc (store the whole thing in `payload jsonb`; validate
client-side):
- Host club (only clubs the account manages), alternate point-of-contact (name/email/
  phone if different), event name.
- Accessibility certification (must accept "accessible to all divisions" or the
  request cannot be approved — block submit with the info@naigc.org message).
- Dates (start/end), registration open/close (date/time/**timezone**), optional late
  registration start.
- Location: venue, street, city, state (dropdown), country (dropdown). *(Address
  autocomplete from street → city/state/country is a nice-to-have; stub now.)*
- Regional-bid question (competition only) → if yes, athletic-trainer/health-pro
  question.
- Insurance needed? (Y/N). Estimated + maximum participants.
- **Levels offered**: WAG (min 3 or none), MAG (min 2 or none), T&T (or none), each
  with optional per-level or per-discipline participant caps.
- Fee collection: does NAIGC collect & remit? If yes: per-participant fee, late fee,
  payout method (PayPal preferred: email+name / or check: payee + USPS address).
- Awards: NAIGC-provided? mailing address, # places (1–3), medals vs sticker-backs,
  **neck-ribbon color/style ranked top-3** from the A-1 list (store the full option
  list in a constant `RIBBON_OPTIONS` — ~150 entries from the feedback doc).
- Banner (Y/N), hotel block (Y/N), overnight accommodations description, add-ons
  (t-shirt: price+sizes; leo: price+sizes), years previously held, anticipated
  schedule attachment (pdf/jpg/png), confirmation-email config (rich text + HTML
  preview, from-address/alias), public-registration-policy acceptance, additional
  comments, final certification + typed name.

The **NAIGC-hosted create form** is the same field set minus the host-club/point-of-
contact/policy-gates (admin is authoritative), plus camp-specific extras (overnight
survey toggle, director name/email + cc-on-confirmation, age-calculation datetime).

## Camp overnight-accommodations survey
If enabled on a camp, **at checkout each athlete answers**: bedtime (Before 10pm /
10pm–Midnight / After Midnight), preferred noise level (3 options), cabin gender
preference (All Male / All Female / Don't Care), roommate requests (free text).
Store on the camp registration (`registrations.camp_survey jsonb`).

## Voting workflow
1. Club manager submits → status `submitted` → `voting`; `deadline_at = now + 7d`.
2. **Email the Sanctioning Team** a vote link (stubbed: create an in-app
   notification + `// TODO email`). Each member opens a **vote page** showing full
   event details (read-only) + Approve / Reject / Abstain + optional comment.
3. **Reminder emails** to non-voters **3 days** and **1 day** before deadline
   (stubbed; needs a scheduler — Supabase cron / Edge Function. Document only.).
4. **Resolution:** as soon as **≥⅔ of the Sanctioning Team approve**, OR at deadline
   if **a majority of votes cast approve** → status `approved`; else `rejected`.
   - Tally is pure logic → `src/lib/sanction.ts` (`tallyVotes(votes, teamSize, now,
     deadline)` → {decided, outcome, approvals, rejections}). Unit-tested.
5. On approval:
   - Auto-assign **Sanction ID** `YYYY_ST_###` (next sequence for that state+year).
   - **Create the Meet** (`eventType`, fields from payload), editable by Sanctioning
     Team + Full League Admins; viewable (not editable) by the host with a
     registration link + a read-only registration-details link.
   - **Email the host** approval + links (stubbed).
6. On rejection / deadline-without-majority → notify host (stubbed).

## Admin/Sanctioning UI
- A **Sanctioning** nav section (visible to `sanctioning` role + admins, wired in
  Wave 3's User Roles): a queue of requests to vote on, each → the vote page; plus a
  list of approved/created events.
- Club managers see their submitted requests + status on their club page.

## Build phases
- **Phase 1 (this push — foundation):** migration 0008; types (`SanctionRequest`,
  `SanctionVote`, `Meet.eventType/sanctionId/campConfig`, `RIBBON_OPTIONS`); the
  sanction request form (club-manager) writing a `submitted` request; the vote page
  + `tallyVotes` pure logic + sanction-ID generator (both unit-tested); the
  Sanctioning queue; meet creation on approval. Emails + reminders stubbed.
- **Phase 2 (later):** transactional email (vote invites, reminders via scheduler,
  approval/host notifications), camp overnight survey at checkout, NAIGC-hosted
  camp create form polish, address autocomplete, schedule-file upload storage,
  confirmation-email rich-text/HTML preview, Stripe-backed fee collection + payouts.

## Constraints
- Reuse existing patterns (mutate + push helpers; design-system CSS; capabilities).
- Pure logic (tally, sanction-ID) is node-testable in `tests/`.
- Nothing here goes live until 0008 is applied AND email/scheduler wiring lands.
