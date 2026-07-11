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
  active: boolean; // purchasable now
  current: boolean;
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
   *  (event-mgmt v2 P4). Absent/undefined ⇒ uncapped. Stored only as of P4
   *  T1 — not enforced yet. */
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
    overnightSurvey?: boolean;
    leoAddon?: { price: number; sizes: string[]; lastPurchaseAt?: string };
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
   *  apparatus at a level counts as 4 against that level's cap. Stored only as
   *  of P4 T1 — enforcement lands in a later P4 task. */
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
  /** The event owner's 7-item task checklist (§B4). Keyed by task id. */
  ownerChecklist?: OwnerChecklist;
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
  /** Camp overnight-accommodations survey answers (event-mgmt v2 §G). Present
   *  only for camp registrations at events with `campConfig.overnightSurvey`
   *  on. Free to edit until the event's change deadline — never a change fee. */
  campSurvey?: {
    bedtime?: 'before-10' | '10-to-midnight' | 'after-midnight';
    noiseLevel?: 'quiet' | 'moderate' | 'lively';
    cabinGenderPref?: Gender | 'No preference';
    roommateRequest?: string;
  };
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

export interface Score {
  id: string; // `${eventId}|${athleteRegId}|${apparatus}`
  eventId: string;
  sessionId: string;
  regId: string;
  apparatus: string;
  sv: number | null; // start value / D-score
  deductions: number | null; // total E deductions (for capped levels: final = sv - deductions)
  eScore?: number | null; // E-score out of 10 (open scoring: final = sv + eScore)
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
