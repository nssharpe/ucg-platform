// Supabase client + repository — wired up against supabase/migrations/0001_schema.sql.
//
// Write-through model: the in-memory store (src/lib/store.ts) stays the source
// of truth for the UI. Every mutation call site keeps its local `mutate()` and
// additionally fires one of the `push*` helpers below to mirror the change to
// Supabase. All writes are fire-and-forget (console.error on failure, never
// block the UI) and are no-ops when `isSupabaseConfigured` is false.
import { createClient, type SupabaseClient, type RealtimePostgresChangesPayload, type PostgrestError } from '@supabase/supabase-js';
import type {
  AccountInvite, AccountingCode, Athlete, Club, ClubMembership, ClubRequest, Coupon, DB, EventAdmin, HostPayout, Invoice, JudgeAccessCode, Level, Event, Membership, MembershipType, Payment, PaymentSnapshotLine, Region, Registration, RefundRequest, SanctionRequest, SanctionVote, Score, Season,
  WaiverDocument, WaiverSignature, WaitlistGroup, SessionRequest, CompetitionOrder, FinalsLineup, EventCheckin,
} from './types';
import { writeQueue, humanizeWriteError, type WriteOp, type ExecResult, type WriteQueueEntry } from './write-queue';
import { pushToast } from './toast-bus';
import type { Database } from './database.types';
import type { CapacityViolation } from './capacity';
import { PAGE_SIZE, sortKeysForTable, hasMorePages } from './pagination';

/** A table's Row type — the shape Supabase returns, used to type the DB→app
 *  row mappers so a schema change (renamed/dropped column) fails the build. */
type Row<T extends keyof Database['public']['Tables']> = Database['public']['Tables'][T]['Row'];
/** A database function's row return shape (for `.rpc()` results). */
type FnReturns<T extends keyof Database['public']['Functions']> = Database['public']['Functions'][T]['Returns'];

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isSupabaseConfigured = Boolean(url && anonKey);

/** Null until env vars are provided — callers must guard on isSupabaseConfigured.
 *  `experimental.passkey` opts into the free Passkeys sign-in API
 *  (signInWithPasskey/registerPasskey/auth.passkey.*) — disabled by default in
 *  the SDK. This is the FREE passwordless sign-in feature, distinct from the
 *  paid "Advanced MFA - WebAuthn" factor (auth.mfa.enroll factorType
 *  'webauthn', which stays declined — see docs/CLAUDE.md Auth patterns). */
export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(url!, anonKey!, {
      auth: { persistSession: true, autoRefreshToken: true, experimental: { passkey: true } },
    })
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

/** Explicit `registrations` column list for the broad `loadAll` read,
 *  EXCLUDING `camp_survey` — see the privacy fix in migration
 *  20260717205348_camp_survey_scoped_read.sql / docs/research/2026-07-17-
 *  supabomb-scan-results.md. `registrations` carries a public `using (true)`
 *  read policy (drives live results/start lists for every visitor), so a
 *  bare `select('*')` here would ask for `camp_survey` on every page load —
 *  the column is REVOKEd from anon/authenticated at the DB level, which would
 *  make `select('*')` itself fail (PostgREST errors the whole query on any
 *  requested-but-unreadable column). Keep in sync with the `registrations`
 *  table schema (Row/Insert/Update in database.types.ts, plus the
 *  post-generation columns noted in registrationToRow/rowToRegistration:
 *  waitlisted/waitlist_group_id/hold_expires_at). Callers that need
 *  camp_survey use the scoped `fetchCampSurveys` RPC instead (self / club
 *  manager / event host) or `fetchEventHostRoster` (host workbook — already
 *  scoped, unaffected by this). */
const REGISTRATION_COLUMNS_NO_SURVEY = 'id, event_id, athlete_id, club_id, discipline, level_id, apparatus, apparatus_levels, session_id, squad_id, refunded, refund_requested, keep_listed, partner_athlete_id, paid, updated_pending, created_at, waitlisted, waitlist_group_id, hold_expires_at' as const;

/** Fetch every row from a table, paging past PostgREST's default row cap
 *  (1000) — used by every `loadAll` table read (not just `people`, which is
 *  what originally needed it: a single nationals alone puts `scores` well
 *  past the cap). `columns` defaults to `'*'`; pass an explicit column list
 *  for tables (like `registrations`) where `select('*')` would ask for a
 *  column with SELECT revoked and fail the whole query (see the
 *  column-revoke trap in CLAUDE.md).
 *
 *  Postgres gives no row-order guarantee across separate queries without an
 *  explicit ORDER BY, so every page here is sorted by the table's
 *  deterministic key (`sortKeysForTable`, src/lib/pagination.ts) — without
 *  it, `.range()` pagination can silently duplicate some rows and skip
 *  others. */
