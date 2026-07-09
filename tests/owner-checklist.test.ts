import { describe, it, expect } from 'vitest';
import { ownerTaskDueDate, ownerReminderStage, OWNER_TASKS } from '../supabase/functions/_shared/owner-checklist';
import type { OwnerChecklist } from '../supabase/functions/_shared/owner-checklist';

describe('OWNER_TASKS', () => {
  it('has the 7 tasks in spec order', () => {
    expect(OWNER_TASKS.map((t) => t.id)).toEqual([
      'contact', 'hotel', 'medalsOrdered', 'medalsTracking', 'insurance', 'onsiteRep', 'payHost',
    ]);
  });
});

describe('ownerTaskDueDate', () => {
  const event = {
    createdAt: '2026-07-01T00:00:00Z',
    regOpens: '2026-08-01T00:00:00Z',
    startDate: '2026-09-15',
    endDate: '2026-09-17',
  };

  it('contact = creation + 7 days', () => {
    expect(ownerTaskDueDate('contact', event)).toBe('2026-07-08T00:00:00.000Z');
  });

  it('contact is null with no createdAt', () => {
    expect(ownerTaskDueDate('contact', { ...event, createdAt: undefined })).toBeNull();
  });

  it('hotel = regOpens verbatim', () => {
    expect(ownerTaskDueDate('hotel', event)).toBe(event.regOpens);
  });

  it('hotel is null with no regOpens', () => {
    expect(ownerTaskDueDate('hotel', { ...event, regOpens: '' })).toBeNull();
  });

  it('medalsOrdered = creation + 7 days', () => {
    expect(ownerTaskDueDate('medalsOrdered', event)).toBe('2026-07-08T00:00:00.000Z');
  });

  it('medalsTracking is null until orderedOn is set', () => {
    expect(ownerTaskDueDate('medalsTracking', event)).toBeNull();
    expect(ownerTaskDueDate('medalsTracking', event, {})).toBeNull();
  });

  it('medalsTracking = orderedOn + 14 days once set', () => {
    const checklist: OwnerChecklist = { medalsOrdered: { orderedOn: '2026-07-10T00:00:00Z' } };
    expect(ownerTaskDueDate('medalsTracking', event, checklist)).toBe('2026-07-24T00:00:00.000Z');
  });

  it('insurance = creation + 14 days', () => {
    expect(ownerTaskDueDate('insurance', event)).toBe('2026-07-15T00:00:00.000Z');
  });

  it('onsiteRep = startDate - 14 days', () => {
    expect(ownerTaskDueDate('onsiteRep', event)).toBe('2026-09-01T00:00:00.000Z');
  });

  it('payHost = endDate + 7 days', () => {
    expect(ownerTaskDueDate('payHost', event)).toBe('2026-09-24T00:00:00.000Z');
  });
});

describe('ownerReminderStage', () => {
  const due = new Date('2026-07-15T00:00:00Z');

  it('returns null well before the 1-week window opens', () => {
    expect(ownerReminderStage(new Date('2026-07-01T00:00:00Z'), due)).toBeNull();
  });

  it('returns null just before the 1-week mark', () => {
    expect(ownerReminderStage(new Date('2026-07-07T23:59:59.999Z'), due)).toBeNull();
  });

  it('returns 1w exactly at the 1-week mark', () => {
    expect(ownerReminderStage(new Date('2026-07-08T00:00:00Z'), due)).toBe('1w');
  });

  it('returns 1w anywhere inside the 1-week window', () => {
    expect(ownerReminderStage(new Date('2026-07-10T12:00:00Z'), due)).toBe('1w');
  });

  it('returns 1w just before the 1-day mark', () => {
    expect(ownerReminderStage(new Date('2026-07-13T23:59:59.999Z'), due)).toBe('1w');
  });

  it('returns 1d exactly at the 1-day mark', () => {
    expect(ownerReminderStage(new Date('2026-07-14T00:00:00Z'), due)).toBe('1d');
  });

  it('returns 1d anywhere inside the 1-day window', () => {
    expect(ownerReminderStage(new Date('2026-07-14T12:00:00Z'), due)).toBe('1d');
  });

  it('returns 1d just before the deadline', () => {
    expect(ownerReminderStage(new Date('2026-07-14T23:59:59.999Z'), due)).toBe('1d');
  });

  it('returns overdue-YYYY-MM-DD exactly at the deadline', () => {
    expect(ownerReminderStage(due, due)).toBe('overdue-2026-07-15');
  });

  it('returns overdue-YYYY-MM-DD keyed to the current day, well past the deadline', () => {
    expect(ownerReminderStage(new Date('2026-08-01T00:00:00Z'), due)).toBe('overdue-2026-08-01');
  });

  it('returns null when overdue but already sent today (lastDailyKeyDate matches)', () => {
    expect(ownerReminderStage(new Date('2026-08-01T05:00:00Z'), due, '2026-08-01')).toBeNull();
  });

  it('returns a new overdue stage the day after lastDailyKeyDate', () => {
    expect(ownerReminderStage(new Date('2026-08-02T00:00:00Z'), due, '2026-08-01')).toBe('overdue-2026-08-02');
  });

  it('returns null when due is invalid', () => {
    expect(ownerReminderStage(new Date(), new Date('not-a-date'))).toBeNull();
  });

  it('returns null when now is invalid', () => {
    expect(ownerReminderStage(new Date('not-a-date'), due)).toBeNull();
  });
});
