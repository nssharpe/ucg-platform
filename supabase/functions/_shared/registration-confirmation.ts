// _shared/registration-confirmation.ts — pure HTML/subject building shared by
// BOTH registration-confirmation email paths (UAT E-02, 2026-08-27 owner
// decisions):
//   - the PAID receipt (`_shared/fulfill.ts`'s `emailReceipt`, sent by
//     stripe-webhook / create-checkout-session's free-order path)
//   - the $0 host-club SELF-registration confirmation
//     (`send-registration-confirmation`), which has no purchase/receipt at
//     all — a host-club registration is created `paid:true` with no cart
//     line, so `emailReceipt` never runs for it (that gap was the root cause
//     of E-02-02).
//
// Both paths render the SAME host-message card and use the SAME subject rule,
// so a host's registrants see one consistent look regardless of which path
// fired. NO Deno/Supabase imports here — unit-tested by vitest under node
// (tests/registration-confirmation.test.ts), mirroring the camp-confirmation.ts
// pattern: this file does no DB work and makes no assumptions about how the
// caller fetched its inputs, so a failure upstream never has to touch this
// file to stay contained.
//
// E-03 retirement note: the per-event "from alias" / "reply-to" override that
// used to live alongside the host's confirmation body (EventWizard's "From
// alias"/"Reply-to email" fields, `confirmation_email.fromAlias`/`.replyTo`)
// is gone as of this change (owner decision: the sender is ALWAYS United Club
// Gymnastics). This module only ever deals with `bodyHtml`.

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** De-duplicate a list of possibly-blank/possibly-repeated event names into
 *  the DISTINCT, non-blank set, preserving first-seen order. Shared by both
 *  `confirmationSubject` and `registeredForLineHtml` so "one event" is
 *  computed identically by both. */
function distinctNames(names: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    const t = (n ?? '').trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** Subject line for a registration/purchase confirmation email (UAT E-02-01
 *  rule 2): when the purchased items / registrations reference EXACTLY ONE
 *  distinct event, name it — `"<event name> Registration Confirmation"`.
 *  Zero distinct events (a membership-only purchase) or MULTIPLE distinct
 *  events keep the generic subject, since naming one of several would be
 *  misleading. `eventNames` is the caller's raw (possibly blank/duplicate)
 *  per-line/per-registration event name list — this function does the
 *  de-duplication. */
export function confirmationSubject(eventNames: (string | null | undefined)[]): string {
  const distinct = distinctNames(eventNames);
  return distinct.length === 1 ? `${distinct[0]} Registration Confirmation` : 'Your United Club Gymnastics receipt';
}

/** The "A message from your host" card (UAT E-02-01 rule 4 — previously "A
 *  message from ${event name}"; the owner's annotation was that the message
 *  is from the HOST, not the event). Returns '' when there is no host
 *  message, so a caller can unconditionally splice the result into a
 *  template without an extra blank check.
 *
 *  Deliberate asymmetry: `bodyHtml` is rendered AS-IS, never `esc()`'d — it
 *  is host-authored HTML (EventWizard's confirmation-email body editor), and
 *  escaping it here would break every host's existing formatting. Don't
 *  "fix" this to escape it; only the plain event-NAME strings this module
 *  handles elsewhere (`registeredForLineHtml`) get escaped, because those are
 *  plain text, not host HTML. */
export function hostMessageCardHtml(bodyHtml: string | null | undefined): string {
  if (!bodyHtml || !bodyHtml.trim()) return '';
  return `<div style="margin:16px 0;padding:12px 14px;border-left:3px solid #F4694A;background:#f7f9fb;">` +
    `<p style="margin:0 0 6px;font-weight:700;color:#1E2B38;">A message from your host</p>` +
    `<div style="color:#1E2B38;">${bodyHtml}</div></div>`;
}

/** "You're registered for &lt;event&gt;." line(s) for the $0 host-club
 *  self-registration confirmation (UAT E-02-02) — one line per distinct
 *  event name, escaped (plain text, not host HTML — see the asymmetry note
 *  on `hostMessageCardHtml`). Returns '' for an empty list. */
export function registeredForLineHtml(eventNames: (string | null | undefined)[]): string {
  return distinctNames(eventNames).map((n) => `<p>You're registered for ${esc(n)}.</p>`).join('');
}
