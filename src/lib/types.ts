export type Discipline = 'MAG' | 'WAG' | 'TNT';

export const DISCIPLINES: Discipline[] = ['MAG', 'WAG', 'TNT'];

export const APPARATUS: Record<Discipline, { code: string; name: string }[]> = {
  MAG: [
    { code: 'FX', name: 'Floor' },
    { code: 'PH', name: 'Pommel Horse' },
    { code: 'SR', name: 'Still Rings' },
    { code: 'VT', name: 'Vault' },
    { code: 'PB', name: 'Parallel Bars' },
    { code: 'HB', name: 'High Bar' },
  ],
  WAG: [
    { code: 'VT', name: 'Vault' },
    { code: 'UB', name: 'Uneven Bars' },
    { code: 'BB', name: 'Balance Beam' },
    { code: 'FX', name: 'Floor' },
  ],
  TNT: [
    { code: 'TR', name: 'Trampoline' },
    { code: 'DM', name: 'Double Mini' },
    { code: 'TU', name: 'Tumbling' },
    { code: 'SY', name: 'Synchro Trampoline' },
  ],
};

export type Region =
  | 'Northeast'
  | 'Mid-Atlantic'
  | 'Southeast'
  | 'Mideast'
  | 'Midwest'
  | 'South Central'
  | 'West'
  | 'Other';

export interface Season {
  id: string;
  name: string; // "2025–26"
  startsOn: string; // ISO date (Jul 1)
  endsOn: string; // ISO date (Jun 30)
  athleteFee: number;
  coachFee: number;
  clubFee: number; // club membership fee for the season (e.g. 109)
  /** Admin toggle for a FUTURE season only — "purchasable early". A
   *  current-by-date season is always purchasable regardless of this flag; a
   *  past season is never purchasable regardless of this flag (P3 2026-07-20
   *  — see season-lifecycle.ts `purchasableSeasons`). */
  active: boolean;
}

export interface Level {
  id: string;
  discipline: Discipline;
  name: string;
  svMax: number | null; // null = open / FIG
  vaults: number;
  order: number;
  /** Soft-deleted: hidden from new events but preserved on past events/results. */
  retired?: boolean;
}

/** Who may register with / compete for a club. */
export type ClubAccess =
  | 'open' // anyone
  | 'affiliates' // affiliates only
  | 'any-student' // any student
  | 'any-undergrad' // any undergraduate
  | 'any-affiliated-student' // any affiliated student
  | 'any-affiliated-undergrad'; // any affiliated undergraduate

export const CLUB_ACCESS_LABELS: Record<ClubAccess, string> = {
  open: 'Open to anyone',
  affiliates: 'Affiliates only',
  'any-student': 'Any student',
  'any-undergrad': 'Any undergraduate',
  'any-affiliated-student': 'Any affiliated student',
  'any-affiliated-undergrad': 'Any affiliated undergraduate',
};

export interface Club {
  id: string;
  name: string;
  shortName: string;
  state: string;
  region: Region;
  managerIds: string[];
  email: string;
  allowClubPay: boolean; // athletes may push membership fee to club cart
  access: ClubAccess; // eligibility for registering with this club
  /** True for exactly the league's own club ("UCG - Main"). Refunds
   *  (event-mgmt v2 Phase 3, spec §H) are only offered for events whose HOST
   *  club has this flag set — see `eventIsRefundEligible` (events-core.ts).
   *  Admin-editable in the clubs editor; defaults false. */
  isLeagueHost?: boolean;
}

export type Gender = 'Male' | 'Female' | 'Non-binary' | 'Genderfluid' | 'Agender' | 'Other';
export type Placement = 'men+' | 'women+';

export type MembershipStatus = 'active' | 'pending-club-payment' | 'pending-waiver' | 'none';

export type MembershipType = 'athlete' | 'coach';

export interface Membership {
  seasonId: string;
  /** A person may hold one athlete AND one coach membership per season. */
  type: MembershipType;
  status: MembershipStatus;
  waiverSignedAt: string | null;
  waiverSignedBy: string | null; // self or guardian name
  paidVia: 'card' | 'club' | 'comp' | null;
  activatedByAdmin?: boolean;
  /** True while this member's fee sits UNPAID in a club's cart (member pushed it
   *  via the club-cart path). Independent of the waiver hold, so a minor whose
   *  guardian waiver is still open can simultaneously be awaiting club payment.
   *  Cleared (false) when the club pays the cart line item. */
  clubCartPending?: boolean;
}

export interface Athlete {
  id: string;
  /** The linked Supabase auth user, if this person has claimed an account. */
  authUserId?: string | null;
  /** Legacy single role; retained for back-compat. Prefer `roles`. */
  kind: 'athlete' | 'coach';
  /** A single person can be an athlete, a coach, or both. Drives which
   *  membership types are offered. Backfilled from `kind` (see 0007). */
  roles: { athlete: boolean; coach: boolean };
  firstName: string;
  lastName: string;
  email: string;
  dob: string;
  gender: Gender;
  placement?: Partial<Record<Discipline, Placement>>;
  gradYear: number; // 1900 = n/a
  studentStatus: 'Student' | 'Non-Student' | ''; // '' = unset (must be chosen for athletes)
  shirt: string;
  country: string;
  state: string;
  /** True ⇒ trains/coaches outside the US; `state` is optional and region = "Outside US". */
  outsideUs?: boolean;
  phone: string;
  /** CTIA SMS opt-in. False/undefined = not consented (cannot be texted). */
  smsConsent?: boolean;
  /** When sms_consent was last set true (ISO). */
  smsConsentAt?: string | null;
  mainClubId: string | null;
  altClubIds: string[];
  levels: Partial<Record<Discipline, string>>; // levelId per discipline
  emergency: { contact: string; relation: string; phone: string };
  dietary: string[];
  dietaryNotes: string;
  memberships: Membership[];
  achievements: string[];
}

/** Admin-set PUBLICATION state — 'draft' (hidden, not registrable) or 'live'
 *  (published). The finer-grained real-time phase (registration open/closed,
 *  in-progress, complete) is DERIVED from timestamps, not stored — see
 *  `deriveEventPhase` in `events-core.ts` (B4: was previously a 5-value
 *  manually-flipped enum; simplified so an admin only ever toggles Draft/Live
 *  and the phase always reflects the actual dates). */
export type EventStatus = 'draft' | 'live';

