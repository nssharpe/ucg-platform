import { describe, it, expect } from 'vitest';
import { sanctionSummaryRows, groupSanctionSummary } from '../supabase/functions/_shared/sanction-summary';

const full = {
  eventName: 'ZZTEST_ApproveThis', eventKind: 'competition',
  altContact: { name: 'Alt Person', email: 'alt@x.com', phone: '555-1212' },
  accessible: true,
  startDate: '2026-11-05', endDate: '2026-11-06',
  regOpens: '2026-09-06T12:00', regCloses: '2026-10-22T23:59', lateRegStart: null,
  venue: 'Z Center', street: '120 Vassar St', city: 'Cambridge', state: 'MA', country: 'United States',
  isRegionalBid: true, hasAthleticTrainer: false, insuranceNeeded: false,
  estimatedParticipants: 80, maxParticipants: null,
  wagLevels: ['lvl-w1', 'lvl-w2'], magLevels: [], tntLevels: [],
  collectFees: true, perParticipantFee: 35, lateFee: 10, payoutMethod: 'paypal', paypalEmail: 'pay@x.com', paypalName: 'MIT Gym',
  naigcAwards: true, awardsAddress: '77 Mass Ave', awardPlaces: 3, awardType: 'medals', ribbonRanking: ['1st', '', ''],
  wantBanner: true, hotelBlock: false, overnightDescription: null,
  tshirtAddon: { price: 5, sizes: ['S', 'M'] }, leoAddon: null,
  yearsPreviouslyHeld: '2024, 2025', additionalComments: 'Please approve', certTypedName: 'Julia Sharpe',
};

const by = (rows: ReturnType<typeof sanctionSummaryRows>, label: string) => rows.find((r) => r.label === label)?.value;

describe('sanctionSummaryRows', () => {
  it('renders every answered field with human-readable values', () => {
    const rows = sanctionSummaryRows(full, { hostClubName: 'MIT Gymnastics Club', levelName: (id) => ({ 'lvl-w1': 'Xcel Silver', 'lvl-w2': 'Xcel Gold' })[id] });
    expect(by(rows, 'Event name')).toBe('ZZTEST_ApproveThis');
    expect(by(rows, 'Event kind')).toBe('Competition');
    expect(by(rows, 'Host club')).toBe('MIT Gymnastics Club');
    expect(by(rows, 'Alternate contact')).toBe('Alt Person · alt@x.com · 555-1212');
    expect(by(rows, 'Dates')).toBe('2026-11-05 to 2026-11-06');
    expect(by(rows, 'Registration opens')).toBe('2026-09-06 12:00');
    expect(by(rows, 'Address')).toBe('120 Vassar St, Cambridge, MA, United States');
    expect(by(rows, 'Regional bid')).toBe('Yes');
    expect(by(rows, 'Athletic trainer present')).toBe('No');
    expect(by(rows, 'WAG levels')).toBe('Xcel Silver, Xcel Gold');
    expect(by(rows, 'MAG levels')).toBeUndefined(); // empty selection is omitted
    expect(by(rows, 'Per-participant fee')).toBe('$35.00');
    expect(by(rows, 'Late fee')).toBe('$10.00');
    expect(by(rows, 'Payout method')).toBe('PayPal');
    expect(by(rows, 'PayPal name')).toBe('MIT Gym');
    expect(rows.some((r) => r.value === 'pay@x.com')).toBe(false); // payout address never rendered
    expect(by(rows, 'Award places')).toBe('3');
    expect(by(rows, 'Award type')).toBe('Medals');
    expect(by(rows, 'Ribbon ranking')).toBe('1st');
    expect(by(rows, 'T-shirt add-on')).toBe('$5.00 · sizes S, M');
    expect(by(rows, 'Leo add-on')).toBe('No');
    expect(by(rows, 'Certified by')).toBe('Julia Sharpe');
  });

  it('omits conditional groups whose toggle is off and blank answers', () => {
    const rows = sanctionSummaryRows({
      eventName: 'Mini', eventKind: 'camp', startDate: '2026-11-05', endDate: '2026-11-05',
      collectFees: false, perParticipantFee: 99, naigcAwards: false, awardPlaces: 3,
      wagLevels: [], magLevels: ['m1'], tntLevels: [], venue: '', additionalComments: null,
    });
    expect(by(rows, 'Event kind')).toBe('Camp');
    expect(by(rows, 'Dates')).toBe('2026-11-05'); // same-day range collapses
    expect(by(rows, 'UCG collects fees')).toBe('No');
    expect(by(rows, 'Per-participant fee')).toBeUndefined();
    expect(by(rows, 'Award places')).toBeUndefined();
    expect(by(rows, 'MAG levels')).toBe('m1'); // unknown id falls back to the id
    expect(by(rows, 'Venue')).toBeUndefined();
    expect(by(rows, 'Additional comments')).toBeUndefined();
  });

  it('handles an empty payload without throwing', () => {
    expect(sanctionSummaryRows({})).toEqual([]);
  });
});

describe('groupSanctionSummary', () => {
  it('groups rows by section in first-seen order', () => {
    const rows = sanctionSummaryRows(full, {});
    const groups = groupSanctionSummary(rows);
    expect(groups.map((g) => g.section)).toEqual(['Event', 'Dates & location', 'Competition details', 'Levels', 'Fees & awards', 'Add-ons & other']);
    expect(groups[0].rows.map((r) => r.label)).toContain('Event name');
  });
});
