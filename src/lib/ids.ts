/**
 * ids.ts — small id-generation helpers shared across forms.
 *
 * Kept out of component files so those can export only components (required for
 * Vite fast-refresh; see react-refresh/only-export-components).
 */

/** Next seed-style id: max numeric suffix + 1 (e.g. club-9 after club-8). */
export function nextId(items: { id: string }[], prefix: string): string {
  const max = items.reduce((m, x) => {
    const n = x.id.startsWith(prefix) ? +x.id.slice(prefix.length) : NaN;
    return Number.isFinite(n) ? Math.max(m, n) : m;
  }, 0);
  return `${prefix}${max + 1}`;
}