/** Real-time phase of a LIVE event, derived from `regOpens`/`regCloses`/
 *  `startDate`/`endDate` — never stored. See `deriveEventPhase`. */
export type EventPhase = 'reg-open' | 'reg-closed' | 'in-progress' | 'complete';

export interface Squad {
  id: string;
  name: string; // "Squad A", "Holding"
  startEvent: number; // rotation start index
  athleteRegIds: string[];
  holding?: boolean;
}

export interface EventSession {
  id: string;
  name: string; // "Session 1 — WAG Xcel Silver/Platinum"
  discipline: Discipline;
  date: string;
  time: string;
  levelIds: string[];
  squads: Squad[];
  /** Nationals events only: distinguishes prelim sessions from finals sessions.
   *  Absent ⇒ a normal (single-phase) session. See NationalsConfig. */
  phase?: 'prelim' | 'final';
  /** By-session-mode routine cap per apparatus code, e.g. `{ VT: 12 }`
   *  (event-mgmt v2 P4). Absent/undefined ⇒ uncapped. Enforced server-side at
   *  checkout via `src/lib/capacity.ts` (mirrored in
   *  `supabase/functions/_shared/capacity.ts`); editable in EventWizard. */
  maxRoutines?: Record<string, number>;
}

/** Placement category, mirroring the reference tool. "Mixed" is team-only. */
export type PlacementCategory =
  | 'Collegiate Women+'
  | 'Collegiate Men+'
  | 'Community Women+'
  | 'Community Men+';

/**
 * Admin-editable Nationals qualification/awards config on an event — the in-app
 * equivalent of the reference tool's per-year config.ini. Cutoffs ("blue
 * numbers") are keyed by platform levelId. See docs/specs/2026-06-13-nationals-
 * qual-awards.md and src/nationals/.
 */
export interface NationalsConfig {
  /** Platform level ids that hold finals (awards from finals); all other
   *  competing levels award straight from prelims. */
  finalsLevelIds: string[];
  /** cutoffs[scope][category][levelId] = N. scope: 'event' | 'aa' | 'team'. */
  cutoffs: {
    event: Partial<Record<PlacementCategory, Record<string, number>>>;
    aa: Partial<Record<PlacementCategory, Record<string, number>>>;
    team: Partial<Record<PlacementCategory, Record<string, number>>>;
    /** Mixed-team cutoffs keyed by levelId. */
    teamMixed: Record<string, number>;
  };
  /** TNT cutoffs keyed by levelId (one number per level — no category/AA/team,
   *  mirroring the reference tool's [Levels] section). */
  tntCutoffs?: Record<string, number>;
  /** Per-levelId start-value caps (validation). */
  svCaps?: Record<string, number>;
}

/** Per-event scoring config (PM decision 2026-07-19). `panels: 2` means each
 *  judge enters their own execution evaluation (deductions or E-score) and
 *  the two are averaged into the final via `combinePanels`
 *  (src/scoring/panels.ts) — the per-score judge override toggle (manual vs
 *  calculator entry) stays available either way. */
export interface ScoringConfig {
  panels: 1 | 2;
  entryMode: 'calculator' | 'simple';
}

/** One question in a camp's registrant survey (PM requirement 2026-07-23,
 *  replacing the old fixed 4-question survey). `options` applies only to
 *  `single`/`multi`; `id` is a stable per-event key (the wizard assigns
 *  `q-<n>`) used both as the question's React key and as the key under which
 *  the athlete's answer is stored in `Registration.campSurvey`. */
export interface CampSurveyQuestion {
  id: string;
  label: string;
  type: 'text' | 'single' | 'multi';
  options?: string[];
  required: boolean;
}

