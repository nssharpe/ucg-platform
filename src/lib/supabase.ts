// Supabase client + repository — wired up against supabase/migrations/0001_schema.sql.
//
// Write-through model: the in-memory store (src/lib/store.ts) stays the source
// of truth for the UI. Every mutation call site keeps its local `mutate()` and
// additionally fires one of the `push*` helpers below to mirror the change to
// Supabase. All writes are fire-and-forget (console.error on failure, never
// block the UI) and are no-ops when `isSupabaseConfigured` is false.
import { createClient, type SupabaseClient, type RealtimePostgresChangesPayload, type PostgrestError } from '@supabase/supabase-js';
import type {
  AccountInvite, Athlete, Club, ClubRequest, Coupon, DB, Invoice, Level, Meet, Membership, Region, Registration, SanctionRequest, SanctionVote, Score, Season,
  WaiverDocument, WaiverSignature,
} from './types';

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
async function fetchAllRows(table: string): Promise<{ data: any[]; error: PostgrestError | null }> {
  const out: any[] = [];
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

/** Fire-and-forget upsert, chunked for arrays >500 rows. */
function remoteUpsert(table: string, rows: Record<string, unknown>[], onConflict?: string) {
  if (!supabase || rows.length === 0) return;
  for (const part of chunk(rows)) {
    const q = onConflict ? { onConflict } : undefined;
    supabase.from(table).upsert(part, q).then(({ error }) => {
      if (error) console.error(`[supabase] upsert ${table} failed:`, error);
    });
  }
}

/** Fire-and-forget delete by primary key. */
function remoteDelete(table: string, id: string, column = 'id') {
  if (!supabase) return;
  supabase.from(table).delete().eq(column, id).then(({ error }) => {
    if (error) console.error(`[supabase] delete ${table} failed:`, error);
  });
}

/** Fire-and-forget delete-all-then-insert for a small child collection. */
function remoteReplace(table: string, match: Record<string, unknown>, rows: Record<string, unknown>[]) {
  if (!supabase) return;
  (async () => {
    let del = supabase!.from(table).delete();
    for (const [k, v] of Object.entries(match)) del = del.eq(k, v);
    const { error: delErr } = await del;
    if (delErr) { console.error(`[supabase] replace(delete) ${table} failed:`, delErr); return; }
    if (rows.length === 0) return;
    for (const part of chunk(rows)) {
      const { error } = await supabase!.from(table).insert(part);
      if (error) console.error(`[supabase] replace(insert) ${table} failed:`, error);
    }
  })();
}

// ---------------------------------------------------------------------------
// Row mappers — DB row (snake_case, matches 0001_schema.sql) <-> TS shape
// ---------------------------------------------------------------------------
const seasonToRow = (s: Season) => ({
  id: s.id, name: s.name, starts_on: s.startsOn, ends_on: s.endsOn,
  athlete_fee: s.athleteFee, coach_fee: s.coachFee, club_fee: s.clubFee,
  active: s.active, current: s.current,
});
const rowToSeason = (r: any): Season => ({
  id: r.id, name: r.name, startsOn: r.starts_on, endsOn: r.ends_on,
  athleteFee: Number(r.athlete_fee), coachFee: Number(r.coach_fee),
  clubFee: r.club_fee == null ? 109 : Number(r.club_fee),
  active: r.active, current: r.current,
});

const levelToRow = (l: Level) => ({
  id: l.id, discipline: l.discipline, name: l.name, sv_max: l.svMax, vaults: l.vaults,
  sort_order: l.order, retired: l.retired ?? false,
});
const rowToLevel = (r: any): Level => ({
  id: r.id, discipline: r.discipline, name: r.name,
  svMax: r.sv_max == null ? null : Number(r.sv_max), vaults: r.vaults, order: r.sort_order,
  ...(r.retired ? { retired: true } : {}),
});

const clubToRow = (c: Club) => ({
  id: c.id, name: c.name, short_name: c.shortName, state: c.state, region: c.region,
  email: c.email, allow_club_pay: c.allowClubPay, access: c.access ?? 'open',
});
const rowToClub = (r: any): Club => ({
  id: r.id, name: r.name, shortName: r.short_name, state: r.state ?? '', region: r.region ?? 'Other',
  managerIds: [], email: r.email ?? '', allowClubPay: r.allow_club_pay, access: r.access ?? 'open',
});

const couponToRow = (c: Coupon) => ({
  code: c.code, pct_off: c.pctOff ?? null, amount_off: c.amountOff ?? null, applies_to: c.appliesTo,
  starts_at: c.startsAt ?? null, ends_at: c.endsAt ?? null,
  max_uses: c.maxUses ?? null, used_count: c.usedCount ?? 0,
});
const rowToCoupon = (r: any): Coupon => ({
  code: r.code, pctOff: r.pct_off == null ? undefined : Number(r.pct_off),
  amountOff: r.amount_off == null ? undefined : Number(r.amount_off), appliesTo: r.applies_to,
  startsAt: r.starts_at ?? null, endsAt: r.ends_at ?? null,
  maxUses: r.max_uses == null ? null : Number(r.max_uses),
  usedCount: r.used_count == null ? 0 : Number(r.used_count),
});

const personToRow = (p: Athlete) => ({
  id: p.id, kind: p.kind,
  roles: p.roles ?? { athlete: p.kind !== 'coach', coach: p.kind === 'coach' },
  first_name: p.firstName, last_name: p.lastName, email: p.email,
  dob: p.dob || null, gender: p.gender, placement: p.placement ?? {}, grad_year: p.gradYear,
  student_status: p.studentStatus, shirt: p.shirt, country: p.country, state: p.state,
  phone: p.phone, main_club_id: p.mainClubId, levels: p.levels ?? {},
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
});
const rowToMembership = (r: any): Membership => ({
  seasonId: r.season_id, type: r.type ?? 'athlete', status: r.status, waiverSignedAt: r.waiver_signed_at,
  waiverSignedBy: r.waiver_signed_by, paidVia: r.paid_via, activatedByAdmin: r.activated_by_admin,
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
  level_id: r.levelId, events: r.events, session_id: r.sessionId, squad_id: squadId,
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
const rowToRegistration = (r: any): Registration => ({
  id: r.id, meetId: r.meet_id, athleteId: r.athlete_id, clubId: r.club_id, discipline: r.discipline,
  levelId: r.level_id, events: r.events ?? [], sessionId: r.session_id,
  refunded: r.refunded, keepListed: r.keep_listed,
  ...(r.refund_requested ? { refundRequested: true } : {}),
  ...(r.partner_athlete_id ? { partnerAthleteId: r.partner_athlete_id } : {}),
  ...(r.event_levels ? { eventLevels: r.event_levels } : {}),
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
export const rowToScore = (r: any): Score => ({
  id: r.id, meetId: r.meet_id, sessionId: r.session_id, regId: r.reg_id, event: r.event,
  sv: r.sv == null ? null : Number(r.sv), deductions: r.deductions == null ? null : Number(r.deductions),
  eScore: r.e_score == null ? null : Number(r.e_score), final: r.final == null ? null : Number(r.final),
  source: r.source, enteredBy: r.entered_by, enteredAt: r.entered_at, flashed: r.flashed,
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
const rowToClubRequest = (r: any): ClubRequest => ({
  id: r.id, requesterPersonId: r.requester_person_id ?? null, proposedName: r.proposed_name,
  shortName: r.short_name ?? '', state: r.state ?? '', region: r.region ?? '', note: r.note ?? '',
  status: r.status, createdAt: r.created_at, decidedAt: r.decided_at, createdClubId: r.created_club_id,
});

const rowToWaiverDocument = (r: any): WaiverDocument => ({
  id: r.id, seasonId: r.season_id, waiverType: r.waiver_type, version: r.version,
  body: r.body, contentHash: r.content_hash, published: r.published, createdAt: r.created_at,
});
const rowToWaiverSignature = (r: any): WaiverSignature => ({
  id: r.id, personId: r.person_id, seasonId: r.season_id, waiverType: r.waiver_type,
  waiverDocumentId: r.waiver_document_id, contentHash: r.content_hash,
  signerName: r.signer_name, signerEmail: r.signer_email, signerRole: r.signer_role,
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

export function pushClub(c: Club) {
  remoteUpsert('clubs', [clubToRow(c)]);
  remoteReplace('club_managers', { club_id: c.id }, c.managerIds.map((personId) => ({ club_id: c.id, person_id: personId })));
}

export function pushPerson(p: Athlete) {
  remoteUpsert('people', [personToRow(p)]);
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

/** Replace an owner's (club or athlete) cart with the given items. */
export function pushCart(ownerKey: string, items: DB['carts'][string], isClub: boolean) {
  const match = isClub ? { club_id: ownerKey } : { person_id: ownerKey };
  remoteReplace('cart_items', match, items.map((it) => cartItemToRow(ownerKey, it, isClub)));
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
  if (!supabase) return;
  if (add) remoteUpsert('club_managers', [{ club_id: clubId, person_id: personId }], 'club_id,person_id');
  else supabase.from('club_managers').delete().eq('club_id', clubId).eq('person_id', personId)
    .then(({ error }) => { if (error) console.error('[supabase] delete club_managers failed:', error); });
}

/** Add or remove a single person↔alternate-club link. */
export function pushAltClub(personId: string, clubId: string, add: boolean) {
  if (!supabase) return;
  if (add) remoteUpsert('person_alt_clubs', [{ person_id: personId, club_id: clubId }], 'person_id,club_id');
  else supabase.from('person_alt_clubs').delete().eq('person_id', personId).eq('club_id', clubId)
    .then(({ error }) => { if (error) console.error('[supabase] delete person_alt_clubs failed:', error); });
}

/** Grant or revoke an app role for an auth user (user_roles). */
export function pushUserRole(userId: string, role: string, grant: boolean) {
  if (!supabase) return;
  if (grant) remoteUpsert('user_roles', [{ user_id: userId, role }], 'user_id,role');
  else supabase.from('user_roles').delete().eq('user_id', userId).eq('role', role)
    .then(({ error }) => { if (error) console.error('[supabase] delete user_roles failed:', error); });
}

/** All user_roles rows — RLS returns every row for an admin, own rows otherwise.
 *  Used by the admin Members screen to reflect/manage admin grants. */
export async function fetchAllRoles(): Promise<{ userId: string; role: string }[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.from('user_roles').select('user_id, role');
  if (error) { console.error('[supabase] fetchAllRoles failed:', error); return []; }
  return (data ?? []).map((r: { user_id: string; role: string }) => ({ userId: r.user_id, role: r.role }));
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
): Promise<{ ok: boolean; error?: string }> {
  if (!supabase) return { ok: false, error: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('record-waiver-signature', { body: args });
  if (error) return { ok: false, error: error.message };
  return data as { ok: boolean; error?: string };
}

/** Create a guardian signing token and email the link. */
export async function requestGuardianWaiver(args: {
  personId: string; seasonId: string; waiverType: string; membershipType: string;
  guardianName: string; guardianEmail: string;
}): Promise<{ ok: boolean; error?: string }> {
  if (!supabase) return { ok: false, error: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('request-guardian-waiver', { body: args });
  if (error) return { ok: false, error: error.message };
  return data as { ok: boolean; error?: string };
}

/** Public token lookup for the guardian signing page (RLS: select=true). */
export async function fetchSignRequest(token: string) {
  if (!supabase) return null;
  const { data, error } = await supabase.from('waiver_sign_requests')
    .select('*').eq('token', token).maybeSingle();
  if (error) { console.error('[supabase] fetchSignRequest failed:', error); return null; }
  return data;
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
      waiverDocsR, waiverSigsR,
    ] = await Promise.all([
      supabase.from('seasons').select('*'),
      supabase.from('levels').select('*'),
      supabase.from('clubs').select('*'),
      supabase.from('club_managers').select('*'),
      fetchAllRows('people'),
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
    const people: Athlete[] = (peopleR.data ?? []).map((r: any) => ({
      id: r.id, authUserId: r.auth_user_id ?? null, kind: r.kind,
      roles: r.roles ?? { athlete: r.kind !== 'coach', coach: r.kind === 'coach' },
      firstName: r.first_name, lastName: r.last_name, email: r.email,
      dob: r.dob ?? '', gender: r.gender, placement: r.placement ?? {}, gradYear: r.grad_year,
      studentStatus: r.student_status, shirt: r.shirt ?? '', country: r.country ?? '', state: r.state ?? '',
      phone: r.phone ?? '', mainClubId: r.main_club_id, altClubIds: altClubsByPerson.get(r.id) ?? [],
      levels: r.levels ?? {}, emergency: r.emergency ?? { contact: '', relation: '', phone: '' },
      dietary: r.dietary ?? [], dietaryNotes: r.dietary_notes ?? '',
      memberships: membershipsByPerson.get(r.id) ?? [], achievements: r.achievements ?? [],
    }));

    const squadsBySession = new Map<string, Meet['sessions'][number]['squads']>();
    for (const r of (squadsR.data ?? []).sort((a: any, b: any) => a.sort_order - b.sort_order)) {
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
    for (const r of (sessionsR.data ?? []).sort((a: any, b: any) => a.sort_order - b.sort_order)) {
      const arr = sessionsByMeet.get(r.meet_id) ?? [];
      arr.push({
        id: r.id, name: r.name, discipline: r.discipline, date: r.date ?? '', time: r.time ?? '',
        levelIds: r.level_ids ?? [], squads: squadsBySession.get(r.id) ?? [],
        ...(r.phase ? { phase: r.phase } : {}),
      });
      sessionsByMeet.set(r.meet_id, arr);
    }

    const meets: Meet[] = (meetsR.data ?? []).map((r: any) => ({
      id: r.id, slug: r.slug, name: r.name, hostClubId: r.host_club_id ?? '', city: r.city ?? '',
      state: r.state ?? '', timezone: r.timezone, startDate: r.start_date ?? '', endDate: r.end_date ?? '',
      status: r.status, regOpens: r.reg_opens ?? '', regCloses: r.reg_closes ?? '',
      entryFee: Number(r.entry_fee), secondDisciplineFee: Number(r.second_discipline_fee),
      disciplines: r.disciplines ?? [], sessions: sessionsByMeet.get(r.id) ?? [],
      ...(r.private_reg_code ? { privateRegCode: r.private_reg_code } : {}),
      ...(r.banquet ? { banquet: r.banquet } : {}),
      ...(r.tshirt_addon ? { tshirtAddon: r.tshirt_addon } : {}),
      ...(r.banner_addon ? { bannerAddon: r.banner_addon } : {}),
      ...(r.change_fee ? { changeFee: r.change_fee } : {}),
      ...(r.event_type && r.event_type !== 'competition' ? { eventType: r.event_type } : {}),
      ...(r.sanction_id ? { sanctionId: r.sanction_id } : {}),
      ...(r.camp_config ? { campConfig: r.camp_config } : {}),
      ...(r.kind && r.kind !== 'standard' ? { kind: r.kind } : {}),
      ...(r.nationals_config ? { nationalsConfig: r.nationals_config } : {}),
    }));

    const registrations: Registration[] = (registrationsR.data ?? []).map(rowToRegistration);
    const scores: Score[] = (scoresR.data ?? []).map(rowToScore);

    const itemsByInvoice = new Map<string, Invoice['items']>();
    for (const r of invoiceItemsR.data ?? []) {
      const arr = itemsByInvoice.get(r.invoice_id) ?? [];
      arr.push({ id: r.id, label: r.label, amount: Number(r.amount), kind: r.kind, refUserId: r.ref_user_id ?? undefined, refunded: r.refunded });
      itemsByInvoice.set(r.invoice_id, arr);
    }
    const invoices: Invoice[] = (invoicesR.data ?? []).map((r: any) => ({
      id: r.id, number: r.number, clubId: r.club_id, athleteId: r.athlete_id,
      createdAt: r.created_at, paidAt: r.paid_at, items: itemsByInvoice.get(r.id) ?? [],
      ...(r.coupon_code ? { couponCode: r.coupon_code } : {}),
    }));

    const carts: DB['carts'] = {};
    for (const r of cartItemsR.data ?? []) {
      const ownerKey = r.club_id ?? r.person_id;
      if (!ownerKey) continue;
      const arr = carts[ownerKey] ?? (carts[ownerKey] = []);
      arr.push({ id: r.id, label: r.label, amount: Number(r.amount), kind: r.kind, refUserId: r.ref_user_id ?? undefined });
    }

    const clubRequests: ClubRequest[] = (clubRequestsR.error ? [] : clubRequestsR.data ?? []).map(rowToClubRequest);

    // 0007 tables — tolerate absence (pre-migration) by checking .error.
    const regionOverridesRow = (appSettingsR.error ? [] : appSettingsR.data ?? [])
      .find((r: any) => r.key === 'region_overrides');
    const regionOverrides = (regionOverridesRow?.value ?? undefined) as DB['regionOverrides'];
    const accountInvites: AccountInvite[] = (accountInvitesR.error ? [] : accountInvitesR.data ?? [])
      .map((r: any): AccountInvite => ({
        id: r.id, personId: r.person_id ?? null, email: r.email, token: r.token,
        status: r.status, createdAt: r.created_at, acceptedAt: r.accepted_at ?? null,
      }));

    const sanctionRequests: SanctionRequest[] = (sanctionRequestsR.error ? [] : sanctionRequestsR.data ?? [])
      .map((r: any): SanctionRequest => ({
        id: r.id, hostClubId: r.host_club_id, requesterPersonId: r.requester_person_id ?? null,
        eventKind: r.event_kind ?? 'competition', status: r.status, payload: r.payload ?? {},
        submittedAt: r.submitted_at ?? null, deadlineAt: r.deadline_at ?? null,
        decidedAt: r.decided_at ?? null, createdMeetId: r.created_meet_id ?? null,
        sanctionId: r.sanction_id ?? null,
      }));
    const sanctionVotes: SanctionVote[] = (sanctionVotesR.error ? [] : sanctionVotesR.data ?? [])
      .map((r: any): SanctionVote => ({
        id: r.id, requestId: r.request_id, voterUserId: r.voter_user_id, vote: r.vote,
        comment: r.comment ?? undefined, votedAt: r.voted_at,
      }));

    const waiverDocuments: WaiverDocument[] = (waiverDocsR.error ? [] : waiverDocsR.data ?? [])
      .map(rowToWaiverDocument);
    const waiverSignatures: WaiverSignature[] = (waiverSigsR.error ? [] : waiverSigsR.data ?? [])
      .map(rowToWaiverSignature);

    return {
      seasons, levels, clubs, people, meets, registrations, scores, invoices, coupons,
      carts, clubRequests,
      ...(regionOverrides ? { regionOverrides } : {}),
      ...(accountInvites.length ? { accountInvites } : {}),
      ...(sanctionRequests.length ? { sanctionRequests } : {}),
      ...(sanctionVotes.length ? { sanctionVotes } : {}),
      ...(waiverDocuments.length ? { waiverDocuments } : {}),
      ...(waiverSignatures.length ? { waiverSignatures } : {}),
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
  onChange: (payload: RealtimePostgresChangesPayload<Record<string, any>>) => void,
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
  payload: RealtimePostgresChangesPayload<Record<string, any>>,
): Map<string, Score | null> {
  const next = new Map(patches);
  if (payload.eventType === 'DELETE') {
    const oldId = (payload.old as Record<string, any> | null)?.id;
    if (oldId != null) next.set(oldId, null);
    return next;
  }
  const updated = rowToScore(payload.new as Record<string, any>);
  next.set(updated.id, updated);
  return next;
}
