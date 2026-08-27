import { describe, it, expect } from 'vitest';
import {
  tallyVotes, nextSanctionId, stateCode,
  deadlineEditable, deadlineToLocalInputValue, localInputValueToDeadlineISO,
} from '../src/lib/sanction';

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

  describe('real 2-person Sanctioning Team (UAT round 2, 2026-08-26)', () => {
    it('1 approval of 2 stays pending before the deadline', () => {
      const t = tallyVotes(v(1, 'approve'), 2, before, deadline);
      expect(t).toMatchObject({ decided: false, outcome: 'pending', approvals: 1 });
    });

    it('2 of 2 approvals early-approves — unanimity at team size 2 is intentional', () => {
      // ceil(2/3 * 2) = 2: both members must approve, exactly as designed.
      const t = tallyVotes(v(2, 'approve'), 2, before, deadline);
      expect(t).toMatchObject({ decided: true, outcome: 'approved', approvals: 2 });
    });

    it('1 approve + 1 reject at the deadline rejects (no majority)', () => {
      const t = tallyVotes([...v(1, 'approve'), ...v(1, 'reject')], 2, after, deadline);
      expect(t).toMatchObject({ decided: true, outcome: 'rejected', approvals: 1, rejections: 1 });
    });

    it('a tie at the deadline rejects', () => {
      // Same case as above, phrased as the general tie rule at a small team size.
      const t = tallyVotes([...v(1, 'approve'), ...v(1, 'reject')], 2, after, deadline);
      expect(t.outcome).toBe('rejected');
    });
  });

  describe('team size 3: 2 approvals early-approve (ceil(2/3*3) = 2)', () => {
    it('2 of 3 approvals early-approves before the deadline', () => {
      const t = tallyVotes(v(2, 'approve'), 3, before, deadline);
      expect(t).toMatchObject({ decided: true, outcome: 'approved', approvals: 2 });
    });

    it('1 of 3 approvals stays pending before the deadline', () => {
      const t = tallyVotes(v(1, 'approve'), 3, before, deadline);
      expect(t).toMatchObject({ decided: false, outcome: 'pending', approvals: 1 });
    });
  });

  describe('teamSize: null (RPC unavailable — never guess a number)', () => {
    it('never early-approves, no matter how many approvals are cast', () => {
      const t = tallyVotes(v(10, 'approve'), null, before, deadline);
      expect(t).toMatchObject({ decided: false, outcome: 'pending', approvals: 10 });
    });

    it('the at/after-deadline majority path is unaffected by an unknown team size', () => {
      const approved = tallyVotes([...v(2, 'approve'), ...v(1, 'reject')], null, after, deadline);
      expect(approved).toMatchObject({ decided: true, outcome: 'approved' });

      const rejected = tallyVotes([...v(1, 'approve'), ...v(1, 'reject')], null, after, deadline);
      expect(rejected).toMatchObject({ decided: true, outcome: 'rejected' });
    });
  });
});

describe('deadlineEditable (owners\' decision 2026-08-26)', () => {
  it('a sanctioning voter may edit while the request is voting', () => {
    expect(deadlineEditable('voting', true)).toBe(true);
  });

  it('an admin-only viewer (canVoteSanction false) cannot edit, even while voting', () => {
    expect(deadlineEditable('voting', false)).toBe(false);
  });

  it('a decided request is read-only regardless of role', () => {
    expect(deadlineEditable('approved', true)).toBe(false);
    expect(deadlineEditable('rejected', true)).toBe(false);
  });

  it('a not-yet-voting request (draft/submitted) is not editable', () => {
    expect(deadlineEditable('draft', true)).toBe(false);
    expect(deadlineEditable('submitted', true)).toBe(false);
  });
});

describe('deadline <-> datetime-local conversion (real UTC instant, not naive-local)', () => {
  it('deadlineToLocalInputValue returns "" for empty/null/undefined/unparsable input', () => {
    expect(deadlineToLocalInputValue('')).toBe('');
    expect(deadlineToLocalInputValue(null)).toBe('');
    expect(deadlineToLocalInputValue(undefined)).toBe('');
    expect(deadlineToLocalInputValue('not-a-date')).toBe('');
  });

  it('deadlineToLocalInputValue produces a minute-precision "YYYY-MM-DDTHH:MM" value', () => {
    const v = deadlineToLocalInputValue('2026-06-25T14:30:00.000Z');
    expect(v).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });

  it('localInputValueToDeadlineISO returns null for empty/unparsable input', () => {
    expect(localInputValueToDeadlineISO('')).toBeNull();
    expect(localInputValueToDeadlineISO('not-a-date')).toBeNull();
  });

  it('localInputValueToDeadlineISO returns a real ISO instant for a valid local value', () => {
    const iso = localInputValueToDeadlineISO('2026-06-25T14:30');
    expect(iso).not.toBeNull();
    expect(new Date(iso!).toISOString()).toBe(iso);
  });

  it('round-trips a whole-minute UTC instant through local-input and back (timezone-independent)', () => {
    const original = '2026-06-25T14:30:00.000Z';
    const localValue = deadlineToLocalInputValue(original);
    const roundTripped = localInputValueToDeadlineISO(localValue);
    expect(roundTripped).toBe(original);
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
