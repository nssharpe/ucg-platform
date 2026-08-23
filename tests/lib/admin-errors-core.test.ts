import { describe, it, expect } from 'vitest';
import { filterProblemReports, nextPageCursor, type ProblemReportFilterable } from '../../src/lib/admin-errors-core';

function row(overrides: Partial<ProblemReportFilterable> = {}): ProblemReportFilterable {
  return {
    description: 'The submit button does nothing on Chrome.',
    reporterName: 'Jamie Rivera',
    reporterEmail: 'jamie@example.com',
    route: '#/cart',
    category: 'bug',
    status: 'open',
    ...overrides,
  };
}

describe('filterProblemReports', () => {
  it('returns everything when the filter is empty', () => {
    const rows = [row(), row({ description: 'Different one' })];
    expect(filterProblemReports(rows, {})).toHaveLength(2);
  });

  it('matches q against description (case-insensitive substring)', () => {
    const rows = [row({ description: 'Submit BUTTON broken' }), row({ description: 'Totally unrelated' })];
    expect(filterProblemReports(rows, { q: 'button' })).toHaveLength(1);
  });

  it('matches q against reporter name', () => {
    const rows = [row({ reporterName: 'Jamie Rivera' }), row({ reporterName: 'Alex Chen' })];
    expect(filterProblemReports(rows, { q: 'rivera' })).toHaveLength(1);
  });

  it('matches q against reporter email', () => {
    const rows = [row({ reporterEmail: 'coach@club.org' }), row({ reporterEmail: 'other@example.com' })];
    expect(filterProblemReports(rows, { q: 'coach@' })).toHaveLength(1);
  });

  it('matches q against route', () => {
    const rows = [row({ route: '#/admin/errors' }), row({ route: '#/events' })];
    expect(filterProblemReports(rows, { q: 'admin/errors' })).toHaveLength(1);
  });

  it('handles a null reporterName/reporterEmail/route without throwing', () => {
    const rows = [row({ reporterName: null, reporterEmail: null, route: null })];
    expect(filterProblemReports(rows, { q: 'anything' })).toHaveLength(0);
    expect(filterProblemReports(rows, {})).toHaveLength(1);
  });

  it('filters by category', () => {
    const rows = [row({ category: 'bug' }), row({ category: 'question' }), row({ category: 'unsure' })];
    expect(filterProblemReports(rows, { category: 'question' })).toHaveLength(1);
  });

  it('category "all" is a no-op', () => {
    const rows = [row({ category: 'bug' }), row({ category: 'question' })];
    expect(filterProblemReports(rows, { category: 'all' })).toHaveLength(2);
  });

  it('filters by status', () => {
    const rows = [row({ status: 'open' }), row({ status: 'resolved' })];
    expect(filterProblemReports(rows, { status: 'resolved' })).toHaveLength(1);
  });

  it('status "all" is a no-op', () => {
    const rows = [row({ status: 'open' }), row({ status: 'resolved' })];
    expect(filterProblemReports(rows, { status: 'all' })).toHaveLength(2);
  });

  it('combines q, category, and status (AND semantics)', () => {
    const rows = [
      row({ category: 'bug', status: 'open', description: 'crash on save' }),
      row({ category: 'bug', status: 'resolved', description: 'crash on save' }),
      row({ category: 'question', status: 'open', description: 'crash on save' }),
    ];
    expect(filterProblemReports(rows, { q: 'crash', category: 'bug', status: 'open' })).toHaveLength(1);
  });
});

describe('nextPageCursor', () => {
  it('returns null for an empty page', () => {
    expect(nextPageCursor([])).toBeNull();
  });

  it('returns the single row\'s createdAt', () => {
    expect(nextPageCursor([{ createdAt: '2026-08-20T10:00:00Z' }])).toBe('2026-08-20T10:00:00Z');
  });

  it('returns the LAST row\'s createdAt (oldest, under created_at desc ordering)', () => {
    const rows = [
      { createdAt: '2026-08-22T10:00:00Z' },
      { createdAt: '2026-08-21T10:00:00Z' },
      { createdAt: '2026-08-20T10:00:00Z' },
    ];
    expect(nextPageCursor(rows)).toBe('2026-08-20T10:00:00Z');
  });
});