export interface Event {
  id: string;
  slug: string;
  name: string;
  hostClubId: string;
  city: string;
  state: string;
  timezone: string;
  startDate: string;
  endDate: string;
  status: EventStatus;
  regOpens: string;
  regCloses: string;
  /** Optional last date/time a registration may still be edited. Past this,
   *  only an admin or the event's HOST club's managers may still edit
   *  (enforced server-side by the `registrations_edit_lockout` trigger, not
   *  just client-side). Absent ⇒ no lockout. */
  lastDateToEdit?: string | null;
  /** Optional finals-lineup submission deadline instant (nationals only, spec
   *  §L.3 "9pm Friday deadline"). `scheduled-dispatch` nags club managers with
   *  missing finals lineups at/after this instant and hard-locks
   *  `finalsRosterLocked` at deadline + 1h. Absent ⇒ scheduler does nothing. */
  finalsLineupDeadlineAt?: string | null;
  entryFee: number; // per discipline
  secondDisciplineFee: number;
  disciplines: Discipline[];
  sessions: EventSession[];
  privateRegCode?: string;
  /** `lastPurchaseAt` (event-mgmt v2 Phase 2): optional ISO datetime after which
   *  this add-on can no longer be purchased; may be after `regCloses`. Absent ⇒
   *  purchasable any time registration is open. */
  banquet?: { price: number; name: string; lastPurchaseAt?: string };
  /** Optional add-ons offered at registration. */
  tshirtAddon?: { price: number; sizes: string[]; lastPurchaseAt?: string };
  bannerAddon?: { price: number; lastPurchaseAt?: string }; // club enters banner text at registration
  /** Fee to modify an existing registration; effective from `startsAt`. */
  changeFee?: { amount: number; startsAt: string };
  /** 'nationals' unlocks the prelim/finals + qualification/awards features and is
   *  creatable only by a UCG admin. Absent ⇒ 'standard'. */
  kind?: 'standard' | 'nationals';
  /** Set when this event IS a UCG-hosted instance (FlipFest camp or Nationals
   *  championship) created from the Seasons & fees "Create" flow
   *  (`src/lib/ucg-event-templates.ts`) rather than a sanctioned club event.
   *  Absent ⇒ a regular sanctioned event. Pins the timezone to
   *  America/Los_Angeles and hides the Nationals-kind checkbox in
   *  `EventWizard` regardless of which value it holds. */
  ucgHosted?: 'flipfest' | 'nationals';
  /** UCG Nationals two-tier publish model (PM feedback 2026-07-23): set when
   *  the event was published via "Publish Dates and Location Only" rather
   *  than the full wizard flow. Lists on the Events page but hides the
   *  "Details" button. Absent/false ⇒ a normal, fully-published event. */
  listingOnly?: boolean;
  /** Present on Nationals events: the qualification/awards configuration. */
  nationalsConfig?: NationalsConfig;
  /** Competition (default) or a camp (NAIGC-hosted, individual-only reg). */
  eventType?: 'competition' | 'camp';
  /** Auto-assigned on sanction approval: `YYYY_ST_###`. */
  sanctionId?: string;
  /** Camp-only configuration (overnight survey, leo add-on, etc.). Director
   *  info and age-calc date moved to the general event-level fields below
   *  (event-mgmt v2 Phase 0 §A) since they apply to competitions too. */
  campConfig?: {
    /** @deprecated pre-2026-07-23 fixed-question survey on/off flag. Superseded
     *  by `survey.enabled`. Kept only so `campSurveyQuestionsOf` (pricing.ts)
     *  can derive the legacy 4-question survey for events saved before this
     *  field existed; new saves write `survey` instead and mirror this flag
     *  true/false for any straggler reader. */
    overnightSurvey?: boolean;
    leoAddon?: { price: number; sizes: string[]; lastPurchaseAt?: string };
    /** @deprecated pre-2026-07-23 per-question "Mandatory?" toggles for the
     *  fixed 4-question survey. Superseded by each question's own `required`
     *  flag in `survey.questions`. Absent ⇒ legacy default (bedtime/
     *  noiseLevel/cabinGenderPref mandatory, roommateRequest optional) — see
     *  `campSurveyQuestionsOf` (pricing.ts), the single source of truth for
     *  deriving legacy events' effective questions. */
    surveyMandatory?: { bedtime?: boolean; noiseLevel?: boolean; cabinGenderPref?: boolean; roommateRequest?: boolean };
    /** Editable per-event registrant survey (PM requirement 2026-07-23):
     *  replaces the old fixed 4-question survey with an admin-authored
     *  question list (text / single-select / multi-select, each with its own
     *  `required` flag). Absent ⇒ derive from the legacy `overnightSurvey`/
     *  `surveyMandatory` fields via `campSurveyQuestionsOf` (pricing.ts) so
     *  pre-existing camps keep their historical 4 questions, editable. */
    survey?: { enabled: boolean; questions: CampSurveyQuestion[] };
  };
  /** Venue name (distinct from city/state — e.g. "University Arena"). */
  venue?: string;
  streetAddress?: string;
  /** Defaults to "United States" when set via the wizard/sanction form. */
  country?: string;
  /** Hotel room-block booking URL. */
  hotelLink?: string;
  /** When ages are calculated as-of, for age-based level eligibility. Applies
   *  to all events (not just camps). */
  ageCalcAt?: string; // ISO datetime
  /** Late-registration window: fee is in dollars, added ON TOP of the entry
   *  fee, effective from `startsAt`. */
  lateReg?: { startsAt: string; fee: number };
  /** Event director contact, general to competitions and camps. */
  director?: { name: string; email: string; ccOnConfirmation: boolean };
  /** Participant caps (event-mgmt v2 P4). `total` counts ATHLETES (competitions
   *  AND camps) — one athlete counts once regardless of how many
   *  disciplines/apparatus they enter. `perDiscipline` (T&T) and `perLevel`
   *  (WAG/MAG) count ROUTINES, i.e. apparatus entries — one athlete entering 4
   *  apparatus at a level counts as 4 against that level's cap. Enforced
   *  server-side at checkout (`src/lib/capacity.ts`). */
  capacity?: {
    total?: number;
    perDiscipline?: Partial<Record<Discipline, number>>;
    perLevel?: Record<string, number>;
  };
  /** Registration mode (event-mgmt v2 P4). 'by-discipline' (default — today's
   *  behavior) vs 'by-session' (sessions are pre-created with per-apparatus
   *  routine caps and athletes register into a specific session). Absent ⇒
   *  'by-discipline'. */
  registrationMode?: 'by-discipline' | 'by-session';
  /** Registration-confirmation email override. */
  confirmationEmail?: { bodyHtml: string; fromAlias?: string; replyTo?: string };
  /** When the event row was created — needed for owner-checklist due dates
   *  (event-mgmt v2 §B4). Server-set (`default now()`); never written by the
   *  client. */
  createdAt?: string;
  /** Sanctioning-team member assigned to shepherd this event (event-mgmt v2
   *  §B3). Absent ⇒ unassigned. */
  owner?: { userId?: string; name: string; email: string };
  /** Per-event scoring config (PM decision 2026-07-19): how many judge panels
   *  score each routine, and which entry mode is offered by default. Absent ⇒
   *  `DEFAULT_SCORING_CONFIG` (`{panels:1, entryMode:'calculator'}`) — use the
   *  `scoringConfigOf` accessor (src/lib/events-core.ts) rather than reading
   *  this field directly, so callers get the default without repeating it. */
  scoringConfig?: ScoringConfig;
  /** The event owner's 7-item task checklist (§B4). Keyed by task id. */
  ownerChecklist?: OwnerChecklist;
  /** "Set Competition Order" lock flag (event-mgmt v2 P5 §E6). Once true,
   *  club managers may only VIEW `CompetitionOrder` rows for this event —
   *  only admins may keep editing. Absent ⇒ false (clubs edit freely). */
  competitionOrderLocked?: boolean;
  /** "Finals roster" lock flag (event-mgmt v2 P5 §E7/§L.3) — SEPARATE from
   *  `competitionOrderLocked` (own hard-lock timing, 10pm day-1). Once true,
   *  club managers may only VIEW `FinalsLineup` rows for this event — only
   *  admins may keep editing. Absent ⇒ false (clubs edit freely). */
  finalsRosterLocked?: boolean;
}

/** Event-owner checklist task ids, in the order they're worked (§B4). */
export type OwnerTaskId =
  | 'contact' | 'hotel' | 'medalsOrdered' | 'medalsTracking'
  | 'insurance' | 'onsiteRep' | 'payHost';

/** One checklist entry: `done`/`doneAt`/`note` are common to every task; the
 *  remaining fields are task-specific payloads (mirrors
 *  supabase/functions/_shared/owner-checklist.ts, which can't import this
 *  file since it must stay Deno/Node-import-free). */
