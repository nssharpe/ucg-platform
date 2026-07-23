# Season card rework, UCG-hosted events (FlipFest / Nationals), view-as removal, timezone auto-set

Date: 2026-07-20. Decided with Nate (+ Julia) in review session. Supersedes the
"Launched" season lifecycle where noted. Branch: `feat/season-ucg-events`.

## Decisions (Nate/Julia, 2026-07-20)

1. **Seasons & Fees card (League Controls) rework**
   - Remove the **Current** column: "current" is DERIVED from today's date
     (the season whose `[startsOn, endsOn]` window contains today). No admin action.
   - Purchasability: past seasons NEVER purchasable; the current season ALWAYS
     purchasable; only FUTURE seasons have an admin toggle (existing `active` flag).
   - Remove the **Launched** column and the whole launch step (see mapping below).
   - Add **FlipFest** and **Nationals** columns: per season, a "Create" button if
     that season's instance doesn't exist yet, else "Edit". Button navigates to a
     dedicated page for that event.
2. **All events are created either via the Request-a-Sanction flow or as a
   FlipFest/Nationals instance.** Remove the admin "+ Sanction New Event" button
   on the Events page (the EventWizard stays, for editing and for the dedicated
   UCG-event pages).
3. **View-as (admin impersonation) is REMOVED entirely** — it was half-working
   (some privileged UI didn't hide) and Nate/Julia prefer logging into test
   accounts. Remove feature + all plumbing.
4. **Timezones**
   - Sanctioned events: no timezone selector. Timezone is AUTO-DERIVED from the
     event's location (US state → dominant IANA zone). UI shows reminder text:
     "Dates & times are in the time zone of the event location."
   - FlipFest & Nationals: timezone is ALWAYS `America/Los_Angeles` (West Coast),
     regardless of venue location (explicit Nate decision — yes, FlipFest is in TN).

## "Launched" → date-derived lifecycle mapping

What `launchedAt` did (audited 2026-07-20) and its replacement:

| Old behavior | New behavior |
|---|---|
| Future season purchasable only if `active` AND launched (`purchasableSeasons`) | Purchasable = current-by-date OR (future AND `active`). Past → never. |
| `eventCreationBlocked`: start date must fall in a current-or-launched season | Start date must fall in ANY existing season window (FlipFest/Nationals are created right after the season row is created). |
| June 1/16/24+ "launch the season" nag emails (`season-launch-nag`) | Same tiers, new condition: nag when NO season row exists covering the upcoming July 1 (create it via "Copy → next year" + review fees). Kind stays `season-launch-nag`. |
| July-1 automatic rollover of `current` (`season-rollover` in scheduled-dispatch) | DELETED — current is derived; no flag to flip. |
| Server-side membership gating reads `launched_at` (`_shared/stripe.ts`) | Server mirrors the new date-derived rule. |

DB: `seasons.current` and `seasons.launched_at` columns stay (no destructive
migration) but the app stops reading/writing them. Grep SQL functions/policies
for `seasons.current` / `launched_at` references; if any exist they must move to
date-derived logic in the same phase.

`currentSeasonId(db)` becomes derived: season window containing today; fallback =
most recent season with `startsOn <= today`; else null. `seasonForDate` keeps its
window-first logic with the new fallback.

## FlipFest / Nationals model

- New `Event.ucgHosted?: 'flipfest' | 'nationals'` (+ nullable text column
  `events.ucg_hosted`, new migration; map in `rowToEvent`/`pushEvent`).
- A season's instance = event with matching `ucgHosted` whose `startDate` falls in
  the season window. One per season (enforce softly: Create button only when absent).
- **Dedicated pages** (standalone admin routes, `RequireAdmin`):
  - `/admin/ucg-event/flipfest/:seasonId` and `/admin/ucg-event/nationals/:seasonId`.
  - Create mode (no instance): page renders the EventWizard prefilled from the
    template (new `template?: Partial<Event>` wizard prop: prefills like
    `editEvent` but SAVES AS CREATE; mutually exclusive with `editEvent`).
    On save → navigate to the created event's public page (wizard default).
  - Edit mode (instance exists): page shows a compact summary card (name, dates,
    reg window, links: public event page; for nationals also its dashboard/admin
    surface on the event detail page) + "Edit details" opening EventWizard with
    `editEvent`. Back-links to `/admin/league`.
- **FlipFest template** (kind `standard`, `eventType:'camp'`): name "FlipFest
  {YYYY}", venue "FlipFest", state TN, `timezone:'America/Los_Angeles'`,
  `ucgHosted:'flipfest'`, `campConfig:{ overnightSurvey:true, leoAddon }`,
  `tshirtAddon` (standard sizes), dates defaulted into the season's August,
  host club = the `is_league_host` club when exactly one exists (else unset, admin
  picks). Fees/dates are prefills — admin reviews everything before save.
- **Nationals template**: name "UCG Nationals {YYYY}", `kind:'nationals'`,
  `ucgHosted:'nationals'`, `timezone:'America/Los_Angeles'`, all disciplines,
  default prelim sessions from the wizard's per-discipline templates, dates in the
  season's spring (April), host club as above. Heavy config (cutoffs, finals
  levels, add-ons) continues post-create on the existing nationals surfaces.
