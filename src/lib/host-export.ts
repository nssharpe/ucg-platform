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
// t-shirt sizes, leo sizes, and banquet quantities. The purchased-add-on
// data model (per-line quantity + size, banquet seat assignment) doesn't
// exist yet -- it's Phase 2 of the add-ons rework -- so leo sizes and
// banquet quantities can't be built honestly today. This ships ONE workbook
// with THREE sheets (Athletes, Counts, Shirt sizes) and defers leo/banquet
// to Phase 2, when purchased-addon line items are queryable.
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

import { APPARATUS, type Discipline } from './types';
import type { HostRosterRow } from './supabase';

export interface SheetModel {
  name: string;
  columns: string[];
  rows: (string | number)[][];
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
    r.clubName ?? '',
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
      groups.set(key, { levelId, clubId, clubName: r.clubName ?? 'Unknown club', athletes: new Set(), apparatusAthletes: new Map() });
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

/** Sheet 3: Shirt sizes -- tally of PROFILE shirt sizes across registered
 *  athletes (distinct athlete, not per-registration, so a multi-discipline
 *  athlete isn't double-counted). This is NOT purchased-shirt quantities --
 *  see the header note baked into row 0. */
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
  const sizeOrder = ['YS', 'YM', 'YL', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'];
  const sizes = [...bySize.keys()].sort((a, b) => {
    const ai = sizeOrder.indexOf(a); const bi = sizeOrder.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
  const dataRows: (string | number)[][] = [
    ['Profile shirt sizes — purchased-shirt quantities arrive with the add-ons rework', ''],
    ...sizes.map((size) => [size, bySize.get(size)!]),
  ];
  if (seen.size > 0) dataRows.push(['Total', seen.size]);
  return { name: 'Shirt sizes', columns, rows: dataRows };
}

/** Build all three sheets for the registration workbook. */
export function buildRegistrationWorkbookSheets(rows: HostRosterRow[], resolveLevelName: (id: string) => string = (id) => id): SheetModel[] {
  return [
    buildAthletesSheet(rows, resolveLevelName),
    buildCountsSheet(rows, resolveLevelName),
    buildShirtSizesSheet(rows),
  ];
}
