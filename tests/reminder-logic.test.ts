import { describe, it, expect } from 'vitest';
import { sanctionReminderStage, notificationLogId } from '../supabase/functions/_shared/reminder-logic';

describe('sanctionReminderStage', () => {
  const deadline = '2026-07-15T00:00:00Z';

  it('returns null well before the 3-day window opens', () => {
    expect(sanctionReminderStage('2026-07-01T00:00:00Z', deadline)).toBeNull();
  });

  it('returns null just before the 3-day mark', () => {
    expect(sanctionReminderStage('2026-07-11T23:59:59.999Z', deadline)).toBeNull();
  });

  it('returns 3d exactly at the 3-day mark', () => {
    expect(sanctionReminderStage('2026-07-12T00:00:00Z', deadline)).toBe('3d');
  });

  it('returns 3d anywhere inside the 3-day window', () => {
    expect(sanctionReminderStage('2026-07-13T12:00:00Z', deadline)).toBe('3d');
  });

  it('returns 3d just before the 1-day mark', () => {
    expect(sanctionReminderStage('2026-07-13T23:59:59.999Z', deadline)).toBe('3d');
  });

  it('returns 1d exactly at the 1-day mark', () => {
    expect(sanctionReminderStage('2026-07-14T00:00:00Z', deadline)).toBe('1d');
  });

  it('returns 1d anywhere inside the 1-day window', () => {
    expect(sanctionReminderStage('2026-07-14T12:00:00Z', deadline)).toBe('1d');
  });

  it('returns 1d just before the deadline', () => {
    expect(sanctionReminderStage('2026-07-14T23:59:59.999Z', deadline)).toBe('1d');
  });

  it('returns closed exactly at the deadline', () => {
    expect(sanctionReminderStage('2026-07-15T00:00:00Z', deadline)).toBe('closed');
  });

  it('returns closed well after the deadline', () => {
    expect(sanctionReminderStage('2026-08-01T00:00:00Z', deadline)).toBe('closed');
  });

  it('returns null when deadline is missing', () => {
    expect(sanctionReminderStage('2026-07-13T00:00:00Z', null)).toBeNull();
    expect(sanctionReminderStage('2026-07-13T00:00:00Z', undefined)).toBeNull();
    expect(sanctionReminderStage('2026-07-13T00:00:00Z', '')).toBeNull();
  });

  it('returns null when deadline is not a valid date', () => {
    expect(sanctionReminderStage('2026-07-13T00:00:00Z', 'not-a-date')).toBeNull();
  });

  it('returns null when now is not a valid date', () => {
    expect(sanctionReminderStage('not-a-date', deadline)).toBeNull();
  });
});

describe('notificationLogId', () => {
  it('builds a deterministic id from kind, ref_id, recipient', () => {
    expect(notificationLogId('sanction-reminder-3d', 'req-1', 'a@b.com')).toBe('sanction-reminder-3d:req-1:a@b.com');
  });

  it('is stable across repeated calls with the same inputs', () => {
    const a = notificationLogId('sanction-voting-closed', 'req-9', 'x@y.com');
    const b = notificationLogId('sanction-voting-closed', 'req-9', 'x@y.com');
    expect(a).toBe(b);
  });

  it('differs when any component differs', () => {
    const base = notificationLogId('sanction-reminder-1d', 'req-1', 'a@b.com');
    expect(notificationLogId('sanction-reminder-3d', 'req-1', 'a@b.com')).not.toBe(base);
    expect(notificationLogId('sanction-reminder-1d', 'req-2', 'a@b.com')).not.toBe(base);
    expect(notificationLogId('sanction-reminder-1d', 'req-1', 'c@d.com')).not.toBe(base);
  });
});
