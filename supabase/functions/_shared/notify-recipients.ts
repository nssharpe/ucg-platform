// _shared/notify-recipients.ts — pure email-recipient validate+dedupe, kept
// dependency-free (no Deno/Supabase imports) so it's directly unit-testable,
// mirroring judge-entry-core.ts/season-lifecycle.ts. Extracted from
// notify-sanction (UAT E-01, 2026-08-27) because the 'submitted' and
// 'approved' events BOTH need to resolve the Sanctioning Team's email list
// independently of whatever else that event sends.

export interface RecipientPersonLite {
  first_name: string | null;
  last_name: string | null;
  email: string | null;
}

export interface EmailRecipient {
  /** "First Last" (trimmed; empty if both names are missing). */
  name: string;
  email: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Validate + case-insensitive-dedupe a list of people rows into sendable
 *  email recipients. Rows with a missing/malformed email, or a repeat of an
 *  email already seen (case-insensitive — the same person can show up twice,
 *  e.g. via two roles), are silently dropped. Order of first occurrence is
 *  preserved. */
export function dedupeEmailRecipients(people: RecipientPersonLite[]): EmailRecipient[] {
  const seen = new Set<string>();
  const out: EmailRecipient[] = [];
  for (const p of people) {
    const email = (p.email ?? '').trim();
    const key = email.toLowerCase();
    if (!EMAIL_RE.test(email) || seen.has(key)) continue;
    seen.add(key);
    out.push({ name: `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim(), email });
  }
  return out;
}
