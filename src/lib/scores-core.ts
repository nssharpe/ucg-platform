// scores-core.ts — pure compare-and-set decision for score posting
// (UAT Z-06-01). Mirrors the predicate inside the `post_score` SQL function
// (supabase/migrations/20260822020000_score_compare_and_set.sql) so the
// invariant is unit-testable without a database. The DATABASE is the one
// real enforcement point (row-locked, so it's also race-safe under true
// concurrency, which this pure function alone can never be) — both writer
// paths (the signed-in client's `pushScore` and the anonymous `judge-entry`
// Edge Function, service role) call that SAME RPC. This export exists for
// tests/documentation of the invariant, not as a second enforcement point.

/** Would posting a score to a row whose current `updated_at` is
 *  `existingUpdatedAt` conflict, given the caller last saw `expectedUpdatedAt`
 *  for that row (or `null`/`undefined` if it believes no row exists yet)?
 *
 *  - No existing row at all -> never a conflict (nothing to overwrite).
 *  - A row exists but the caller expected none -> ALWAYS a conflict. This is
 *    the two-concurrent-judges case: judge B's device loaded the score pad
 *    before judge A's post landed, so judge B has never seen an updated_at
 *    for this id.
 *  - A row exists and the expectation matches exactly -> no conflict.
 *  - A row exists and the expectation differs -> conflict (someone else
 *    posted since the caller last read this row). */
export function shouldConflict(
  existingUpdatedAt: string | null | undefined,
  expectedUpdatedAt: string | null | undefined,
): boolean {
  if (existingUpdatedAt == null) return false;
  if (expectedUpdatedAt == null) return true;
  return expectedUpdatedAt !== existingUpdatedAt;
}
