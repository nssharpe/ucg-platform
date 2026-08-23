import { describe, it, expect } from 'vitest';
import { currentClubId } from '../../src/lib/current-club';

describe('currentClubId (UAT Z-01-02: no hardcoded managedClubIds[0])', () => {
  it('returns null when the viewer manages no clubs', () => {
    expect(currentClubId([], null)).toBeNull();
    expect(currentClubId([], 'club-a')).toBeNull();
  });

  it('falls back to the first managed club when nothing is stored', () => {
    expect(currentClubId(['club-a', 'club-b'], null)).toBe('club-a');
  });

  it('uses the stored club when it is one of the managed clubs', () => {
    expect(currentClubId(['club-a', 'club-b'], 'club-b')).toBe('club-b');
  });

  it('falls back to the first managed club when the stored id is stale (no longer managed)', () => {
    expect(currentClubId(['club-a', 'club-b'], 'club-zzz')).toBe('club-a');
  });

  it('a single managed club always wins regardless of a stale stored id', () => {
    expect(currentClubId(['club-a'], 'club-zzz')).toBe('club-a');
  });
});
