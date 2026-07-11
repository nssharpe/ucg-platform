// Pure helpers for user-entered external URLs.

/**
 * Normalize a user-entered external URL for storage/rendering.
 *
 * Users often paste values like "www.hilton.com/…" with no scheme. Rendered
 * directly as `<a href>`, the browser resolves those relative to the current
 * page (e.g. the GitHub Pages base path) instead of treating them as
 * absolute — producing a broken link. This prepends `https://` when no
 * http(s) scheme is present.
 *
 * Intentionally minimal: no further validation beyond scheme detection.
 */
export function normalizeExternalUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}
