export type Discipline = 'MAG' | 'WAG' | 'TNT';

export const DISCIPLINES: Discipline[] = ['MAG', 'WAG', 'TNT'];

export const EVENTS: Record<Discipline, { code: string; name: string }[]> = {
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
}

export interface Club {
  id: string;
  name: string;
  shortName: string;
  state: string;
  region: Region;
  managerIds: string[];
  email: string;
  allowClubPay: boolean; // athletes may push membership fee to club cart
}

export type Gender = 'Male' | 'Female' | 'Non-binary' | 'Genderfluid' | 'Agender' | 'Other';
export type Placement = 'men+' | 'women+';

export type MembershipStatus = 'active' | 'pending-club-payment' | 'none';

export interface Membership {
  seasonId: string;
  status: MembershipStatus;
  waiverSignedAt: string | null;
  waiverSignedBy: string | null; // self or guardian name
  paidVia: 'card' | 'club' | 'comp' | null;
  activatedByAdmin?: boolean;
}

export interface Athlete {
  id: string;
  kind: 'athlete' | 'coach';
  firstName: string;
  lastName: string;
  email: string;
  dob: string;
  gender: Gender;
  placement?: Partial<Record<Discipline, Placement>>;
  gradYear: number; // 1900 = n/a
  studentStatus: 'Student' | 'Non-Student';
  shirt: string;
  country: string;
  state: string;
  phone: string;
  mainClubId: string | null;
  altClubIds: string[];
  levels: Partial<Record<Discipline, string>>; // levelId per discipline
  emergency: { contact: string; relation: string; phone: string };
  dietary: string[];
  dietaryNotes: string;
  memberships: Membership[];
  achievements: string[];
}

export type MeetStatus = 'draft' | 'reg-open' | 'reg-closed' | 'in-progress' | 'complete';

export interface Squad {
  id: string;
  name: string; // "Squad A", "Holding"
  startEvent: number; // rotation start index
  athleteRegIds: string[];
  holding?: boolean;
}

export interface MeetSession {
  id: string;
  name: string; // "Session 1 — WAG Xcel Silver/Platinum"
  discipline: Discipline;
  date: string;
  time: string;
  levelIds: string[];
  squads: Squad[];
}

export interface Meet {
  id: string;
  slug: string;
  name: string;
  hostClubId: string;
  city: string;
  state: string;
  timezone: string;
  startDate: string;
  endDate: string;
  status: MeetStatus;
  regOpens: string;
  regCloses: string;
  entryFee: number; // per discipline
  secondDisciplineFee: number;
  disciplines: Discipline[];
  sessions: MeetSession[];
  privateRegCode?: string;
  banquet?: { price: number; name: string };
}

export interface Registration {
  id: string;
  meetId: string;
  athleteId: string;
  clubId: string; // competing-for club
  discipline: Discipline;
  levelId: string;
  events: string[]; // event codes
  sessionId: string | null;
  /** Placement category (e.g. "Collegiate Women", "Community Men+") — drives
   *  results grouping badges & filters, mirroring the Nationals results viewer. */
  category?: string;
  /** Qualifier flags per event code (+ "AA"/"Team") — drives green/gold
   *  highlighting on results, mirroring the Nationals results viewer. */
  quals?: Record<string, boolean>;
  refunded?: boolean;
  keepListed?: boolean; // refunded but keep for shirt/gift
}

export interface Score {
  id: string; // `${meetId}|${athleteRegId}|${event}`
  meetId: string;
  sessionId: string;
  regId: string;
  event: string;
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
}

export interface InvoiceItem {
  id: string;
  label: string;
  amount: number;
  kind: 'membership' | 'meet-entry' | 'banquet' | 'addon' | 'donation' | 'discount';
  refUserId?: string;
  refunded?: boolean;
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
}

export interface CartItem extends InvoiceItem {}

export interface Coupon {
  code: string;
  pctOff?: number;
  amountOff?: number;
  appliesTo: 'membership' | 'meet-entry' | 'any';
}

export type RoleId =
  | 'admin'
  | 'club-manager'
  | 'athlete'
  | 'judge'
  | 'meet-host'
  | 'spectator';

export interface Role {
  id: RoleId;
  label: string;
  personaName: string;
  description: string;
}

export interface DB {
  seasons: Season[];
  levels: Level[];
  clubs: Club[];
  people: Athlete[];
  meets: Meet[];
  registrations: Registration[];
  scores: Score[];
  invoices: Invoice[];
  coupons: Coupon[];
  carts: Record<string, CartItem[]>; // key: clubId or athleteId
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
