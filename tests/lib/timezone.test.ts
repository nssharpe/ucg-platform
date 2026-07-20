import { describe, it, expect } from 'vitest';
import { timezoneForState } from '../../src/lib/timezone';

// Full 50-state + DC table, by 2-letter code — mirrors the spec's dominant-zone
// choices for split states (state-capital zone wins).
const STATE_CODE_ZONES: [string, string][] = [
  ['AL', 'America/Chicago'],
  ['AK', 'America/Anchorage'],
  ['AZ', 'America/Phoenix'],
  ['AR', 'America/Chicago'],
  ['CA', 'America/Los_Angeles'],
  ['CO', 'America/Denver'],
  ['CT', 'America/New_York'],
  ['DE', 'America/New_York'],
  ['DC', 'America/New_York'],
  ['FL', 'America/New_York'],
  ['GA', 'America/New_York'],
  ['HI', 'Pacific/Honolulu'],
  ['ID', 'America/Boise'],
  ['IL', 'America/Chicago'],
  ['IN', 'America/New_York'],
  ['IA', 'America/Chicago'],
  ['KS', 'America/Chicago'],
  ['KY', 'America/New_York'],
  ['LA', 'America/Chicago'],
  ['ME', 'America/New_York'],
  ['MD', 'America/New_York'],
  ['MA', 'America/New_York'],
  ['MI', 'America/New_York'],
  ['MN', 'America/Chicago'],
  ['MS', 'America/Chicago'],
  ['MO', 'America/Chicago'],
  ['MT', 'America/Denver'],
  ['NE', 'America/Chicago'],
  ['NV', 'America/Los_Angeles'],
  ['NH', 'America/New_York'],
  ['NJ', 'America/New_York'],
  ['NM', 'America/Denver'],
  ['NY', 'America/New_York'],
  ['NC', 'America/New_York'],
  ['ND', 'America/Chicago'],
  ['OH', 'America/New_York'],
  ['OK', 'America/Chicago'],
  ['OR', 'America/Los_Angeles'],
  ['PA', 'America/New_York'],
  ['RI', 'America/New_York'],
  ['SC', 'America/New_York'],
  ['SD', 'America/Chicago'],
  ['TN', 'America/Chicago'],
  ['TX', 'America/Chicago'],
  ['UT', 'America/Denver'],
  ['VT', 'America/New_York'],
  ['VA', 'America/New_York'],
  ['WA', 'America/Los_Angeles'],
  ['WV', 'America/New_York'],
  ['WI', 'America/Chicago'],
  ['WY', 'America/Denver'],
];

describe('timezoneForState — 50 states + DC, by 2-letter code', () => {
  it.each(STATE_CODE_ZONES)('%s -> %s', (code, zone) => {
    expect(timezoneForState(code)).toBe(zone);
  });

  it('covers all 50 states + DC (51 entries)', () => {
    expect(STATE_CODE_ZONES).toHaveLength(51);
  });
});

describe('timezoneForState — territories', () => {
  it('PR -> America/Puerto_Rico', () => {
    expect(timezoneForState('PR')).toBe('America/Puerto_Rico');
  });
  it('VI -> America/Puerto_Rico', () => {
    expect(timezoneForState('VI')).toBe('America/Puerto_Rico');
  });
  it('GU -> Pacific/Guam', () => {
    expect(timezoneForState('GU')).toBe('Pacific/Guam');
  });
});

describe('timezoneForState — full state names', () => {
  it('Tennessee -> America/Chicago (capital, not the split-zone default)', () => {
    expect(timezoneForState('Tennessee')).toBe('America/Chicago');
  });
  it('Kentucky -> America/New_York', () => {
    expect(timezoneForState('Kentucky')).toBe('America/New_York');
  });
  it('Texas -> America/Chicago', () => {
    expect(timezoneForState('Texas')).toBe('America/Chicago');
  });
  it('Idaho -> America/Boise', () => {
    expect(timezoneForState('Idaho')).toBe('America/Boise');
  });
  it('Oregon -> America/Los_Angeles', () => {
    expect(timezoneForState('Oregon')).toBe('America/Los_Angeles');
  });
  it('Arizona -> America/Phoenix', () => {
    expect(timezoneForState('Arizona')).toBe('America/Phoenix');
  });
  it('Alaska -> America/Anchorage', () => {
    expect(timezoneForState('Alaska')).toBe('America/Anchorage');
  });
  it('Hawaii -> Pacific/Honolulu', () => {
    expect(timezoneForState('Hawaii')).toBe('Pacific/Honolulu');
  });
  it('District of Columbia -> America/New_York', () => {
    expect(timezoneForState('District of Columbia')).toBe('America/New_York');
  });
});

describe('timezoneForState — case/whitespace insensitivity', () => {
  it('lowercase code "tn"', () => {
    expect(timezoneForState('tn')).toBe('America/Chicago');
  });
  it('padded code " TN "', () => {
    expect(timezoneForState(' TN ')).toBe('America/Chicago');
  });
  it('lowercase full name "tennessee"', () => {
    expect(timezoneForState('tennessee')).toBe('America/Chicago');
  });
  it('mixed case full name "TeNnEsSeE"', () => {
    expect(timezoneForState('TeNnEsSeE')).toBe('America/Chicago');
  });
  it('padded full name "  Oregon  "', () => {
    expect(timezoneForState('  Oregon  ')).toBe('America/Los_Angeles');
  });
});

describe('timezoneForState — unknown/foreign/blank fallback', () => {
  it('unknown state string falls back to America/New_York', () => {
    expect(timezoneForState('Neverland')).toBe('America/New_York');
  });
  it('blank state falls back to America/New_York', () => {
    expect(timezoneForState('')).toBe('America/New_York');
  });
  it('undefined state falls back to America/New_York', () => {
    expect(timezoneForState(undefined)).toBe('America/New_York');
  });
  it('null state falls back to America/New_York', () => {
    expect(timezoneForState(null)).toBe('America/New_York');
  });
  it('a US state but non-US country falls back to America/New_York', () => {
    expect(timezoneForState('California', 'Canada')).toBe('America/New_York');
  });
  it('accepts blank/omitted country as US', () => {
    expect(timezoneForState('Texas')).toBe('America/Chicago');
    expect(timezoneForState('Texas', '')).toBe('America/Chicago');
  });
  it('accepts "United States" and "USA" spellings', () => {
    expect(timezoneForState('Texas', 'United States')).toBe('America/Chicago');
    expect(timezoneForState('Texas', 'USA')).toBe('America/Chicago');
  });
});
