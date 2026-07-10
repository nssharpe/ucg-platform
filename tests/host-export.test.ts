import { describe, it, expect } from 'vitest';
import { buildAthletesSheet, buildCountsSheet, buildShirtSizesSheet, buildRegistrationWorkbookSheets } from '../src/lib/host-export';
import type { HostRosterRow } from '../src/lib/supabase';

const row = (overrides: Partial<HostRosterRow>): HostRosterRow => ({
  regId: 'r1', athleteId: 'a1', firstName: 'Ada', lastName: 'Lovelace',
  clubId: 'c1', clubName: 'Alpha Gym', discipline: 'WAG', levelId: 'lvl-1',
  apparatus: ['VT', 'UB'], apparatusLevels: null, sessionId: 's1',
  paid: true, updatedPending: false, partnerAthleteId: null,
  shirt: 'M', dietary: [], email: 'a@x.com', phone: '555-1000',
  emergencyContact: 'Bea 555-2000', studentStatus: 'Student', region: 'Northeast',
  ...overrides,
});

const resolve = (id: string) => (id === 'lvl-1' ? 'Level 1' : id === 'lvl-2' ? 'Level 2' : id);

describe('buildAthletesSheet', () => {
  it('gives a multi-discipline athlete one row per discipline, not a merged row', () => {
    const rows: HostRosterRow[] = [
      row({ regId: 'r1', athleteId: 'a1', discipline: 'WAG', apparatus: ['VT', 'UB'] }),
      row({ regId: 'r2', athleteId: 'a1', discipline: 'MAG', apparatus: ['VT', 'FX'] }),
    ];
    const sheet = buildAthletesSheet(rows, resolve);
    expect(sheet.rows).toHaveLength(2);
    const disciplines = sheet.rows.map((r) => r[sheet.columns.indexOf('Discipline')]);
    expect(disciplines.sort()).toEqual(['MAG', 'WAG']);
  });

  it('marks T&T apparatus cells with the apparatus level, not a checkmark', () => {
    const rows: HostRosterRow[] = [
      row({ discipline: 'TNT', apparatus: ['TR', 'DM'], apparatusLevels: { TR: 'Level 5', DM: 'Level 4' } }),
    ];
    const sheet = buildAthletesSheet(rows, resolve);
    const trCol = sheet.columns.indexOf('TR');
    const dmCol = sheet.columns.indexOf('DM');
    expect(sheet.rows[0][trCol]).toBe('Level 5');
    expect(sheet.rows[0][dmCol]).toBe('Level 4');
  });

  it('marks MAG/WAG apparatus cells with a checkmark when entered, blank otherwise', () => {
    const rows: HostRosterRow[] = [row({ discipline: 'WAG', apparatus: ['VT'] })];
    const sheet = buildAthletesSheet(rows, resolve);
    expect(sheet.rows[0][sheet.columns.indexOf('VT')]).toBe('✓');
    expect(sheet.rows[0][sheet.columns.indexOf('BB')]).toBe('');
  });

  it('includes one column per apparatus code across all disciplines, deduped', () => {
    const sheet = buildAthletesSheet([]);
    // MAG: FX,PH,SR,VT,PB,HB; WAG adds UB,BB (VT/FX shared); TNT: TR,DM,TU,SY
    for (const code of ['FX', 'PH', 'SR', 'VT', 'PB', 'HB', 'UB', 'BB', 'TR', 'DM', 'TU', 'SY']) {
      expect(sheet.columns).toContain(code);
    }
    expect(sheet.columns.filter((c) => c === 'VT')).toHaveLength(1);
    expect(sheet.columns.filter((c) => c === 'FX')).toHaveLength(1);
  });

  it('returns no rows for an empty roster', () => {
    const sheet = buildAthletesSheet([]);
    expect(sheet.rows).toEqual([]);
  });

  it('reflects paid/pending status', () => {
    const rows: HostRosterRow[] = [
      row({ athleteId: 'a1', paid: true, updatedPending: false }),
      row({ regId: 'r2', athleteId: 'a2', paid: false, updatedPending: true }),
      row({ regId: 'r3', athleteId: 'a3', paid: false, updatedPending: false }),
    ];
    const sheet = buildAthletesSheet(rows, resolve);
    const statusCol = sheet.columns.indexOf('Status');
    expect(sheet.rows.map((r) => r[statusCol])).toEqual(['Paid', 'Pending (edited)', 'Pending']);
  });
});