export interface OwnerChecklistEntry {
  done?: boolean;
  doneAt?: string;
  note?: string;
  /** medalsOrdered payload. */
  orderedOn?: string;
  /** medalsTracking payload. */
  trackingLink?: string;
  hostReceived?: boolean;
  /** insurance payload (free-text path/link for now; upload wired later). */
  filePath?: string;
  /** onsiteRep payload. */
  name?: string;
  email?: string;
  /** payHost payload. */
  method?: 'check' | 'paypal';
  paidOn?: string;
}

export type OwnerChecklist = Partial<Record<OwnerTaskId, OwnerChecklistEntry>>;

export type SanctionStatus =
  | 'draft' | 'submitted' | 'voting' | 'approved' | 'rejected' | 'withdrawn';

/** A club manager's request to sanction an event. The full form lives in
 *  `payload` (see docs/specs/2026-06-18-event-management.md). */
export interface SanctionRequest {
  id: string;
  hostClubId: string;
  requesterPersonId: string | null;
  eventKind: 'competition' | 'camp';
  status: SanctionStatus;
  payload: Record<string, unknown>; // the full sanction form
  submittedAt?: string | null;
  deadlineAt?: string | null; // submittedAt + 7 days
  decidedAt?: string | null;
  createdEventId?: string | null;
  sanctionId?: string | null;
}

export interface SanctionVote {
  id: string;
  requestId: string;
  voterUserId: string;
  vote: 'approve' | 'reject' | 'abstain';
  comment?: string;
  votedAt: string;
}

export interface Registration {
  id: string;
  eventId: string;
  athleteId: string;
  clubId: string; // competing-for club
  discipline: Discipline;
  levelId: string;
  apparatus: string[]; // apparatus codes
  sessionId: string | null;
  /** Which of the session's squads this registration is placed in — the DB's
   *  own source of truth for squad membership (registrations.squad_id).
   *  `Event.sessions[].squads[].athleteRegIds` (the reverse index) used to be
   *  built from this at `loadAll` time; Phase 3 (data-layer-scale) removed
   *  registrations from loadAll, so SquadBuilder (Events.tsx) now bootstraps
   *  that reverse index from this field via the by-event slice instead —
   *  see its `hydratedRef` effect. Read-only for that purpose; SquadBuilder
   *  still writes squad_id via `pushRegistration`'s existing squadId
   *  parameter / `pushEventSessions`, unchanged. */
  squadId?: string | null;
  /** Placement category (e.g. "Collegiate Women", "Community Men+") — drives
   *  results grouping badges & filters, mirroring the Nationals results viewer. */
  category?: string;
  /** Qualifier flags per apparatus code (+ "AA"/"Team") — drives green/gold
   *  highlighting on results, mirroring the Nationals results viewer. */
  quals?: Record<string, boolean>;
  /** True once the registration's entry/change fee is actually paid through a
   *  pay path (3f). Defaults FALSE on create ⇒ "Pending Purchase". Host-club
   *  ($0) registrations are created `paid: true` (nothing to purchase). Treat a
   *  missing value as false. */
  paid?: boolean;
  /** Set when an already-PAID registration is edited in a way that incurs a
   *  change fee: `paid` flips back to false AND this flips true, so the UI can
   *  show "Updated pending purchase" (vs a never-paid "Pending Purchase").
   *  Cleared when the change fee is paid (back to paid:true). */
  updatedPending?: boolean;
  refunded?: boolean;
  refundRequested?: boolean; // athlete/club asked for a refund; admin reviews
  keepListed?: boolean; // refunded but keep for shirt/gift
  /** Synchro trampoline partner (any athlete w/ membership). A synchro event
   *  cannot go live until every synchro entry has a partner assigned. */
  partnerAthleteId?: string | null;
  /** Per-event level override (event code → levelId). T&T uses this now;
   *  shape future-proofs per-apparatus levels for MAG/WAG. Absent ⇒ use
   *  `levelId` for all events. */
  apparatusLevels?: Record<string, string>;
  /** Camp registrant-survey answers (event-mgmt v2 §G; question list made
   *  editable 2026-07-23). Present only for camp registrations at events
   *  with a survey configured (`campSurveyQuestionsOf`, pricing.ts) and
   *  enabled. Free to edit until the event's change deadline — never a
   *  change fee. Keyed by `CampSurveyQuestion.id`: a `single`/`text`
   *  question stores its answer as a string, `multi` as a string[]. Legacy
   *  rows (pre-2026-07-23) are fixed-key objects — `bedtime`/`noiseLevel`/
   *  `cabinGenderPref`/`roommateRequest` — which are valid values of this
   *  same `Record<string, string | string[]>` shape (those legacy ids are
   *  exactly the ones `campSurveyQuestionsOf` derives), so no migration or
   *  adapter is needed to read them back. */
  campSurvey?: Record<string, string | string[]>;
  /** DB `created_at` (timestamptz), READ-ONLY: never written by `pushRegistration`
   *  (the app's whole-row upsert never maps this column back, so the DB default
   *  `now()` — stamped once at first INSERT — is preserved across edits). This is
   *  the late-registration-fee anchor (emv2 P0 Task 3): the fee applies iff the
   *  EARLIEST `createdAt` among an athlete's regs at an event is at/after
   *  `Event.lateReg.startsAt`. Absent on a client-constructed (not-yet-saved) reg. */
  createdAt?: string;
  /** True when this registration is a waitlist placeholder (event-mgmt v2
   *  P4): no cart line, does not count toward any capacity cap, and is
   *  excluded from rosters/exports until promoted (flips back to false). */
  waitlisted?: boolean;
  /** The WaitlistGroup this registration belongs to while waitlisted. Absent
   *  once promoted off the waitlist. */
  waitlistGroupId?: string | null;
  /** Soft hold on a capacity-capped event: holds this registration's spot for
   *  30 minutes from cart-add, refreshed when checkout starts. Null/absent ⇒
   *  no active hold (unlimited event, or hold already consumed/expired). */
  holdExpiresAt?: string | null;
}

/** A grouped, all-or-nothing waitlist entry (event-mgmt v2 P4): a club's
 *  whole cohort of athletes at one level, or a single self-registering
 *  member, queues together in strict FIFO order (`queuedAt`). A promoted
 *  group gets a 24h hold (`holdExpiresAt`) to complete checkout before being
 *  re-queued to the back (`queuedAt` bumped, `status` back to 'waiting').
 *  Promotion/notify/expiry transitions are service-role (Edge Function)
 *  concerns — clients may only create a 'waiting' group or cancel their own. */