- EventWizard: when `template?.ucgHosted` or `editEvent?.ucgHosted` is set, hide
  the timezone-dependent selector (already removed globally — see §Timezone) and
  pin `America/Los_Angeles`; also hide the "Nationals" checkbox (kind comes from
  the template).

## Timezone derivation

- New pure module `src/lib/timezone.ts`: `timezoneForState(state: string,
  country?: string): string` — full US state/territory → dominant IANA zone map
  (split states get their dominant zone: TX→Chicago, TN→Chicago is WRONG — TN is
  split East/Central, dominant Central BUT Nashville/Memphis Central vs Knoxville
  Eastern; choose the zone covering the state capital: TN→America/Chicago,
  KY→America/New_York, IN→America/New_York, ND/SD/NE/KS→America/Chicago,
  TX→America/Chicago, FL→America/New_York, MI→America/New_York,
  ID→America/Boise? use America/Boise for ID, OR→America/Los_Angeles,
  AZ→America/Phoenix, AK→America/Anchorage, HI→Pacific/Honolulu). Non-US or
  unknown → `America/New_York` fallback. Vitest table test required.
- Sanction request form (`Sanction.tsx`): remove the timezone `<select>`; show
  the reminder line; on approval, `timezone = timezoneForState(state, country)`.
- EventWizard: remove the Timezone field; keep interpolating the tz abbreviation
  into datetime labels. tz value = `editEvent`'s stored tz; for sanctioned events
  recompute when `state` changes; UCG-hosted → pinned LA. Reminder text replaces
  the old field's hint.
- Existing events keep their stored `timezone` (no data migration).

## View-as removal (complete)

Remove: `viewPersonId` sessionStorage plumbing in `store.ts`
(`useViewPersonId`/`setViewPersonId`/`getViewPersonId`, `ucg-view-person` key),
the `Persona`/`DEFAULT_PERSONA`/`getPersona`/`usePersona` bits ONLY if their sole
consumers are view-as (trace first; demo/unconfigured mode must keep working),
the `viewPersonId` param + `impersonating` + `actingAsAdmin` distinction in
`capabilities-core.ts` (collapse `actingAsAdmin` → `isAdmin`; keep the exported
name removed and update ALL consumers), the Layout "View as (admin)" combo +
"Viewing as" banner + topbar prefix, and related tests. `deriveCapabilities`
signature shrinks; update `capabilities.ts` callers + tests.

## Execution phases (sequential implementers, one branch)

1. **P1 view-as removal** (sonnet). Self-contained; no server code.
2. **P2 timezone** (sonnet): `timezone.ts` + tests, Sanction.tsx, EventWizard.
3. **P3 season lifecycle** (sonnet DRAFTS, controller fable-reviews — touches
   membership money gating): rewrite `season-lifecycle.ts` + `_shared` mirror
   (LOCKSTEP), scheduled-dispatch (drop rollover, retarget nag),
   `capabilities-core.ts` derived current, `Membership.tsx`, `_shared/stripe.ts`
   / `create-checkout-session` server gating, Seasons.tsx column removal +
   purchasability cell rules, Home.tsx `find(s=>s.current)` call sites, tests.
