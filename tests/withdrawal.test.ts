import { describe, it, expect } from 'vitest';
import { withdrawalPlan, withdrawalEmailVariant } from '../src/lib/withdrawal';

describe('withdrawalPlan', () => {
  it('removes when the event has no lastDateToEdit at all', () => {
    expect(withdrawalPlan({ now: new Date('2026-09-01'), lastDateToEdit: null })).toBe('remove');
  });

  it('removes at-or-before lastDateToEdit', () => {
    expect(withdrawalPlan({ now: new Date('2026-08-01T12:00:00Z'), lastDateToEdit: '2026-08-01T12:00:00Z' })).toBe('remove');
    expect(withdrawalPlan({ now: new Date('2026-07-31T00:00:00Z'), lastDateToEdit: '2026-08-01T00:00:00Z' })).toBe('remove');
  });

  it('scratches strictly after lastDateToEdit', () => {
    expect(withdrawalPlan({ now: new Date('2026-08-01T12:00:01Z'), lastDateToEdit: '2026-08-01T12:00:00Z' })).toBe('scratch');
    expect(withdrawalPlan({ now: new Date('2026-09-01'), lastDateToEdit: '2026-08-01T00:00:00Z' })).toBe('scratch');
  });
});

describe('withdrawalEmailVariant', () => {
  it('is plain for a UCG-hosted / refund-eligible event regardless of club', () => {
    expect(withdrawalEmailVariant({ ucgHosted: true, athleteClubId: 'club-a', hostClubId: 'club-b' })).toBe('plain');
    expect(withdrawalEmailVariant({ ucgHosted: true, athleteClubId: null, hostClubId: null })).toBe('plain');
    expect(withdrawalEmailVariant({ ucgHosted: true, athleteClubId: 'club-a', hostClubId: 'club-a' })).toBe('plain');
  });

  it('is refund-contact for a non-UCG event when the athlete competes elsewhere', () => {
    expect(withdrawalEmailVariant({ ucgHosted: false, athleteClubId: 'club-a', hostClubId: 'club-b' })).toBe('refund-contact');
  });

  it('is refund-contact when the athlete has no club at a non-UCG event', () => {
    expect(withdrawalEmailVariant({ ucgHosted: false, athleteClubId: null, hostClubId: 'club-b' })).toBe('refund-contact');
  });

  it('is host-club for a non-UCG event when the athlete competes for the host club', () => {
    expect(withdrawalEmailVariant({ ucgHosted: false, athleteClubId: 'club-a', hostClubId: 'club-a' })).toBe('host-club');
  });

  it('is refund-contact for a non-UCG event with no host club on record', () => {
    expect(withdrawalEmailVariant({ ucgHosted: false, athleteClubId: 'club-a', hostClubId: null })).toBe('refund-contact');
  });
});