async function fetchAllRows<T = unknown>(table: string, columns: string = '*'): Promise<{ data: T[]; error: PostgrestError | null }> {
  const sortKeys = sortKeysForTable(table);
  const out: T[] = [];
  let from = 0;
  for (;;) {
    let query = supabase!.from(table).select(columns).range(from, from + PAGE_SIZE - 1);
    for (const key of sortKeys) query = query.order(key, { ascending: true });
    const { data, error } = await query;
    if (error) return { data: out, error };
    out.push(...((data ?? []) as T[]));
    if (!data || !hasMorePages(data.length)) break;
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
  if (op.kind === 'rpc') {
    const { error } = await supabase.rpc(op.fn, op.args);
    return { error };
  }
  if (op.kind === 'update') {
    let upd = supabase.from(op.table).update(op.patch);
    for (const [k, v] of Object.entries(op.match)) upd = upd.eq(k, v);
    const { error } = await upd;
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

// A PERMANENT write failure (RLS denial, integrity violation, etc. — see
// classifyWriteError) means the optimistic local change in src/lib/store.ts
// is now known to be wrong: the server never applied it and never will on
// retry. There's no per-entry undo, so the rollback is a full reload from
// Supabase (store.ts's syncFromSupabase, the same function boot hydration
// uses) — imported dynamically to avoid a static import cycle with store.ts
// (which imports isSupabaseConfigured/loadAll from this module).
// The sync must NOT run while other queued writes are still pending: it
// reassigns the whole local db from the server, so syncing mid-queue would
// wipe the optimistic state of writes that are about to succeed (e.g. a batch
// where one line hits RLS while another is in transient backoff) — a new
// divergence introduced by the rollback itself. So: wait for the queue to
// fully drain (every entry succeeded, was removed as permanent, or settled to
// 'failed'), then sync once. Coalesced: permanent failures arriving while a
// drain-then-sync is already scheduled are covered by that same sync, because
// writeQueue.run() re-entrantly returns the in-flight run promise, which only
// resolves after the process loop has dealt with EVERY pending entry —
// including ones enqueued or re-failed after this was scheduled.
let rollbackSyncScheduled = false;
function scheduleRollbackSync() {
  if (rollbackSyncScheduled) return;
  rollbackSyncScheduled = true;
  const waitForDrain = async (): Promise<void> => {
    for (;;) {
      await writeQueue.run();
      // run() can also resolve early when the browser went offline mid-run
      // (entries left pending, no attempts burned). Syncing then would wipe
      // their optimistic state, so wait for the next queue notification
      // (resume()/online, retry, …) and re-check until truly drained.
      if (writeQueue.getState().pending === 0) return;
      await new Promise<void>((resolve) => {
        const unsub = writeQueue.subscribe(() => { unsub(); resolve(); });
      });
    }
  };
  void waitForDrain()
    .then(() => import('./store'))
    .then((m) => m.syncFromSupabase())
    .finally(() => { rollbackSyncScheduled = false; });
}

function handlePermanentWriteFailure(entry: WriteQueueEntry, error: unknown): void {
  const reason = humanizeWriteError(error);
  pushToast(
    `Couldn't save ${entry.label}: ${reason}. Your change was not saved and the page has been refreshed from the server.`,
    { variant: 'error' },
  );
  scheduleRollbackSync();
}

if (supabase) writeQueue.setOnPermanentFailure(handlePermanentWriteFailure);

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

/** Queue a targeted column UPDATE by primary key (not a full-row upsert) —
 *  for rows where RLS grants UPDATE on only specific columns. */
function remoteUpdate(table: string, id: string, patch: Record<string, unknown>, column = 'id') {
  if (!supabase) return;
  writeQueue.enqueue({ kind: 'update', table, match: { [column]: id }, patch }, table);
}

/** Queue a delete-all-then-insert for a small child collection. */
function remoteReplace(table: string, match: Record<string, unknown>, rows: Record<string, unknown>[]) {
  if (!supabase) return;
  writeQueue.enqueue({ kind: 'replace', table, match, rows }, table);
}

// ---------------------------------------------------------------------------
// Row mappers — DB row (snake_case, matches 0001_schema.sql) <-> TS shape
// ---------------------------------------------------------------------------
// P3 (2026-07-20): the app stops reading/writing `current`/`launched_at` —
// "current" and "purchasable" are now derived from dates (see
// src/lib/season-lifecycle.ts). The DB columns stay (no destructive
// migration); they're just ignored here.
const seasonToRow = (s: Season) => ({
  id: s.id, name: s.name, starts_on: s.startsOn, ends_on: s.endsOn,
  athlete_fee: s.athleteFee, coach_fee: s.coachFee, club_fee: s.clubFee,
  active: s.active,
});
const rowToSeason = (r: Row<'seasons'>): Season => ({
  id: r.id, name: r.name, startsOn: r.starts_on, endsOn: r.ends_on,
  athleteFee: Number(r.athlete_fee), coachFee: Number(r.coach_fee),
  clubFee: r.club_fee == null ? 109 : Number(r.club_fee),
  active: r.active,
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
  is_league_host: c.isLeagueHost ?? false,
});
// `is_league_host` is not yet in the generated database.types.ts (its migration
// hasn't been applied/regenerated against at write time) — CLAUDE.md: from()
// still typechecks fine since the client has no Database generic; the row
// param just needs the extra optional field spliced in, same pattern as
// rowToPayment/rowToEventAdmin's inline row types for pre-generation tables.
const rowToClub = (r: Row<'clubs'> & { is_league_host?: boolean | null }): Club => ({
  id: r.id, name: r.name, shortName: r.short_name ?? '', state: r.state ?? '', region: (r.region ?? 'Other') as Club['region'],
  managerIds: [], email: r.email ?? '', allowClubPay: r.allow_club_pay, access: (r.access ?? 'open') as Club['access'],
  isLeagueHost: r.is_league_host ?? false,
});

const couponToRow = (c: Coupon) => ({
  code: c.code, pct_off: c.pctOff ?? null, amount_off: c.amountOff ?? null, applies_to: c.appliesTo,
  applies_to_event_id: c.appliesToEventId ?? null,
  starts_at: c.startsAt ?? null, ends_at: c.endsAt ?? null,
  max_uses: c.maxUses ?? null, used_count: c.usedCount ?? 0,
  restricted_to_person_id: c.restrictedToPersonId ?? null,
});
const rowToCoupon = (r: Row<'coupons'>): Coupon => ({
  code: r.code, pctOff: r.pct_off == null ? undefined : Number(r.pct_off),
  amountOff: r.amount_off == null ? undefined : Number(r.amount_off), appliesTo: r.applies_to as Coupon['appliesTo'],
  appliesToEventId: (r as { applies_to_event_id?: string | null }).applies_to_event_id ?? null,
  startsAt: r.starts_at ?? null, endsAt: r.ends_at ?? null,
  maxUses: r.max_uses == null ? null : Number(r.max_uses),
  usedCount: r.used_count == null ? 0 : Number(r.used_count),
  restrictedToPersonId: (r as { restricted_to_person_id?: string | null }).restricted_to_person_id ?? null,
});

const personToRow = (p: Athlete) => ({
  id: p.id, kind: p.kind,
  roles: p.roles ?? { athlete: p.kind !== 'coach', coach: p.kind === 'coach' },
  first_name: p.firstName, last_name: p.lastName, email: p.email,
  dob: p.dob || null, gender: p.gender, placement: p.placement ?? {}, grad_year: p.gradYear || null,
  student_status: p.studentStatus || null, shirt: p.shirt, country: p.country, state: p.state,
  outside_us: p.outsideUs ?? false,
  // Opt-OUT model (SMS is covered by the liability waiver): consenting by
  // default unless explicitly set false (a STOP reply — sms-webhook). A
  // brand-new person (p.smsConsent undefined) defaults to true, matching the
  // people.sms_consent column default.
  phone: p.phone, sms_consent: p.smsConsent ?? true, sms_consent_at: p.smsConsentAt ?? null,
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

const eventToRow = (m: Event) => ({
  // '' means "no host club" client-side (events-core.ts UCG-hosted-no-club
  // path, PM feedback 2026-07-22) — host_club_id is a nullable FK into
  // clubs(id), so an empty string would violate the constraint; write null.
  id: m.id, slug: m.slug, name: m.name, host_club_id: m.hostClubId || null, city: m.city, state: m.state,
  timezone: m.timezone, start_date: m.startDate || null, end_date: m.endDate || null, status: m.status,
  reg_opens: m.regOpens || null, reg_closes: m.regCloses || null,
  last_date_to_edit: m.lastDateToEdit || null, entry_fee: m.entryFee,
  second_discipline_fee: m.secondDisciplineFee, disciplines: m.disciplines,
  private_reg_code: m.privateRegCode ?? null, banquet: m.banquet ?? null,
  tshirt_addon: m.tshirtAddon ?? null, banner_addon: m.bannerAddon ?? null,
  change_fee: m.changeFee ?? null,
  event_type: m.eventType ?? 'competition', sanction_id: m.sanctionId ?? null,
  camp_config: m.campConfig ?? null,
  kind: m.kind ?? 'standard', nationals_config: m.nationalsConfig ?? null,
  ucg_hosted: m.ucgHosted ?? null,
  venue: m.venue ?? null, street_address: m.streetAddress ?? null, country: m.country ?? null,
  hotel_link: m.hotelLink ?? null, age_calc_at: m.ageCalcAt || null,
  late_reg: m.lateReg ?? null, director: m.director ?? null, capacity: m.capacity ?? null,
  confirmation_email: m.confirmationEmail ?? null,
  owner: m.owner ?? null, owner_checklist: m.ownerChecklist ?? null,
  registration_mode: m.registrationMode ?? 'by-discipline',
  competition_order_locked: m.competitionOrderLocked ?? false,
  finals_roster_locked: m.finalsRosterLocked ?? false,
  finals_lineup_deadline_at: m.finalsLineupDeadlineAt || null,
  scoring_config: m.scoringConfig ?? null,
  // Omit when unset so event saves keep working against a DB that doesn't
  // have the column yet (migration 20260722221027 pending on prod at ship
  // time); the Nationals wizard always sets listingOnly explicitly, so
  // true→false transitions still write.
  ...(m.listingOnly !== undefined ? { listing_only: m.listingOnly } : {}),
});

const sessionToRow = (eventId: string, s: Event['sessions'][number]) => ({
  id: s.id, event_id: eventId, name: s.name, discipline: s.discipline,
  date: s.date || null, time: s.time || null, level_ids: s.levelIds,
  phase: s.phase ?? null, max_routines: s.maxRoutines ?? null,
});

const squadToRow = (sessionId: string, q: Event['sessions'][number]['squads'][number], i: number) => ({
  id: q.id, session_id: sessionId, name: q.name, start_event: q.startEvent,
  holding: q.holding ?? false, sort_order: i,
});

// `camp_survey` is DELIBERATELY OMITTED here (bugfix 2026-07-23): the app
// writes whole-row registrations upserts (INSERT ... ON CONFLICT (id) DO
// UPDATE SET col = EXCLUDED.col for every written column) — Postgres requires
// SELECT privilege on any column referenced via EXCLUDED, even though the
// upsert itself uses `Prefer: return=minimal` and requests no representation
// back. Migration 20260717205348_camp_survey_scoped_read.sql revoked
// table-wide SELECT on `registrations` from anon/authenticated and granted it
// back on every column EXCEPT camp_survey — that migration's write-path
// reasoning ("no .select() chained ⇒ return=minimal ⇒ the revoke can't break
// writes") checked the wrong mechanism; it missed the EXCLUDED-read
// requirement, so EVERY registrations upsert by ANY authenticated user was
// failing prod-wide with "permission denied for table registrations" since
// 2026-07-17. Fix: never reference camp_survey from an upsert — write it
// through the targeted-column-UPDATE path instead (pushCampSurvey below),
// which compiles to a plain `UPDATE ... SET camp_survey = $1` with no
// EXCLUDED reference and no revoked-column read.
const registrationToRow = (r: Registration, squadId: string | null = null) => ({
  id: r.id, event_id: r.eventId, athlete_id: r.athleteId, club_id: r.clubId, discipline: r.discipline,
  // '' (the camp-registration "no level" sentinel, CLAUDE.md "Camps are
  // session-less/level-less") must become null, not the literal empty
  // string -- level_id is a nullable FK into levels(id) with no row whose id
  // is '', so writing '' verbatim violates registrations_level_id_fkey
  // (23503). Bug found 2026-07-23 while live-verifying the camp_survey
  // permission fix above: it was masked until now because the camp_survey
  // privilege error aborted every upsert before Postgres ever reached the FK
  // check, so no camp registration write has actually succeeded since camps
  // shipped (2026-07-22) -- matches the pre-existing `sessionId || null`
  // pattern on the very next line.
  level_id: r.levelId || null, apparatus: r.apparatus, session_id: r.sessionId || null, squad_id: squadId,
  refunded: r.refunded ?? false, refund_requested: r.refundRequested ?? false,
  keep_listed: r.keepListed ?? false,
  partner_athlete_id: r.partnerAthleteId ?? null, apparatus_levels: r.apparatusLevels ?? null,
  paid: r.paid ?? false, updated_pending: r.updatedPending ?? false,
  waitlisted: r.waitlisted ?? false, waitlist_group_id: r.waitlistGroupId ?? null,
  hold_expires_at: r.holdExpiresAt ?? null,
});

/** squad_id for every registration, derived from session.squads[].athleteRegIds. */
function squadIdsByReg(event: Event): Map<string, string> {
  const map = new Map<string, string>();
  for (const s of event.sessions) for (const q of s.squads) for (const regId of q.athleteRegIds) map.set(regId, q.id);
  return map;
}
// `camp_survey` is deliberately excluded from loadAll's registrations select
// (REGISTRATION_COLUMNS_NO_SURVEY, see the const's doc comment) — the row
// shape coming back from that query has no `camp_survey` key at all, so this
// mapper's input type makes the column optional rather than requiring it.
type RegistrationRowMaybeSurvey = Omit<Row<'registrations'>, 'camp_survey'> & { camp_survey?: Row<'registrations'>['camp_survey'] };
const rowToRegistration = (r: RegistrationRowMaybeSurvey): Registration => ({
  id: r.id, eventId: r.event_id, athleteId: r.athlete_id, clubId: r.club_id ?? '', discipline: r.discipline as Registration['discipline'],
  levelId: r.level_id ?? '', apparatus: (r.apparatus ?? []) as Registration['apparatus'], sessionId: r.session_id ?? '',
  refunded: r.refunded, keepListed: r.keep_listed,
  paid: (r as { paid?: boolean | null }).paid ?? false,
  ...((r as { updated_pending?: boolean | null }).updated_pending ? { updatedPending: true } : {}),
  ...(r.refund_requested ? { refundRequested: true } : {}),
  ...(r.partner_athlete_id ? { partnerAthleteId: r.partner_athlete_id } : {}),
  ...(r.apparatus_levels ? { apparatusLevels: r.apparatus_levels as Registration['apparatusLevels'] } : {}),
  ...(r.camp_survey ? { campSurvey: r.camp_survey as Registration['campSurvey'] } : {}),
  ...((r as { waitlisted?: boolean | null }).waitlisted ? { waitlisted: true } : {}),
  ...((r as { waitlist_group_id?: string | null }).waitlist_group_id ? { waitlistGroupId: (r as { waitlist_group_id?: string | null }).waitlist_group_id } : {}),
  ...((r as { hold_expires_at?: string | null }).hold_expires_at ? { holdExpiresAt: (r as { hold_expires_at?: string | null }).hold_expires_at } : {}),
  // READ-ONLY: never included in registrationToRow's push mapping (see Registration.createdAt).
  ...(r.created_at ? { createdAt: r.created_at } : {}),
});

const scoreToRow = (s: Score) => ({
  id: s.id, event_id: s.eventId, session_id: s.sessionId, reg_id: s.regId, apparatus: s.apparatus,
  sv: s.sv, deductions: s.deductions, e_score: s.eScore ?? null, final: s.final,
  source: s.source ?? 'manual',
  calc: s.calc ?? null, calc_state: s.calcState ?? null,
  adjust_note: s.adjustNote ?? null, adjusted_at: s.adjustedAt ?? null,
  entered_by: s.enteredBy, entered_at: s.enteredAt, flashed: s.flashed,
  scratched: s.scratched ?? false,
  // Second judge panel's raw execution inputs (2026-07-19 scoring config).
  deductions2: s.deductions2 ?? null, e_score2: s.eScore2 ?? null,
});
export const rowToScore = (r: Row<'scores'>): Score => ({
  id: r.id, eventId: r.event_id, sessionId: r.session_id ?? '', regId: r.reg_id ?? '', apparatus: r.apparatus as Score['apparatus'],
  sv: r.sv == null ? null : Number(r.sv), deductions: r.deductions == null ? null : Number(r.deductions),
  eScore: r.e_score == null ? null : Number(r.e_score), final: r.final == null ? null : Number(r.final),
  source: r.source as Score['source'], enteredBy: r.entered_by ?? '', enteredAt: r.entered_at, flashed: r.flashed,
  ...(r.calc != null ? { calc: r.calc } : {}),
  ...(r.calc_state != null ? { calcState: r.calc_state } : {}),
  ...(r.adjust_note != null ? { adjustNote: r.adjust_note } : {}),
  ...(r.adjusted_at != null ? { adjustedAt: r.adjusted_at } : {}),
  ...(r.scratched ? { scratched: true } : {}),
  ...((r as { deductions2?: number | string | null }).deductions2 != null ? { deductions2: Number((r as { deductions2?: number | string | null }).deductions2) } : {}),
  ...((r as { e_score2?: number | string | null }).e_score2 != null ? { eScore2: Number((r as { e_score2?: number | string | null }).e_score2) } : {}),
});

// cart_items: one row per item, owner = club_id or person_id
function cartItemToRow(ownerKey: string, item: DB['carts'][string][number], isClub: boolean) {
  return {
    id: item.id, club_id: isClub ? ownerKey : null, person_id: isClub ? null : ownerKey,
    label: item.label, amount: item.amount, kind: item.kind, ref_user_id: item.refUserId ?? null,
    ref_season_id: item.refSeasonId ?? null, ref_type: item.refType ?? null,
    ref_reg_ids: item.refRegIds ?? null,
    ref_event_id: item.refEventId ?? null, ref_line_type: item.refLineType ?? null,
    prior_reg_snapshot: item.priorRegSnapshot ?? null,
    // Per-unit add-on fields (event-mgmt v2 Phase 2): shirt/leo size, and a
    // banquet ticket's assignee (person id or the 'extra' sentinel).
    addon_size: item.addonSize ?? null, addon_assignee: item.addonAssigneeId ?? null,
  };
}

const invoiceToRow = (i: Invoice) => ({
  id: i.id, number: i.number, club_id: i.clubId, athlete_id: i.athleteId,
  coupon_code: i.couponCode ?? null, created_at: i.createdAt, paid_at: i.paidAt,
  // Preserve the Stripe finance fields on round-trip (the webhook is their writer;
  // a non-Stripe direct-pay invoice carries nulls, which is correct).
  stripe_payment_intent_id: i.stripePaymentIntentId ?? null, stripe_fee: i.stripeFee ?? null,
});
const invoiceItemToRow = (invoiceId: string, it: Invoice['items'][number]) => ({
  id: it.id, invoice_id: invoiceId, label: it.label, amount: it.amount, kind: it.kind,
  ref_user_id: it.refUserId ?? null, refunded: it.refunded ?? false,
  ref_reg_ids: it.refRegIds ?? null,
  ref_event_id: it.refEventId ?? null, ref_line_type: it.refLineType ?? null,
  // Per-unit add-on fields (event-mgmt v2 Phase 2) — see cartItemToRow.
  addon_size: it.addonSize ?? null, addon_assignee: it.addonAssigneeId ?? null,
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
const rowToEventAdmin = (r: { id: string; event_id: string; user_id: string; email: string; name: string | null; granted_by: string | null; created_at: string }): EventAdmin => ({
  id: r.id, eventId: r.event_id, userId: r.user_id, email: r.email,
  name: r.name, grantedBy: r.granted_by, createdAt: r.created_at,
});
// Inline snapshot-line row shape written by create-checkout-session's
// `linesSnapshot` (event-mgmt v2 Phase 6 T2) — snake_case jsonb, mapped to
// PaymentSnapshotLine below. Tolerant of nulls (early snapshots predate
// `paid_cents`).
type PaymentSnapshotLineRow = {
  id: string; kind: string; label: string; amount_cents: number; paid_cents?: number | null;
  club_id?: string | null; ref_user_id?: string | null; ref_season_id?: string | null;
  ref_type?: string | null; ref_reg_ids?: string[] | null; ref_event_id?: string | null;
  ref_line_type?: string | null;
};
const rowToPaymentSnapshotLine = (l: PaymentSnapshotLineRow): PaymentSnapshotLine => ({
  id: l.id, kind: l.kind as PaymentSnapshotLine['kind'], label: l.label, amountCents: l.amount_cents,
  paidCents: l.paid_cents ?? undefined, clubId: l.club_id ?? undefined, refUserId: l.ref_user_id ?? undefined,
  refSeasonId: l.ref_season_id ?? undefined, refType: l.ref_type ?? undefined,
  refRegIds: l.ref_reg_ids ?? undefined, refEventId: l.ref_event_id ?? undefined,
  refLineType: l.ref_line_type ?? undefined,
});
const rowToPayment = (r: {
  id: string; stripe_session_id: string | null; stripe_payment_intent_id: string | null;
  person_id: string | null; status: string; amount_subtotal: number | null; service_fee: number | null;
  stripe_fee: number | null; currency: string; cart_item_ids: string[] | null; ref_reg_ids: string[] | null;
  ref_season_id: string | null; ref_type: string | null; invoice_id: string | null;
  stripe_event_id: string | null; created_at: string; fulfilled_at: string | null;
  lines_snapshot?: PaymentSnapshotLineRow[] | null;
}): Payment => ({
  id: r.id, stripeSessionId: r.stripe_session_id, stripePaymentIntentId: r.stripe_payment_intent_id,
  personId: r.person_id, status: r.status as Payment['status'],
  amountSubtotal: r.amount_subtotal, serviceFee: r.service_fee, stripeFee: r.stripe_fee,
  currency: r.currency ?? 'usd', cartItemIds: r.cart_item_ids ?? [], refRegIds: r.ref_reg_ids ?? [],
  refSeasonId: r.ref_season_id, refType: r.ref_type, invoiceId: r.invoice_id,
  stripeEventId: r.stripe_event_id, createdAt: r.created_at, fulfilledAt: r.fulfilled_at,
  linesSnapshot: r.lines_snapshot ? r.lines_snapshot.map(rowToPaymentSnapshotLine) : undefined,
});
// refund_requests is not yet in the generated database.types.ts (T4 does not
// apply/regenerate against its own migration — the controller pushes it at
// phase end), so this uses an inline row type like rowToPayment/rowToEventAdmin
// rather than Row<'refund_requests'>. No refundRequestToRow / pushRefundRequest
// exists — writes are server-side only (SECURITY DEFINER RPCs / Edge
// Functions in T5/T6), matching the payments table's read-only-from-client model.
const rowToRefundRequest = (r: {
  id: string; created_at: string; requester_person_id: string; club_id: string | null;
  event_id: string; kind: string; reg_id: string | null; invoice_item_id: string | null;
  payment_id: string | null; reason: string; reason_detail: string | null; status: string;
  reviewed_by: string | null; reviewed_at: string | null; refund_amount_cents: number | null;
  stripe_refund_id: string | null;
}): RefundRequest => ({
  id: r.id, createdAt: r.created_at, requesterPersonId: r.requester_person_id, clubId: r.club_id,
  eventId: r.event_id, kind: r.kind as RefundRequest['kind'], regId: r.reg_id, invoiceItemId: r.invoice_item_id,
  paymentId: r.payment_id, reason: r.reason as RefundRequest['reason'], reasonDetail: r.reason_detail,
  status: r.status as RefundRequest['status'], reviewedBy: r.reviewed_by, reviewedAt: r.reviewed_at,
  refundAmountCents: r.refund_amount_cents, stripeRefundId: r.stripe_refund_id,
});
// waitlist_groups is not yet in the generated database.types.ts (this
// migration hasn't been applied/regenerated against at write time) — inline
// row type like rowToPayment/rowToEventAdmin/rowToRefundRequest. Unlike
// refund_requests, clients DO write this table directly (self/manager
// queue-join + cancel), so both directions are implemented here.
const waitlistGroupToRow = (g: WaitlistGroup) => ({
  id: g.id, event_id: g.eventId, club_id: g.clubId ?? null, person_id: g.personId ?? null,
  discipline: g.discipline, level_id: g.levelId ?? null, session_id: g.sessionId ?? null,
  status: g.status, queued_at: g.queuedAt, notified_at: g.notifiedAt ?? null,
  hold_expires_at: g.holdExpiresAt ?? null,
});
const rowToWaitlistGroup = (r: {
  id: string; event_id: string; club_id: string | null; person_id: string | null;
  discipline: string; level_id: string | null; session_id: string | null; status: string;
  queued_at: string; notified_at: string | null; hold_expires_at: string | null; created_at: string;
}): WaitlistGroup => ({
  id: r.id, eventId: r.event_id, clubId: r.club_id, personId: r.person_id,
  discipline: r.discipline as WaitlistGroup['discipline'], levelId: r.level_id, sessionId: r.session_id,
  status: r.status as WaitlistGroup['status'], queuedAt: r.queued_at, notifiedAt: r.notified_at,
  holdExpiresAt: r.hold_expires_at, createdAt: r.created_at,
});
// judge_access_codes is not yet in the generated database.types.ts (this
// migration hasn't been applied/regenerated against at write time) — inline
// row type like rowToWaitlistGroup. Clients (event hosts/admins) write this
// table directly (Generate/Regenerate/Revoke), so both directions are
// implemented here.
const judgeAccessCodeToRow = (c: JudgeAccessCode) => ({
  id: c.id, event_id: c.eventId, token: c.token, code: c.code,
  created_by: c.createdBy ?? null, revoked_at: c.revokedAt ?? null,
});
const rowToJudgeAccessCode = (r: {
  id: string; event_id: string; token: string; code: string;
  created_by: string | null; created_at: string; revoked_at: string | null;
}): JudgeAccessCode => ({
  id: r.id, eventId: r.event_id, token: r.token, code: r.code,
  createdBy: r.created_by, createdAt: r.created_at, revokedAt: r.revoked_at,
});
// session_requests is not yet in the generated database.types.ts (this
// migration hasn't been applied/regenerated against at write time) — inline
// row type like rowToWaitlistGroup. Unlike waitlist_groups, clients may
// rewrite `answers` in full (surveys are fully editable), so both directions
// are implemented here with no column-grant restriction.
const sessionRequestToRow = (s: SessionRequest) => ({
  id: s.id, event_id: s.eventId, club_id: s.clubId ?? null, person_id: s.personId ?? null,
  discipline: s.discipline, level_id: s.levelId ?? null, answers: s.answers ?? {},
  updated_at: new Date().toISOString(),
});
const rowToSessionRequest = (r: {
  id: string; event_id: string; club_id: string | null; person_id: string | null;
  discipline: string; level_id: string | null; answers: unknown;
  created_at: string; updated_at: string;
}): SessionRequest => ({
  id: r.id, eventId: r.event_id, clubId: r.club_id, personId: r.person_id,
  discipline: r.discipline as SessionRequest['discipline'], levelId: r.level_id,
  answers: (r.answers ?? {}) as SessionRequest['answers'],
  createdAt: r.created_at, updatedAt: r.updated_at,
});
// competition_orders is not yet in the generated database.types.ts (this
// migration hasn't been applied/regenerated against at write time) — inline
// row type like rowToSessionRequest/rowToWaitlistGroup. Fully editable (like
// session_requests, unlike waitlist_groups' column-grant restriction) so both
// directions are implemented with no column-grant restriction.
const competitionOrderToRow = (o: CompetitionOrder) => ({
  id: o.id, event_id: o.eventId, club_id: o.clubId, level_id: o.levelId,
  apparatus: o.apparatus, sections: o.sections ?? [],
  updated_at: new Date().toISOString(),
});
const rowToCompetitionOrder = (r: {
  id: string; event_id: string; club_id: string; level_id: string;
  apparatus: string; sections: unknown; updated_at: string;
}): CompetitionOrder => ({
  id: r.id, eventId: r.event_id, clubId: r.club_id, levelId: r.level_id,
  apparatus: r.apparatus, sections: (r.sections ?? []) as string[][],
  updatedAt: r.updated_at,
});
// finals_lineups is not yet in the generated database.types.ts (this
// migration hasn't been applied/regenerated against at write time) — inline
// row type like rowToCompetitionOrder/rowToSessionRequest. Fully editable
// (RLS blocks the write entirely once locked, no column-grant restriction).
const finalsLineupToRow = (l: FinalsLineup) => ({
  id: l.id, event_id: l.eventId, club_id: l.clubId, level_id: l.levelId,
  category: l.category, apparatus: l.apparatus, reg_ids: l.regIds ?? [],
  updated_at: new Date().toISOString(),
});
const rowToFinalsLineup = (r: {
  id: string; event_id: string; club_id: string; level_id: string;
  category: string; apparatus: string; reg_ids: unknown; updated_at: string;
}): FinalsLineup => ({
  id: r.id, eventId: r.event_id, clubId: r.club_id, levelId: r.level_id,
  category: r.category, apparatus: r.apparatus, regIds: (r.reg_ids ?? []) as string[],
  updatedAt: r.updated_at,
});
// event_checkins is not yet in the generated database.types.ts (this
// migration hasn't been applied/regenerated against at write time) — inline
// row type like rowToCompetitionOrder/rowToFinalsLineup. Unlike those two,
// `authenticated` holds a column-level UPDATE grant restricted to
// status/signed_name/checked_in_at/checked_in_by ONLY (see
// `confirmEventCheckin` below) — `eventCheckinToRow` still emits every
// column (used for the admin-only INSERT "open" path, which needs the full
// row), the restriction is enforced server-side by the grant, not here.
const eventCheckinToRow = (c: EventCheckin) => ({
  id: c.id, event_id: c.eventId, club_id: c.clubId ?? null, person_id: c.personId ?? null,
  status: c.status, signed_name: c.signedName ?? null, checked_in_at: c.checkedInAt ?? null,
  checked_in_by: c.checkedInBy ?? null, opened_by: c.openedBy ?? null,
});
const rowToEventCheckin = (r: {
  id: string; event_id: string; club_id: string | null; person_id: string | null;
  status: string; signed_name: string | null; checked_in_at: string | null;
  checked_in_by: string | null; opened_by: string | null; created_at: string;
}): EventCheckin => ({
  id: r.id, eventId: r.event_id, clubId: r.club_id, personId: r.person_id,
  status: r.status as EventCheckin['status'], signedName: r.signed_name,
  checkedInAt: r.checked_in_at, checkedInBy: r.checked_in_by, openedBy: r.opened_by,
  createdAt: r.created_at,
});
// accounting_codes / host_payouts are not yet in the generated
// database.types.ts (this migration hasn't been applied/regenerated
// against at write time) -- inline row types like rowToCompetitionOrder/
// rowToFinalsLineup. Both are fully editable (plain admin/finance_admin CRUD,
// no server-only or column-grant write restriction), so both directions are
// implemented for each with no column-grant restriction.
const accountingCodeToRow = (a: AccountingCode) => ({
  id: a.id, item_key: a.itemKey, code: a.code, label: a.label ?? null,
  updated_at: new Date().toISOString(),
});
const rowToAccountingCode = (r: {
  id: string; item_key: string; code: string; label: string | null; updated_at: string;
}): AccountingCode => ({
  id: r.id, itemKey: r.item_key, code: r.code, label: r.label ?? undefined, updatedAt: r.updated_at,
});
const hostPayoutToRow = (p: HostPayout) => ({
  id: p.id, event_id: p.eventId, amount_cents: p.amountCents, method: p.method,
  reference: p.reference ?? null, paid_on: p.paidOn, notes: p.notes ?? null,
  created_by: p.createdBy ?? null, updated_at: new Date().toISOString(),
});
const rowToHostPayout = (r: {
  id: string; event_id: string; amount_cents: number; method: string; reference: string | null;
  paid_on: string; notes: string | null; created_by: string | null; created_at: string; updated_at: string;
}): HostPayout => ({
  id: r.id, eventId: r.event_id, amountCents: r.amount_cents, method: r.method as HostPayout['method'],
  reference: r.reference ?? undefined, paidOn: r.paid_on, notes: r.notes ?? undefined,
  createdBy: r.created_by ?? undefined, createdAt: r.created_at, updatedAt: r.updated_at,
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
/** Insert a waitlist group (event-mgmt v2 P4 T1): a person queuing themselves
 *  or a manager queuing their own club's cohort. RLS pins status='waiting' on
 *  insert. NOTE: effectively insert-only for clients — `authenticated` holds a
 *  column-level UPDATE grant on `status` ONLY, so this upsert's conflict-update
 *  path (which writes every column) is denied for an existing row. Cancel is a
 *  targeted UPDATE to status='cancelled' (the only client-writable transition);
 *  all other transitions are service-role. No client DELETE policy exists.
 *  Later P4 tasks add the actual queue-join/cancel call sites. */
export function pushWaitlistGroup(g: WaitlistGroup) { remoteUpsert('waitlist_groups', [waitlistGroupToRow(g)]); }
export function pushJudgeAccessCode(c: JudgeAccessCode) { remoteUpsert('judge_access_codes', [judgeAccessCodeToRow(c)]); }
/** "Revoke" — targeted column UPDATE (not a full upsert) so it doesn't fight
 *  a concurrent write to the same row. Matches RLS's separate update policy. */
export function revokeJudgeAccessCode(id: string) { remoteUpdate('judge_access_codes', id, { revoked_at: new Date().toISOString() }); }
/** Cancel a waitlist group (event-mgmt v2 P4 T6 "Leave waitlist" — self or
 *  club-manager): the only client-writable status transition on an EXISTING
 *  row. Must go through the targeted `remoteUpdate` column-update, NOT
 *  `pushWaitlistGroup`'s upsert — RLS grants UPDATE on `status` alone, and an
 *  upsert's ON CONFLICT DO UPDATE path writes every column, so it's denied
 *  for a row that already exists. */
export function cancelWaitlistGroup(id: string) { remoteUpdate('waitlist_groups', id, { status: 'cancelled' }); }
/** No client DELETE RLS policy exists on waitlist_groups (rows are
 *  cancelled via status update, never deleted, by design); this exists only
 *  for admin-tooling/service-role symmetry with the other delete* helpers. */
export function deleteWaitlistGroup(id: string) { remoteDelete('waitlist_groups', id, 'id'); }
/** Upsert a nationals session-request survey (event-mgmt v2 Phase 5 A1):
 *  a club manager's per-level/MAG/TNT survey, or an independent athlete's
 *  per-discipline survey. Unlike `pushWaitlistGroup`, this is a full
 *  read-write upsert — surveys are editable in place (no column-grant
 *  restriction), so the conflict-update path rewrites `answers` freely.
 *  `updated_at` is stamped fresh on every write. */
export function pushSessionRequest(s: SessionRequest) { remoteUpsert('session_requests', [sessionRequestToRow(s)]); }
/** Delete a session-request survey (e.g. cleanup after a dropped level). */
export function deleteSessionRequest(id: string) { remoteDelete('session_requests', id, 'id'); }
/** Upsert a club's competition order for one (event, level, apparatus)
 *  (event-mgmt v2 Phase 5 B1, spec §E6). Full read-write upsert — RLS blocks
 *  the write entirely once `Event.competitionOrderLocked` is true for a
 *  non-admin caller (`event_order_locked()` in the P5 B1 migration), so no
 *  column-grant restriction is needed here (unlike `pushWaitlistGroup`).
 *  `updated_at` is stamped fresh on every write. */
export function pushCompetitionOrder(o: CompetitionOrder) { remoteUpsert('competition_orders', [competitionOrderToRow(o)]); }
/** Delete a competition-order row (e.g. cleanup after a dropped apparatus). */
export function deleteCompetitionOrder(id: string) { remoteDelete('competition_orders', id, 'id'); }
/** Upsert a club's finals-roster lineup for one (event, level, category,
 *  apparatus) (event-mgmt v2 Phase 5 C1, spec §E7/§L.3). Full read-write
 *  upsert — RLS blocks the write entirely once `Event.finalsRosterLocked` is
 *  true for a non-admin caller (`event_finals_locked()` in the P5 C1
 *  migration), so no column-grant restriction is needed here (unlike
 *  `pushWaitlistGroup`). `updated_at` is stamped fresh on every write. */
export function pushFinalsLineup(l: FinalsLineup) { remoteUpsert('finals_lineups', [finalsLineupToRow(l)]); }
/** Delete a finals-lineup row (e.g. cleanup after a dropped apparatus). */
export function deleteFinalsLineup(id: string) { remoteDelete('finals_lineups', id, 'id'); }
/** Admin/sanctioning-only: OPEN check-in for a club or independent athlete
 *  (event-mgmt v2 Phase 5 E1, spec §L.4) — an insert-only upsert (RLS's
 *  INSERT policy is admin/sanctioning-only, and the conflict-update path
 *  would need the full column-write reach non-admins don't have; admins can
 *  re-open an existing row via this same call since they bypass the
 *  column grant). `status:'open'` is always the row's initial state. */
export function pushEventCheckin(c: EventCheckin) { remoteUpsert('event_checkins', [eventCheckinToRow(c)]); }
/** Club manager / athlete confirms an already-open check-in (event-mgmt v2
 *  Phase 5 E1). Must go through this targeted `remoteUpdate`, NOT
 *  `pushEventCheckin`'s upsert — RLS grants UPDATE on
 *  status/signed_name/checked_in_at/checked_in_by ONLY, and an upsert's ON
 *  CONFLICT DO UPDATE path writes every column (incl. event_id/club_id/
 *  person_id/opened_by), which is denied for a row that already exists. */
export function confirmEventCheckin(id: string, patch: { status: 'checked-in'; signedName: string; checkedInAt: string; checkedInBy: string }) {
  remoteUpdate('event_checkins', id, { status: patch.status, signed_name: patch.signedName, checked_in_at: patch.checkedInAt, checked_in_by: patch.checkedInBy }, 'id');
}
/** Admin-only cleanup: undo an erroneously opened check-in. */
export function deleteEventCheckin(id: string) { remoteDelete('event_checkins', id, 'id'); }
/** Upsert an accounting-code lookup row (event-mgmt v2 Phase 6 T1, spec §M).
 *  Full read-write upsert -- RLS is admin/finance_admin only on all four
 *  policies, so no column-grant restriction is needed. `updated_at` is
 *  stamped fresh on every write. */
export function pushAccountingCode(a: AccountingCode) { remoteUpsert('accounting_codes', [accountingCodeToRow(a)]); }
/** Delete an accounting-code mapping. */
export function deleteAccountingCode(id: string) { remoteDelete('accounting_codes', id, 'id'); }
/** Upsert a host-payout record (event-mgmt v2 Phase 6 T1, spec §M). Full
 *  read-write upsert -- RLS is admin/finance_admin only on all four policies,
 *  so no column-grant restriction is needed. `updated_at` is stamped fresh
 *  on every write. */
export function pushHostPayout(p: HostPayout) { remoteUpsert('host_payouts', [hostPayoutToRow(p)]); }
/** Delete a host-payout record. */
export function deleteHostPayout(id: string) { remoteDelete('host_payouts', id, 'id'); }
/** Upsert a Stripe payment record. In practice the service-role Edge Functions
 *  write these (clients only read own rows via RLS); this exists for symmetry +
 *  any admin tooling. Money fields are CENTS. */
export function pushPayment(p: Payment) {
  remoteUpsert('payments', [{
    id: p.id, stripe_session_id: p.stripeSessionId, stripe_payment_intent_id: p.stripePaymentIntentId,
    person_id: p.personId, status: p.status, amount_subtotal: p.amountSubtotal, service_fee: p.serviceFee,
    stripe_fee: p.stripeFee, currency: p.currency, cart_item_ids: p.cartItemIds, ref_reg_ids: p.refRegIds,
    ref_season_id: p.refSeasonId, ref_type: p.refType, invoice_id: p.invoiceId,
    stripe_event_id: p.stripeEventId, fulfilled_at: p.fulfilledAt,
  }]);
}
/** Hard-delete a person remotely (used by account merge). Cascades remove the
 *  person's remaining child rows (memberships, alt clubs, signatures, etc.). */
export function deletePerson(id: string) { remoteDelete('people', id, 'id'); }

export function pushClub(c: Club) {
  remoteUpsert('clubs', [clubToRow(c)]);
  // NOT remoteReplace (plain client-side delete-then-insert under RLS): a
  // non-admin manager's own permission to re-INSERT the replacement rows is
  // `manages_club(club_id)`, which the DELETE step (still-authorized at that
  // point) had just made false by removing their own row — so the INSERT
  // half then failed its own RLS check, silently wiping every manager off
  // the club with no error surfaced to the actor. `replace_club_managers`
  // checks authorization ONCE up front and does both writes atomically,
  // server-side, bypassing this self-referential trap entirely.
  writeQueue.enqueue({
    kind: 'rpc', table: 'club_managers', fn: 'replace_club_managers',
    args: { p_club_id: c.id, p_person_ids: c.managerIds },
  }, 'club_managers');
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

/** Delete a membership row by its (person, season, type) — the same stable id
 *  `membershipToRow` derives. Used when an UNPAID club-cart-pushed membership
 *  is canceled by removing its cart line (the push created the row, so removing
 *  the push removes it — see removeCartItemWithSync / cart-sync.ts). */
export function deleteMembership(personId: string, seasonId: string, type: string) {
  remoteDelete('memberships', `${personId}:${seasonId}:${type}`, 'id');
}

export function pushEvent(m: Event) {
  remoteUpsert('events', [eventToRow(m)]);
  remoteReplace('event_sessions', { event_id: m.id }, m.sessions.map((s) => sessionToRow(m.id, s)));
  for (const s of m.sessions) {
    remoteReplace('squads', { session_id: s.id }, s.squads.map((q, i) => squadToRow(s.id, q, i)));
  }
}

/** Push only an event's sessions/squads (status/fields unchanged), and the
 *  resulting squad_id placements for that event's registrations. */
export function pushEventSessions(m: Event, registrations: Registration[]) {
  remoteReplace('event_sessions', { event_id: m.id }, m.sessions.map((s) => sessionToRow(m.id, s)));
  for (const s of m.sessions) {
    remoteReplace('squads', { session_id: s.id }, s.squads.map((q, i) => squadToRow(s.id, q, i)));
  }
  const squadIds = squadIdsByReg(m);
  const eventRegs = registrations.filter((r) => r.eventId === m.id);
  remoteUpsert('registrations', eventRegs.map((r) => registrationToRow(r, squadIds.get(r.id) ?? null)));
}

export function pushRegistration(r: Registration, squadId: string | null = null) {
  remoteUpsert('registrations', [registrationToRow(r, squadId)]);
}
export function deleteRegistration(id: string) { remoteDelete('registrations', id); }

/** Write ONLY a registration's camp_survey answers, via a targeted column
 *  UPDATE (not the whole-row upsert `pushRegistration` does) — see the long
 *  comment on `registrationToRow` above for why: camp_survey's SELECT
 *  privilege is revoked from anon/authenticated (20260717205348), and an
 *  upsert's ON CONFLICT DO UPDATE needs SELECT on every EXCLUDED column,
 *  while a plain `UPDATE ... SET camp_survey = $1` does not. Call this AFTER
 *  `pushRegistration` for the same reg when both need writing in the same
 *  save — the write queue is strict FIFO per entry (write-queue.ts `process()`
 *  fully resolves each entry, in enqueue order, before starting the next), so
 *  enqueuing this call synchronously right after `pushRegistration(reg)`
 *  guarantees the row exists (or already existed) before the survey column
 *  update runs against it. */
export function pushCampSurvey(regId: string, survey: Registration['campSurvey']) {
  remoteUpdate('registrations', regId, { camp_survey: survey ?? null });
}

/** Scoped camp-survey read (privacy fix, docs/research/2026-07-17-supabomb-
 *  scan-results.md "camp_survey is world-readable"): `camp_survey` is no
 *  longer selectable off the base `registrations` row (loadAll's broad read
 *  excludes it, and the column is REVOKEd from anon/authenticated — see
 *  migration 20260717205348_camp_survey_scoped_read.sql) since that table
 *  carries a public `using (true)` read policy. The self-registration/edit
 *  flows (Events.tsx SelfRegModal, MyRegistrations.tsx EditRegistrationModal)
 *  still need to prefill an athlete's OWN prior answer, so they call this RPC
 *  on demand instead — authorized for the athlete themself, a manager of the
 *  registration's club, or the event's host (mirrors `is_event_host`).
 *  Returns a registrationId → campSurvey map; omit `eventId` to fetch across
 *  every registration the caller may see (used sparingly — callers here
 *  always pass one event). Fails soft ([] map) on error, matching the
 *  read-only, non-blocking nature of a prefill. */
export async function fetchCampSurveys(eventId?: string): Promise<Record<string, Registration['campSurvey'] | null>> {
  if (!supabase) return {};
  const { data, error } = await supabase.rpc('registration_camp_surveys', { p_event_id: eventId ?? null });
  if (error) { console.error('[supabase] registration_camp_surveys failed:', error); return {}; }
  const out: Record<string, Registration['campSurvey'] | null> = {};
  for (const r of (data ?? []) as FnReturns<'registration_camp_surveys'>) {
    out[r.registration_id] = (r.camp_survey as Registration['campSurvey'] | null) ?? null;
  }
  return out;
}

/** B4.4: sync a synchro partner's SY level server-side via
 *  sync_synchro_partner_level — NOT a plain upsert, since the caller
 *  typically doesn't have RLS write access to the PARTNER's own
 *  registration row (a different athlete, often a different club). Pass the
 *  id of the registration the caller just saved (their OWN, which they DO
 *  have access to) plus its SY level; the RPC re-derives the named partner
 *  and authorizes against the caller's own row server-side. See the
 *  migration's comment for the full rationale. */
export function syncSynchroPartnerLevelRemote(myRegId: string, syLevel: string) {
  writeQueue.enqueue({
    kind: 'rpc', table: 'registrations', fn: 'sync_synchro_partner_level',
    args: { p_my_reg_id: myRegId, p_sy_level: syLevel },
  }, 'registrations');
}

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
    decided_at: r.decidedAt ?? null, created_event_id: r.createdEventId ?? null,
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

/** The sanctioning-team roster (sanctioning + admin app_role holders), for the
 *  event-owner assignment dropdown (event-mgmt v2 §B3). Returns [] on error
 *  or when unconfigured. */
export interface SanctioningTeamMember { userId: string; name: string; email: string }
export async function listSanctioningTeam(): Promise<SanctioningTeamMember[]> {
  if (!supabase) return [];
  const { data, error } = await supabase.rpc('list_sanctioning_team');
  if (error) { console.error('[supabase] list_sanctioning_team failed:', error); return []; }
  return ((data ?? []) as { user_id: string; name: string; email: string }[]).map((r) => ({
    userId: r.user_id, name: r.name, email: r.email,
  }));
}

/** Grant per-event admin access (event-mgmt v2 §C) to the account matching
 *  `email` exactly. Awaited (not queued) because the UI needs the matched
 *  identity — or the RPC's raised exception message ("No account found for
 *  that email.") — synchronously to toast. */
export async function grantEventAdmin(
  eventId: string, email: string,
): Promise<{ ok: true; userId: string; email: string; name: string | null } | { ok: false; error: string }> {
  if (!supabase) return { ok: false, error: 'Not configured.' };
  const { data, error } = await supabase.rpc('grant_event_admin', { p_event_id: eventId, p_email: email });
  if (error) { console.error('[supabase] grant_event_admin failed:', error); return { ok: false, error: error.message }; }
  const row = ((data ?? []) as { user_id: string; email: string; name: string | null }[])[0];
  if (!row) return { ok: false, error: 'No account found for that email.' };
  return { ok: true, userId: row.user_id, email: row.email, name: row.name };
}

/** Revoke a per-event admin grant. Returns an error message on failure
 *  (unwrapped from the RPC's raised exception), null on success. */
export async function revokeEventAdmin(eventId: string, userId: string): Promise<string | null> {
  if (!supabase) return 'Not configured.';
  const { error } = await supabase.rpc('revoke_event_admin', { p_event_id: eventId, p_user_id: userId });
  if (error) { console.error('[supabase] revoke_event_admin failed:', error); return error.message; }
  return null;
}

/** One row of the event host viewing page's registration roster (event-mgmt
 *  v2 §C — `event_host_roster` RPC). Column set mirrors the admin CSV export
 *  (Events.tsx exportCsv) plus the reg-identity fields needed to group it. */
export interface HostRosterRow {
  regId: string;
  athleteId: string;
  firstName: string;
  lastName: string;
  clubId: string | null;
  clubName: string | null;
  discipline: string;
  levelId: string | null;
  apparatus: string[];
  apparatusLevels: Record<string, string> | null;
  sessionId: string | null;
  paid: boolean;
  updatedPending: boolean;
  partnerAthleteId: string | null;
  shirt: string | null;
  dietary: string[];
  email: string | null;
  phone: string | null;
  emergencyContact: string | null;
  studentStatus: string | null;
  region: string | null;
  /** Camp-workbook fields (event-mgmt v2 Phase 2 T7) -- added to the RPC
   *  alongside `event_host_addons` in 20260710151638_event_host_addons_and_
   *  camp_detail.sql. Populated for every event, not just camps; the camp
   *  export sheet is simply the only consumer today. */
  dob: string | null;
  gender: string | null;
  campSurvey: Registration['campSurvey'] | null;
  /** Registration `created_at` -- the closest thing to a "date registered"
   *  timestamp (see Registration.createdAt doc comment in types.ts). */
  createdAt: string | null;
}

/** One purchased add-on UNIT (t-shirt/leo/banquet) for an event, across every
 *  competing club (event-mgmt v2 Phase 2 T7) -- `event_host_addons` RPC,
 *  the add-on counterpart to `event_host_roster`. Excludes 'banner' (a flat
 *  per-event purchase, not a per-unit line) and refunded units. */
export interface HostAddonRow {
  itemId: string;
  refLineType: 'tshirt' | 'leo' | 'banquet' | null;
  addonSize: string | null;
  addonAssignee: string | null;
  assigneeFirstName: string | null;
  assigneeLastName: string | null;
  label: string;
  /** Set only for an athlete's own t-shirt/leo self-purchase (see the RPC's
   *  doc comment in 20260710151638_event_host_addons_and_camp_detail.sql) —
   *  distinct from `addonAssignee`, which is banquet-only. */
  refUserId: string | null;
}

/** Event-wide registration roster for the host viewing page (event-mgmt v2
 *  §C) — a deliberate RLS exception (`event_host_roster`, SECURITY DEFINER):
 *  hosts need to see athletes from every competing club, not just their own.
 *  Returns [] on error/unconfigured; callers should still surface a toast by
 *  checking the returned ok flag from the tuple-returning variant if needed —
 *  kept simple (array-only) since the page already gates on caps.isEventHost
 *  before calling, so an error here is an unexpected failure, not an
 *  authorization question. */
export async function fetchEventHostRoster(eventId: string): Promise<{ ok: true; rows: HostRosterRow[] } | { ok: false; error: string }> {
  if (!supabase) return { ok: false, error: 'Not configured.' };
  const { data, error } = await supabase.rpc('event_host_roster', { p_event_id: eventId });
  if (error) { console.error(`[supabase] event_host_roster failed: ${error.message}${error.code ? ` (${error.code})` : ''}`); return { ok: false, error: error.message }; }
  const rows = ((data ?? []) as FnReturns<'event_host_roster'>).map((r) => ({
    regId: r.reg_id, athleteId: r.athlete_id, firstName: r.first_name, lastName: r.last_name,
    clubId: r.club_id, clubName: r.club_name, discipline: r.discipline, levelId: r.level_id,
    apparatus: r.apparatus ?? [], apparatusLevels: (r.apparatus_levels as Record<string, string> | null) ?? null,
    sessionId: r.session_id, paid: !!r.paid, updatedPending: !!r.updated_pending,
    partnerAthleteId: r.partner_athlete_id, shirt: r.shirt, dietary: r.dietary ?? [],
    email: r.email, phone: r.phone, emergencyContact: r.emergency_contact,
    studentStatus: r.student_status, region: r.region,
    dob: r.dob, gender: r.gender,
    campSurvey: (r.camp_survey as Registration['campSurvey'] | null) ?? null,
    createdAt: r.created_at,
  }));
  return { ok: true, rows };
}

/** Purchased add-on units (t-shirt/leo/banquet) for an event, across every
 *  competing club (event-mgmt v2 Phase 2 T7) — same RLS-exception reasoning
 *  as `fetchEventHostRoster`, via the `event_host_addons` RPC. */
export async function fetchEventHostAddons(eventId: string): Promise<{ ok: true; rows: HostAddonRow[] } | { ok: false; error: string }> {
  if (!supabase) return { ok: false, error: 'Not configured.' };
  const { data, error } = await supabase.rpc('event_host_addons', { p_event_id: eventId });
  if (error) { console.error(`[supabase] event_host_addons failed: ${error.message}${error.code ? ` (${error.code})` : ''}`); return { ok: false, error: error.message }; }
  const rows = ((data ?? []) as FnReturns<'event_host_addons'>).map((r) => ({
    itemId: r.item_id,
    refLineType: (r.ref_line_type as HostAddonRow['refLineType']) ?? null,
    addonSize: r.addon_size,
    addonAssignee: r.addon_assignee,
    assigneeFirstName: r.assignee_first_name,
    assigneeLastName: r.assignee_last_name,
    label: r.label,
    refUserId: r.ref_user_id,
  }));
  return { ok: true, rows };
}

/** Total collected so far for an event through the platform (dollars,
 *  excluding processing/service fees) — for the host status card. */
export async function fetchEventCollectedTotal(eventId: string): Promise<{ ok: true; total: number } | { ok: false; error: string }> {
  if (!supabase) return { ok: false, error: 'Not configured.' };
  const { data, error } = await supabase.rpc('event_collected_total', { p_event_id: eventId });
  if (error) { console.error('[supabase] event_collected_total failed:', error); return { ok: false, error: error.message }; }
  return { ok: true, total: Number(data ?? 0) };
}

/** Mark the host as having received the medals shipment — the host's one
 *  scoped write on the event-mgmt v2 §C host page (they can't UPDATE events
 *  directly; see `mark_medals_received`). Returns an error message on
 *  failure, null on success. */
export async function markMedalsReceived(eventId: string): Promise<string | null> {
  if (!supabase) return 'Not configured.';
  const { error } = await supabase.rpc('mark_medals_received', { p_event_id: eventId });
  if (error) { console.error('[supabase] mark_medals_received failed:', error); return error.message; }
  return null;
}

/** Add/edit a registration through the host roster tool (event-mgmt v2 P1
 *  Task 8, spec §C). Applies ONLY the server whitelist (athlete/club/
 *  discipline/level/apparatus/apparatus_levels/session/partner) -- paid/
 *  updated_pending/refunded are never touched by this path. A brand-new
 *  host-added registration lands `paid: true` with no cart line/fee (see
 *  `host_upsert_registration`'s migration comment for the payment-semantics
 *  decision). Awaited (not queued) so the caller can toast the RPC's raised
 *  message synchronously. Returns an error message on failure, null on
 *  success. */
export async function hostUpsertRegistration(eventId: string, reg: Registration): Promise<string | null> {
  if (!supabase) return 'Not configured.';
  const payload = {
    id: reg.id, event_id: reg.eventId, athlete_id: reg.athleteId, club_id: reg.clubId,
    discipline: reg.discipline, level_id: reg.levelId, apparatus: reg.apparatus,
    apparatus_levels: reg.apparatusLevels ?? null, session_id: reg.sessionId || null,
    partner_athlete_id: reg.partnerAthleteId ?? null,
  };
  const { error } = await supabase.rpc('host_upsert_registration', { p_event_id: eventId, p_reg: payload });
  if (error) { console.error('[supabase] host_upsert_registration failed:', error); return error.message; }
  return null;
}

/** Remove a registration through the host roster tool -- a hard delete with
 *  NO refund/payment side effect (refunds are a Phase 3 feature; see
 *  `host_delete_registration`'s migration comment). Returns an error message
 *  on failure, null on success. */
export async function hostDeleteRegistration(eventId: string, regId: string): Promise<string | null> {
  if (!supabase) return 'Not configured.';
  const { error } = await supabase.rpc('host_delete_registration', { p_event_id: eventId, p_reg_id: regId });
  if (error) { console.error('[supabase] host_delete_registration failed:', error); return error.message; }
  return null;
}

/** Resolve an existing account by exact email for the host roster tool's
 *  "add athlete by email" flow (mirrors grantEventAdmin's exact-email-only
 *  lookup -- no general people-search exposed to a host). */
export async function findPersonForHost(
  eventId: string, email: string,
): Promise<{ ok: true; personId: string; firstName: string; lastName: string; clubId: string | null } | { ok: false; error: string }> {
  if (!supabase) return { ok: false, error: 'Not configured.' };
  const { data, error } = await supabase.rpc('find_person_for_host', { p_event_id: eventId, p_email: email });
  if (error) { console.error('[supabase] find_person_for_host failed:', error); return { ok: false, error: error.message }; }
  const row = ((data ?? []) as FnReturns<'find_person_for_host'>)[0];
  if (!row) return { ok: false, error: 'No account found for that email.' };
  return { ok: true, personId: row.person_id, firstName: row.first_name, lastName: row.last_name, clubId: row.club_id };
}

const INSURANCE_CERT_ALLOWED_EXT = ['pdf', 'jpg', 'jpeg', 'png'];
const INSURANCE_CERT_MAX_BYTES = 10 * 1024 * 1024; // 10MB

/** Upload an insurance certificate to the private `event-files` bucket
 *  (event-mgmt v2 §C / §B4) under `insurance/<eventId>/<filename>` and
 *  return the stored path (saved onto the owner checklist's `filePath`).
 *  Only sanctioning/admin callers pass the storage RLS insert policy
 *  (20260709210935_event_files_bucket.sql) — a host/member caller gets a
 *  storage error, unwrapped here into a readable message. Validates
 *  extension + a ~10MB size cap client-side (the source of truth is still
 *  the storage policy, this is just a friendlier error before the round trip). */
export async function uploadInsuranceCertificate(eventId: string, file: File): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  if (!supabase) return { ok: false, error: 'Not configured.' };
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  if (!INSURANCE_CERT_ALLOWED_EXT.includes(ext)) {
    return { ok: false, error: 'Only PDF, JPG, or PNG files are allowed.' };
  }
  if (file.size > INSURANCE_CERT_MAX_BYTES) {
    return { ok: false, error: 'File is too large — the limit is 10MB.' };
  }
  const sanitized = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = `insurance/${eventId}/${sanitized}`;
  const { error } = await supabase.storage.from('event-files').upload(path, file, { upsert: true });
  if (error) { console.error('[supabase] uploadInsuranceCertificate failed:', error); return { ok: false, error: error.message }; }
  return { ok: true, path };
}

/** Resolve a signed, time-limited URL for a stored insurance certificate
 *  (bucket is private — there is no public URL). ~10 minute expiry, so
 *  callers should resolve on click/open, not cache it on render. */
export async function insuranceCertificateUrl(path: string): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  if (!supabase) return { ok: false, error: 'Not configured.' };
  const { data, error } = await supabase.storage.from('event-files').createSignedUrl(path, 600);
  if (error || !data?.signedUrl) { console.error('[supabase] insuranceCertificateUrl failed:', error); return { ok: false, error: error?.message ?? 'Could not open the certificate.' }; }
  return { ok: true, url: data.signedUrl };
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

export interface SendEventEmailResult {
  ok: boolean;
  sent: number;
  failed: number;
  recipientCount: number;
  error?: string;
}

/** Send (or test-send) an event-scoped email via the send-event-email Edge
 *  Function (event-mgmt v2 §J). Recipients are resolved SERVER-SIDE from the
 *  event's registrations + the given filters — the client never sends a
 *  recipient list. Caller must be an admin, sanctioning, manage the event's
 *  host club, or hold an event_admins grant (the function re-checks). */
export async function sendEventEmail(args: {
  eventId: string;
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  fromAlias?: string;
  cc?: string[];
  filters: { roles: ('athlete' | 'manager' | 'clubEmail')[]; sessionIds?: string[]; levelIds?: string[]; disciplines?: string[] };
  test?: boolean;
}): Promise<SendEventEmailResult> {
  if (!supabase) return { ok: false, sent: 0, failed: 0, recipientCount: 0, error: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('send-event-email', { body: args });
  if (error) return { ok: false, sent: 0, failed: 0, recipientCount: 0, error: await edgeErrorMessage(error) };
  const result = data as { sent: number; failed: number; recipientCount: number };
  return { ok: true, ...result };
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

/** Like `edgeErrorMessage`, but also returns the parsed JSON body (if any) so
 *  a caller that cares about a structured `code` field (event-mgmt v2 P4 T6:
 *  `create-checkout-session`'s `capacity-exceeded`/`session-required`
 *  rejections) can branch on it instead of string-matching `error`. */
async function edgeErrorBody(error: { message: string }): Promise<{ message: string; body?: Record<string, unknown> }> {
  let msg = error.message;
  let body: Record<string, unknown> | undefined;
  try {
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === 'function') {
      body = await ctx.json();
      if (body?.error) msg = String(body.error);
    }
  } catch { /* fall back to error.message */ }
  return { message: msg, body };
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

/** Start a Stripe Embedded Checkout for the given MEMBERSHIP cart items (Phase
 *  S2). The server recomputes every amount from pricing.ts (the cart's display
 *  amounts are never trusted), adds the service fee, creates the session, and
 *  inserts a `pending` payments row. Returns the session `client_secret` for the
 *  embedded form plus the payment row id the FE polls (self-read RLS) until
 *  `status='paid'`. The verified `stripe-webhook` is the sole completer.
 *
 *  **Free-order path (emv2 P3):** when a coupon reduces the total to exactly
 *  $0, the server fulfills the order directly and returns `free: true` with
 *  no `clientSecret` — the caller must check `free` and skip mounting Stripe
 *  entirely (see `CartCheckout.tsx`). The payment row is already `paid` by
 *  the time this resolves. */
/** A rejected checkout because the cart's own registrations would blow a
 *  configured capacity cap at `eventId` (event-mgmt v2 P4 T6). `violations`
 *  names exactly which caps and by how much — see `CapacityViolation`. */
export interface CheckoutCapacityError {
  code: 'capacity-exceeded';
  eventId: string;
  eventName: string;
  violations: CapacityViolation[];
}

/** A rejected checkout because a by-session event has an entry with no (or an
 *  invalid) session picked — a structural error, not a capacity overage. */
export interface CheckoutSessionRequiredError {
  code: 'session-required';
  eventId: string;
  eventName: string;
  regIds: string[];
}

/** A rejected checkout because a nationals event in the cart has an
 *  unanswered required session-planning survey (event-mgmt v2 Phase 5 A3,
 *  spec §L.1/§E5.4). The client normally catches this in advance (see
 *  `missingNationalsSurveyEvents` in `pricing.ts`, checked before this
 *  request is even sent) — this is the server-authoritative fallback for
 *  anything the advisory check missed (e.g. a survey answered/unanswered by
 *  someone else between the check and the request). */
export interface CheckoutSurveyRequiredError {
  code: 'session-survey-required';
  eventId: string;
  eventName: string;
  missing: string[];
}

export async function createCheckoutSession(args: {
  cartItemIds: string[];
  couponCode?: string;
}): Promise<{
  ok: boolean; clientSecret?: string; sessionId?: string; paymentId?: string; free?: boolean;
  amountSubtotal?: number; discountAmount?: number; serviceFee?: number; error?: string;
  capacityError?: CheckoutCapacityError; sessionRequiredError?: CheckoutSessionRequiredError;
  surveyRequiredError?: CheckoutSurveyRequiredError;
}> {
  if (!supabase) return { ok: false, error: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('create-checkout-session', { body: args });
  if (error) {
    const { message, body } = await edgeErrorBody(error);
    if (body?.code === 'capacity-exceeded') {
      return {
        ok: false, error: message,
        capacityError: {
          code: 'capacity-exceeded',
          eventId: body.eventId as string,
          eventName: body.eventName as string,
          violations: (body.violations as CapacityViolation[]) ?? [],
        },
      };
    }
    if (body?.code === 'session-required') {
      return {
        ok: false, error: message,
        sessionRequiredError: {
          code: 'session-required',
          eventId: body.eventId as string,
          eventName: body.eventName as string,
          regIds: (body.regIds as string[]) ?? [],
        },
      };
    }
    if (body?.code === 'session-survey-required') {
      return {
        ok: false, error: message,
        surveyRequiredError: {
          code: 'session-survey-required',
          eventId: body.eventId as string,
          eventName: body.eventName as string,
          missing: (body.missing as string[]) ?? [],
        },
      };
    }
    return { ok: false, error: message };
  }
  return data as {
    ok: boolean; clientSecret?: string; sessionId?: string; paymentId?: string; free?: boolean;
    amountSubtotal?: number; discountAmount?: number; serviceFee?: number;
  };
}

/** One server-priced line from a `mode:'preview'` call, keyed to a cart item. */
export interface CartPreviewLine {
  itemId: string;
  label: string;
  amountCents: number;
}

/** Price a set of cart items exactly the way checkout would, WITHOUT starting
 *  a checkout (S4, money-story UX): `create-checkout-session { mode:
 *  'preview' }` runs the same auth/ownership/validation and pricing recompute
 *  and returns before any write — no payments row, no Stripe call, no coupon
 *  redemption. Used by the Cart page to replace the stale, client-written
 *  `cart_items.amount` with the server's real price so the cart and the
 *  checkout summary can never disagree (`diffCartLinePrices` in `pricing.ts`
 *  does the comparison). On ANY failure (network, validation rejection, capacity
 *  conflict, etc.) the caller should fall back to the stored "Estimated"
 *  amounts — a failed preview must never block or empty the cart. */
export async function previewCartTotal(args: {
  cartItemIds: string[];
  couponCode?: string;
}): Promise<{
  ok: boolean; lines?: CartPreviewLine[];
  amountSubtotal?: number; discountAmount?: number; serviceFee?: number; total?: number;
  error?: string;
}> {
  if (!supabase) return { ok: false, error: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('create-checkout-session', {
    body: { ...args, mode: 'preview' },
  });
  if (error) return { ok: false, error: await edgeErrorMessage(error) };
  return data as {
    ok: boolean; lines?: CartPreviewLine[];
    amountSubtotal?: number; discountAmount?: number; serviceFee?: number; total?: number;
  };
}

/** Poll a payment row's fulfillment status (Phase S3). The signed-in person can
 *  self-read their own payments rows (RLS: person_id = my_person_id()); the
 *  embedded-checkout FE polls this after `onComplete` until `status='paid'`
 *  (webhook fulfilled) or `'failed'`. Returns null on error / not-found. */
export async function fetchPaymentStatus(
  paymentId: string,
): Promise<{ status: Payment['status']; invoiceId: string | null } | null> {
  if (!supabase) return null;
  const { data, error } = await supabase
    .from('payments')
    .select('status, invoice_id')
    .eq('id', paymentId)
    .maybeSingle();
  if (error || !data) return null;
  return {
    status: (data as { status: Payment['status'] }).status,
    invoiceId: (data as { invoice_id: string | null }).invoice_id ?? null,
  };
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

/** Admin-only break-glass: deletes ALL of the target auth user's MFA factors
 *  and emails them a notice (auth-hardening Phase B). Pass either id. */
export async function adminResetMfa(
  target: { targetUserId: string } | { targetEmail: string },
): Promise<{ ok: boolean; removedCount?: number; error?: string }> {
  if (!supabase) return { ok: false, error: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('admin-reset-mfa', { body: target });
  if (error) return { ok: false, error: await edgeErrorMessage(error) };
  return data as { ok: boolean; removedCount?: number; error?: string };
}

/** Manifest returned by `admin-delete-person` — counts of what was deleted vs
 *  anonymized, what was deliberately kept as-is, and whether the auth user /
 *  the `people` row itself were removed (personDeleted: false = tombstoned
 *  in place instead, because financial/competition/legal records still
 *  reference this id). See supabase/functions/admin-delete-person/index.ts. */
export interface AdminDeletePersonManifest {
  deleted: Record<string, number>;
  anonymized: Record<string, number>;
  kept: string[];
  authUserDeleted: boolean;
  personDeleted: boolean;
  alreadyTombstoned: boolean;
}

/** Admin-only, admin role required (NOT finance_admin): delete/anonymize a
 *  person per F5 (GDPR/COPPA-adjacent data-deletion request). `confirmName`
 *  must match the person's CURRENT full name — the server re-checks it. */
export async function adminDeletePerson(
  args: { personId: string; confirmName: string },
): Promise<{ ok: boolean; manifest?: AdminDeletePersonManifest; error?: string }> {
  if (!supabase) return { ok: false, error: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('admin-delete-person', { body: args });
  if (error) return { ok: false, error: await edgeErrorMessage(error) };
  return data as { ok: boolean; manifest?: AdminDeletePersonManifest; error?: string };
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
  /** Set for event-scoped sends (EventCommunicate page) — lets the per-event
   *  sent log filter to just this event's rows (event-mgmt v2 §J). Absent
   *  for the league Communicate tool's org-wide sends. */
  eventId?: string | null;
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
      event_id: entry.eventId ?? null,
    });
  } catch (e) { console.error('[supabase] logComm failed:', e); }
}

/** The signed-in user's communication history (admins see all, via RLS).
 *  Pass `eventId` to filter to one event's sends (EventCommunicate page). */
export async function fetchCommLog(limit = 100, eventId?: string): Promise<(CommLogEntry & { id: string; sentAt: string })[]> {
  if (!supabase) return [];
  let q = supabase.from('comm_log').select('*').order('sent_at', { ascending: false }).limit(limit);
  if (eventId) q = q.eq('event_id', eventId);
  const { data, error } = await q;
  if (error) { console.error('[supabase] fetchCommLog failed:', error); return []; }
  return (data ?? []).map((r) => ({
    id: r.id, sentAt: r.sent_at, channel: r.channel, isTest: r.is_test, subject: r.subject, body: r.body,
    recipientCount: r.recipient_count, sentCount: r.sent_count, failedCount: r.failed_count,
    recipients: (r.recipients ?? []) as { name: string; contact: string }[], error: r.error,
    segments: r.segments ?? null, encoding: r.encoding ?? null, costEstimate: r.cost_estimate ?? null,
    eventId: r.event_id ?? null,
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

/** No-login check of whether an email has a sign-in account (auth.users),
 *  used on a failed sign-in to show "No account exists for that email"
 *  instead of a generic wrong-password error. Account-enumeration via this
 *  check is an accepted tradeoff (confirmed with Nate) — defaults to `true`
 *  (i.e. falls back to the generic error) on any failure so we never
 *  incorrectly claim "no account" for a real one. */
export async function emailHasAccount(email: string): Promise<boolean> {
  if (!supabase) return true;
  const { data, error } = await supabase.rpc('email_has_account', { p_email: email });
  if (error) { console.error('[supabase] email_has_account failed:', error); return true; }
  return data === true;
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

// ---------------------------------------------------------------------------
// Judge — codeless access (2026-07-19) — Edge Function invokers
// ---------------------------------------------------------------------------
/** No-login unlock: resolve a 6-digit code or a long access token to an
 *  event + the long token (always store THAT, never the short code — the
 *  code isn't globally unique). Called anonymously from the `/judge/access/
 *  :token` link, a scanned QR, or the inline code field on `/judge`. */
export async function judgeUnlock(args: { code?: string; token?: string }): Promise<{ ok: boolean; eventId?: string; token?: string; error?: string }> {
  if (!supabase) return { ok: false, error: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('judge-entry', { body: { op: 'unlock', ...args } });
  if (error) return { ok: false, error: await edgeErrorMessage(error) };
  return data as { ok: boolean; eventId?: string; token?: string; error?: string };
}

/** No-login score submission for a codeless-unlocked device — the server
 *  re-validates everything (token active, registration/apparatus match,
 *  numeric bounds) via judge-entry-core.ts and stamps `entered_by` itself;
 *  nothing here is trusted, this is just the wire shape. */
export async function judgeSubmitScore(args: {
  token: string; regId: string; apparatus: string;
  sv: number | null; deductions: number | null; eScore?: number | null; final: number | null;
  source?: string; calc?: string; calcState?: unknown; flashed?: boolean; scratched?: boolean;
  /** Second judge panel's raw execution inputs (2026-07-19 scoring config). */
  deductions2?: number | null; eScore2?: number | null;
}): Promise<{ ok: boolean; error?: string }> {
  if (!supabase) return { ok: false, error: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('judge-entry', { body: { op: 'submit', ...args } });
  if (error) return { ok: false, error: await edgeErrorMessage(error) };
  return data as { ok: boolean; error?: string };
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

/** Request a refund on a paid registration entry or a purchased add-on line
 *  (event-mgmt v2 Phase 3, spec §H). Server resolves ownership/authorization
 *  and eligibility (host club must be the league's own — `is_league_host`);
 *  creates a `refund_requests` row and emails the requester + refund managers.
 *  Does NOT itself process the refund — that's the review flow (T6). Pass
 *  `clubId` when requesting on behalf of an athlete from a club-manager
 *  context (the server verifies the caller actually manages that club before
 *  honoring it — a mismatched clubId is simply ignored server-side). */
export async function requestRefund(args: {
  kind: 'registration' | 'addon';
  regId?: string;
  invoiceItemId?: string;
  reason: 'injury' | 'illness' | 'bereavement' | 'other';
  reasonDetail?: string;
  clubId?: string;
}): Promise<{ ok: boolean; requestId?: string; error?: string }> {
  if (!supabase) return { ok: false, error: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('request-refund', { body: args });
  if (error) return { ok: false, error: await edgeErrorMessage(error) };
  return data as { ok: boolean; requestId?: string; error?: string };
}

/** Approve or reject a pending refund request (event-mgmt v2 Phase 3, spec §H,
 *  T6). Refund-manager/admin only, enforced server-side. Approve computes the
 *  refund (100%/75% by the event's `lastDateToEdit`, capped at what's left on
 *  the payment), calls Stripe, and applies the item/registration state change;
 *  reject just declines with no item/registration change (beyond clearing
 *  `refund_requested`). Caller should `syncFromSupabase()` afterward to pick
 *  up the new `refund_requests`/registrations/invoice_items state. */
export async function processRefund(
  requestId: string,
  action: 'approve' | 'reject',
): Promise<{ ok: boolean; refundAmountCents?: number; stripeRefundId?: string | null; error?: string }> {
  if (!supabase) return { ok: false, error: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('process-refund', { body: { requestId, action } });
  if (error) return { ok: false, error: await edgeErrorMessage(error) };
  return data as { ok: boolean; refundAmountCents?: number; stripeRefundId?: string | null; error?: string };
}

/** Admin/sanctioning-only waitlist override (event-mgmt v2 P4 T7): 'promote'
 *  force-notifies a 'waiting' group right now, IGNORING capacity; 'requeue'
 *  forces a 'notified' group back to 'waiting' at the back of the queue.
 *  Server-side authz + the actual DB writes (waitlist_groups' RLS only lets a
 *  client cancel its OWN group) — this is the one legitimate override path. */
export async function manageWaitlist(
  groupId: string,
  action: 'promote' | 'requeue',
): Promise<{ ok: boolean; status?: string; holdExpiresAt?: string; queuedAt?: string; error?: string }> {
  if (!supabase) return { ok: false, error: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('manage-waitlist', { body: { groupId, action } });
  if (error) return { ok: false, error: await edgeErrorMessage(error) };
  return data as { ok: boolean; status?: string; holdExpiresAt?: string; queuedAt?: string; error?: string };
}

/** One row of the event waitlist queue as returned by manage-waitlist's
 *  read-only 'list' action (names/counts resolved server-side). */
export interface WaitlistQueueRow {
  id: string;
  clubId: string | null;
  personId: string | null;
  name: string;
  discipline: string;
  levelId: string | null;
  sessionId: string | null;
  status: 'waiting' | 'notified';
  queuedAt: string;
  notifiedAt: string | null;
  holdExpiresAt: string | null;
  regCount: number;
}

/** Event waitlist queue (event-mgmt v2 P4 T7), served by the manage-waitlist
 *  edge function's 'list' action rather than a client waitlist_groups read —
 *  the table's RLS deliberately only exposes a group to its OWN club/person
 *  (plus admins), so hosts/sanctioning get visibility through this
 *  server-side-authorized read (admin/sanctioning/host manager/event-admin
 *  grantee) instead of an RLS relaxation. `canManage` reports whether the
 *  caller may promote/requeue (admin/sanctioning). */
export async function fetchEventWaitlist(
  eventId: string,
): Promise<{ ok: boolean; canManage?: boolean; groups?: WaitlistQueueRow[]; error?: string }> {
  if (!supabase) return { ok: false, error: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('manage-waitlist', { body: { action: 'list', eventId } });
  if (error) return { ok: false, error: await edgeErrorMessage(error) };
  return data as { ok: boolean; canManage?: boolean; groups?: WaitlistQueueRow[]; error?: string };
}

// --- Payments reconciliation (F4) -------------------------------------------
// admin/finance_admin only, enforced server-side. Read-only against Stripe;
// writes go through the shared idempotent fulfillPayment core ('refulfill')
// or a bookkeeping-only status/note update ('mark-refunded') — see
// supabase/functions/reconcile-payments/index.ts for the full contract.

/** One stuck-pending payment row from the 'scan' op. */
export interface ReconStuckPendingRow {
  id: string;
  createdAt: string;
  amountSubtotal: number | null;
  serviceFee: number | null;
  currency: string;
  personId: string | null;
  clubId: string | null;
  stripeSessionId: string | null;
}

/** One Stripe-vs-our-records drift verdict from the 'scan' op. See
 *  `src/lib/reconciliation.ts` for verdict semantics. */
export interface ReconDriftRow {
  id: string;
  createdAt: string;
  personId: string | null;
  totalChargedCents: number;
  ourApprovedRefundedCents: number;
  stripeRefundedCents: number;
  verdict: 'consistent' | 'dashboard-refund-drift-partial' | 'dashboard-refund-drift-full' | 'record-ahead-of-stripe';
}

/** Scan for stuck-pending payments (unconditional) and refund drift within
 *  the last `days` (default 90, server-capped 365). On-demand only — never
 *  call this automatically on mount (it does up to ~100 live Stripe lookups). */
export async function reconcileScan(days?: number): Promise<{
  ok: boolean; stuckPending?: ReconStuckPendingRow[]; driftRows?: ReconDriftRow[];
  truncated?: boolean; scannedDays?: number; scannedCount?: number; error?: string;
}> {
  if (!supabase) return { ok: false, error: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('reconcile-payments', { body: { op: 'scan', days } });
  if (error) return { ok: false, error: await edgeErrorMessage(error) };
  return data as Awaited<ReturnType<typeof reconcileScan>>;
}

/** Re-run fulfillment for a stuck-pending payment (Panel A action). Re-checks
 *  the Stripe session server-side FIRST; only fulfills if Stripe says paid.
 *  Caller should `syncFromSupabase()` afterward on success. */
export async function reconcileRefulfill(paymentId: string): Promise<{
  ok: boolean; fulfilled?: boolean; verdict?: string; stripePaymentStatus?: string; stripeSessionStatus?: string; error?: string;
}> {
  if (!supabase) return { ok: false, error: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('reconcile-payments', { body: { op: 'refulfill', paymentId } });
  if (error) return { ok: false, error: await edgeErrorMessage(error) };
  return data as Awaited<ReturnType<typeof reconcileRefulfill>>;
}

/** Reflect a CONFIRMED Stripe-Dashboard-side refund into `payments` (Panel B
 *  action) — bookkeeping alignment only; does NOT touch registrations/
 *  memberships/invoices. Server re-verifies against Stripe before writing.
 *  Caller should `syncFromSupabase()` afterward on success. */
export async function reconcileMarkRefunded(paymentId: string, note?: string): Promise<{
  ok: boolean; verdict?: string; statusChanged?: boolean; stripeRefundedCents?: number; ourApprovedRefundedCents?: number; error?: string;
}> {
  if (!supabase) return { ok: false, error: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('reconcile-payments', { body: { op: 'mark-refunded', paymentId, note } });
  if (error) return { ok: false, error: await edgeErrorMessage(error) };
  return data as Awaited<ReturnType<typeof reconcileMarkRefunded>>;
}

/** Token lookup for the guardian signing page via SECURITY DEFINER RPC
 *  (the table itself is not publicly readable). */
export async function fetchSignRequest(token: string): Promise<FnReturns<'get_waiver_sign_request'>[number] | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.rpc('get_waiver_sign_request', { p_token: token });
  if (error) { console.error('[supabase] fetchSignRequest failed:', error); return null; }
  return (data as FnReturns<'get_waiver_sign_request'> | null)?.[0] ?? null;
}

/** Submit an in-app "Report a problem" note (nav-drawer entry point, any
 *  signed-in user). The server derives the reporter's identity from the JWT
 *  (never trusts a client-sent name/email) and routes the email by category. */
export async function reportProblem(args: {
  category: 'bug' | 'question' | 'unsure';
  description: string;
  route: string;
  appVersion: string;
  recentErrors: { message: string; at: string }[];
  /** Optional screenshots (compressed client-side to JPEG, max 3 / 2MB each —
   *  see src/lib/image-resize.ts). The server re-validates size/type/magic
   *  bytes; this is UX-only, not a trust boundary. */
  attachments?: { name: string; type: 'image/jpeg' | 'image/png' | 'image/webp'; dataBase64: string }[];
}): Promise<{ ok: boolean; error?: string }> {
  if (!supabase) return { ok: false, error: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('report-problem', { body: args });
  if (error) return { ok: false, error: await edgeErrorMessage(error) };
  return data as { ok: boolean; error?: string };
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
      eventsR, sessionsR, squadsR, registrationsR, scoresR, couponsR, cartItemsR, invoicesR, invoiceItemsR,
      clubRequestsR, appSettingsR, accountInvitesR, sanctionRequestsR, sanctionVotesR,
      waiverDocsR, waiverSigsR, clubMembershipsR, paymentsR, eventAdminsR, refundRequestsR, waitlistGroupsR,
      sessionRequestsR, competitionOrdersR, finalsLineupsR, eventCheckinsR, accountingCodesR, hostPayoutsR,
      judgeAccessCodesR,
    ] = await Promise.all([
      fetchAllRows<Row<'seasons'>>('seasons'),
      fetchAllRows<Row<'levels'>>('levels'),
      fetchAllRows<Row<'clubs'>>('clubs'),
      fetchAllRows<Row<'club_managers'>>('club_managers'),
      fetchAllRows<Row<'people'>>('people'),
      fetchAllRows<Row<'person_alt_clubs'>>('person_alt_clubs'),
      fetchAllRows<Row<'memberships'>>('memberships'),
      fetchAllRows<Row<'events'>>('events'),
      // event_sessions: `any` (not a stricter Row<'event_sessions'>) deliberately —
      // this table's generated `phase` column type (`string | null`) is looser than
      // the app-level EventSession['phase'] literal union, and the object-building
      // code below already assumes the looser typing the (untyped) Supabase client
      // gave every table before this fetch-mechanism change. Fixing that typing gap
      // is out of scope here (no shape changes).
      fetchAllRows<any>('event_sessions'), // eslint-disable-line @typescript-eslint/no-explicit-any
      fetchAllRows<Row<'squads'>>('squads'),
      fetchAllRows<RegistrationRowMaybeSurvey>('registrations', REGISTRATION_COLUMNS_NO_SURVEY),
      fetchAllRows<Row<'scores'>>('scores'),
      fetchAllRows<Row<'coupons'>>('coupons'),
      fetchAllRows<Row<'cart_items'>>('cart_items'),
      fetchAllRows<Row<'invoices'>>('invoices'),
      fetchAllRows<Row<'invoice_items'>>('invoice_items'),
      fetchAllRows<Row<'club_requests'>>('club_requests'),
      fetchAllRows<Row<'app_settings'>>('app_settings'),       // 0007; tolerated if absent
      fetchAllRows<Row<'account_invites'>>('account_invites'),     // 0007; tolerated if absent
      fetchAllRows<Row<'sanction_requests'>>('sanction_requests'),   // 0008; tolerated if absent
      fetchAllRows<Row<'sanction_votes'>>('sanction_votes'),      // 0008; tolerated if absent
      fetchAllRows<Row<'waiver_documents'>>('waiver_documents'),    // tolerated if absent
      fetchAllRows<Row<'waiver_signatures'>>('waiver_signatures'),   // tolerated if absent
      fetchAllRows<Row<'club_memberships'>>('club_memberships'),    // tolerated if absent
      // payments / event_admins onward: several of these tables (see comment above
      // rowToRefundRequest, ~line 546) predate database.types.ts regeneration, so
      // there is no Row<'table'> to key off — use each table's own rowToX mapper
      // parameter type instead (Parameters<typeof rowToX>[0]) so the fetched shape
      // stays in lockstep with what the mapper already declares it needs.
      fetchAllRows<Parameters<typeof rowToPayment>[0]>('payments'),            // S1; tolerated if absent
      fetchAllRows<Row<'event_admins'>>('event_admins'),        // emv2 P1 T3; tolerated if absent
      fetchAllRows<Parameters<typeof rowToRefundRequest>[0]>('refund_requests'),     // emv2 P3 T4; tolerated if absent (not in generated types)
      fetchAllRows<Parameters<typeof rowToWaitlistGroup>[0]>('waitlist_groups'),     // emv2 P4 T1; tolerated if absent (not in generated types)
      fetchAllRows<Parameters<typeof rowToSessionRequest>[0]>('session_requests'),    // emv2 P5 A1; tolerated if absent (not in generated types)
      fetchAllRows<Parameters<typeof rowToCompetitionOrder>[0]>('competition_orders'),  // emv2 P5 B1; tolerated if absent (not in generated types)
      fetchAllRows<Parameters<typeof rowToFinalsLineup>[0]>('finals_lineups'),      // emv2 P5 C1; tolerated if absent (not in generated types)
      fetchAllRows<Parameters<typeof rowToEventCheckin>[0]>('event_checkins'),      // emv2 P5 E1; tolerated if absent (not in generated types)
      fetchAllRows<Parameters<typeof rowToAccountingCode>[0]>('accounting_codes'),    // emv2 P6 T1; tolerated if absent (not in generated types)
      fetchAllRows<Parameters<typeof rowToHostPayout>[0]>('host_payouts'),        // emv2 P6 T1; tolerated if absent (not in generated types)
      fetchAllRows<Parameters<typeof rowToJudgeAccessCode>[0]>('judge_access_codes'),  // 2026-07-19; RLS-empty for non-hosts, tolerated if absent (not in generated types)
    ]);

    // club_requests may not exist on a pre-0005 DB — tolerate its error, fail on the rest.
    const errors = [
      seasonsR, levelsR, clubsR, clubManagersR, peopleR, altClubsR, membershipsR,
      eventsR, sessionsR, squadsR, registrationsR, scoresR, couponsR, cartItemsR, invoicesR, invoiceItemsR,
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
      dob: r.dob ?? '', gender: r.gender as Athlete['gender'], placement: (r.placement ?? {}) as Athlete['placement'], gradYear: r.grad_year ?? 0,
      studentStatus: (r.student_status ?? '') as Athlete['studentStatus'], shirt: r.shirt ?? '', country: r.country ?? '', state: r.state ?? '',
      outsideUs: (r as { outside_us?: boolean }).outside_us ?? false,
      phone: r.phone ?? '', smsConsent: r.sms_consent ?? false, smsConsentAt: r.sms_consent_at ?? null,
      mainClubId: r.main_club_id, altClubIds: altClubsByPerson.get(r.id) ?? [],
      levels: (r.levels ?? {}) as Athlete['levels'], emergency: (r.emergency ?? { contact: '', relation: '', phone: '' }) as Athlete['emergency'],
      dietary: (r.dietary ?? []) as Athlete['dietary'], dietaryNotes: r.dietary_notes ?? '',
      memberships: membershipsByPerson.get(r.id) ?? [], achievements: (r.achievements ?? []) as Athlete['achievements'],
    }));

    const squadsBySession = new Map<string, Event['sessions'][number]['squads']>();
    for (const r of (squadsR.data ?? []).sort((a: Row<'squads'>, b: Row<'squads'>) => a.sort_order - b.sort_order)) {
      const arr = squadsBySession.get(r.session_id) ?? [];
      arr.push({ id: r.id, name: r.name, startEvent: r.start_event, athleteRegIds: [], holding: r.holding });
      squadsBySession.set(r.session_id, arr);
    }
    // Place registrations into squads via registrations.squad_id
    const squadById = new Map<string, Event['sessions'][number]['squads'][number]>();
    for (const arr of squadsBySession.values()) for (const q of arr) squadById.set(q.id, q);
    for (const r of registrationsR.data ?? []) {
      if (r.squad_id && squadById.has(r.squad_id)) squadById.get(r.squad_id)!.athleteRegIds.push(r.id);
    }

    const sessionsByEvent = new Map<string, Event['sessions']>();
    for (const r of (sessionsR.data ?? []).sort((a: Row<'event_sessions'>, b: Row<'event_sessions'>) => a.sort_order - b.sort_order)) {
      const arr = sessionsByEvent.get(r.event_id) ?? [];
      arr.push({
        id: r.id, name: r.name, discipline: r.discipline, date: r.date ?? '', time: r.time ?? '',
        levelIds: r.level_ids ?? [], squads: squadsBySession.get(r.id) ?? [],
        ...(r.phase ? { phase: r.phase } : {}),
        ...((r as { max_routines?: Record<string, number> | null }).max_routines
          ? { maxRoutines: (r as { max_routines?: Record<string, number> | null }).max_routines as Record<string, number> }
          : {}),
      });
      sessionsByEvent.set(r.event_id, arr);
    }

    const events: Event[] = (eventsR.data ?? []).map((r: Row<'events'>) => ({
      id: r.id, slug: r.slug, name: r.name, hostClubId: r.host_club_id ?? '', city: r.city ?? '',
      state: r.state ?? '', timezone: r.timezone, startDate: r.start_date ?? '', endDate: r.end_date ?? '',
      status: r.status as Event['status'], regOpens: r.reg_opens ?? '', regCloses: r.reg_closes ?? '',
      lastDateToEdit: r.last_date_to_edit ?? null,
      finalsLineupDeadlineAt: (r as { finals_lineup_deadline_at?: string | null }).finals_lineup_deadline_at ?? null,
      entryFee: Number(r.entry_fee), secondDisciplineFee: Number(r.second_discipline_fee),
      disciplines: (r.disciplines ?? []) as Event['disciplines'], sessions: sessionsByEvent.get(r.id) ?? [],
      ...(r.private_reg_code ? { privateRegCode: r.private_reg_code } : {}),
      ...(r.banquet ? { banquet: r.banquet as Event['banquet'] } : {}),
      ...(r.tshirt_addon ? { tshirtAddon: r.tshirt_addon as Event['tshirtAddon'] } : {}),
      ...(r.banner_addon ? { bannerAddon: r.banner_addon as Event['bannerAddon'] } : {}),
      ...(r.change_fee ? { changeFee: r.change_fee as Event['changeFee'] } : {}),
      ...(r.event_type && r.event_type !== 'competition' ? { eventType: r.event_type as Event['eventType'] } : {}),
      ...(r.sanction_id ? { sanctionId: r.sanction_id } : {}),
      ...(r.camp_config ? { campConfig: r.camp_config as Event['campConfig'] } : {}),
      ...(r.kind && r.kind !== 'standard' ? { kind: r.kind as Event['kind'] } : {}),
      ...((r as { ucg_hosted?: string | null }).ucg_hosted
        ? { ucgHosted: (r as { ucg_hosted?: string | null }).ucg_hosted as Event['ucgHosted'] }
        : {}),
      ...(r.nationals_config ? { nationalsConfig: r.nationals_config as unknown as Event['nationalsConfig'] } : {}),
      ...(r.venue ? { venue: r.venue } : {}),
      ...(r.street_address ? { streetAddress: r.street_address } : {}),
      ...(r.country ? { country: r.country } : {}),
      ...(r.hotel_link ? { hotelLink: r.hotel_link } : {}),
      ...(r.age_calc_at ? { ageCalcAt: r.age_calc_at } : {}),
      ...(r.late_reg ? { lateReg: r.late_reg as Event['lateReg'] } : {}),
      ...(r.director ? { director: r.director as Event['director'] } : {}),
      ...(r.capacity ? { capacity: r.capacity as Event['capacity'] } : {}),
      ...(r.confirmation_email ? { confirmationEmail: r.confirmation_email as Event['confirmationEmail'] } : {}),
      ...(r.created_at ? { createdAt: r.created_at } : {}),
      ...(r.owner ? { owner: r.owner as Event['owner'] } : {}),
      ...(r.owner_checklist ? { ownerChecklist: r.owner_checklist as Event['ownerChecklist'] } : {}),
      ...((r as { registration_mode?: string | null }).registration_mode === 'by-session'
        ? { registrationMode: 'by-session' as const }
        : {}),
      ...((r as { competition_order_locked?: boolean | null }).competition_order_locked
        ? { competitionOrderLocked: true }
        : {}),
      ...((r as { finals_roster_locked?: boolean | null }).finals_roster_locked
        ? { finalsRosterLocked: true }
        : {}),
      ...((r as { scoring_config?: Event['scoringConfig'] | null }).scoring_config
        ? { scoringConfig: (r as { scoring_config?: Event['scoringConfig'] | null }).scoring_config as Event['scoringConfig'] }
        : {}),
      ...((r as { listing_only?: boolean | null }).listing_only
        ? { listingOnly: true }
        : {}),
    }));

    const registrations: Registration[] = (registrationsR.data ?? []).map(rowToRegistration);
    const scores: Score[] = (scoresR.data ?? []).map(rowToScore);

    const itemsByInvoice = new Map<string, Invoice['items']>();
    for (const r of invoiceItemsR.data ?? []) {
      const arr = itemsByInvoice.get(r.invoice_id) ?? [];
      arr.push({ id: r.id, label: r.label, amount: Number(r.amount), kind: r.kind, refUserId: r.ref_user_id ?? undefined, refunded: r.refunded,
        ...((r as { ref_reg_ids?: string[] | null }).ref_reg_ids ? { refRegIds: (r as { ref_reg_ids?: string[] | null }).ref_reg_ids ?? undefined } : {}),
        ...((r as { ref_event_id?: string | null }).ref_event_id ? { refEventId: (r as { ref_event_id?: string | null }).ref_event_id ?? undefined } : {}),
        ...((r as { ref_line_type?: string | null }).ref_line_type ? { refLineType: (r as { ref_line_type?: string | null }).ref_line_type as Invoice['items'][number]['refLineType'] } : {}),
        ...((r as { addon_size?: string | null }).addon_size ? { addonSize: (r as { addon_size?: string | null }).addon_size ?? undefined } : {}),
        ...((r as { addon_assignee?: string | null }).addon_assignee ? { addonAssigneeId: (r as { addon_assignee?: string | null }).addon_assignee ?? undefined } : {}) });
      itemsByInvoice.set(r.invoice_id, arr);
    }
    const invoices: Invoice[] = (invoicesR.data ?? []).map((r: Row<'invoices'>) => ({
      id: r.id, number: r.number, clubId: r.club_id, athleteId: r.athlete_id,
      createdAt: r.created_at, paidAt: r.paid_at, items: itemsByInvoice.get(r.id) ?? [],
      ...(r.coupon_code ? { couponCode: r.coupon_code } : {}),
      // Stripe finance fields (written by stripe-webhook; not in the generated
      // Row type yet). Surfaced so Phase 5 finance reads the REAL processing fee.
      stripePaymentIntentId: (r as { stripe_payment_intent_id?: string | null }).stripe_payment_intent_id ?? null,
      stripeFee: (r as { stripe_fee?: number | null }).stripe_fee ?? null,
    }));

    const carts: DB['carts'] = {};
    for (const r of cartItemsR.data ?? []) {
      const ownerKey = r.club_id ?? r.person_id;
      if (!ownerKey) continue;
      const arr = carts[ownerKey] ?? (carts[ownerKey] = []);
      arr.push({ id: r.id, label: r.label, amount: Number(r.amount), kind: r.kind, refUserId: r.ref_user_id ?? undefined,
        refSeasonId: (r as { ref_season_id?: string | null }).ref_season_id ?? undefined,
        refType: ((r as { ref_type?: string | null }).ref_type ?? undefined) as MembershipType | 'club' | undefined,
        ...((r as { ref_reg_ids?: string[] | null }).ref_reg_ids ? { refRegIds: (r as { ref_reg_ids?: string[] | null }).ref_reg_ids ?? undefined } : {}),
        ...((r as { ref_event_id?: string | null }).ref_event_id ? { refEventId: (r as { ref_event_id?: string | null }).ref_event_id ?? undefined } : {}),
        ...((r as { ref_line_type?: string | null }).ref_line_type ? { refLineType: (r as { ref_line_type?: string | null }).ref_line_type as Invoice['items'][number]['refLineType'] } : {}),
        ...((r as { prior_reg_snapshot?: Registration[] | null }).prior_reg_snapshot ? { priorRegSnapshot: (r as { prior_reg_snapshot?: Registration[] | null }).prior_reg_snapshot ?? undefined } : {}),
        ...((r as { addon_size?: string | null }).addon_size ? { addonSize: (r as { addon_size?: string | null }).addon_size ?? undefined } : {}),
        ...((r as { addon_assignee?: string | null }).addon_assignee ? { addonAssigneeId: (r as { addon_assignee?: string | null }).addon_assignee ?? undefined } : {}) });
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
        decidedAt: r.decided_at ?? null, createdEventId: r.created_event_id ?? null,
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
    const payments: Payment[] = (paymentsR.error ? [] : paymentsR.data ?? [])
      .map(rowToPayment);
    const eventAdmins: EventAdmin[] = (eventAdminsR.error ? [] : eventAdminsR.data ?? [])
      .map(rowToEventAdmin);
    const refundRequests: RefundRequest[] = (refundRequestsR.error ? [] : refundRequestsR.data ?? [])
      .map(rowToRefundRequest);
    const waitlistGroups: WaitlistGroup[] = (waitlistGroupsR.error ? [] : waitlistGroupsR.data ?? [])
      .map(rowToWaitlistGroup);
    const sessionRequests: SessionRequest[] = (sessionRequestsR.error ? [] : sessionRequestsR.data ?? [])
      .map(rowToSessionRequest);
    const competitionOrders: CompetitionOrder[] = (competitionOrdersR.error ? [] : competitionOrdersR.data ?? [])
      .map(rowToCompetitionOrder);
    const finalsLineups: FinalsLineup[] = (finalsLineupsR.error ? [] : finalsLineupsR.data ?? [])
      .map(rowToFinalsLineup);
    const eventCheckins: EventCheckin[] = (eventCheckinsR.error ? [] : eventCheckinsR.data ?? [])
      .map(rowToEventCheckin);
    const accountingCodes: AccountingCode[] = (accountingCodesR.error ? [] : accountingCodesR.data ?? [])
      .map(rowToAccountingCode);
    const hostPayouts: HostPayout[] = (hostPayoutsR.error ? [] : hostPayoutsR.data ?? [])
      .map(rowToHostPayout);
    const judgeAccessCodes: JudgeAccessCode[] = (judgeAccessCodesR.error ? [] : judgeAccessCodesR.data ?? [])
      .map(rowToJudgeAccessCode);

    return {
      seasons, levels, clubs, people, events, registrations, scores, invoices, coupons,
      carts, clubRequests,
      ...(regionOverrides ? { regionOverrides } : {}),
      ...(accountInvites.length ? { accountInvites } : {}),
      ...(sanctionRequests.length ? { sanctionRequests } : {}),
      ...(sanctionVotes.length ? { sanctionVotes } : {}),
      ...(waiverDocuments.length ? { waiverDocuments } : {}),
      ...(waiverSignatures.length ? { waiverSignatures } : {}),
      ...(clubMemberships.length ? { clubMemberships } : {}),
      ...(payments.length ? { payments } : {}),
      ...(eventAdmins.length ? { eventAdmins } : {}),
      ...(refundRequests.length ? { refundRequests } : {}),
      ...(waitlistGroups.length ? { waitlistGroups } : {}),
      ...(sessionRequests.length ? { sessionRequests } : {}),
      ...(competitionOrders.length ? { competitionOrders } : {}),
      ...(finalsLineups.length ? { finalsLineups } : {}),
      ...(eventCheckins.length ? { eventCheckins } : {}),
      ...(accountingCodes.length ? { accountingCodes } : {}),
      ...(hostPayouts.length ? { hostPayouts } : {}),
      ...(judgeAccessCodes.length ? { judgeAccessCodes } : {}),
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
    // 20260618000007 replaced the 2-col unique with (person_id, season_id, type);
    // the old 2-col spec matches no constraint on a from-migrations database.
    return rows.length ? supabase!.from('memberships').upsert(rows, { onConflict: 'person_id,season_id,type' }) : undefined;
  });
  await step('Events', () => supabase!.from('events').upsert(db.events.map(eventToRow)));
  await step('Event sessions', () => {
    const rows = db.events.flatMap((m) => m.sessions.map((s) => sessionToRow(m.id, s)));
    return rows.length ? supabase!.from('event_sessions').upsert(rows) : undefined;
  });
  await step('Squads', () => {
    const rows = db.events.flatMap((m) => m.sessions.flatMap((s) => s.squads.map((q, i) => squadToRow(s.id, q, i))));
    return rows.length ? supabase!.from('squads').upsert(rows) : undefined;
  });
  const squadIdsByEvent = new Map(db.events.map((m) => [m.id, squadIdsByReg(m)]));
  for (const part of chunk(db.registrations)) {
    await step('Registrations', () => supabase!.from('registrations').upsert(
      part.map((r) => registrationToRow(r, squadIdsByEvent.get(r.eventId)?.get(r.id) ?? null)),
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

/** Realtime wiring for live results: subscribes to score changes for an event.
 *  `onChange` receives the raw postgres_changes payload — use
 *  `applyScorePatch` to accumulate it into a patch map. */
export function subscribeEventScores(
  eventId: string,
  onChange: (payload: RealtimePostgresChangesPayload<Row<'scores'>>) => void,
): () => void {
  if (!supabase) return () => {};
  const channel = supabase
    .channel(`scores:${eventId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'scores', filter: `event_id=eq.${eventId}` }, onChange)
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
