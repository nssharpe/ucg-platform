import { describe, it, expect } from 'vitest';
import { summarizeRoster, levelNameResolver } from '../src/lib/host-page';
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

describe('summarizeRoster', () => {
  it('groups by level, counting distinct clubs and distinct athletes per apparatus', () => {
    const rows: HostRosterRow[] = [
      row({ athleteId: 'a1', clubId: 'c1', clubName: 'Alpha Gym', levelId: 'lvl-1', apparatus: ['VT', 'UB'] }),
      row({ regId: 'r2', athleteId: 'a2', clubId: 'c1', clubName: 'Alpha Gym', levelId: 'lvl-1', apparatus: ['VT'] }),
      row({ regId: 'r3', athleteId: 'a3', clubId: 'c2', clubName: 'Beta Gym', levelId: 'lvl-1', apparatus: ['BB'] }),
    ];
    const [summary] = summarizeRoster(rows);
    expect(summary.levelId).toBe('lvl-1');
    expect(summary.clubs).toEqual([
      { clubId: 'c1', clubName: 'Alpha Gym', athleteCount: 2 },
      { clubId: 'c2', clubName: 'Beta Gym', athleteCount: 1 },
    ]);
    expect(summary.apparatusCounts).toEqual({ VT: 2, UB: 1, BB: 1 });
  });

  it('separates levels and sorts them by resolved display name', () => {
    const rows: HostRosterRow[] = [
      row({ athleteId: 'a1', levelId: 'lvl-open' }),
      row({ regId: 'r2', athleteId: 'a2', levelId: 'lvl-novice' }),
    ];
    const resolve = levelNameResolver([
      { id: 'lvl-open', name: 'Open' },
      { id: 'lvl-novice', name: 'Novice' },
    ]);
    const summary = summarizeRoster(rows, resolve);
    expect(summary.map((s) => s.levelName)).toEqual(['Novice', 'Open']);
  });

  it('counts a synchro pair once per partner athlete on the shared apparatus code', () => {
    const rows: HostRosterRow[] = [
      row({ athleteId: 'a1', levelId: 'lvl-1', apparatus: ['SY'], partnerAthleteId: 'a2' }),
      row({ regId: 'r2', athleteId: 'a2', levelId: 'lvl-1', apparatus: ['SY'], partnerAthleteId: 'a1' }),
    ];
    const [summary] = summarizeRoster(rows);
    expect(summary.apparatusCounts).toEqual({ SY: 2 });
  });

  it('groups registrations with no level under an "Unassigned level" bucket', () => {
    const rows: HostRosterRow[] = [row({ levelId: null })];
    const [summary] = summarizeRoster(rows);
    expect(summary.levelId).toBe('');
    expect(summary.levelName).toBe('Unassigned level');
  });

  it('falls back to the raw id when a level cannot be resolved', () => {
    const rows: HostRosterRow[] = [row({ levelId: 'lvl-missing' })];
    const [summary] = summarizeRoster(rows, levelNameResolver([]));
    expect(summary.levelName).toBe('lvl-missing');
  });

  it('returns [] for an empty roster', () => {
    expect(summarizeRoster([])).toEqual([]);
  });
});