export interface WaitlistGroup {
  id: string;
  eventId: string;
  /** Set for a club-manager-queued cohort; null for a personal group. */
  clubId?: string | null;
  /** Set for a personal (self-registration) group; null for a club group. */
  personId?: string | null;
  discipline: Discipline;
  levelId?: string | null;
  /** By-session mode only. */
  sessionId?: string | null;
  status: 'waiting' | 'notified' | 'promoted' | 'cancelled' | 'expired';
  queuedAt: string;
  notifiedAt?: string | null;
  holdExpiresAt?: string | null;
  createdAt?: string;
}

/** Answer payload for a nationals session-request survey row (event-mgmt v2
 *  Phase 5 §L.1/§E5.4). `arrival` doubles as the club variant's "arrival
 *  window" and the independent variant's "arrival day" — a single-choice
 *  free-form string (the A2 UI defines the actual option set). A survey
 *  counts as answered once `arrival` is a non-empty string — see
 *  `sessionRequestAnswered` in `src/lib/pricing.ts`. */
export type SessionRequestAnswers = {
  arrival?: string;
  /** Multi-select of `EventSession.id` values. */
  preferredSessionIds?: string[];
  /** Club variant only — whether the club wants its athletes split across
   *  separate gyms/podiums when possible. Absent/null for the independent
   *  variant, which has no such field. */
  separateGyms?: boolean | null;
  notes?: string;
};

/** A nationals session-request survey row (event-mgmt v2 Phase 5 §L.1/§E5.4):
 *  clubs submit one per registered WAG level plus one combined MAG and one
 *  combined T&T survey; independent athletes submit one per discipline
 *  they're registered in. Scoped by EITHER `clubId` (club variant) OR
 *  `personId` (independent variant) — never both, never neither (mirrors
 *  `WaitlistGroup`'s dual-scoping). Fully client-editable (no state machine
 *  like `WaitlistGroup`'s status) — see `session_requests` RLS in the P5
 *  migration. */
export interface SessionRequest {
  id: string;
  eventId: string;
  /** Set for the club variant; null for the independent-athlete variant. */
  clubId?: string | null;
  /** Set for the independent-athlete variant; null for the club variant. */
  personId?: string | null;
  discipline: Discipline;
  /** WAG club variant only; null for combined MAG/TNT and every independent
   *  survey. */
  levelId?: string | null;
  answers: SessionRequestAnswers;
  createdAt?: string;
  updatedAt?: string;
}

/** A club's drag-and-drop competing order for one apparatus at one level, at
 *  one event (event-mgmt v2 Phase 5 §E6, "Set Competition Order"). MAG/WAG
 *  only — not T&T. `sections` is an array of arrays of registration ids: the
 *  outer array is section (flight) order, each inner array is that section's
 *  athlete competing order — one jsonb shape encodes both the athlete order
 *  AND the club's section split (capped at 12 for WAG / 15 for MAG per
 *  section, see `sectionCap` in `src/lib/competition-order.ts`). Writable by
 *  the club manager only while `Event.competitionOrderLocked` is false; once
 *  locked, only admins may edit (`competition_orders` RLS in the P5 B1
 *  migration). */
export interface CompetitionOrder {
  id: string;
  eventId: string;
  clubId: string;
  levelId: string;
  apparatus: string;
  sections: string[][];
  updatedAt?: string;
}

/** A nationals team's (club + level + placement category) finals lineup for
 *  one apparatus (event-mgmt v2 Phase 5 §E7, §L.3, "Finals roster"): pick up
 *  to `FINALS_LINEUP_MAX` (4) athletes + drag order. `category` is the
 *  placement category string produced by the nationals engine's
 *  `deriveCategory` (e.g. `'Collegiate Women+'`). Writable by the club
 *  manager only while `Event.finalsRosterLocked` is false — a SEPARATE lock
 *  from `Event.competitionOrderLocked`; once locked, only admins may edit
 *  (`finals_lineups` RLS in the P5 C1 migration). */
export interface FinalsLineup {
  id: string;
  eventId: string;
  clubId: string;
  levelId: string;
  category: string;
  apparatus: string;
  regIds: string[];
  updatedAt?: string;
}

/** A nationals check-in row (event-mgmt v2 Phase 5 E1, spec §L.4): a row
 *  EXISTS only once a league/meet admin has OPENED check-in for a scope —
 *  "no row for this (event, scope)" IS the "not opened yet" state, so there's
 *  no separate boolean. Scoped by EITHER `clubId` (club variant) OR
 *  `personId` (independent-athlete variant) — never both, never neither
 *  (same dual-scoping idiom as `WaitlistGroup`/`SessionRequest`). Once open,
 *  the club manager (or the athlete themself) confirms with a checkbox +
 *  typed signature, flipping `status` to `'checked-in'`. Client writes to an
 *  EXISTING row may only touch `status`/`signedName`/`checkedInAt`/
 *  `checkedInBy` — a column-level grant in the `event_checkins` RLS blocks
 *  rewriting `eventId`/`clubId`/`personId`/`openedBy` (see
 *  `confirmEventCheckin` in `src/lib/supabase.ts`). */
export interface EventCheckin {
  id: string;
  eventId: string;
  /** Set for the club variant; null for the independent-athlete variant. */
  clubId?: string | null;
  /** Set for the independent-athlete variant; null for the club variant. */
  personId?: string | null;
  status: 'open' | 'checked-in';
  /** The name typed at confirmation. */
  signedName?: string | null;
  checkedInAt?: string | null;
  /** Person id of whoever confirmed (club manager or the athlete). */
  checkedInBy?: string | null;
  /** Person id of the admin who opened check-in for this scope. */
  openedBy?: string | null;
  createdAt?: string;
}

/** A purchase-item-type → external accounting code mapping (event-mgmt v2
 *  Phase 6 T1, spec §M) -- e.g. mapping 'membership' or 'meet-entry:entry' to
 *  a QuickBooks code, for the finance dashboards to group revenue by code.
 *  `itemKey` is app-defined and unique; admin/finance_admin fully editable. */
export type AccountingCode = {
  id: string;
  itemKey: string;
  code: string;
  label?: string;
  updatedAt?: string;
};

/** A manual record of money paid OUT to an event host club (event-mgmt v2
 *  Phase 6 T1, spec §M) -- payouts happen outside Stripe (check/PayPal/ACH),
 *  so finance_admin/admin record them by hand for the dashboards to
 *  reconcile against gross revenue. */
