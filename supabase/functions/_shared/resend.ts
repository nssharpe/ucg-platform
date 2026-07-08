// _shared/resend.ts — Resend HTTP transport shared by all email functions.
//
// Sender is config, not code: RESEND_FROM (default onboarding@resend.dev) flips
// to the verified naigc.org address with a secret change only. RESEND_API_KEY is
// required; a missing key throws a clear, caller-surfaced error.

const EMAILS_URL = 'https://api.resend.com/emails';
const BATCH_URL = 'https://api.resend.com/emails/batch';

export function resendFrom(): string {
  const from = Deno.env.get('RESEND_FROM');
  if (!from) {
    // onboarding@resend.dev only delivers to the Resend account owner — a missing
    // RESEND_FROM in prod means near-total silent delivery failure. Make it loud.
    console.warn('RESEND_FROM is not set; falling back to onboarding@resend.dev (test-only sender).');
    return 'United Club Gymnastics <onboarding@resend.dev>';
  }
  return from;
}

function apiKey(): string {
  const key = Deno.env.get('RESEND_API_KEY');
  if (!key) throw new Error('Email is not configured: RESEND_API_KEY secret is missing.');
  return key;
}

export interface EmailMessage {
  to: string | string[];
  cc?: string | string[];
  /** Replies go here instead of the from address (Resend `reply_to`). */
  reply_to?: string | string[];
  /** Overrides the DISPLAY NAME of the sender only — the address part always
   *  stays RESEND_FROM's verified address (arbitrary from-addresses won't
   *  deliver; per-event "from" is alias + reply_to by design, emv2 §N7-6). */
  fromName?: string;
  subject: string;
  html?: string;
  text?: string;
}

/** RESEND_FROM with its display name swapped to `name` (address unchanged).
 *  Falls back to RESEND_FROM verbatim when no name is given. */
function fromWithName(name?: string): string {
  const base = resendFrom();
  if (!name) return base;
  const addr = base.match(/<([^>]+)>/)?.[1] ?? base;
  // Quote the display name; strip quote/angle chars that could break the header.
  return `"${name.replace(/["<>]/g, '')}" <${addr}>`;
}

export interface BatchResult {
  ok: boolean;
  sentCount: number;
  failedCount: number;
  sent: string[];
  failed: { email: string; error: string }[];
}

const toLabel = (to: string | string[]) => (Array.isArray(to) ? to.join(',') : to);

/** Send a single message. Throws on transport/API error. */
export async function sendOne(msg: EmailMessage): Promise<{ id: string }> {
  const res = await fetch(EMAILS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: fromWithName(msg.fromName), to: msg.to, cc: msg.cc, reply_to: msg.reply_to, subject: msg.subject, html: msg.html, text: msg.text }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.message ?? `Resend error (${res.status})`);
  return { id: body?.id ?? '' };
}

/** Send many distinct messages in one request (≤100). Resend's batch endpoint
 *  keeps each message separate (no leaked recipient list). Semantics are
 *  all-or-nothing at submit time: Resend validates the whole batch, so a 2xx
 *  marks every message sent and a non-2xx marks every message failed with the
 *  API error. Like SMTP, this catches submit-time rejection only — asynchronous
 *  bounces are not reflected here (they'd need Resend webhooks). */
export async function sendBatch(messages: EmailMessage[]): Promise<BatchResult> {
  if (messages.length === 0) return { ok: true, sentCount: 0, failedCount: 0, sent: [], failed: [] };
  const payload = messages.map((m) => ({ from: fromWithName(m.fromName), to: m.to, cc: m.cc, reply_to: m.reply_to, subject: m.subject, html: m.html, text: m.text }));
  const res = await fetch(BATCH_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  const addrs = messages.map((m) => toLabel(m.to));
  if (!res.ok) {
    const error = body?.message ?? `Resend error (${res.status})`;
    return { ok: false, sentCount: 0, failedCount: messages.length, sent: [], failed: addrs.map((email) => ({ email, error })) };
  }
  return { ok: true, sentCount: messages.length, failedCount: 0, sent: addrs, failed: [] };
}
