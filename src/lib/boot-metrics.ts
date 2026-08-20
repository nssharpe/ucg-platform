// Pure predicates for store.ts's boot instrumentation (Phase 1 of
// docs/specs/2026-07-24-data-layer-scale.md — "make the three documented
// triggers able to fire on their own instead of only surfacing as a user bug
// report"). Kept dependency-free (no Supabase client, no DOM except the
// ambient `DOMException` type) so they're directly testable — see
// tests/lib/boot-metrics.test.ts.

/** Bytes threshold for flagging the boot payload. The spec's 2-year
 *  projection is ~60 MB against a ~5 MB localStorage quota — this fires far
 *  below either number, at "starting to matter" rather than "already
 *  broken", so there's runway to act before the quota error does. */
export const BOOT_PAYLOAD_BYTES_THRESHOLD = 2 * 1024 * 1024; // ~2 MB

/** Hydration-duration threshold (ms), per the same spec section. The timed
 *  span is the whole `loadAll()` network fetch — a 4–5-round-trip waterfall
 *  whose normal signed-in baseline measured ~3.1–3.5s in prod (error_logs,
 *  Aug 2026) — so the threshold must sit well above that floor or it fires on
 *  every ordinary boot. 10s keeps genuine tail events reportable (observed
 *  10.2s / 34.2s boots would still log) without the everyday noise. */
export const BOOT_HYDRATION_MS_THRESHOLD = 10_000; // ~10 s

/** Pure. True when either documented trigger has fired for this hydration. */
export function shouldReportBootMetrics(payloadBytes: number, hydrationMs: number): boolean {
  return payloadBytes > BOOT_PAYLOAD_BYTES_THRESHOLD || hydrationMs > BOOT_HYDRATION_MS_THRESHOLD;
}

/** Pure. True when `err` is specifically a storage-quota-exceeded exception —
 *  distinguished from every other reason `Storage.setItem` can throw (storage
 *  disabled, private-browsing denial that isn't quota-shaped, etc.), so only
 *  the genuine quota condition gets reported as a named finding. Browsers
 *  disagree on the exact shape: modern engines (incl. current Safari) use
 *  `name === 'QuotaExceededError'`; Firefox's legacy shape is
 *  `NS_ERROR_DOM_QUOTA_REACHED` / code 1014; the older cross-browser code is
 *  22. Checking all four covers both Safari- and Firefox-style exceptions
 *  regardless of version. */
export function isQuotaExceededError(err: unknown): boolean {
  if (!(err instanceof DOMException)) return false;
  return (
    err.name === 'QuotaExceededError' ||
    err.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    err.code === 22 ||
    err.code === 1014
  );
}