export type HostPayout = {
  id: string;
  eventId: string;
  amountCents: number;
  method: 'check' | 'paypal' | 'ach';
  /** Check #, PayPal txn id, or ACH reference -- free text, method-dependent. */
  reference?: string;
  /** ISO date (not a full timestamp) the payout was made. */
  paidOn: string;
  notes?: string;
  /** Person id of the finance user who recorded the payout. */
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
};

export interface Score {
  id: string; // `${eventId}|${athleteRegId}|${apparatus}`
  eventId: string;
  sessionId: string;
  regId: string;
  apparatus: string;
  sv: number | null; // start value / D-score
  deductions: number | null; // total E deductions (for capped levels: final = sv - deductions)
  eScore?: number | null; // E-score out of 10 (open scoring: final = sv + eScore)
  /** Second judge panel's raw execution inputs (event.scoringConfig.panels === 2,
   *  2026-07-19). `combinePanels` (src/scoring/panels.ts) averages these against
   *  `deductions`/`eScore` into the effective execution value the final derives
   *  from; absent/null when only one panel is configured or judge 2 hasn't
   *  entered yet. */
  deductions2?: number | null;
  eScore2?: number | null;
  final: number | null;
  source?: 'manual' | 'mag-calc' | 'wag-open-calc' | 'masters-calc' | 'wag-sv-calc' | 'tnt-calc';
  /** Which embedded calculator produced this score (CalcKind), if any. */
  calc?: string;
  /** Serialized calculator inputs exactly as filled when the score was posted —
   *  lets athletes/admins reopen the calculator as it was, and admins adjust it. */
  calcState?: unknown;
  adjustNote?: string;
  adjustedAt?: string;
  enteredBy: string;
  enteredAt: string;
  flashed: boolean;
  /** Athlete withdrew from this apparatus (reference-tool "Scratched"). Excluded
   *  from placement/team scoring; distinct from a 0.0 score. Nationals scoring. */
  scratched?: boolean;
  /** Server-stamped compare-and-set version (UAT Z-06-01) — the `updated_at`
   *  the caller last saw for this score id. READ-ONLY: never written by
   *  `scoreToRow`'s push mapping — it's entirely server-controlled (default
   *  on insert, a trigger on update). Passed back as `post_score`'s
   *  `p_expected_updated_at` on the NEXT post so a second judge's concurrent
   *  write is caught as a conflict instead of silently overwriting. */
  updatedAt?: string;
}

export interface InvoiceItem {
  id: string;
  label: string;
  amount: number;
  /** `'banquet'` is a LEGACY kind value retained only for pre-Phase-2 data — new
   *  per-unit add-on lines (banquet/tshirt/banner/leo) all use `kind: 'addon'`,
   *  differentiated via `refLineType` below (event-mgmt v2 Phase 2). */
  kind: 'membership' | 'meet-entry' | 'banquet' | 'addon' | 'donation' | 'discount' | 'fee';
  refUserId?: string;
  /** For membership cart/invoice lines: the exact season + type this fee covers,
   *  so paying the line activates the RIGHT membership (a person may hold several
   *  across seasons/types). The `'club'` sentinel marks a CLUB membership line
   *  (a club buying its own seasonal membership) — paying it activates the
   *  `club_memberships` row for `refSeasonId`; `refUserId` is unset (the cart is
   *  the club's own cart, and `ref_user_id` FKs `people`, not `clubs`). */
  refSeasonId?: string;
  refType?: MembershipType | 'club';
  /** For meet-entry / change-fee lines (3f): the registration id(s) this line
   *  pays for, so the pay path can flip exactly those registrations to
   *  `paid: true`. */
  refRegIds?: string[];
  /** The event a meet-entry / addon line belongs to — lets the server re-price the
   *  line (esp. addons, which carry no reg ids). */
  refEventId?: string;
  /** Refines `kind` for server-side re-pricing: 'entry'|'change' for meet-entry
   *  lines, 'tshirt'|'banner'|'banquet'|'leo' for addon lines. Memberships leave
   *  it unset. */
  refLineType?: 'entry' | 'change' | 'tshirt' | 'banner' | 'banquet' | 'leo';
  refunded?: boolean;
  /** Per-unit add-on lines (event-mgmt v2 Phase 2): one InvoiceItem/CartItem per
   *  unit purchased (each shirt/leo/banquet ticket is its own line). */
  /** Shirt/leo size for this unit (tshirt/leo add-on lines only). */
  addonSize?: string;
  /** Who this unit is for (banquet lines only): a person id, or the literal
   *  sentinel `'extra'` for an unassigned ticket. At most one ASSIGNED ticket per
   *  person per event is enforced server-side (Task 2, not here). */
  addonAssigneeId?: string;
  /** For `kind:'meet-entry', refLineType:'change'` lines only: the FULL prior
   *  Registration row(s) (matching `refRegIds`) as they were BEFORE this change
   *  was applied, captured at cart-item creation time. Lets deleting the cart
   *  item revert the registration(s) instead of leaving them mutated. Absent
   *  for non-change items and for cart items created before this existed. */
  priorRegSnapshot?: Registration[];
}

export interface Invoice {
  id: string;
  number: string;
  clubId: string | null; // null = individual
  athleteId: string | null;
  createdAt: string;
  paidAt: string | null;
  items: InvoiceItem[];
  couponCode?: string;
  /** Stripe payment-intent id once the invoice is paid via Stripe (S1+). */
  stripePaymentIntentId?: string | null;
  /** Stripe's actual processing fee in CENTS, from the balance txn (S1+). */
  stripeFee?: number | null;
}

export type CartItem = InvoiceItem;

/** One frozen line of a payment's `lines_snapshot` (written by
 *  `create-checkout-session`, event-mgmt v2 Phase 6 T2 — see that function's
 *  `linesSnapshot` build, ~line 894). `amountCents` is the server-computed
 *  PRE-coupon list price; `paidCents` is the POST-coupon actual charge (the
 *  refund base) — absent on payments written before this field existed
 *  (2026-07-02), in which case callers should fall back to `amountCents`. */
export type PaymentSnapshotLine = {
  id: string;
  kind: InvoiceItem['kind'];
  label: string;
  amountCents: number;
  paidCents?: number;
  clubId?: string;
  refUserId?: string;
  refSeasonId?: string;
  refType?: string;
  refRegIds?: string[];
  refEventId?: string;
  refLineType?: string;
};