4. **P4 UCG-hosted events** (sonnet): migration `ucg_hosted`, types/plumbing,
   wizard `template` prop + LA pinning, templates module
   (`src/lib/ucg-event-templates.ts`, pure + vitest), dedicated pages + routes,
   Seasons.tsx FlipFest/Nationals columns, remove Events.tsx create button.

Each phase: `npm run build` + `npx eslint <touched>` + `npx vitest run` before
commit. Controller applies the migration (staging then prod) and deploys
`scheduled-dispatch` (+ any other touched fns) at the end; verify the
no-verify-jwt trio after any function deploy. Responsive sweep for Seasons.tsx
(table gets 2 new columns) at 375/768/1280.

## 2026-07-22 PM feedback pass (applied on `feat/ucg-event-creation-feedback`)

Nate walked both creation flows + a camp event page; the resulting changes:

- **FlipFest (camps generally):** wizard hides URL-slug hint + host-club input
  (UCG-hosted; submit falls back to `singleLeagueHostClubId`, errors if no
  league-host club is flagged), location block (FlipFest only — the real
  address `272 Lake Frances Rd, Crossville, TN` is baked into
  `flipfestTemplate`), hotel link, age-calc date, 2nd-discipline fee, banquet/
  banner/change-fee, edit-lockout (camps auto-set `lastDateToEdit = regCloses`
  on save), the whole Disciplines & sessions section (template seeds all three
  disciplines — camp registration reads them downstream), the capacity hint
  text + per-discipline/per-level caps, and Scoring. `entryFee` defaults 200.
- **Event page:** subtitle drops timezone + `#/events/slug` breadcrumb;
  host shows literal "UCG" when `event.ucgHosted`; "Field" card renamed
  "Participants"; Quick links gated for camps (no results/score-entry/manage/
  scores-CSV) and the card disappears when no links apply.
- **Nationals:** renders as a FULL PAGE, not a modal (`EventWizard`'s new
  `variant='page'` prop; `UcgEvent.tsx` uses it for nationals create AND
  edit). Create-mode defaults: late fee, banquet, t-shirt, banner, change fee,
  edit lockout, finals deadline, custom confirmation email all pre-checked;
  judge panels default 2; finals levels default `mag-int/mag-adv/wag-plat/
  wag-diamond/wag-l9`.
- **Nationals sessions × gyms (create only):** the per-discipline session
  cards are replaced by two lists — session time slots (default 4) and gyms
  (name + discipline + levels; defaults Orange=MAG-sans-Masters, Red=WAG
  Diamond, Green=WAG Platinum, Yellow=WAG Silver/9/Open, Purple=all T&T;
  Masters excluded everywhere by default). Pure builder
  `buildNationalsSessions` (`ucg-event-templates.ts`, unit-tested) cross-
  products slots×gyms into ordinary `EventSession[]` (`phase:'prelim'`,
  names like "Session 2 — Orange (MAG)"). EDIT of an existing nationals
  event keeps the classic per-session cards (slots×gyms reconstruction is
  lossy); heavy session management stays on the event page manage tools.

## 2026-07-22 PM feedback pass 2 (applied on `feat/ucg-event-feedback-2`)

Second round after Nate tested the new flows:

- **Camps session-less/level-less:** camp events save `sessions: []`,
  `secondDisciplineFee: 0` (flat fee), `lastDateToEdit = regCloses`;
  `disciplines` kept purely as "equipment available" (simple checkbox row in
  the wizard). `RegistrationEditor` camp mode = discipline checkboxes only
  (no level/apparatus/session); camp regs save `levelId: ''`,
  `apparatus: []`, `sessionId: null`. Known follow-up: `RosterToolsCard`
  still requires level/apparatus (spawned as its own task).