describe('buildCountsSheet', () => {
  it('counts distinct athletes per apparatus within each level x club group, plus a totals row', () => {
    const rows: HostRosterRow[] = [
      row({ regId: 'r1', athleteId: 'a1', clubId: 'c1', clubName: 'Alpha Gym', levelId: 'lvl-1', apparatus: ['VT', 'UB'] }),
      row({ regId: 'r2', athleteId: 'a2', clubId: 'c1', clubName: 'Alpha Gym', levelId: 'lvl-1', apparatus: ['VT'] }),
      row({ regId: 'r3', athleteId: 'a3', clubId: 'c2', clubName: 'Beta Gym', levelId: 'lvl-1', apparatus: ['BB'] }),
    ];
    const sheet = buildCountsSheet(rows, resolve);
    const vtCol = sheet.columns.indexOf('VT');
    const totalCol = sheet.columns.indexOf('Total athletes');
    const alphaRow = sheet.rows.find((r) => r[1] === 'Alpha Gym')!;
    expect(alphaRow[vtCol]).toBe(2);
    expect(alphaRow[totalCol]).toBe(2);
    const totalsRow = sheet.rows.find((r) => r[0] === 'Totals')!;
    expect(totalsRow[vtCol]).toBe(2);
    expect(totalsRow[totalCol]).toBe(3);
  });

  it('groups unassigned-level registrations under "Unassigned level"', () => {
    const rows: HostRosterRow[] = [row({ levelId: null })];
    const sheet = buildCountsSheet(rows, resolve);
    expect(sheet.rows[0][0]).toBe('Unassigned level');
  });

  it('returns no rows (not even a totals row) for an empty roster', () => {
    const sheet = buildCountsSheet([]);
    expect(sheet.rows).toEqual([]);
  });
});

describe('buildShirtSizesSheet', () => {
  it('tallies distinct athletes per size, counting a multi-discipline athlete once', () => {
    const rows: HostRosterRow[] = [
      row({ regId: 'r1', athleteId: 'a1', discipline: 'WAG', shirt: 'M' }),
      row({ regId: 'r2', athleteId: 'a1', discipline: 'MAG', shirt: 'M' }),
      row({ regId: 'r3', athleteId: 'a2', shirt: 'L' }),
      row({ regId: 'r4', athleteId: 'a3', shirt: null }),
    ];
    const sheet = buildShirtSizesSheet(rows);
    const dataRows = sheet.rows.slice(1); // row 0 is the header note
    expect(dataRows).toContainEqual(['M', 1]);
    expect(dataRows).toContainEqual(['L', 1]);
    expect(dataRows).toContainEqual(['Unspecified', 1]);
    expect(dataRows).toContainEqual(['Total', 3]);
  });

  it('carries a header note explaining this is profile sizes, not purchased quantities', () => {
    const sheet = buildShirtSizesSheet([row({})]);
    expect(sheet.rows[0][0]).toMatch(/purchased-shirt quantities arrive with the add-ons rework/);
  });

  it('returns just the header note for an empty roster', () => {
    const sheet = buildShirtSizesSheet([]);
    expect(sheet.rows).toHaveLength(1);
  });
});

describe('buildRegistrationWorkbookSheets', () => {
  it('builds all three sheets in order', () => {
    const sheets = buildRegistrationWorkbookSheets([row({})], resolve);
    expect(sheets.map((s) => s.name)).toEqual(['Athletes', 'Counts', 'Shirt sizes']);
  });
});
