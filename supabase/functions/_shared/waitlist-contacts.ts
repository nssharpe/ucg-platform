// _shared/waitlist-contacts.ts — waitlist_groups contact resolution + email
// bodies shared between scheduled-dispatch's promotion sweep and the
// manage-waitlist admin-override edge function (event-mgmt v2 P4 T7). Both
// call the SAME functions so the automatic sweep and an admin's manual
// promote/requeue send identical wording.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { renderEmail } from './email-layout.ts';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export interface Contact {
  email: string;
  name: string;
}

export interface WaitlistGroupRow {
  id: string;
  event_id: string;
  club_id: string | null;
  person_id: string | null;
}

/** The people to notify for a waitlist group: every manager of `club_id` for
 *  a club group, or the single `person_id` person for a personal group.
 *  Deduped by lowercased email; entries with no usable email are dropped. */
export async function resolveGroupContacts(db: SupabaseClient, group: WaitlistGroupRow): Promise<Contact[]> {
  if (group.person_id) {
    const { data: person } = await db
      .from('people')
      .select('email, first_name, last_name')
      .eq('id', group.person_id)
      .maybeSingle();
    const p = person as { email: string; first_name: string; last_name: string } | null;
    if (!p || !p.email || !EMAIL_RE.test(p.email.trim())) return [];
    return [{ email: p.email.trim().toLowerCase(), name: `${p.first_name} ${p.last_name}`.trim() }];
  }
  if (group.club_id) {
    const { data: mgrRows } = await db.from('club_managers').select('person_id').eq('club_id', group.club_id);
    const personIds = ((mgrRows ?? []) as { person_id: string }[]).map((r) => r.person_id);
    if (personIds.length === 0) return [];
    const { data: people } = await db.from('people').select('id, email, first_name, last_name').in('id', personIds);
    const seen = new Set<string>();
    const out: Contact[] = [];
    for (const p of (people ?? []) as { email: string; first_name: string; last_name: string }[]) {
      const email = (p.email ?? '').trim().toLowerCase();
      if (!EMAIL_RE.test(email) || seen.has(email)) continue;
      seen.add(email);
      out.push({ email, name: `${p.first_name} ${p.last_name}`.trim() });
    }
    return out;
  }
  return [];
}

/** Where the "complete checkout" / "view waitlist" link should point: the
 *  club's page for a club group, else the member's own cart/registrations. */
export function groupLandingUrl(appUrl: string, group: WaitlistGroupRow): string {
  return group.club_id ? `${appUrl}/#/club/${group.club_id}` : `${appUrl}/#/my-registrations`;
}

const fmtDeadline = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });

export function promotionEmailHtml(opts: { eventName: string; holdExpiresAt: string; link: string }): string {
  return renderEmail({
    heading: 'A spot opened up',
    bodyHtml: `<p>Hello,</p>
<p>A spot has opened up for your waitlisted registration at <strong>${esc(opts.eventName)}</strong>.</p>
<p>Complete checkout by <strong>${esc(fmtDeadline(opts.holdExpiresAt))}</strong> to claim it — after that, the spot returns to the waitlist and your place goes to the back of the queue.</p>`,
    cta: { text: 'Complete checkout', href: opts.link },
  });
}

export function requeueEmailHtml(opts: { eventName: string; link: string }): string {
  return renderEmail({
    heading: 'Your waitlist hold lapsed',
    bodyHtml: `<p>Hello,</p>
<p>The checkout window for your waitlisted spot at <strong>${esc(opts.eventName)}</strong> lapsed before checkout was completed.</p>
<p>You're still on the waitlist — you've been placed at the <strong>end of the queue</strong> and will be notified again if another spot opens up.</p>`,
    cta: { text: 'View waitlist status', href: opts.link },
  });
}

export function promotionSubject(eventName: string): string {
  return `Waitlist update — ${eventName}`;
}

export function requeueSubject(eventName: string): string {
  return `Waitlist update — ${eventName}`;
}
