import { describe, it, expect } from 'vitest';
import {
  buildAthletesSheet, buildCountsSheet, buildShirtSizesSheet, buildRegistrationWorkbookSheets,
  buildPurchasedShirtsSheet, buildLeoSizesSheet, buildBanquetSheet, buildCampRosterSheet,
} from '../src/lib/host-export';
import type { HostRosterRow, HostAddonRow } from '../src/lib/supabase';
import type { CampSurveyQuestion } from '../src/lib/types';

const row = (overrides: Partial<HostRosterRow>): HostRosterRow => ({
  regId: 'r1', athleteId: 'a1', firstName: 'Ada', lastName: 'Lovelace',
  clubId: 'c1', clubName: 'Alpha Gym', discipline: 'WAG', levelId: 'lvl-1',
  apparatus: ['VT', 'UB'], apparatusLevels: null, sessionId: 's1',
  paid: true, updatedPending: false, partnerAthleteId: null,
  shirt: 'M', dietary: [], email: 'a@x.com', phone: '555-1000',
  emergencyContact: 'Bea 555-2000', studentStatus: 'Student', region: 'Northeast',
  dob: '2005-04-01', gender: 'Female', campSurvey: null, createdAt: '2026-06-01T00:00:00Z',
  ...overrides,
});

const addonRow = (overrides: Partial<HostAddonRow>): HostAddonRow => ({
  itemId: 'ii1', refLineType: 'tshirt', addonSize: 'M', addonAssignee: null,
  assigneeFirstName: null, assigneeLastName: null, label: 'Camp t-shirt (size M)', refUserId: null,
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

  it('carries a header note pointing to the purchased-shirt sheet', () => {
    const sheet = buildShirtSizesSheet([row({})]);
    expect(sheet.rows[0][0]).toMatch(/Shirts \(purchased\)/);
  });

  it('returns just the header note for an empty roster', () => {
    const sheet = buildShirtSizesSheet([]);
    expect(sheet.rows).toHaveLength(1);
  });
});

describe('buildPurchasedShirtsSheet / buildLeoSizesSheet', () => {
  it('lists one row per purchased unit plus a size x count summary, ignoring other line types', () => {
    const rows: HostAddonRow[] = [
      addonRow({ itemId: 'i1', refLineType: 'tshirt', addonSize: 'M', label: 'Shirt — Ada (size M)' }),
      addonRow({ itemId: 'i2', refLineType: 'tshirt', addonSize: 'M', label: 'Shirt — Bob (size M)' }),
      addonRow({ itemId: 'i3', refLineType: 'tshirt', addonSize: 'L', label: 'Shirt — Cy (size L)' }),
      addonRow({ itemId: 'i4', refLineType: 'leo', addonSize: 'YM', label: 'Leo — Dee (size YM)' }),
      addonRow({ itemId: 'i5', refLineType: 'banquet', label: 'Banquet — Extra ticket' }),
    ];
    const shirts = buildPurchasedShirtsSheet(rows)!;
    expect(shirts.name).toBe('Shirts (purchased)');
    const unitRows = shirts.rows.slice(0, 3);
    expect(unitRows).toEqual([
      ['Shirt — Ada (size M)', 'M'],
      ['Shirt — Bob (size M)', 'M'],
      ['Shirt — Cy (size L)', 'L'],
    ]);
    expect(shirts.rows).toContainEqual(['M', 2]);
    expect(shirts.rows).toContainEqual(['L', 1]);
    expect(shirts.rows).toContainEqual(['Total', 3]);

    const leos = buildLeoSizesSheet(rows)!;
    expect(leos.name).toBe('Leo sizes');
    expect(leos.rows[0]).toEqual(['Leo — Dee (size YM)', 'YM']);
    expect(leos.rows).toContainEqual(['Total', 1]);
  });

  it('returns null when nothing of that type was purchased', () => {
    expect(buildPurchasedShirtsSheet([addonRow({ refLineType: 'leo' })])).toBeNull();
    expect(buildLeoSizesSheet([addonRow({ refLineType: 'tshirt' })])).toBeNull();
    expect(buildPurchasedShirtsSheet([])).toBeNull();
  });

  it('treats a missing/blank size as Unspecified', () => {
    const sheet = buildPurchasedShirtsSheet([addonRow({ addonSize: null })])!;
    expect(sheet.rows[0][1]).toBe('Unspecified');
    expect(sheet.rows).toContainEqual(['Unspecified', 1]);
  });
});

