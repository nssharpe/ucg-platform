// Supabase client + repository — wired up against supabase/migrations/0001_schema.sql.
//
// Write-through model: the in-memory store (src/lib/store.ts) stays the source
// of truth for the UI. Every mutation call site keeps its local `mutate()` and
// additionally fires one of the `push*` helpers below to mirror the change to
// Supabase. All writes are fire-and-forget (console.error on failure, never
// block the UI) and are no-ops when `isSupabaseConfigured` is false.
import { createClient, type SupabaseClient, type RealtimePostgresChangesPayload, type PostgrestError } from '@supabase/supabase-js';
import type {
  AccountInvite, Athlete, Club, ClubMembership, ClubRequest, Coupon, DB, Invoice, Level, Meet, Membership, MembershipType, Region, Registration, SanctionRequest, SanctionVote, Score, Season,
  WaiverDocument, WaiverSignature,
} from './types';
import { writeQueue, type WriteOp, type ExecResult } from './write-queue';
import type { Database } from './database.types';

/** A table's Row type — the shape Supabase returns, used to type the DB→app
 *  row mappers so a schema change (renamed/dropped column) fails the build. */
type Row<T extends keyof Database['public']['Tables']> = Database['public']['Tables'][T]['Row'];
/** A database function's row return shape (for `.rpc()` results). */
type FnReturns<T extends keyof Database['public']['Functions']> = Database['public']['Functions'][T]['Returns'];

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isSupabaseConfigured = Boolean(url && anonKey);

/** Null until env vars are provided — callers must guard on isSupabaseConfigured. */
export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(url!, anonKey!, { auth: { persistSession: true, autoRefreshToken: true } })
  : null;

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------
const CHUNK_SIZE = 500;

