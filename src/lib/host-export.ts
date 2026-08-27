// Pure workbook-shaping helpers for the Event Host Page's Excel export
// (event-mgmt v2 Phase 1, §C/§K "Excel exports"). These functions only build
// plain sheet models — { name, columns, rows } — with no exceljs/DOM
// dependency, so they're cheap to unit-test. The thin exceljs wiring
// (styling, freeze pane, download) lives in src/pages/Events.tsx next to the
// button, matching how host-page.ts keeps summarizeRoster() pure and lets
// the page component own rendering.
//
// SCOPE DECISION (recorded here per the task brief): Julia's five requested
// downloads are full athlete detail, level x club x apparatus counts,
// t-shirt sizes, leo sizes, and banquet quantities. Phase 1 shipped ONE
// workbook with THREE sheets (Athletes, Counts, Shirt sizes [profile]) and
// deferred leo/banquet/purchased-shirt to Phase 2, since the purchased-addon
// data model (per-unit quantity + size, banquet seat assignment) didn't
// exist yet.
//
// PHASE 2 (event-mgmt v2 T7): the per-unit add-on model now exists
// (`invoice_items.kind='addon'`, one row per purchased unit -- see
// supabase/migrations/20260710024630_addon_unit_fields.sql), sourced across
// every competing club via the `event_host_addons` RPC (same RLS-exception
// reasoning as `event_host_roster` -- see
// 20260710151638_event_host_addons_and_camp_detail.sql). This adds: Shirts
// (purchased), Leo sizes, and Banquet sheets, each gated on the event's addon
// being configured (omitted entirely otherwise, not just empty), plus a Camp
// roster sheet (one row per athlete: birthday/gender/purchased sizes/survey
// answers/date registered) for camp events. The Phase-1 Shirt sizes
// (profile) sheet is KEPT alongside the new purchased-shirt sheet -- it
// answers a different question (what size does the athlete's profile say,
// vs. what did they actually buy) and hosts may want both when reconciling
// orders against rosters.
//
// MULTI-DISCIPLINE ROW DECISION: `HostRosterRow` is already one row per
// *registration* (`event_host_roster` selects from `registrations`, one row
// per reg id -- see supabase/migrations/20260709211656_event_host_tools.sql
// and tests/host-page.test.ts, where a synchro pair is two separate rows,
// one per partner's own registration). A registration is scoped to exactly
// one discipline. Apparatus codes are NOT unique across disciplines --
// MAG and WAG both use VT and FX (src/lib/types.ts APPARATUS) -- so an
// athlete entered in two disciplines can't be flattened into one row without
// either clashing on those shared columns or fabricating a discipline-
// qualified column per apparatus (MAG-VT vs WAG-VT), which would only ever
// be sparse. The legacy "Registration Email Master" the reference doc
// describes (docs/reference/README.md) resolves this the same way: separate
// `WAG/MAG/TnT Athlete Data` sheets. Rather than 3 near-duplicate sheets,
// the Athletes sheet here keeps ONE row per registration (i.e. one row per
// athlete per discipline they're entered in) and includes a Discipline
// column -- multi-discipline athletes get one row per discipline, never a
// merged/clashing row. This is a one-line change from "1 row per athlete"
// if that's preferred later; the grouping key would just become athleteId.

import { APPARATUS, type Discipline, type CampSurveyQuestion } from './types';
import type { HostRosterRow, HostAddonRow } from './supabase';
import { campSurveyQuestionsOf, campSurveyAnswerLabel } from './pricing';

export interface SheetModel {
  name: string;
  columns: string[];
  rows: (string | number)[][];
}


/** Club display label for export sheets: real name, 'Independent' for a
 *  club-less (NULL/'' clubId) registrant, 'Unknown club' only for a real id
 *  whose club row is missing (independents-exist rule, 2026-08-27). */
function clubLabel(clubId: string | null | undefined, clubName: string | null | undefined): string {
  return clubName ?? ((clubId ?? '') === '' ? 'Independent' : 'Unknown club');
}

const fullName = (r: HostRosterRow) => `${r.firstName} ${r.lastName}`.trim();