/** A Stripe Embedded Checkout payment record (server source of truth). All money
 *  fields are in CENTS (Stripe's unit). A `pending` row is created when the
 *  Checkout Session is opened; the verified webhook flips it to `paid` and runs
 *  fulfillment. The browser only reads its OWN rows (self-read RLS) to poll for
 *  `paid`. Mirrors the `payments` table (S1 migration). */
export interface Payment {
  id: string;
  stripeSessionId: string | null;
  stripePaymentIntentId: string | null;
  personId: string | null;
  status: 'pending' | 'paid' | 'failed' | 'refunded';
  amountSubtotal: number | null;
  serviceFee: number | null;
  stripeFee: number | null;
  currency: string;
  cartItemIds: string[];
  refRegIds: string[];
  refSeasonId: string | null;
  refType: string | null;
  invoiceId: string | null;
  stripeEventId: string | null;
  createdAt: string;
  fulfilledAt: string | null;
  /** Frozen, server-priced line set the payment fulfilled/will fulfill from
   *  (event-mgmt v2 Phase 6 T2 — see `PaymentSnapshotLine`). Absent for very
   *  old pre-snapshot payments. */
  linesSnapshot?: PaymentSnapshotLine[];
}

export interface Coupon {
  code: string;
  pctOff?: number;
  amountOff?: number;
  // 'membership' (legacy: any membership type) is kept for existing coupons;
  // new codes pick the finer-grained athlete/club/coach-membership scope, or
  // 'meet-entry' scoped to one specific event via `appliesToEventId`.
  appliesTo: 'membership' | 'athlete-membership' | 'club-membership' | 'coach-membership' | 'meet-entry' | 'any';
  /** Only meaningful when appliesTo === 'meet-entry': the one event this code
   *  is valid for. Hard-expires (regardless of `endsAt`) once that event's
   *  end_date has passed. */
  appliesToEventId?: string | null;
  startsAt?: string | null; // ISO; null/absent = no start bound
  endsAt?: string | null; // ISO; null/absent = no end bound
  maxUses?: number | null; // null/absent = unlimited
  usedCount?: number; // times redeemed
  /** When set, only this person may redeem the code. null/absent = anyone. */
  restrictedToPersonId?: string | null;
}

/** A member's request to create a new club (admins approve → real club). */
export interface ClubRequest {
  id: string;
  requesterPersonId: string | null;
  proposedName: string;
  shortName: string;
  state: string;
  region: Region | '';
  note: string;
  status: 'pending' | 'approved' | 'dismissed';
  createdAt: string;
  decidedAt?: string | null;
  createdClubId?: string | null;
}

/** Admin "create account for this athlete" — emails a setup link. The real
 *  email send is stubbed until a transactional-email provider is wired. */
export interface AccountInvite {
  id: string;
  personId: string | null;
  email: string;
  token: string;
  status: 'pending' | 'accepted' | 'revoked';
  createdAt: string;
  acceptedAt?: string | null;
}

// A single waiver covers all members regardless of membership type. 'General' is
// the canonical waiver_type stored in the DB.
export type WaiverType = 'General';
export const GENERAL_WAIVER_TYPE: WaiverType = 'General';

export interface WaiverDocument {
  id: string;
  seasonId: string;
  waiverType: WaiverType;
  version: number;
  body: string;
  contentHash: string;
  published: boolean;
  createdAt: string;
}

export interface WaiverSignature {
  id: string;
  personId: string;
  seasonId: string;
  waiverType: WaiverType;
  waiverDocumentId: string;
  contentHash: string;
  signerName: string;
  signerEmail: string;
  signerRole: 'self' | 'guardian';
  signerRelationship?: string | null;
  consent: boolean;
  signedAt: string;
  ip?: string | null;
  userAgent?: string | null;
}

export interface DB {
  seasons: Season[];
  levels: Level[];
  clubs: Club[];
  people: Athlete[];
  events: Event[];
  registrations: Registration[];
  scores: Score[];
  invoices: Invoice[];
  coupons: Coupon[];
  carts: Record<string, CartItem[]>; // key: clubId or athleteId
  clubRequests: ClubRequest[];
  /** Admin-editable state→region overrides (drag states between regions).
   *  Absent ⇒ use the hardcoded STATE_REGIONS map. */
  regionOverrides?: Record<string, Region>;
  /** Pending/handled account-setup invites created by admins. */
  accountInvites?: AccountInvite[];
  /** Event-Management sanction requests + their votes. */
  sanctionRequests?: SanctionRequest[];
  sanctionVotes?: SanctionVote[];
  /** Versioned waiver text (all versions retained). */
  waiverDocuments?: WaiverDocument[];
  /** Recorded e-signatures (the legal evidence records). */
  waiverSignatures?: WaiverSignature[];
  /** Per-(club, season) club memberships — gate for registration & hosting. */
  clubMemberships?: ClubMembership[];
  /** Stripe Embedded Checkout payment records (server source of truth). */
  payments?: Payment[];
  /** Per-event admin grants — host-level access to ONE event, granted to
   *  another account (event-mgmt v2 §C). Not a club role. */
  eventAdmins?: EventAdmin[];
  /** Refund requests (event-mgmt v2 Phase 3, spec §H). Written only via
   *  server-side RPCs/Edge Functions built in T5/T6 — never a direct client
   *  table write, so there is no corresponding pushRefundRequest(). */
  refundRequests?: RefundRequest[];
  /** Grouped waitlist entries (event-mgmt v2 Phase 4 T1). */
  waitlistGroups?: WaitlistGroup[];
  /** Nationals session-request surveys (event-mgmt v2 Phase 5 A1). */
  sessionRequests?: SessionRequest[];
  /** Club competition orders (event-mgmt v2 Phase 5 B1, spec §E6). */
  competitionOrders?: CompetitionOrder[];
  /** Nationals finals-roster lineups (event-mgmt v2 Phase 5 C1, spec §E7/§L.3). */
  finalsLineups?: FinalsLineup[];
  /** Nationals check-in flow rows (event-mgmt v2 Phase 5 E1, spec §L.4). */
  eventCheckins?: EventCheckin[];
  /** Purchase-item-type → external accounting code lookup (event-mgmt v2
   *  Phase 6 T1, spec §M). Admin/finance_admin editable. */
  accountingCodes?: AccountingCode[];
  /** Manual records of money paid OUT to an event host club (event-mgmt v2
   *  Phase 6 T1, spec §M) -- payouts happen outside Stripe. Admin/
   *  finance_admin editable. */
  hostPayouts?: HostPayout[];
  /** Codeless judge access codes — one ACTIVE (non-revoked) row per event
   *  (2026-07-19). Only readable by admin/host/event-admin (RLS mirrors
   *  is_event_host); an anonymous judge never reads this collection, they
   *  resolve access through the `judge-entry` Edge Function instead. */
  judgeAccessCodes?: JudgeAccessCode[];
}

