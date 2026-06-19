import { describe, it, expect } from 'vitest';
import { tallyVotes, nextSanctionId, stateCode } from '../src/lib/sanction';

const v = (n: number, val: 'approve' | 'reject' | 'abstain') =>
  Array.from({ length: n }, () => ({ vote: val }));

describe('tallyVotes', () => {
  const before = '2026-06-18T00:00:00Z';
  const deadline = '2026-06-25T00:00:00Z';
  const after = '2026-06-26T00:00:00Z';

  it('early-approves at 2/3 of the team', () => {
    // team 9 → ceil(6) = 6 approvals needed
    const t = tallyVotes(v(6, 'approve'), 9, before, deadline);
    expect(t).toMatchObject({ decided: true, outcome: 'approved', approvals: 6 });
  });

  it('stays pending below 2/3 before the deadline', () => {
    const t = tallyVotes([...v(5, 'approve')], 9, before, deadline);
    expect(t).toMatchObject({ decided: false, outcome: 'pending' });
  });

  it('at deadline, approves on a majority of votes cast', () => {
    const t = tallyVotes([...v(3, 'approve'), ...v(2, 'reject')], 9, after, deadline);
    expect(t).toMatchObject({ decided: true, outcome: 'approved' });
  });

  it('at deadline, rejects on a tie (no majority)', () => {
    const t = tallyVotes([...v(2, 'approve'), ...v(2, 'reject')], 9, after, deadline);
    expect(t).toMatchObject({ decided: true, outcome: 'rejected' });
  });

  it('at deadline with no votes, rejects', () => {
    const t = tallyVotes([], 9, after, deadline);
    expect(t).toMatchObject({ decided: true, outcome: 'rejected', cast: 0 });
  });

  it('counts abstains separately and they do not approve', () => {
    const t = tallyVotes([...v(1, 'approve'), ...v(3, 'abstain')], 9, after, deadline);
    expect(t).toMatchObject({ outcome: 'approved', abstains: 3, approvals: 1 });
  });
});

describe('sanction ids', () => {
  it('maps state names to codes', () => {
    expect(stateCode('Ohio')).toBe('OH');
    expect(stateCode('District of Columbia')).toBe('DC');
    expect(stateCode('tx')).toBe('TX');
    expect(stateCode('Atlantis')).toBe('XX');
  });

  it('starts at 001 for a fresh state/year', () => {
    expect(nextSanctionId(2026, 'Ohio', [])).toBe('2026_OH_001');
  });

  it('increments per state per year', () => {
    const ids = ['2026_OH_001', '2026_OH_002', '2026_TX_001', '2025_OH_009'];
    expect(nextSanctionId(2026, 'Ohio', ids)).toBe('2026_OH_003');
    expect(nextSanctionId(2026, 'Texas', ids)).toBe('2026_TX_002');
    expect(nextSanctionId(2026, 'California', ids)).toBe('2026_CA_001');
  });
});
