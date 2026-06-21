// Sanitize admin-authored waiver HTML before rendering it (members + public
// guardian page). Even though only admins can author waivers (RLS-gated), this is
// defense-in-depth for public-facing HTML rendering. Links are forced to open in a
// new tab with noopener.
import DOMPurify from 'dompurify';

let hooked = false;

export function sanitizeWaiverHtml(html: string): string {
  if (typeof window === 'undefined') return ''; // no DOM (e.g. SSR/tests) — render nothing
  if (!hooked) {
    DOMPurify.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A' && node.getAttribute('href')) {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    });
    hooked = true;
  }
  return DOMPurify.sanitize(html);
}
