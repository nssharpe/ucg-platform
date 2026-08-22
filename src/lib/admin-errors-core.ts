// Pure helpers for the admin "Errors & Problems" page (src/pages/AdminErrors.tsx):
// client-side search/filter over an already-fetched page of problem reports,
// and the keyset "Load more" cursor shared by both its tabs. Kept free of
// React/Supabase so it's unit-testable, mirroring events-core.ts.

export type ProblemCategory = 'bug' | 'question' | 'unsure';
export type ProblemStatus = 'open' | 'resolved';

export interface ProblemReportFilterable {
  description: string;
  reporterName: string | null;
  reporterEmail: string | null;
  route: string | null;
  category: ProblemCategory;
  status: ProblemStatus;
}

export interface ProblemReportFilter {
  q?: string;
  /** 'all' means "don't filter by status here" — the page fetches ONE status
   *  at a time from the server (fetchProblemReports({status})), so narrowing
   *  further client-side to a DIFFERENT status than what was fetched would
   *  just produce an empty list. A status change is a refetch, not a filter
   *  call; this field exists mainly so the shape matches the task and stays
   *  testable in isolation from that fetch/refetch wiring. */
  status?: ProblemStatus | 'all';
  category?: ProblemCategory | 'all';
}

/** Client-side search/filter over one already-fetched page of problem
 *  reports. Matches `q` against description, reporter name/email, and
 *  route (case-insensitive substring). */
export function filterProblemReports<T extends ProblemReportFilterable>(
  rows: T[],
  filter: ProblemReportFilter,
): T[] {
  const q = (filter.q ?? '').trim().toLowerCase();
  return rows.filter((r) => {
    if (filter.status && filter.status !== 'all' && r.status !== filter.status) return false;
    if (filter.category && filter.category !== 'all' && r.category !== filter.category) return false;
    if (!q) return true;
    return (
      r.description.toLowerCase().includes(q) ||
      (r.reporterName ?? '').toLowerCase().includes(q) ||
      (r.reporterEmail ?? '').toLowerCase().includes(q) ||
      (r.route ?? '').toLowerCase().includes(q)
    );
  });
}

/** Keyset pagination cursor for "Load more": the `created_at` of the OLDEST
 *  row in a page ordered `created_at desc` (i.e. the LAST element), or null
 *  when the page is empty. Pass the result as `before` to the next fetch
 *  (`created_at < before`).
 *
 *  `created_at` is not unique, so a burst of rows sharing the exact cursor
 *  timestamp could in principle be skipped by a strict `<` fetch on the next
 *  page. This is an accepted, documented gap rather than a composite
 *  `(created_at, id)` cursor — callers append-and-dedupe the next page by
 *  `id`, which makes an accidental *overlap* harmless; a same-millisecond
 *  *skip* is the residual risk and is rare enough (server-generated
 *  timestamps, human-paced admin submissions) not to warrant the extra
 *  complexity here. */
export function nextPageCursor(rows: { createdAt: string }[]): string | null {
  if (rows.length === 0) return null;
  return rows[rows.length - 1].createdAt;
}
