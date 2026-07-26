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

/**
 * Absolute app base URL (origin + Vite base path, trailing slash stripped) —
 * build absolute in-app links from THIS, not `location.origin` alone, so
 * they still work under the GitHub Pages subpath (`/ucg-platform/`) and any
 * future host. Mirrors the `appUrl` pattern already used by
 * JudgeAccessCard (src/pages/Events.tsx) for its judge-access link/QR code.
 */
export function appBaseUrl(): string {
  return window.location.origin + import.meta.env.BASE_URL.replace(/\/$/, '');
}

/**
 * Copy text to the clipboard; falls back to a `prompt()` dialog showing the
 * text when the Clipboard API is unavailable or denied (e.g. non-secure
 * context, permission blocked, older browser). Returns true when the
 * clipboard write itself succeeded (the caller can toast on that; the
 * prompt() fallback is its own visible affordance and needs no toast).
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    window.prompt('Copy this link:', text);
    return false;
  }
}