function chunk<T>(rows: T[], size = CHUNK_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

const PAGE_SIZE = 1000;

/** Fetch every row from a table, paging past PostgREST's default row cap
 *  (1000) — needed for `people`, which now exceeds that with the full
 *  ScoreFlippers import. */
async function fetchAllRows<T>(table: string): Promise<{ data: T[]; error: PostgrestError | null }> {
  const out: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase!.from(table).select('*').range(from, from + PAGE_SIZE - 1);
    if (error) return { data: out, error };
    out.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return { data: out, error: null };
}

// All write-through goes through the outbound queue (src/lib/write-queue.ts):
// each op is retried with backoff, persisted so it survives a reload, and a
// terminal failure is surfaced to the user (components/WriteStatus.tsx) instead
// of being silently lost. The queue's executor — registered below — performs
// the actual chunked Supabase calls.

/** Run one queued WriteOp against Supabase. Chunks large arrays; on any error
 *  returns it so the queue retries the whole op (every op is idempotent: upsert,
 *  or delete-then-insert). */
async function executeWriteOp(op: WriteOp): Promise<ExecResult> {
  if (!supabase) return { error: null };
  if (op.kind === 'upsert') {
    for (const part of chunk(op.rows)) {
      const q = op.onConflict ? { onConflict: op.onConflict } : undefined;
      const { error } = await supabase.from(op.table).upsert(part, q);
      if (error) return { error };
    }
    return { error: null };
  }
  if (op.kind === 'delete') {
    let del = supabase.from(op.table).delete();
    for (const [k, v] of Object.entries(op.match)) del = del.eq(k, v);
    const { error } = await del;
    return { error };
  }
  // replace: delete the matched set, then insert the new rows.
  let del = supabase.from(op.table).delete();
  for (const [k, v] of Object.entries(op.match)) del = del.eq(k, v);
  const { error: delErr } = await del;
  if (delErr) return { error: delErr };
  for (const part of chunk(op.rows)) {
    const { error } = await supabase.from(op.table).insert(part);
    if (error) return { error };
  }
  return { error: null };
}

if (supabase) writeQueue.setExecutor(executeWriteOp);

/** Queue an upsert (chunked at execution time for arrays >500 rows). */
function remoteUpsert(table: string, rows: Record<string, unknown>[], onConflict?: string) {
  if (!supabase || rows.length === 0) return;
  writeQueue.enqueue({ kind: 'upsert', table, rows, onConflict }, table);
}

/** Queue a delete by the given equality match (defaults to primary key). */
function remoteDeleteWhere(table: string, match: Record<string, unknown>) {
  if (!supabase) return;
  writeQueue.enqueue({ kind: 'delete', table, match }, table);
}

/** Queue a delete by primary key. */
function remoteDelete(table: string, id: string, column = 'id') {
  remoteDeleteWhere(table, { [column]: id });
}

/** Queue a delete-all-then-insert for a small child collection. */
function remoteReplace(table: string, match: Record<string, unknown>, rows: Record<string, unknown>[]) {
  if (!supabase) return;
  writeQueue.enqueue({ kind: 'replace', table, match, rows }, table);
}

// ---------------------------------------------------------------------------
// Row mappers — DB row (snake_case, matches 0001_schema.sql) <-> TS shape
// ---------------------------------------------------------------------------
const seasonToRow = (s: Season) => ({
  id: s.id, name: s.name, starts_on: s.startsOn, ends_on: s.endsOn,
  athlete_fee: s.athleteFee, coach_fee: s.coachFee, club_fee: s.clubFee,
  active: s.active, current: s.current,
});
const rowToSeason = (r: Row<'seasons'>): Season => ({
  id: r.id, name: r.name, startsOn: r.starts_on, endsOn: r.ends_on,
  athleteFee: Number(r.athlete_fee), coachFee: Number(r.coach_fee),
  clubFee: r.club_fee == null ? 109 : Number(r.club_fee),
  active: r.active, current: r.current,
});

const levelToRow = (l: Level) => ({
  id: l.id, discipline: l.discipline, name: l.name, sv_max: l.svMax, vaults: l.vaults,
  sort_order: l.order, retired: l.retired ?? false,
});
const rowToLevel = (r: Row<'levels'>): Level => ({
  id: r.id, discipline: r.discipline, name: r.name,
  svMax: r.sv_max == null ? null : Number(r.sv_max), vaults: r.vaults, order: r.sort_order,
  ...(r.retired ? { retired: true } : {}),
});

const clubToRow = (c: Club) => ({
  id: c.id, name: c.name, short_name: c.shortName, state: c.state, region: c.region,
  email: c.email, allow_club_pay: c.allowClubPay, access: c.access ?? 'open',
});
const rowToClub = (r: Row<'clubs'>): Club => ({
  id: r.id, name: r.name, shortName: r.short_name ?? '', state: r.state ?? '', region: (r.region ?? 'Other') as Club['region'],
  managerIds: [], email: r.email ?? '', allowClubPay: r.allow_club_pay, access: (r.access ?? 'open') as Club['access'],
});

const couponToRow = (c: Coupon) => ({
  code: c.code, pct_off: c.pctOff ?? null, amount_off: c.amountOff ?? null, applies_to: c.appliesTo,
  starts_at: c.startsAt ?? null, ends_at: c.endsAt ?? null,
  max_uses: c.maxUses ?? null, used_count: c.usedCount ?? 0,
  restricted_to_person_id: c.restrictedToPersonId ?? null,
});
const rowToCoupon = (r: Row<'coupons'>): Coupon => ({
  code: r.code, pctOff: r.pct_off == null ? undefined : Number(r.pct_off),
  amountOff: r.amount_off == null ? undefined : Number(r.amount_off), appliesTo: r.applies_to as Coupon['appliesTo'],
  startsAt: r.starts_at ?? null, endsAt: r.ends_at ?? null,
  maxUses: r.max_uses == null ? null : Number(r.max_uses),
  usedCount: r.used_count == null ? 0 : Number(r.used_count),
  restrictedToPersonId: (r as { restricted_to_person_id?: string | null }).restricted_to_person_id ?? null,
});

const personToRow = (p: Athlete) => ({
  id: p.id, kind: p.kind,
  roles: p.roles ?? { athlete: p.kind !== 'coach', coach: p.kind === 'coach' },
  first_name: p.firstName, last_name: p.lastName, email: p.email,
  dob: p.dob || null, gender: p.gender, placement: p.placement ?? {}, grad_year: p.gradYear,
  student_status: p.studentStatus, shirt: p.shirt, country: p.country, state: p.state,
  outside_us: p.outsideUs ?? false,
  phone: p.phone, sms_consent: p.smsConsent ?? false, sms_consent_at: p.smsConsentAt ?? null,
  main_club_id: p.mainClubId, levels: p.levels ?? {},
  emergency: p.emergency ?? {}, dietary: p.dietary ?? [], dietary_notes: p.dietaryNotes ?? '',
  achievements: p.achievements ?? [],
});

const membershipToRow = (personId: string, m: Membership) => ({
  // Membership has no TS id; derive a stable one (0004 dropped the uuid default).
  // Includes type so a person can hold athlete + coach in the same season.
  id: `${personId}:${m.seasonId}:${m.type ?? 'athlete'}`,
  person_id: personId, season_id: m.seasonId, type: m.type ?? 'athlete', status: m.status,
  waiver_signed_at: m.waiverSignedAt, waiver_signed_by: m.waiverSignedBy,
  paid_via: m.paidVia, activated_by_admin: m.activatedByAdmin ?? false,
  club_cart_pending: m.clubCartPending ?? false,
});
const rowToMembership = (r: Row<'memberships'>): Membership => ({
  seasonId: r.season_id, type: (r.type ?? 'athlete') as Membership['type'], status: r.status as Membership['status'], waiverSignedAt: r.waiver_signed_at,
  waiverSignedBy: r.waiver_signed_by, paidVia: r.paid_via, activatedByAdmin: r.activated_by_admin,
  clubCartPending: (r as { club_cart_pending?: boolean }).club_cart_pending ?? false,
});

const meetToRow = (m: Meet) => ({
  id: m.id, slug: m.slug, name: m.name, host_club_id: m.hostClubId, city: m.city, state: m.state,
  timezone: m.timezone, start_date: m.startDate || null, end_date: m.endDate || null, status: m.status,
  reg_opens: m.regOpens || null, reg_closes: m.regCloses || null, entry_fee: m.entryFee,
  second_discipline_fee: m.secondDisciplineFee, disciplines: m.disciplines,
  private_reg_code: m.privateRegCode ?? null, banquet: m.banquet ?? null,
  tshirt_addon: m.tshirtAddon ?? null, banner_addon: m.bannerAddon ?? null,
  change_fee: m.changeFee ?? null,
  event_type: m.eventType ?? 'competition', sanction_id: m.sanctionId ?? null,
  camp_config: m.campConfig ?? null,
  kind: m.kind ?? 'standard', nationals_config: m.nationalsConfig ?? null,
});

const sessionToRow = (meetId: string, s: Meet['sessions'][number]) => ({
  id: s.id, meet_id: meetId, name: s.name, discipline: s.discipline,
  date: s.date || null, time: s.time || null, level_ids: s.levelIds,
  phase: s.phase ?? null,
});

const squadToRow = (sessionId: string, q: Meet['sessions'][number]['squads'][number], i: number) => ({
  id: q.id, session_id: sessionId, name: q.name, start_event: q.startEvent,
  holding: q.holding ?? false, sort_order: i,
});

const registrationToRow = (r: Registration, squadId: string | null = null) => ({
  id: r.id, meet_id: r.meetId, athlete_id: r.athleteId, club_id: r.clubId, discipline: r.discipline,
  level_id: r.levelId, events: r.events, session_id: r.sessionId || null, squad_id: squadId,
  refunded: r.refunded ?? false, refund_requested: r.refundRequested ?? false,
  keep_listed: r.keepListed ?? false,
  partner_athlete_id: r.partnerAthleteId ?? null, event_levels: r.eventLevels ?? null,
});

/** squad_id for every registration, derived from session.squads[].athleteRegIds. */
function squadIdsByReg(meet: Meet): Map<string, string> {
  const map = new Map<string, string>();
  for (const s of meet.sessions) for (const q of s.squads) for (const regId of q.athleteRegIds) map.set(regId, q.id);
  return map;
}
const rowToRegistration = (r: Row<'registrations'>): Registration => ({
  id: r.id, meetId: r.meet_id, athleteId: r.athlete_id, clubId: r.club_id ?? '', discipline: r.discipline as Registration['discipline'],
  levelId: r.level_id ?? '', events: (r.events ?? []) as Registration['events'], sessionId: r.session_id ?? '',
  refunded: r.refunded, keepListed: r.keep_listed,
  ...(r.refund_requested ? { refundRequested: true } : {}),
  ...(r.partner_athlete_id ? { partnerAthleteId: r.partner_athlete_id } : {}),
  ...(r.event_levels ? { eventLevels: r.event_levels as Registration['eventLevels'] } : {}),
});

const scoreToRow = (s: Score) => ({
  id: s.id, meet_id: s.meetId, session_id: s.sessionId, reg_id: s.regId, event: s.event,
  sv: s.sv, deductions: s.deductions, e_score: s.eScore ?? null, final: s.final,
  source: s.source ?? 'manual',
  calc: s.calc ?? null, calc_state: s.calcState ?? null,
  adjust_note: s.adjustNote ?? null, adjusted_at: s.adjustedAt ?? null,
  entered_by: s.enteredBy, entered_at: s.enteredAt, flashed: s.flashed,
  scratched: s.scratched ?? false,
});
export const rowToScore = (r: Row<'scores'>): Score => ({
  id: r.id, meetId: r.meet_id, sessionId: r.session_id ?? '', regId: r.reg_id ?? '', event: r.event as Score['event'],
  sv: r.sv == null ? null : Number(r.sv), deductions: r.deductions == null ? null : Number(r.deductions),
  eScore: r.e_score == null ? null : Number(r.e_score), final: r.final == null ? null : Number(r.final),
  source: r.source as Score['source'], enteredBy: r.entered_by ?? '', enteredAt: r.entered_at, flashed: r.flashed,
  ...(r.calc != null ? { calc: r.calc } : {}),
  ...(r.calc_state != null ? { calcState: r.calc_state } : {}),
  ...(r.adjust_note != null ? { adjustNote: r.adjust_note } : {}),
  ...(r.adjusted_at != null ? { adjustedAt: r.adjusted_at } : {}),
  ...(r.scratched ? { scratched: true } : {}),
});

// cart_items: one row per item, owner = club_id or person_id
function cartItemToRow(ownerKey: string, item: DB['carts'][string][number], isClub: boolean) {
  return {
    id: item.id, club_id: isClub ? ownerKey : null, person_id: isClub ? null : ownerKey,
    label: item.label, amount: item.amount, kind: item.kind, ref_user_id: item.refUserId ?? null,
    ref_season_id: item.refSeasonId ?? null, ref_type: item.refType ?? null,
  };
}

const invoiceToRow = (i: Invoice) => ({
  id: i.id, number: i.number, club_id: i.clubId, athlete_id: i.athleteId,
  coupon_code: i.couponCode ?? null, created_at: i.createdAt, paid_at: i.paidAt,
});
const invoiceItemToRow = (invoiceId: string, it: Invoice['items'][number]) => ({
  id: it.id, invoice_id: invoiceId, label: it.label, amount: it.amount, kind: it.kind,
  ref_user_id: it.refUserId ?? null, refunded: it.refunded ?? false,
});

const clubRequestToRow = (r: ClubRequest) => ({
  id: r.id, requester_person_id: r.requesterPersonId, proposed_name: r.proposedName,
  short_name: r.shortName, state: r.state || null, region: r.region || null, note: r.note,
  status: r.status, created_at: r.createdAt, decided_at: r.decidedAt ?? null,
  created_club_id: r.createdClubId ?? null,
});
const rowToClubRequest = (r: Row<'club_requests'>): ClubRequest => ({
  id: r.id, requesterPersonId: r.requester_person_id ?? null, proposedName: r.proposed_name,
  shortName: r.short_name ?? '', state: r.state ?? '', region: (r.region ?? '') as ClubRequest['region'], note: r.note ?? '',
  status: r.status as ClubRequest['status'], createdAt: r.created_at, decidedAt: r.decided_at, createdClubId: r.created_club_id,
});

const rowToWaiverDocument = (r: Row<'waiver_documents'>): WaiverDocument => ({
  id: r.id, seasonId: r.season_id, waiverType: r.waiver_type as WaiverDocument['waiverType'], version: r.version,
  body: r.body, contentHash: r.content_hash, published: r.published, createdAt: r.created_at,
});
const rowToClubMembership = (r: { id: string; club_id: string; season_id: string; status: string; granted_by_admin: boolean; created_at: string }): ClubMembership => ({
  id: r.id, clubId: r.club_id, seasonId: r.season_id, status: 'active',
  grantedByAdmin: !!r.granted_by_admin, createdAt: r.created_at,
});
const rowToWaiverSignature = (r: Row<'waiver_signatures'>): WaiverSignature => ({
  id: r.id, personId: r.person_id, seasonId: r.season_id, waiverType: r.waiver_type as WaiverSignature['waiverType'],
  waiverDocumentId: r.waiver_document_id, contentHash: r.content_hash,
  signerName: r.signer_name, signerEmail: r.signer_email, signerRole: r.signer_role as WaiverSignature['signerRole'],
  signerRelationship: r.signer_relationship, consent: r.consent, signedAt: r.signed_at,
  ip: r.ip, userAgent: r.user_agent,
});

// ---------------------------------------------------------------------------
// Domain push helpers — call from mutation sites alongside local mutate()
// ---------------------------------------------------------------------------
export function pushSeason(s: Season) { remoteUpsert('seasons', [seasonToRow(s)]); }
export function pushLevel(l: Level) { remoteUpsert('levels', [levelToRow(l)]); }
export function deleteLevel(id: string) { remoteDelete('levels', id); }
export function pushCoupon(c: Coupon) { remoteUpsert('coupons', [couponToRow(c)]); }
export function deleteCoupon(code: string) { remoteDelete('coupons', code, 'code'); }
export function pushClubMembership(cm: ClubMembership) {
  remoteUpsert('club_memberships', [{ id: cm.id, club_id: cm.clubId, season_id: cm.seasonId, status: cm.status, granted_by_admin: cm.grantedByAdmin }]);
}
export function deleteClubMembership(id: string) { remoteDelete('club_memberships', id, 'id'); }
/** Hard-delete a person remotely (used by account merge). Cascades remove the
 *  person's remaining child rows (memberships, alt clubs, signatures, etc.). */
export function deletePerson(id: string) { remoteDelete('people', id, 'id'); }

export function pushClub(c: Club) {
  remoteUpsert('clubs', [clubToRow(c)]);
  remoteReplace('club_managers', { club_id: c.id }, c.managerIds.map((personId) => ({ club_id: c.id, person_id: personId })));
}

/** Push a person row (+ alt-clubs + memberships) to Supabase.
 *  Pass `opts.selfAuthUserId` ONLY when the acting signed-in user is saving
 *  THEIR OWN row: it stamps `auth_user_id` so the `people` INSERT RLS policy's
 *  `auth_user_id = auth.uid()` branch passes on a first-time self INSERT (an
 *  ordinary member otherwise fails is_admin()/manages_club()). NEVER pass it
 *  when creating/editing OTHER people (admins/club-managers) — that would stamp
 *  the actor's uid onto someone else's row. */
export function pushPerson(p: Athlete, opts?: { selfAuthUserId?: string }) {
  const row = opts?.selfAuthUserId
    ? { ...personToRow(p), auth_user_id: opts.selfAuthUserId }
    : personToRow(p);
  remoteUpsert('people', [row]);
  remoteReplace('person_alt_clubs', { person_id: p.id }, p.altClubIds.map((clubId) => ({ person_id: p.id, club_id: clubId })));
  remoteReplace('memberships', { person_id: p.id }, p.memberships.map((m) => membershipToRow(p.id, m)));
}

/** Upsert just one season's membership row for a person (no replace of others). */
export function pushMembership(personId: string, m: Membership) {
  remoteUpsert('memberships', [membershipToRow(personId, m)], 'person_id,season_id,type');
}

export function pushMeet(m: Meet) {
  remoteUpsert('meets', [meetToRow(m)]);
  remoteReplace('meet_sessions', { meet_id: m.id }, m.sessions.map((s) => sessionToRow(m.id, s)));
  for (const s of m.sessions) {
    remoteReplace('squads', { session_id: s.id }, s.squads.map((q, i) => squadToRow(s.id, q, i)));
  }
}

/** Push only a meet's sessions/squads (status/fields unchanged), and the
 *  resulting squad_id placements for that meet's registrations. */
export function pushMeetSessions(m: Meet, registrations: Registration[]) {
  remoteReplace('meet_sessions', { meet_id: m.id }, m.sessions.map((s) => sessionToRow(m.id, s)));
  for (const s of m.sessions) {
    remoteReplace('squads', { session_id: s.id }, s.squads.map((q, i) => squadToRow(s.id, q, i)));
  }
  const squadIds = squadIdsByReg(m);
  const meetRegs = registrations.filter((r) => r.meetId === m.id);
  remoteUpsert('registrations', meetRegs.map((r) => registrationToRow(r, squadIds.get(r.id) ?? null)));
}

export function pushRegistration(r: Registration, squadId: string | null = null) {
  remoteUpsert('registrations', [registrationToRow(r, squadId)]);
}
export function deleteRegistration(id: string) { remoteDelete('registrations', id); }

export function pushScore(s: Score) { remoteUpsert('scores', [scoreToRow(s)]); }

/** Replace an owner's (club or athlete) cart with the given items. Uses a
 *  delete-then-insert, so it's for the cart OWNER (club manager / the athlete). */
export function pushCart(ownerKey: string, items: DB['carts'][string], isClub: boolean) {
  const match = isClub ? { club_id: ownerKey } : { person_id: ownerKey };
  remoteReplace('cart_items', match, items.map((it) => cartItemToRow(ownerKey, it, isClub)));
}

/** Append ONE item to an owner's cart (no replace). Used when a member pushes
 *  their own fee to a club cart they don't manage — they can insert their own
 *  row (ref_user_id = self) but can't replace the whole club cart under RLS. */
export function pushCartItem(ownerKey: string, item: DB['carts'][string][number], isClub: boolean) {
  remoteUpsert('cart_items', [cartItemToRow(ownerKey, item, isClub)]);
}

export function pushInvoice(inv: Invoice) {
  remoteUpsert('invoices', [invoiceToRow(inv)]);
  remoteReplace('invoice_items', { invoice_id: inv.id }, inv.items.map((it) => invoiceItemToRow(inv.id, it)));
}

export function pushClubRequest(r: ClubRequest) { remoteUpsert('club_requests', [clubRequestToRow(r)]); }

/** Insert a new immutable waiver document version (admin only via RLS). */
export function pushWaiverDocument(d: WaiverDocument) {
  remoteUpsert('waiver_documents', [{
    id: d.id, season_id: d.seasonId, waiver_type: d.waiverType, version: d.version,
    body: d.body, content_hash: d.contentHash, published: d.published, created_at: d.createdAt,
  }]);
}

/** Persist the admin-edited state→region overrides (0007 app_settings). */
export function pushRegionOverrides(overrides: Record<string, Region>) {
  remoteUpsert('app_settings', [{ key: 'region_overrides', value: overrides, updated_at: new Date().toISOString() }], 'key');
}

/** Persist an account-setup invite (0007 account_invites). */
export function pushAccountInvite(inv: AccountInvite) {
  remoteUpsert('account_invites', [{
    id: inv.id, person_id: inv.personId, email: inv.email, token: inv.token,
    status: inv.status, created_at: inv.createdAt, accepted_at: inv.acceptedAt ?? null,
  }]);
}

/** Persist a sanction request (0008 sanction_requests). */
export function pushSanctionRequest(r: SanctionRequest) {
  remoteUpsert('sanction_requests', [{
    id: r.id, host_club_id: r.hostClubId, requester_person_id: r.requesterPersonId,
    event_kind: r.eventKind, status: r.status, payload: r.payload,
    submitted_at: r.submittedAt ?? null, deadline_at: r.deadlineAt ?? null,
    decided_at: r.decidedAt ?? null, created_meet_id: r.createdMeetId ?? null,
    sanction_id: r.sanctionId ?? null,
  }]);
}

/** Persist a sanction vote (0008 sanction_votes). */
export function pushSanctionVote(v: SanctionVote) {
  remoteUpsert('sanction_votes', [{
    id: v.id, request_id: v.requestId, voter_user_id: v.voterUserId, vote: v.vote,
    comment: v.comment ?? null, voted_at: v.votedAt,
  }], 'request_id,voter_user_id');
}

/** Add or remove a single person↔club manager link. */
export function pushClubManager(clubId: string, personId: string, add: boolean) {
  if (add) remoteUpsert('club_managers', [{ club_id: clubId, person_id: personId }], 'club_id,person_id');
  else remoteDeleteWhere('club_managers', { club_id: clubId, person_id: personId });
}

/** Add or remove a single person↔alternate-club link. */
export function pushAltClub(personId: string, clubId: string, add: boolean) {
  if (add) remoteUpsert('person_alt_clubs', [{ person_id: personId, club_id: clubId }], 'person_id,club_id');
  else remoteDeleteWhere('person_alt_clubs', { person_id: personId, club_id: clubId });
}

/** Grant or revoke an app role for an auth user (user_roles). */
export function pushUserRole(userId: string, role: string, grant: boolean) {
  if (grant) remoteUpsert('user_roles', [{ user_id: userId, role }], 'user_id,role');
  else remoteDeleteWhere('user_roles', { user_id: userId, role });
}

/** All user_roles rows — RLS returns every row for an admin, own rows otherwise.
 *  Used by the admin Members screen to reflect/manage admin grants. */
export async function fetchAllRoles(): Promise<{ userId: string; role: string }[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.from('user_roles').select('user_id, role');
  if (error) { console.error('[supabase] fetchAllRoles failed:', error); return []; }
  return (data ?? []).map((r: { user_id: string; role: string }) => ({ userId: r.user_id, role: r.role }));
}

/** Set (upsert) a regional representative's region. One region per user_id;
 *  conflict on user_id replaces. Admin-only at the RLS layer. */
export function setRegionalRepRegion(userId: string, region: string) {
  remoteUpsert('regional_rep_regions', [{ user_id: userId, region }], 'user_id');
}

/** All regional_rep_regions rows as { [user_id]: region }. RLS returns every row
 *  for an admin (own row otherwise). Returns {} on error, matching fetchAllRoles. */
export async function fetchRegionalRepRegions(): Promise<Record<string, string>> {
  if (!supabase) return {};
  const { data, error } = await supabase.from('regional_rep_regions').select('user_id, region');
  if (error) { console.error('[supabase] fetchRegionalRepRegions failed:', error); return {}; }
  const out: Record<string, string> = {};
  for (const r of (data ?? []) as { user_id: string; region: string }[]) out[r.user_id] = r.region;
  return out;
}

/** The signed-in user's app roles. Pass the known auth uid (from the session)
 *  to avoid a redundant getUser() round-trip; falls back to getUser() if omitted.
 *  RLS returns only the caller's own rows. */
export async function fetchMyRoles(uid?: string): Promise<string[]> {
  if (!supabase) return [];
  let userId = uid;
  if (!userId) {
    const { data: userData } = await supabase.auth.getUser();
    userId = userData.user?.id;
  }
  if (!userId) return [];
  const { data, error } = await supabase.from('user_roles').select('role').eq('user_id', userId);
  if (error) { console.error('[supabase] fetchMyRoles failed:', error); return []; }
  return (data ?? []).map((r: { role: string }) => r.role);
}

/** Link the signed-in auth user to an existing (claimed by verified email) or
 *  new person; returns the person id (text) or null when unconfigured/failed. */
export async function linkOrCreatePerson(first: string, last: string): Promise<string | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.rpc('link_or_create_person', { p_first: first, p_last: last });
  if (error) { console.error('[supabase] link_or_create_person failed:', error); return null; }
  return (data as string) ?? null;
}