/** Renders one registration's apparatus entry for a given apparatus code:
 *  the apparatus level for T&T (levels are per-apparatus there), a
 *  checkmark for MAG/WAG, or blank when the athlete isn't entered on it. */
function apparatusCell(row: HostRosterRow, code: string): string {
  if (!row.apparatus.includes(code)) return '';
  const lvl = row.apparatusLevels?.[code];
  return lvl ? lvl : '✓';
}

function paidLabel(row: HostRosterRow): string {
  if (row.paid) return 'Paid';
  if (row.updatedPending) return 'Pending (edited)';
  return 'Pending';
}

/** Sheet 1: Athletes -- one row per registration (see MULTI-DISCIPLINE ROW
 *  DECISION above), one column per apparatus code across ALL disciplines so
 *  the sheet stays a single flat table hosts can filter/sort freely. */
export function buildAthletesSheet(rows: HostRosterRow[], resolveLevelName: (id: string) => string = (id) => id): SheetModel {
  const apparatusCodes: string[] = [];
  for (const d of Object.keys(APPARATUS) as Discipline[]) {
    for (const a of APPARATUS[d]) if (!apparatusCodes.includes(a.code)) apparatusCodes.push(a.code);
  }

  const columns = [
    'Athlete', 'Club', 'Discipline', 'Level',
    ...apparatusCodes,
    'Session', 'Shirt (profile)', 'Dietary', 'Email', 'Phone',
    'Emergency contact', 'Student', 'Region', 'Status',
  ];

  const sorted = [...rows].sort((a, b) =>
    (a.clubName ?? '').localeCompare(b.clubName ?? '') || fullName(a).localeCompare(fullName(b)) || a.discipline.localeCompare(b.discipline));

  const dataRows = sorted.map((r) => [
    fullName(r),
    clubLabel(r.clubId, r.clubName),
    r.discipline,
    r.levelId ? resolveLevelName(r.levelId) : '',
    ...apparatusCodes.map((code) => apparatusCell(r, code)),
    r.sessionId ?? '',
    r.shirt ?? '',
    r.dietary.join(', '),
    r.email ?? '',
    r.phone ?? '',
    r.emergencyContact ?? '',
    r.studentStatus ?? '',
    r.region ?? '',
    paidLabel(r),
  ]);

  return { name: 'Athletes', columns, rows: dataRows };
}

/** Sheet 2: Counts -- level x club rows, one column per apparatus code
 *  (distinct-athlete count on that apparatus within the level+club), plus a
 *  distinct-athlete Total column and a final Totals row across all clubs. */
export function buildCountsSheet(rows: HostRosterRow[], resolveLevelName: (id: string) => string = (id) => id): SheetModel {
  const apparatusCodes: string[] = [];
  for (const d of Object.keys(APPARATUS) as Discipline[]) {
    for (const a of APPARATUS[d]) if (!apparatusCodes.includes(a.code)) apparatusCodes.push(a.code);
  }
  const columns = ['Level', 'Club', ...apparatusCodes, 'Total athletes'];

  type Key = string; // `${levelId}||${clubId}`
  const groups = new Map<Key, { levelId: string; clubId: string; clubName: string; athletes: Set<string>; apparatusAthletes: Map<string, Set<string>> }>();
  for (const r of rows) {
    const levelId = r.levelId ?? '';
    const clubId = r.clubId ?? '';
    const key = `${levelId}||${clubId}`;
    if (!groups.has(key)) {
      groups.set(key, { levelId, clubId, clubName: clubLabel(r.clubId, r.clubName), athletes: new Set(), apparatusAthletes: new Map() });
    }
    const g = groups.get(key)!;
    g.athletes.add(r.athleteId);
    for (const code of r.apparatus) {
      if (!g.apparatusAthletes.has(code)) g.apparatusAthletes.set(code, new Set());
      g.apparatusAthletes.get(code)!.add(r.athleteId);
    }
  }

  const sortedGroups = [...groups.values()].sort((a, b) =>
    resolveLevelName(a.levelId || '￿').localeCompare(resolveLevelName(b.levelId || '￿')) || a.clubName.localeCompare(b.clubName));

  const dataRows: (string | number)[][] = sortedGroups.map((g) => [
    g.levelId ? resolveLevelName(g.levelId) : 'Unassigned level',
    g.clubName,
    ...apparatusCodes.map((code) => g.apparatusAthletes.get(code)?.size ?? 0),
    g.athletes.size,
  ]);

  if (sortedGroups.length > 0) {
    const totalApparatus = apparatusCodes.map((code) => {
      const seen = new Set<string>();
      for (const g of sortedGroups) for (const id of g.apparatusAthletes.get(code) ?? []) seen.add(`${g.levelId}||${id}`);
      return seen.size;
    });
    const totalAthletes = new Set(rows.map((r) => `${r.levelId ?? ''}||${r.athleteId}`)).size;
    dataRows.push(['Totals', '', ...totalApparatus, totalAthletes]);
  }

  return { name: 'Counts', columns, rows: dataRows };
}

