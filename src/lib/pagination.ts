// Pure pagination helpers for `fetchAllRows` (src/lib/supabase.ts). Kept
// dependency-free (no Supabase client, no store) so they're directly
// testable — see tests/lib/pagination.test.ts.
//
// PostgREST's default row cap is 1000 rows per request; `fetchAllRows` pages
// past it with `.range()`. Postgres gives NO row-order guarantee across
// separate queries without an explicit ORDER BY, so paginated `.range()`
// calls without a deterministic sort can silently DUPLICATE some rows and
// SKIP others across page boundaries. Every table read via `fetchAllRows`
// must resolve to a non-empty, stable sort key via `sortKeysForTable`.

export const PAGE_SIZE = 1000;

/** Tables whose row identity is NOT a plain `id` column — the columns
 *  listed together are unique per row and give a deterministic ORDER BY.
 *  Every table not listed here defaults to sorting by `id`
 *  (see `sortKeysForTable`). Verified against src/lib/database.types.ts and
 *  the migrations that created each table:
 *  - `club_managers` / `person_alt_clubs`: composite PK (no `id` column).
 *  - `app_settings`: keyed on `key`.
 *  - `coupons`: keyed on `code`. */
const COMPOSITE_SORT_KEYS: Readonly<Record<string, readonly [string, ...string[]]>> = {
  club_managers: ['club_id', 'person_id'],
  person_alt_clubs: ['person_id', 'club_id'],
  app_settings: ['key'],
  coupons: ['code'],
};

/** Pure. Resolves the deterministic ORDER BY column(s) `fetchAllRows` must
 *  apply for a table's paginated fetch. Defaults to `['id']` for any table
 *  not in `COMPOSITE_SORT_KEYS`. Throws — rather than silently falling back
 *  to an unordered fetch — if a registered entry is somehow empty, so a
 *  misconfigured entry fails loudly instead of reintroducing the
 *  skip/duplicate bug this module exists to prevent. */
export function sortKeysForTable(table: string): readonly string[] {
  const keys = Object.prototype.hasOwnProperty.call(COMPOSITE_SORT_KEYS, table)
    ? COMPOSITE_SORT_KEYS[table]
    : (['id'] as const);
  if (!keys || keys.length === 0) {
    throw new Error(
      `fetchAllRows: no deterministic sort key for table "${table}" — register one in ` +
      `COMPOSITE_SORT_KEYS (src/lib/pagination.ts) rather than paginating unordered.`,
    );
  }
  return keys;
}

/** Pure. True when a returned page might not be the last one — i.e. it came
 *  back at (or somehow above) the page-size cap, so another `.range()` call
 *  is needed. A page shorter than the requested range means the table is
 *  exhausted. */
export function hasMorePages(receivedCount: number, pageSize: number = PAGE_SIZE): boolean {
  return receivedCount >= pageSize;
}