/** Atomically record one redemption of a coupon (enforces max_uses server-side).
 *  Returns true when a redemption was counted. Best-effort: never throws. */
export async function redeemCoupon(code: string): Promise<boolean> {
  if (!supabase) return false;
  const { data, error } = await supabase.rpc('redeem_coupon', { p_code: code });
  if (error) { console.error('[supabase] redeem_coupon failed:', error); return false; }
  return data === true;
}

// ---------------------------------------------------------------------------
// Email — invoke the send-email Edge Function (Gmail SMTP for now)
// ---------------------------------------------------------------------------
export interface SendEmailResult {
  ok: boolean;
  sentCount: number;
  failedCount: number;
  failed?: { email: string; error: string }[];
  error?: string;
}

/** Send an HTML email to the given recipients via the send-email Edge Function.
 *  Caller must be a signed-in admin (the function re-checks the `admin` role).
 *  Returns `{ ok: false, error }` when unconfigured or on any failure. */
export async function sendEmail(
  subject: string,
  html: string,
  recipients: { email: string; name?: string }[],
): Promise<SendEmailResult> {
  if (!supabase) return { ok: false, sentCount: 0, failedCount: recipients.length, error: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('send-email', {
    body: { subject, html, recipients },
  });
  if (error) {
    // Edge errors carry the JSON body on the context response.
    let msg = error.message;
    try {
      const ctx = (error as { context?: Response }).context;
      if (ctx && typeof ctx.json === 'function') {
        const body = await ctx.json();
        if (body?.error) msg = body.error;
      }
    } catch { /* fall back to error.message */ }
    return { ok: false, sentCount: 0, failedCount: recipients.length, error: msg };
  }
  return data as SendEmailResult;
}

export interface SendSmsResult {
  ok: boolean;
  sentCount: number;
  failedCount: number;
  segments?: number;
  encoding?: 'GSM-7' | 'UCS-2';
  failed?: { phone: string; error: string }[];
  error?: string;
}

/** Send a text message to the given recipients via the send-sms Edge Function.
 *  Caller must be a signed-in admin (the function re-checks the `admin` role).
 *  Returns `{ ok: false, error }` when unconfigured or on any failure. */
export async function sendSms(
  body: string,
  recipients: { phone: string; name?: string }[],
): Promise<SendSmsResult> {
  if (!supabase) return { ok: false, sentCount: 0, failedCount: recipients.length, error: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('send-sms', {
    body: { body, recipients },
  });
  if (error) {
    // Edge errors carry the JSON body on the context response.
    let msg = error.message;
    try {
      const ctx = (error as { context?: Response }).context;
      if (ctx && typeof ctx.json === 'function') {
        const errBody = await ctx.json();
        if (errBody?.error) msg = errBody.error;
      }
    } catch { /* fall back to error.message */ }
    return { ok: false, sentCount: 0, failedCount: recipients.length, error: msg };
  }
  return data as SendSmsResult;
}

/** Unwrap an Edge Function invocation error: prefer the JSON `error` field the
 *  function returned (carried on the response context) over the generic
 *  "non-2xx status" message, so callers can surface the real reason. */
async function edgeErrorMessage(error: { message: string }): Promise<string> {
  let msg = error.message;
  try {
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === 'function') { const b = await ctx.json(); if (b?.error) msg = b.error; }
  } catch { /* fall back to error.message */ }
  return msg;
}

/** Notify a club's managers that items were pushed to their cart. Fire-and-forget
 *  from the caller's perspective — failures are non-fatal (the cart item still
 *  exists and shows on the managers' dashboard). Returns the function result. */
export async function notifyClubCart(args: {
  clubId: string;
  items: { label: string; amount: number }[];
  addedByName?: string;
}): Promise<{ ok: boolean; sentCount?: number; error?: string }> {
  if (!supabase) return { ok: false, error: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('notify-club-cart', { body: args });
  if (error) return { ok: false, error: await edgeErrorMessage(error) };
  return data as { ok: boolean; sentCount?: number; error?: string };
}

/** Send the "Welcome to UCG" email (CC'ing the member's regional team) after a
 *  no-club member's FIRST membership-only purchase. The CLIENT decides "first
 *  membership"; the function re-checks no-club + not-Outside-US server-side and
 *  sends nothing if either fails. Best-effort — never blocks the purchase UX.
 *  Pass nothing (or omit personId) to welcome the caller's own account. */
export async function sendMembershipWelcome(
  personId?: string,
): Promise<{ ok: boolean; sent?: boolean; error?: string }> {
  if (!supabase) return { ok: false, error: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('send-membership-welcome', {
    body: personId ? { personId } : {},
  });
  if (error) return { ok: false, error: await edgeErrorMessage(error) };
  return data as { ok: boolean; sent?: boolean; error?: string };
}

/** Invite someone to a club by email (coach invite or membership purchase).
 *  Caller must manage the club (the function re-checks). */
export async function sendClubInvite(args: {
  clubId: string;
  kind: 'coach' | 'membership';
  email: string;
  name?: string;
}): Promise<{ ok: boolean; sentCount?: number; error?: string }> {
  if (!supabase) return { ok: false, error: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('send-club-invite', { body: args });
  if (error) return { ok: false, error: await edgeErrorMessage(error) };
  return data as { ok: boolean; sentCount?: number; error?: string };
}

/** Create an account for someone (club manager / admin) and email them a
 *  set-password link. Caller must manage the club (the function re-checks). */
export async function inviteAccount(args: {
  clubId: string;
  email: string;
  firstName: string;
  lastName: string;
  kind?: 'athlete' | 'coach';
}): Promise<{ ok: boolean; sentCount?: number; error?: string }> {
  if (!supabase) return { ok: false, error: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('invite-account', { body: args });
  if (error) return { ok: false, error: await edgeErrorMessage(error) };
  return data as { ok: boolean; sentCount?: number; error?: string };
}

// ---------------------------------------------------------------------------
// Client error log — durable, admin-searchable record of front-end errors.
// ---------------------------------------------------------------------------
export interface ErrorLogRow {
  id: string; createdAt: string; email: string | null; personId: string | null;
  context: string | null; message: string; stack: string | null;
  detail: unknown; url: string | null; userAgent: string | null; appVersion: string | null;
}

/** Persist a reported client error (fire-and-forget; never throws). */
export async function logClientError(e: {
  message: string; stack?: string; context?: string; detail?: Record<string, unknown>;
}): Promise<void> {
  if (!supabase) return;
  try {
    const { data: u } = await supabase.auth.getUser();
    const email = u.user?.email ?? null;
    const personId = u.user
      ? (await supabase.from('people').select('id').eq('auth_user_id', u.user.id).maybeSingle()).data?.id ?? null
      : null;
    await supabase.from('error_logs').insert({
      person_id: personId, email, context: e.context ?? null,
      message: e.message?.slice(0, 2000) ?? '(no message)', stack: e.stack?.slice(0, 8000) ?? null,
      detail: e.detail ?? null, url: (typeof location !== 'undefined' ? location.hash : null),
      user_agent: (typeof navigator !== 'undefined' ? navigator.userAgent : null),
      app_version: (import.meta.env.VITE_APP_VERSION as string | undefined) ?? import.meta.env.MODE,
    });
  } catch { /* logging must never break the app */ }
}

/** Read recent client errors (admins only, via RLS). Optional text filter is
 *  applied client-side over email/message/context. */
export async function fetchErrorLogs(limit = 200): Promise<ErrorLogRow[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.from('error_logs').select('*').order('created_at', { ascending: false }).limit(limit);
  if (error) { console.error('[supabase] fetchErrorLogs failed:', error); return []; }
  return (data ?? []).map((r) => ({
    id: r.id, createdAt: r.created_at, email: r.email, personId: r.person_id, context: r.context,
    message: r.message, stack: r.stack, detail: r.detail, url: r.url, userAgent: r.user_agent, appVersion: r.app_version,
  }));
}

// ---------------------------------------------------------------------------
// Communication log — record + read sends from the Communicate tool.
// ---------------------------------------------------------------------------
export interface CommLogEntry {
  id?: string;
  sentAt?: string;
  channel: 'email' | 'sms';
  isTest: boolean;
  subject: string | null;
  body: string;
  recipientCount: number;
  sentCount: number | null;
  failedCount: number | null;
  recipients: { name: string; contact: string }[];
  error: string | null;
  /** SMS-only: segments per recipient, encoding, and estimated total cost (USD). */
  segments?: number | null;
  encoding?: string | null;
  costEstimate?: number | null;
}

/** Insert a comm-log row (best-effort; never throws). */
export async function logComm(entry: CommLogEntry): Promise<void> {
  if (!supabase) return;
  try {
    const { data: u } = await supabase.auth.getUser();
    const personId = u.user ? (await supabase.from('people').select('id').eq('auth_user_id', u.user.id).maybeSingle()).data?.id ?? null : null;
    await supabase.from('comm_log').insert({
      sender_person_id: personId,
      channel: entry.channel, is_test: entry.isTest, subject: entry.subject, body: entry.body,
      recipient_count: entry.recipientCount, sent_count: entry.sentCount, failed_count: entry.failedCount,
      recipients: entry.recipients, error: entry.error,
      segments: entry.segments ?? null, encoding: entry.encoding ?? null, cost_estimate: entry.costEstimate ?? null,
    });
  } catch (e) { console.error('[supabase] logComm failed:', e); }
}

/** The signed-in user's communication history (admins see all, via RLS). */
export async function fetchCommLog(limit = 100): Promise<(CommLogEntry & { id: string; sentAt: string })[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.from('comm_log').select('*').order('sent_at', { ascending: false }).limit(limit);
  if (error) { console.error('[supabase] fetchCommLog failed:', error); return []; }
  return (data ?? []).map((r) => ({
    id: r.id, sentAt: r.sent_at, channel: r.channel, isTest: r.is_test, subject: r.subject, body: r.body,
    recipientCount: r.recipient_count, sentCount: r.sent_count, failedCount: r.failed_count,
    recipients: (r.recipients ?? []) as { name: string; contact: string }[], error: r.error,
    segments: r.segments ?? null, encoding: r.encoding ?? null, costEstimate: r.cost_estimate ?? null,
  }));
}

export interface SmsMessage {
  id: string;
  direction: 'outbound' | 'inbound';
  phone: string;
  status: string | null;
  body: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Per-message SMS log (outbound delivery status + inbound replies). Admin-only via RLS. */
export async function fetchSmsMessages(limit = 200): Promise<SmsMessage[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.from('sms_messages').select('*').order('created_at', { ascending: false }).limit(limit);
  if (error) { console.error('[supabase] fetchSmsMessages failed:', error); return []; }
  return (data ?? []).map((r) => ({
    id: r.id, direction: r.direction, phone: r.phone, status: r.status, body: r.body,
    error: r.error, createdAt: r.created_at, updatedAt: r.updated_at,
  }));
}

/** Ask a club's managers + league admins for manager access. Email only. */
export async function requestManagerAccess(
  clubId: string,
): Promise<{ ok: boolean; sentCount?: number; error?: string }> {
  if (!supabase) return { ok: false, error: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('request-manager-access', { body: { clubId } });
  if (error) return { ok: false, error: await edgeErrorMessage(error) };
  return data as { ok: boolean; sentCount?: number; error?: string };
}

/** Sanction lifecycle email (submitted → team; approved/rejected → host). */
export async function notifySanction(args: {
  requestId: string;
  event: 'submitted' | 'approved' | 'rejected';
}): Promise<{ ok: boolean; sentCount?: number; error?: string }> {
  if (!supabase) return { ok: false, error: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('notify-sanction', { body: args });
  if (error) return { ok: false, error: await edgeErrorMessage(error) };
  return data as { ok: boolean; sentCount?: number; error?: string };
}

// ---------------------------------------------------------------------------
// Waiver — Edge Function invokers + public reads
// ---------------------------------------------------------------------------
export interface RecordSignatureArgs {
  personId: string; seasonId: string; waiverType: string; membershipType: string;
  waiverDocumentId: string; contentHash: string;
  signerName: string; signerEmail: string;
  signerRole: 'self' | 'guardian'; signerRelationship?: string;
  consent: boolean; token?: string;        // present for guardian path
}

/** Record a signature server-side (stamps real IP) + activate membership.
 *  Returns { ok } or { ok:false, error }. */
export async function recordWaiverSignature(
  args: RecordSignatureArgs,
): Promise<{ ok: boolean; pendingPayment?: boolean; error?: string }> {
  if (!supabase) return { ok: false, error: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('record-waiver-signature', { body: args });
  if (error) return { ok: false, error: await edgeErrorMessage(error) };
  return data as { ok: boolean; pendingPayment?: boolean; error?: string };
}

/** Create a guardian signing token and email the link. */
export async function requestGuardianWaiver(args: {
  personId: string; seasonId: string; waiverType: string; membershipType: string;
  guardianName: string; guardianEmail: string;
}): Promise<{ ok: boolean; error?: string }> {
  if (!supabase) return { ok: false, error: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('request-guardian-waiver', { body: args });
  if (error) return { ok: false, error: await edgeErrorMessage(error) };
  return data as { ok: boolean; error?: string };
}

/** No-login lookup of a manager-access request by its review token. */
export async function fetchManagerAccessRequest(token: string): Promise<{ status: string; requesterName: string; clubName: string } | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.rpc('get_manager_access_request', { p_token: token });
  if (error) { console.error('[supabase] get_manager_access_request failed:', error); return null; }
  const row = (data as { status: string; requester_name: string; club_name: string }[] | null)?.[0];
  return row ? { status: row.status, requesterName: row.requester_name, clubName: row.club_name } : null;
}

/** No-login approve/deny of a manager-access request. Returns the outcome:
 *  'approved' | 'denied' | 'already' | 'invalid' | 'error'. */
export async function decideManagerAccess(token: string, decision: 'approve' | 'deny', decider: string): Promise<string> {
  if (!supabase) return 'error';
  const { data, error } = await supabase.rpc('decide_manager_access', { p_token: token, p_decision: decision, p_decider: decider });
  if (error) { console.error('[supabase] decide_manager_access failed:', error); return 'error'; }
  return (data as string) ?? 'error';
}

/** No-login, token-gated denial notification: emails the requester that their
 *  Club Admin request was not approved. Recipients are resolved server-side from
 *  the token (the reviewer page is anonymous), so no auth/admin gate is needed. */
export async function notifyManagerAccessDenied(token: string): Promise<{ ok: boolean; sentCount?: number; error?: string }> {
  if (!supabase) return { ok: false, error: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('notify-manager-access-denied', { body: { token } });
  if (error) return { ok: false, error: await edgeErrorMessage(error) };
  return data as { ok: boolean; sentCount?: number; error?: string };
}

/** Admin/club-manager mints a no-login waiver signing link for a member (tied to
 *  their athlete record). Returns the link to email and/or copy. */
export async function createWaiverLink(args: {
  personId: string; seasonId: string; waiverType: string; membershipType?: string;
  signerRole?: 'self' | 'guardian';
}): Promise<{ ok: boolean; token?: string; link?: string; signerRole?: 'self' | 'guardian'; error?: string }> {
  if (!supabase) return { ok: false, error: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('create-waiver-link', { body: args });
  if (error) return { ok: false, error: await edgeErrorMessage(error) };
  return data as { ok: boolean; token?: string; link?: string; signerRole?: 'self' | 'guardian'; error?: string };
}

/** Token lookup for the guardian signing page via SECURITY DEFINER RPC
 *  (the table itself is not publicly readable). */
export async function fetchSignRequest(token: string): Promise<FnReturns<'get_waiver_sign_request'>[number] | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.rpc('get_waiver_sign_request', { p_token: token });
  if (error) { console.error('[supabase] fetchSignRequest failed:', error); return null; }
  return (data as FnReturns<'get_waiver_sign_request'> | null)?.[0] ?? null;
}

/** The published waiver doc for a season+type (latest published version). */
export async function fetchPublishedWaiver(seasonId: string, waiverType: string) {
  if (!supabase) return null;
  const { data, error } = await supabase.from('waiver_documents')
    .select('*').eq('season_id', seasonId).eq('waiver_type', waiverType)
    .eq('published', true).order('version', { ascending: false }).limit(1).maybeSingle();
  if (error) { console.error('[supabase] fetchPublishedWaiver failed:', error); return null; }
  return data ? rowToWaiverDocument(data) : null;
}

// ---------------------------------------------------------------------------
// loadAll — hydrate the in-memory DB shape from Supabase on boot
// ---------------------------------------------------------------------------
export async function loadAll(): Promise<DB | null> {
  if (!supabase) return null;
  try {
    const [
      seasonsR, levelsR, clubsR, clubManagersR, peopleR, altClubsR, membershipsR,
      meetsR, sessionsR, squadsR, registrationsR, scoresR, couponsR, cartItemsR, invoicesR, invoiceItemsR,
      clubRequestsR, appSettingsR, accountInvitesR, sanctionRequestsR, sanctionVotesR,
      waiverDocsR, waiverSigsR, clubMembershipsR,
    ] = await Promise.all([
      supabase.from('seasons').select('*'),
      supabase.from('levels').select('*'),
      supabase.from('clubs').select('*'),
      supabase.from('club_managers').select('*'),
      fetchAllRows<Row<'people'>>('people'),
      supabase.from('person_alt_clubs').select('*'),
      supabase.from('memberships').select('*'),
      supabase.from('meets').select('*'),
      supabase.from('meet_sessions').select('*'),
      supabase.from('squads').select('*'),
      supabase.from('registrations').select('*'),
      supabase.from('scores').select('*'),
      supabase.from('coupons').select('*'),
      supabase.from('cart_items').select('*'),
      supabase.from('invoices').select('*'),
      supabase.from('invoice_items').select('*'),
      supabase.from('club_requests').select('*'),
      supabase.from('app_settings').select('*'),       // 0007; tolerated if absent
      supabase.from('account_invites').select('*'),     // 0007; tolerated if absent
      supabase.from('sanction_requests').select('*'),   // 0008; tolerated if absent
      supabase.from('sanction_votes').select('*'),      // 0008; tolerated if absent
      supabase.from('waiver_documents').select('*'),    // tolerated if absent
      supabase.from('waiver_signatures').select('*'),   // tolerated if absent
      supabase.from('club_memberships').select('*'),    // tolerated if absent
    ]);

    // club_requests may not exist on a pre-0005 DB — tolerate its error, fail on the rest.
    const errors = [
      seasonsR, levelsR, clubsR, clubManagersR, peopleR, altClubsR, membershipsR,
      meetsR, sessionsR, squadsR, registrationsR, scoresR, couponsR, cartItemsR, invoicesR, invoiceItemsR,
    ].map((r) => r.error).filter(Boolean);
    if (errors.length) { console.error('[supabase] loadAll failed:', errors); return null; }

    const seasons = (seasonsR.data ?? []).map(rowToSeason);
    const levels = (levelsR.data ?? []).map(rowToLevel);
    const coupons = (couponsR.data ?? []).map(rowToCoupon);

    const managersByClub = new Map<string, string[]>();
    for (const r of clubManagersR.data ?? []) {
      const arr = managersByClub.get(r.club_id) ?? [];
      arr.push(r.person_id);
      managersByClub.set(r.club_id, arr);
    }
    const clubs: Club[] = (clubsR.data ?? []).map((r) => ({ ...rowToClub(r), managerIds: managersByClub.get(r.id) ?? [] }));

    const altClubsByPerson = new Map<string, string[]>();
    for (const r of altClubsR.data ?? []) {
      const arr = altClubsByPerson.get(r.person_id) ?? [];
      arr.push(r.club_id);
      altClubsByPerson.set(r.person_id, arr);
    }
    const membershipsByPerson = new Map<string, Membership[]>();
    for (const r of membershipsR.data ?? []) {
      const arr = membershipsByPerson.get(r.person_id) ?? [];
      arr.push(rowToMembership(r));
      membershipsByPerson.set(r.person_id, arr);
    }
    const people: Athlete[] = (peopleR.data ?? []).map((r: Row<'people'>) => ({
      id: r.id, authUserId: r.auth_user_id ?? null, kind: r.kind as Athlete['kind'],
      roles: (r.roles ?? { athlete: r.kind !== 'coach', coach: r.kind === 'coach' }) as Athlete['roles'],
      firstName: r.first_name, lastName: r.last_name, email: r.email,
      dob: r.dob ?? '', gender: r.gender as Athlete['gender'], placement: (r.placement ?? {}) as Athlete['placement'], gradYear: r.grad_year ?? 1900,
      studentStatus: r.student_status as Athlete['studentStatus'], shirt: r.shirt ?? '', country: r.country ?? '', state: r.state ?? '',
      outsideUs: (r as { outside_us?: boolean }).outside_us ?? false,
      phone: r.phone ?? '', smsConsent: r.sms_consent ?? false, smsConsentAt: r.sms_consent_at ?? null,
      mainClubId: r.main_club_id, altClubIds: altClubsByPerson.get(r.id) ?? [],
      levels: (r.levels ?? {}) as Athlete['levels'], emergency: (r.emergency ?? { contact: '', relation: '', phone: '' }) as Athlete['emergency'],
      dietary: (r.dietary ?? []) as Athlete['dietary'], dietaryNotes: r.dietary_notes ?? '',
      memberships: membershipsByPerson.get(r.id) ?? [], achievements: (r.achievements ?? []) as Athlete['achievements'],
    }));

    const squadsBySession = new Map<string, Meet['sessions'][number]['squads']>();
    for (const r of (squadsR.data ?? []).sort((a: Row<'squads'>, b: Row<'squads'>) => a.sort_order - b.sort_order)) {
      const arr = squadsBySession.get(r.session_id) ?? [];
      arr.push({ id: r.id, name: r.name, startEvent: r.start_event, athleteRegIds: [], holding: r.holding });
      squadsBySession.set(r.session_id, arr);
    }
    // Place registrations into squads via registrations.squad_id
    const squadById = new Map<string, Meet['sessions'][number]['squads'][number]>();
    for (const arr of squadsBySession.values()) for (const q of arr) squadById.set(q.id, q);
    for (const r of registrationsR.data ?? []) {
      if (r.squad_id && squadById.has(r.squad_id)) squadById.get(r.squad_id)!.athleteRegIds.push(r.id);
    }

    const sessionsByMeet = new Map<string, Meet['sessions']>();
    for (const r of (sessionsR.data ?? []).sort((a: Row<'meet_sessions'>, b: Row<'meet_sessions'>) => a.sort_order - b.sort_order)) {
      const arr = sessionsByMeet.get(r.meet_id) ?? [];
      arr.push({
        id: r.id, name: r.name, discipline: r.discipline, date: r.date ?? '', time: r.time ?? '',
        levelIds: r.level_ids ?? [], squads: squadsBySession.get(r.id) ?? [],
        ...(r.phase ? { phase: r.phase } : {}),
      });
      sessionsByMeet.set(r.meet_id, arr);
    }

    const meets: Meet[] = (meetsR.data ?? []).map((r: Row<'meets'>) => ({
      id: r.id, slug: r.slug, name: r.name, hostClubId: r.host_club_id ?? '', city: r.city ?? '',
      state: r.state ?? '', timezone: r.timezone, startDate: r.start_date ?? '', endDate: r.end_date ?? '',
      status: r.status as Meet['status'], regOpens: r.reg_opens ?? '', regCloses: r.reg_closes ?? '',
      entryFee: Number(r.entry_fee), secondDisciplineFee: Number(r.second_discipline_fee),
      disciplines: (r.disciplines ?? []) as Meet['disciplines'], sessions: sessionsByMeet.get(r.id) ?? [],
      ...(r.private_reg_code ? { privateRegCode: r.private_reg_code } : {}),
      ...(r.banquet ? { banquet: r.banquet as Meet['banquet'] } : {}),
      ...(r.tshirt_addon ? { tshirtAddon: r.tshirt_addon as Meet['tshirtAddon'] } : {}),
      ...(r.banner_addon ? { bannerAddon: r.banner_addon as Meet['bannerAddon'] } : {}),
      ...(r.change_fee ? { changeFee: r.change_fee as Meet['changeFee'] } : {}),
      ...(r.event_type && r.event_type !== 'competition' ? { eventType: r.event_type as Meet['eventType'] } : {}),
      ...(r.sanction_id ? { sanctionId: r.sanction_id } : {}),
      ...(r.camp_config ? { campConfig: r.camp_config as Meet['campConfig'] } : {}),
      ...(r.kind && r.kind !== 'standard' ? { kind: r.kind as Meet['kind'] } : {}),
      ...(r.nationals_config ? { nationalsConfig: r.nationals_config as unknown as Meet['nationalsConfig'] } : {}),
    }));

    const registrations: Registration[] = (registrationsR.data ?? []).map(rowToRegistration);
    const scores: Score[] = (scoresR.data ?? []).map(rowToScore);

    const itemsByInvoice = new Map<string, Invoice['items']>();
    for (const r of invoiceItemsR.data ?? []) {
      const arr = itemsByInvoice.get(r.invoice_id) ?? [];
      arr.push({ id: r.id, label: r.label, amount: Number(r.amount), kind: r.kind, refUserId: r.ref_user_id ?? undefined, refunded: r.refunded });
      itemsByInvoice.set(r.invoice_id, arr);
    }
    const invoices: Invoice[] = (invoicesR.data ?? []).map((r: Row<'invoices'>) => ({
      id: r.id, number: r.number, clubId: r.club_id, athleteId: r.athlete_id,
      createdAt: r.created_at, paidAt: r.paid_at, items: itemsByInvoice.get(r.id) ?? [],
      ...(r.coupon_code ? { couponCode: r.coupon_code } : {}),
    }));

    const carts: DB['carts'] = {};
    for (const r of cartItemsR.data ?? []) {
      const ownerKey = r.club_id ?? r.person_id;
      if (!ownerKey) continue;
      const arr = carts[ownerKey] ?? (carts[ownerKey] = []);
      arr.push({ id: r.id, label: r.label, amount: Number(r.amount), kind: r.kind, refUserId: r.ref_user_id ?? undefined,
        refSeasonId: (r as { ref_season_id?: string | null }).ref_season_id ?? undefined,
        refType: ((r as { ref_type?: string | null }).ref_type ?? undefined) as MembershipType | 'club' | undefined });
    }

    const clubRequests: ClubRequest[] = (clubRequestsR.error ? [] : clubRequestsR.data ?? []).map(rowToClubRequest);

    // 0007 tables — tolerate absence (pre-migration) by checking .error.
    const regionOverridesRow = (appSettingsR.error ? [] : appSettingsR.data ?? [])
      .find((r: Row<'app_settings'>) => r.key === 'region_overrides');
    const regionOverrides = (regionOverridesRow?.value ?? undefined) as DB['regionOverrides'];
    const accountInvites: AccountInvite[] = (accountInvitesR.error ? [] : accountInvitesR.data ?? [])
      .map((r: Row<'account_invites'>): AccountInvite => ({
        id: r.id, personId: r.person_id ?? null, email: r.email, token: r.token,
        status: r.status as AccountInvite['status'], createdAt: r.created_at, acceptedAt: r.accepted_at ?? null,
      }));

    const sanctionRequests: SanctionRequest[] = (sanctionRequestsR.error ? [] : sanctionRequestsR.data ?? [])
      .map((r: Row<'sanction_requests'>): SanctionRequest => ({
        id: r.id, hostClubId: r.host_club_id ?? '', requesterPersonId: r.requester_person_id ?? null,
        eventKind: (r.event_kind ?? 'competition') as SanctionRequest['eventKind'], status: r.status as SanctionRequest['status'], payload: (r.payload ?? {}) as SanctionRequest['payload'],
        submittedAt: r.submitted_at ?? null, deadlineAt: r.deadline_at ?? null,
        decidedAt: r.decided_at ?? null, createdMeetId: r.created_meet_id ?? null,
        sanctionId: r.sanction_id ?? null,
      }));
    const sanctionVotes: SanctionVote[] = (sanctionVotesR.error ? [] : sanctionVotesR.data ?? [])
      .map((r: Row<'sanction_votes'>): SanctionVote => ({
        id: r.id, requestId: r.request_id, voterUserId: r.voter_user_id, vote: r.vote as SanctionVote['vote'],
        comment: r.comment ?? undefined, votedAt: r.voted_at,
      }));

    const waiverDocuments: WaiverDocument[] = (waiverDocsR.error ? [] : waiverDocsR.data ?? [])
      .map(rowToWaiverDocument);
    const waiverSignatures: WaiverSignature[] = (waiverSigsR.error ? [] : waiverSigsR.data ?? [])
      .map(rowToWaiverSignature);
    const clubMemberships: ClubMembership[] = (clubMembershipsR.error ? [] : clubMembershipsR.data ?? [])
      .map(rowToClubMembership);

    return {
      seasons, levels, clubs, people, meets, registrations, scores, invoices, coupons,
      carts, clubRequests,
      ...(regionOverrides ? { regionOverrides } : {}),
      ...(accountInvites.length ? { accountInvites } : {}),
      ...(sanctionRequests.length ? { sanctionRequests } : {}),
      ...(sanctionVotes.length ? { sanctionVotes } : {}),
      ...(waiverDocuments.length ? { waiverDocuments } : {}),
      ...(waiverSignatures.length ? { waiverSignatures } : {}),
      ...(clubMemberships.length ? { clubMemberships } : {}),
    };
  } catch (e) {
    console.error('[supabase] loadAll threw:', e);
    return null;
  }
}

/** Push every table of a local DB snapshot to Supabase — used by the admin
 *  "Push local DB → Supabase" seed tool. Runs as the signed-in user under RLS. */
export async function pushAll(db: DB, onProgress?: (label: string) => void): Promise<void> {
  if (!supabase) return;
  const step = async (label: string, fn: () => PromiseLike<{ error: unknown }> | undefined) => {
    onProgress?.(label);
    const r = fn();
    if (r) {
      const { error } = await r;
      if (error) throw new Error(`${label}: ${JSON.stringify(error)}`);
    }
  };

  await step('Seasons', () => supabase!.from('seasons').upsert(db.seasons.map(seasonToRow)));
  await step('Levels', () => supabase!.from('levels').upsert(db.levels.map(levelToRow)));
  await step('Coupons', () => db.coupons.length ? supabase!.from('coupons').upsert(db.coupons.map(couponToRow)) : undefined);
  await step('Clubs', () => supabase!.from('clubs').upsert(db.clubs.map(clubToRow)));
  for (const part of chunk(db.people)) {
    await step('People', () => supabase!.from('people').upsert(part.map(personToRow)));
  }
  // after people: club_managers.person_id references people
  await step('Club managers', () => {
    const rows = db.clubs.flatMap((c) => c.managerIds.map((personId) => ({ club_id: c.id, person_id: personId })));
    return rows.length ? supabase!.from('club_managers').upsert(rows) : undefined;
  });
  await step('Alt clubs', () => {
    const rows = db.people.flatMap((p) => p.altClubIds.map((clubId) => ({ person_id: p.id, club_id: clubId })));
    return rows.length ? supabase!.from('person_alt_clubs').upsert(rows) : undefined;
  });
  await step('Memberships', () => {
    const rows = db.people.flatMap((p) => p.memberships.map((m) => membershipToRow(p.id, m)));
    return rows.length ? supabase!.from('memberships').upsert(rows, { onConflict: 'person_id,season_id' }) : undefined;
  });
  await step('Meets', () => supabase!.from('meets').upsert(db.meets.map(meetToRow)));
  await step('Meet sessions', () => {
    const rows = db.meets.flatMap((m) => m.sessions.map((s) => sessionToRow(m.id, s)));
    return rows.length ? supabase!.from('meet_sessions').upsert(rows) : undefined;
  });
  await step('Squads', () => {
    const rows = db.meets.flatMap((m) => m.sessions.flatMap((s) => s.squads.map((q, i) => squadToRow(s.id, q, i))));
    return rows.length ? supabase!.from('squads').upsert(rows) : undefined;
  });
  const squadIdsByMeet = new Map(db.meets.map((m) => [m.id, squadIdsByReg(m)]));
  for (const part of chunk(db.registrations)) {
    await step('Registrations', () => supabase!.from('registrations').upsert(
      part.map((r) => registrationToRow(r, squadIdsByMeet.get(r.meetId)?.get(r.id) ?? null)),
    ));
  }
  for (const part of chunk(db.scores)) {
    await step('Scores', () => supabase!.from('scores').upsert(part.map(scoreToRow)));
  }
  await step('Carts', () => {
    const clubIds = new Set(db.clubs.map((c) => c.id));
    const rows = Object.entries(db.carts).flatMap(([ownerKey, items]) =>
      items.map((it) => cartItemToRow(ownerKey, it, clubIds.has(ownerKey))));
    return rows.length ? supabase!.from('cart_items').upsert(rows) : undefined;
  });
  await step('Invoices', () => db.invoices.length ? supabase!.from('invoices').upsert(db.invoices.map(invoiceToRow)) : undefined);
  await step('Invoice items', () => {
    const rows = db.invoices.flatMap((inv) => inv.items.map((it) => invoiceItemToRow(inv.id, it)));
    return rows.length ? supabase!.from('invoice_items').upsert(rows) : undefined;
  });
  await step('Club requests', () => db.clubRequests.length
    ? supabase!.from('club_requests').upsert(db.clubRequests.map(clubRequestToRow)) : undefined);
  onProgress?.('Done');
}

/** Realtime wiring for live results: subscribes to score changes for a meet.
 *  `onChange` receives the raw postgres_changes payload — use
 *  `applyScorePatch` to accumulate it into a patch map. */
export function subscribeMeetScores(
  meetId: string,
  onChange: (payload: RealtimePostgresChangesPayload<Row<'scores'>>) => void,
): () => void {
  if (!supabase) return () => {};
  const channel = supabase
    .channel(`scores:${meetId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'scores', filter: `meet_id=eq.${meetId}` }, onChange)
    .subscribe();
  return () => { supabase.removeChannel(channel); };
}

/** Accumulate a scores-table realtime change into a patch map
 *  (id → Score for insert/update, id → null for delete). Callers overlay the
 *  patches onto the store's scores at render time, so a store refresh
 *  (loadAll / local mutate) is reconciled automatically. */
export function applyScorePatch(
  patches: ReadonlyMap<string, Score | null>,
  payload: RealtimePostgresChangesPayload<Row<'scores'>>,
): Map<string, Score | null> {
  const next = new Map(patches);
  if (payload.eventType === 'DELETE') {
    const oldId = (payload.old as Partial<Row<'scores'>> | null)?.id;
    if (oldId != null) next.set(oldId, null);
    return next;
  }
  const updated = rowToScore(payload.new as Row<'scores'>);
  next.set(updated.id, updated);
  return next;
}