const SHIRT_SIZE_ORDER = ['YS', 'YM', 'YL', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'];

/** Sorts size labels by the standard youth→adult shirt/leo progression,
 *  unrecognized labels last (alphabetically among themselves). Shared by the
 *  profile shirt-size tally and the purchased shirt/leo size tallies below
 *  so all three sheets order sizes the same way. */
function sortSizes(sizes: string[]): string[] {
  return [...sizes].sort((a, b) => {
    const ai = SHIRT_SIZE_ORDER.indexOf(a); const bi = SHIRT_SIZE_ORDER.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
}

/** Sheet 3: Shirt sizes (profile) -- tally of PROFILE shirt sizes across
 *  registered athletes (distinct athlete, not per-registration, so a
 *  multi-discipline athlete isn't double-counted). This is NOT purchased-
 *  shirt quantities -- see buildPurchasedAddonUnitSheet('tshirt', ...) below
 *  for that, and the header note baked into row 0 here. */
export function buildShirtSizesSheet(rows: HostRosterRow[]): SheetModel {
  const columns = ['Size', 'Athletes'];
  const seen = new Set<string>();
  const bySize = new Map<string, number>();
  for (const r of rows) {
    if (seen.has(r.athleteId)) continue;
    seen.add(r.athleteId);
    const size = r.shirt && r.shirt.trim() ? r.shirt.trim() : 'Unspecified';
    bySize.set(size, (bySize.get(size) ?? 0) + 1);
  }
  const sizes = sortSizes([...bySize.keys()]);
  const dataRows: (string | number)[][] = [
    ['Profile shirt sizes — see the "Shirts (purchased)" sheet for what was actually bought', ''],
    ...sizes.map((size) => [size, bySize.get(size)!]),
  ];
  if (seen.size > 0) dataRows.push(['Total', seen.size]);
  return { name: 'Shirt sizes (profile)', columns, rows: dataRows };
}

/** Sheets 4/5 (Phase 2 T7): one row per purchased add-on UNIT of the given
 *  type (`'tshirt'` or `'leo'`) -- label + size -- followed by a spacer and a
 *  size x count summary block, mirroring buildShirtSizesSheet's tally
 *  layout. Purchased quantities come from `event_host_addons`, which already
 *  excludes refunded units (see the RPC's migration), so no refunded check
 *  is needed here. Returns null (sheet omitted, not emitted empty) when the
 *  add-on isn't configured OR configured-but-nothing-purchased-yet, since an
 *  empty tally sheet is just noise for a host who hasn't sold any yet -- the
 *  page also shouldn't render a download for a workbook with zero rows
 *  toward this add-on. Callers that want the sheet even with zero purchases
 *  can pass `alwaysShow: true` (unused today, kept for symmetry/testability). */
function buildPurchasedAddonUnitSheet(
  lineType: 'tshirt' | 'leo',
  sheetName: string,
  addonRows: HostAddonRow[],
  alwaysShow = false,
): SheetModel | null {
  const units = addonRows.filter((r) => r.refLineType === lineType);
  if (units.length === 0 && !alwaysShow) return null;

  const columns = ['Label', 'Size'];
  const dataRows: (string | number)[][] = units.map((u) => [u.label, u.addonSize?.trim() || 'Unspecified']);

  const bySize = new Map<string, number>();
  for (const u of units) {
    const size = u.addonSize?.trim() || 'Unspecified';
    bySize.set(size, (bySize.get(size) ?? 0) + 1);
  }
  const sizes = sortSizes([...bySize.keys()]);
  dataRows.push(['', '']);
  dataRows.push(['Size summary', 'Count']);
  for (const size of sizes) dataRows.push([size, bySize.get(size)!]);
  dataRows.push(['Total', units.length]);

  return { name: sheetName, columns, rows: dataRows };
}

/** Sheet 4: Shirts (purchased) -- see buildPurchasedAddonUnitSheet. */
export function buildPurchasedShirtsSheet(addonRows: HostAddonRow[]): SheetModel | null {
  return buildPurchasedAddonUnitSheet('tshirt', 'Shirts (purchased)', addonRows);
}

/** Sheet 5: Leo sizes -- see buildPurchasedAddonUnitSheet. */
export function buildLeoSizesSheet(addonRows: HostAddonRow[]): SheetModel | null {
  return buildPurchasedAddonUnitSheet('leo', 'Leo sizes', addonRows);
}

/** A banquet unit's display name: 'extra' -> "Extra ticket"; an assigned
 *  ticket resolves the person's name from the joined `people` row the
 *  `event_host_addons` RPC already returns; a resolvable-but-nameless
 *  assignee (shouldn't happen -- every `addonAssignee` is either 'extra' or
 *  a real person id) falls back to the raw id rather than silently
 *  dropping the row. */
function banquetAssigneeName(row: HostAddonRow): string {
  if (row.addonAssignee === 'extra') return 'Extra ticket';
  const name = `${row.assigneeFirstName ?? ''} ${row.assigneeLastName ?? ''}`.trim();
  return name || row.addonAssignee || 'Unknown';
}

/** Sheet 6 (Phase 2 T7): Banquet -- one row per purchased ticket (assignee +
 *  label), then a total count and a breakdown of assigned-vs-extra tickets.
 *  Returns null when nothing's been purchased yet (see
 *  buildPurchasedAddonUnitSheet's doc comment for the same reasoning). */
export function buildBanquetSheet(addonRows: HostAddonRow[]): SheetModel | null {
  const tickets = addonRows.filter((r) => r.refLineType === 'banquet');
  if (tickets.length === 0) return null;

  const columns = ['Assignee', 'Label'];
  const dataRows: (string | number)[][] = tickets.map((t) => [banquetAssigneeName(t), t.label]);

  const extraCount = tickets.filter((t) => t.addonAssignee === 'extra').length;
  const assignedCount = tickets.length - extraCount;
  dataRows.push(['', '']);
  dataRows.push(['Total tickets', tickets.length]);
  dataRows.push(['Assigned', assignedCount]);
  dataRows.push(['Extra', extraCount]);

  return { name: 'Banquet', columns, rows: dataRows };
}

/** One camp roster row's purchased shirt/leo sizes: an athlete's own
 *  self-purchase units, joined by `refUserId` (see the `event_host_addons`
 *  migration's doc comment for why this -- not `addonAssignee`, which is
 *  banquet-only -- is the right join key for shirt/leo). Camps are
 *  individual-only registration (no club-cart purchase path), so a camp
 *  athlete's own units always carry `refUserId`; multiple units of the same
 *  type join as a comma list. */
function purchasedSizesForAthlete(addonRows: HostAddonRow[], athleteId: string, lineType: 'tshirt' | 'leo'): string {
  return addonRows
    .filter((r) => r.refLineType === lineType && r.refUserId === athleteId)
    .map((r) => r.addonSize?.trim() || 'Unspecified')
    .join(', ');
}

/** Sheet (camp events only, Phase 2 T7 spec §G): one row per athlete (not
 *  per registration -- camps are individual-only registration, so this is
 *  normally the same thing, but a roster is deduped by athleteId to
 *  guarantee "one line per athlete" even if that ever changes) with the
 *  detail a camp host needs beyond the generic Athletes sheet: birthday,
 *  gender, profile vs. purchased shirt size, purchased leo size, the event's
 *  configured survey answers (dynamic columns, human labels via
 *  `campSurveyAnswerLabel` -- mirrors supabase/functions/_shared/camp-
 *  confirmation.ts), and date registered (`Registration.createdAt`, added to
 *  `event_host_roster` for this). `questions` defaults to the legacy 4-question
 *  survey (`campSurveyQuestionsOf(undefined).questions`) so existing callers
 *  that don't yet thread the event's actual config through still get the
 *  historical columns. */
export function buildCampRosterSheet(
  rows: HostRosterRow[],
  addonRows: HostAddonRow[],
  questions: CampSurveyQuestion[] = campSurveyQuestionsOf(undefined).questions,
): SheetModel {
  const columns = [
    'Athlete', 'Club', 'Birthday', 'Gender',
    'Shirt (profile)', 'Shirt (purchased)', 'Leo (purchased)',
    ...questions.map((q) => q.label),
    'Date registered',
  ];

  const seen = new Set<string>();
  const deduped: HostRosterRow[] = [];
  for (const r of rows) {
    if (seen.has(r.athleteId)) continue;
    seen.add(r.athleteId);
    deduped.push(r);
  }
  const sorted = [...deduped].sort((a, b) => fullName(a).localeCompare(fullName(b)));

  const dataRows = sorted.map((r) => {
    const survey = r.campSurvey;
    const answerCells = questions.map((q) => {
      const v = survey?.[q.id];
      if (v == null) return '';
      return Array.isArray(v) ? v.map((x) => campSurveyAnswerLabel(q.id, x)).join('; ') : campSurveyAnswerLabel(q.id, v);
    });
    return [
      fullName(r),
      clubLabel(r.clubId, r.clubName),
      r.dob ?? '',
      r.gender ?? '',
      r.shirt ?? '',
      purchasedSizesForAthlete(addonRows, r.athleteId, 'tshirt'),
      purchasedSizesForAthlete(addonRows, r.athleteId, 'leo'),
      ...answerCells,
      r.createdAt ?? '',
    ];
  });

  return { name: 'Camp roster', columns, rows: dataRows };
}

/** Which optional add-on sheets/section apply to this event -- callers
 *  derive this from the `Event` row (kept as a narrow pick rather than
 *  importing the full `Event` type here, matching this file's existing
 *  dependency-light style). */
export interface WorkbookAddonConfig {
  tshirtConfigured: boolean;
  leoConfigured: boolean;
  banquetConfigured: boolean;
  isCamp: boolean;
  /** The camp event's resolved survey questions (`campSurveyQuestionsOf`,
   *  pricing.ts) — dynamic columns for the Camp roster sheet. Only read when
   *  `isCamp`; defaults to the legacy 4-question survey. */
  campSurveyQuestions?: CampSurveyQuestion[];
}

/** Build every sheet for the registration workbook: the Phase-1 core three
 *  (Athletes, Counts, Shirt sizes [profile]) always; the Phase-2 purchased
 *  add-on sheets (Shirts (purchased), Leo sizes, Banquet) only when both
 *  configured AND at least one unit's been purchased; and a Camp roster
 *  sheet only for camp events. `addonRows` defaults to `[]` so existing
 *  callers/tests that only care about the roster-derived sheets don't need
 *  to pass it. */
export function buildRegistrationWorkbookSheets(
  rows: HostRosterRow[],
  resolveLevelName: (id: string) => string = (id) => id,
  addonRows: HostAddonRow[] = [],
  config: WorkbookAddonConfig = { tshirtConfigured: false, leoConfigured: false, banquetConfigured: false, isCamp: false },
): SheetModel[] {
  const sheets: SheetModel[] = [
    buildAthletesSheet(rows, resolveLevelName),
    buildCountsSheet(rows, resolveLevelName),
    buildShirtSizesSheet(rows),
  ];
  if (config.tshirtConfigured) {
    const s = buildPurchasedShirtsSheet(addonRows);
    if (s) sheets.push(s);
  }
  if (config.leoConfigured) {
    const s = buildLeoSizesSheet(addonRows);
    if (s) sheets.push(s);
  }
  if (config.banquetConfigured) {
    const s = buildBanquetSheet(addonRows);
    if (s) sheets.push(s);
  }
  if (config.isCamp) {
    sheets.push(buildCampRosterSheet(rows, addonRows, config.campSurveyQuestions));
  }
  return sheets;
}