- **Camp survey configurable + reviewable:** wizard "Registrant survey"
  section (camps) — master toggle (`campConfig.overnightSurvey`) + the four
  FIXED questions each with a Mandatory checkbox
  (`campConfig.surveyMandatory`; absent = legacy 3-of-4 rule).
  FlipFest template pre-checks everything. New host/admin "Survey responses"
  card on the event page (totals + individual answers via the scoped
  `registration_camp_surveys` RPC).
- **Nationals wizard:** age-calc checkbox hidden for UCG-hosted (Masters-rules
  meets only); Event director section hidden for UCG-hosted — templates bake
  `{name:'UCG', email:'info@unitedgymnastics.org', ccOnConfirmation:false}`
  (director's ONLY consumer is the receipt-cc branch in `_shared/fulfill.ts`);
  confirmation reply-to defaults to info@unitedgymnastics.org on UCG create.
- **No host club for UCG events:** the "Flag a club as league host" error is
  gone — UCG-hosted events save `host_club_id NULL` (eventToRow coerces
  `''`→null). `eventIsRefundEligible` + `request-refund` treat `ucgHosted`
  as eligible; host-$0 pricing comparisons hard-guarded against
  `'' === ''` (unaffiliated camp self-reg would have gotten free entry);
  `ucg_hosted` made admin-only writable (guard trigger `20260722220449`)
  since it now grants refund eligibility + UCG branding.
- **Two-tier Nationals publish:** `events.listing_only`
  (`20260722221027`) + wizard footer buttons "Publish Dates and Location
  Only" (validates name/dates/location only; Events list row WITHOUT the
  Details link; registration suppressed) and "Publish Full Details" (full
  validation, clears the flag); labels flip to "Edit …" per mode once
  published. Status Draft/Live radios hidden on this wizard. The slots×gyms
  UI also shows when EDITING a UCG-nationals event with no sessions yet
  (dates-only → full path); an event with sessions keeps the classic cards.
  Compat: `listing_only` is omitted from event writes unless the flag is in
  play, so ordinary saves work against a pre-migration DB (prod, until
  Nate's push).

## 2026-07-23 PM feedback pass 3 (applied on `feat/ucg-event-feedback-2`)

- **Camp registration is discipline-less:** RegistrationEditor camp mode is a
  single confirmation (no checkboxes); a new camp reg saves exactly ONE row
  (`discipline: event.disciplines[0]` — enum NOT NULL demands a value, never
  shown), legacy multi-row camp regs edit without churn. Cart labels drop the
  "(MAG)" suffix for camps. Roster tools + Competition setup removed from the
  camp host dashboard; registration-workbook export stays.
- **URGENT prod fix (shipped early, merge 2ba474e):** every client
  `registrations` upsert had failed `42501` since 2026-07-17 — the
  camp_survey column-SELECT revoke breaks `ON CONFLICT DO UPDATE SET
  camp_survey = EXCLUDED.camp_survey` (EXCLUDED reads need SELECT). Fixed by
  dropping camp_survey from the upsert mapping + targeted-UPDATE
  `pushCampSurvey`; also fixed the masked `level_id: ''` FK violation for
  camp regs. Live-verified against prod (201/204, row + survey persisted).
- **Camp survey question builder:** `campConfig.survey.questions`
  (text / single / multi + options + required), wizard editor seeded with the
  classic 4; legacy events derive them via `campSurveyQuestionsOf`. Answers
  keyed by question id; dynamic rendering in reg flows, responses card,
  receipt email (`_shared/camp-confirmation.ts`), host export. stripe-webhook
  / create-checkout-session / reconcile-payments redeployed (prod+staging,
  trio verify_jwt re-checked).
- **UCG event page cleanup:** Owner checklist/assignment, Event Admins, and
  the host-dashboard Event status card hidden for `ucgHosted` events; the
  admin "Nationals summary — view as" card replaced by a real Event summary
  (regs per discipline, athletes, clubs, waitlist, add-on counts via
  `event_host_addons`); check-in card kept with an explainer + "Preview as"
  label; "Edit event" on a UCG event now routes admins to
  `/admin/ucg-event/:template/:seasonId` (via `seasonForDate`) with the
  editor auto-opened.