/** A codeless judge access code: URL, 6-digit `code`, and QR are three forms
 *  of the same `token`-carrying link. A device that unlocks with either can
 *  enter scores for ANY discipline/apparatus at `eventId` — no per-judge
 *  identity. Generated client-side (host UI) via `crypto.getRandomValues`;
 *  "Regenerate" revokes the old row (`revokedAt`) before inserting a new one
 *  — never hard-deleted, so the audit trail survives. */
export interface JudgeAccessCode {
  id: string;
  eventId: string;
  token: string;
  code: string;
  createdBy?: string | null;
  createdAt?: string;
  revokedAt?: string | null;
}

/** A per-event admin grant: `userId` holds the same host-level access to
 *  `eventId` as the event's host-club managers. Written only via the
 *  grant_event_admin/revoke_event_admin RPCs — never a direct table write. */
export interface EventAdmin {
  id: string;
  eventId: string;
  userId: string;
  email: string;
  name?: string | null;
  grantedBy?: string | null;
  createdAt?: string;
}

/** A request to refund a purchased registration entry fee or add-on
 *  (event-mgmt v2 Phase 3, spec §H). Refunds are only offered for events
 *  hosted by the league's own club (`eventIsRefundEligible`, events-core.ts).
 *  `refundAmountCents` (pricing.ts) computes `refundAmountCents` from the
 *  item's price, `event.lastDateToEdit`, and `reviewedAt` once approved — the
 *  service fee is NEVER refunded. All writes (create/approve/reject/process)
 *  happen via SECURITY DEFINER RPCs / service-role Edge Functions (T5/T6) —
 *  there is no client-side pushRefundRequest(). */
export interface RefundRequest {
  id: string;
  createdAt: string;
  requesterPersonId: string;
  /** Set when requested from a club cart context (a manager requesting on
   *  behalf of an athlete's purchase); null for a self-serve member request. */
  clubId?: string | null;
  eventId: string;
  kind: 'registration' | 'addon';
  /** Meaningful when kind === 'registration'. */
  regId?: string | null;
  /** Meaningful when kind === 'addon'. */
  invoiceItemId?: string | null;
  paymentId?: string | null;
  reason: 'injury' | 'illness' | 'bereavement' | 'other';
  reasonDetail?: string | null;
  status: 'pending' | 'approved' | 'rejected';
  reviewedBy?: string | null;
  reviewedAt?: string | null;
  refundAmountCents?: number | null;
  stripeRefundId?: string | null;
  /** Ties together every row belonging to ONE reviewable decision (UAT Z-04,
   *  T4b `20260821150000`) — every per-payment row for a registration refund
   *  request shares one `requestGroupId`; an add-on request is a one-row
   *  group where this equals its own `id`. Falls back to `id` for the rare
   *  row somehow missing it client-side (defensive only — the column is
   *  NOT NULL in the DB). `RefundReview.tsx` groups on this, not on `id`. */
  requestGroupId: string;
  /** Required free-text reason the reviewer gave for REJECTING this request
   *  (rule 6) — distinct from `reason`/`reasonDetail`, which are the
   *  REQUESTER's stated reason. Null for pending/approved rows. */
  rejectionReason?: string | null;
}

/** A club's membership for a season. Its presence (status 'active') is the gate
 *  that lets the club's athletes register and the club host that season. */
export interface ClubMembership {
  id: string;
  clubId: string;
  seasonId: string;
  status: 'active';
  grantedByAdmin: boolean;
  createdAt: string;
}

export const STATE_REGIONS: Record<string, Region> = {
  Alabama: 'Southeast', Alaska: 'West', Arizona: 'West', Arkansas: 'South Central',
  California: 'West', Colorado: 'West', Connecticut: 'Northeast', Delaware: 'Mid-Atlantic',
  'District of Columbia': 'Mid-Atlantic', Florida: 'Southeast', Georgia: 'Southeast',
  Hawaii: 'West', Idaho: 'West', Illinois: 'Midwest', Indiana: 'Mideast', Iowa: 'Midwest',
  Kansas: 'South Central', Kentucky: 'Mideast', Louisiana: 'Southeast', Maine: 'Northeast',
  Maryland: 'Mid-Atlantic', Massachusetts: 'Northeast', Michigan: 'Mideast',
  Minnesota: 'Midwest', Mississippi: 'Southeast', Missouri: 'Midwest', Montana: 'West',
  Nebraska: 'Midwest', Nevada: 'West', 'New Hampshire': 'Northeast', 'New Jersey': 'Mid-Atlantic',
  'New Mexico': 'West', 'New York': 'Northeast', 'North Carolina': 'Southeast',
  'North Dakota': 'Midwest', Ohio: 'Mideast', Oklahoma: 'South Central', Oregon: 'West',
  Pennsylvania: 'Mid-Atlantic', 'Rhode Island': 'Northeast', 'South Carolina': 'Southeast',
  'South Dakota': 'Midwest', Tennessee: 'Southeast', Texas: 'South Central', Utah: 'West',
  Vermont: 'Northeast', Virginia: 'Mid-Atlantic', Washington: 'West',
  'West Virginia': 'Mid-Atlantic', Wisconsin: 'Midwest', Wyoming: 'West',
};

export const SHIRT_SIZES = ['Youth S', 'Youth M', 'Youth L', 'Adult S', 'Adult M', 'Adult L', 'Adult XL', 'Adult XXL', 'Adult XXXL'];
export const DIETARY_OPTIONS = ['Celiac', 'Gluten-free', 'No Dairy', 'Peanut Allergy', 'Shellfish Allergy', 'Tree Nut Allergy', 'Vegan', 'Vegetarian', 'Other'];