describe('buildBanquetSheet', () => {
  it('resolves assignee names, tallies assigned vs extra, and returns null when nothing purchased', () => {
    const rows: HostAddonRow[] = [
      addonRow({ itemId: 'b1', refLineType: 'banquet', addonAssignee: 'a1', assigneeFirstName: 'Ada', assigneeLastName: 'Lovelace', label: 'Banquet — For Ada' }),
      addonRow({ itemId: 'b2', refLineType: 'banquet', addonAssignee: 'extra', assigneeFirstName: null, assigneeLastName: null, label: 'Banquet — Extra ticket' }),
      addonRow({ itemId: 'b3', refLineType: 'tshirt' }),
    ];
    const sheet = buildBanquetSheet(rows)!;
    expect(sheet.name).toBe('Banquet');
    expect(sheet.rows[0]).toEqual(['Ada Lovelace', 'Banquet — For Ada']);
    expect(sheet.rows[1]).toEqual(['Extra ticket', 'Banquet — Extra ticket']);
    expect(sheet.rows).toContainEqual(['Total tickets', 2]);
    expect(sheet.rows).toContainEqual(['Assigned', 1]);
    expect(sheet.rows).toContainEqual(['Extra', 1]);

    expect(buildBanquetSheet([addonRow({ refLineType: 'tshirt' })])).toBeNull();
  });
});

describe('buildCampRosterSheet', () => {
  // Default (no `questions` arg) falls back to the legacy 4-question survey's
  // resolved labels — full sentences, since that's what `campSurveyQuestionsOf`
  // derives (event-mgmt v2 §G question list made editable 2026-07-23).
  it('gives one row per athlete with legacy survey answers, purchased sizes joined by refUserId, and dedupes multi-reg athletes', () => {
    const rows: HostRosterRow[] = [
      row({
        regId: 'r1', athleteId: 'a1', firstName: 'Ada', lastName: 'Lovelace', dob: '2005-04-01', gender: 'Female',
        shirt: 'M', createdAt: '2026-06-01T00:00:00Z',
        campSurvey: { bedtime: '10-to-midnight', noiseLevel: 'quiet', cabinGenderPref: 'Female', roommateRequest: 'Bea' },
      }),
      // A second registration for the SAME athlete (shouldn't happen for camps, but the sheet must still dedupe).
      row({ regId: 'r2', athleteId: 'a1', firstName: 'Ada', lastName: 'Lovelace' }),
    ];
    const addonRows: HostAddonRow[] = [
      addonRow({ refLineType: 'tshirt', addonSize: 'M', refUserId: 'a1', label: 'Shirt' }),
      addonRow({ refLineType: 'leo', addonSize: 'YM', refUserId: 'a1', label: 'Leo' }),
      addonRow({ refLineType: 'tshirt', addonSize: 'L', refUserId: 'other', label: 'Shirt for someone else' }),
    ];
    const sheet = buildCampRosterSheet(rows, addonRows);
    expect(sheet.rows).toHaveLength(1);
    const r = sheet.rows[0];
    const col = (name: string) => r[sheet.columns.indexOf(name)];
    expect(col('Athlete')).toBe('Ada Lovelace');
    expect(col('Birthday')).toBe('2005-04-01');
    expect(col('Gender')).toBe('Female');
    expect(col('Shirt (profile)')).toBe('M');
    expect(col('Shirt (purchased)')).toBe('M');
    expect(col('Leo (purchased)')).toBe('YM');
    expect(col('What time do you plan to go to bed?')).toBe('10pm–midnight');
    expect(col('What is the preferred noise level in your cabin?')).toBe('Quiet');
    expect(col('Would you prefer a co-ed or single gender cabin?')).toBe('Female');
    expect(col('If you have any roommate requests (including people you DO NOT want to room with), please list them here.')).toBe('Bea');
    expect(col('Date registered')).toBe('2026-06-01T00:00:00Z');
  });

  it('leaves survey columns blank when there is no survey', () => {
    const sheet = buildCampRosterSheet([row({ campSurvey: undefined })], []);
    expect(sheet.rows[0][sheet.columns.indexOf('What time do you plan to go to bed?')]).toBe('');
  });

  it('builds columns dynamically from a custom question list, joining multi-select answers with "; "', () => {
    const questions: CampSurveyQuestion[] = [
      { id: 'q-1', label: 'Favorite color?', type: 'text', required: true },
      { id: 'q-2', label: 'Activities', type: 'multi', options: ['Archery', 'Swimming'], required: false },
    ];
    const sheet = buildCampRosterSheet(
      [row({ campSurvey: { 'q-1': 'Blue', 'q-2': ['Archery', 'Swimming'] } })],
      [],
      questions,
    );
    expect(sheet.columns).toContain('Favorite color?');
    expect(sheet.columns).toContain('Activities');
    expect(sheet.columns).not.toContain('Bedtime');
    const col = (name: string) => sheet.rows[0][sheet.columns.indexOf(name)];
    expect(col('Favorite color?')).toBe('Blue');
    expect(col('Activities')).toBe('Archery; Swimming');
  });
});

