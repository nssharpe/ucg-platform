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

export type EventStatus = 'draft' | 'reg-open' | 'reg-closed' | 'in-progress' | 'complete';

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
  entryFee: number; // per discipline
  secondDisciplineFee: number;
  disciplines: Discipline[];
  sessions: EventSession[];
  privateRegCode?: string;
  banquet?: { price: number; name: string };
  /** Optional add-ons offered at registration. */
  tshirtAddon?: { price: number; sizes: string[] };
  bannerAddon?: { price: number }; // club enters banner text at registration
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
  /** Camp-only configuration (overnight survey, director cc, leo add-on, etc.). */
  campConfig?: {
    overnightSurvey?: boolean;
    directorName?: string;
    directorEmail?: string;
    directorCcOnConfirmation?: boolean;
    leoAddon?: { price: number; sizes: string[] };
    ageCalcAt?: string; // ISO datetime
  };
}

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
   *  lines, 'tshirt'|'banner' for addon lines. Memberships leave it unset. */
  refLineType?: 'entry' | 'change' | 'tshirt' | 'banner';
  refunded?: boolean;
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
