import { describe, it, expect } from 'vitest';
import { checkinAthleteCount, type CheckinScopeReg } from '../src/lib/pricing';

describe('checkinAthleteCount', () => {
  it('returns 0 for no registrations', () => {
    expect(checkinAthleteCount([])).toBe(0);
  });

  it('counts distinct athletes, not registrations', () => {
    const regs: CheckinScopeReg[] = [
      { athleteId: 'a1' },
      { athleteId: 'a1' }, // same athlete, second discipline/apparatus
      { athleteId: 'a2' },
      { athleteId: 'a3' },
    ];
    expect(checkinAthleteCount(regs)).toBe(3);
  });

  it('counts a single athlete once even with many entries', () => {
    const regs: CheckinScopeReg[] = [{ athleteId: 'solo' }, { athleteId: 'solo' }, { athleteId: 'solo' }];
    expect(checkinAthleteCount(regs)).toBe(1);
  });
});