describe('buildRegistrationWorkbookSheets', () => {
  it('builds the core three sheets when no add-ons are configured and the event is not a camp', () => {
    const sheets = buildRegistrationWorkbookSheets([row({})], resolve);
    expect(sheets.map((s) => s.name)).toEqual(['Athletes', 'Counts', 'Shirt sizes (profile)']);
  });

  it('adds purchased-addon sheets only when configured AND purchased, and the camp sheet only for camps', () => {
    const addonRows: HostAddonRow[] = [
      addonRow({ refLineType: 'tshirt', addonSize: 'M', label: 'Shirt' }),
      addonRow({ refLineType: 'leo', addonSize: 'YM', label: 'Leo' }),
      addonRow({ refLineType: 'banquet', addonAssignee: 'extra', label: 'Banquet' }),
    ];
    const sheets = buildRegistrationWorkbookSheets([row({})], resolve, addonRows, {
      tshirtConfigured: true, leoConfigured: true, banquetConfigured: true, isCamp: true,
    });
    expect(sheets.map((s) => s.name)).toEqual([
      'Athletes', 'Counts', 'Shirt sizes (profile)', 'Shirts (purchased)', 'Leo sizes', 'Banquet', 'Camp roster',
    ]);
  });

  it('omits a configured add-on sheet when nothing of that type was purchased', () => {
    const sheets = buildRegistrationWorkbookSheets([row({})], resolve, [], {
      tshirtConfigured: true, leoConfigured: false, banquetConfigured: false, isCamp: false,
    });
    expect(sheets.map((s) => s.name)).toEqual(['Athletes', 'Counts', 'Shirt sizes (profile)']);
  });
});

// Independents-exist rule (2026-08-27): sheets label a club-less registrant
// 'Independent' — never an empty cell, never 'Unknown club'.
import { buildAthletesSheet, buildCountsSheet } from '../src/lib/host-export';
describe('independent club labels', () => {
  const indyRow = {
    athleteId: 'a1', firstName: 'Indy', lastName: 'Solo', clubId: '', clubName: null,
    discipline: 'MAG', levelId: 'lv1', apparatus: ['FX'], sessionId: null,
    dietary: [], shirt: null, email: null, phone: null, gender: null, dob: null,
  } as never;
  it('athlete detail sheet shows Independent', () => {
    const sheet = buildAthletesSheet([indyRow]);
    expect(JSON.stringify(sheet)).toContain('Independent');
    expect(JSON.stringify(sheet)).not.toContain('Unknown club');
  });
  it('counts sheet shows Independent', () => {
    const sheet = buildCountsSheet([indyRow]);
    expect(JSON.stringify(sheet)).toContain('Independent');
    expect(JSON.stringify(sheet)).not.toContain('Unknown club');
  });
});
