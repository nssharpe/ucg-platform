// Pure helpers for the inbound SMS webhook (Phase 4): phone normalization, STOP
// keyword detection, and Telnyx webhook payload classification. Kept free of
// Deno/runtime deps so they get Vitest coverage (tests/sms-inbound.test.ts).
// A Deno copy lives at supabase/functions/sms-webhook/parse.ts — keep them in
// sync (same pattern as sms-segments.ts ↔ send-sms/segments.ts).

/** Reduce a phone in any format to its last 10 digits for matching. */
export function normalizePhone(raw: string): string {
  const digits = (raw ?? '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

// CTIA standard opt-out keywords (Telnyx also honors these at the carrier; we
// mirror at the app layer to flip sms_consent). A bare keyword only — multi-word
// messages like "please stop" are not treated as opt-outs.
const STOP_KEYWORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']);

/** True if the message body is exactly a CTIA stop keyword. */
export function isStopKeyword(text: string): boolean {
  return STOP_KEYWORDS.has((text ?? '').trim().toUpperCase());
}

/** Collapse a Telnyx delivery status into the three states the UI/webhook care
 *  about. Unknown / in-flight / empty all read as 'pending'. */
export function classifyDeliveryStatus(status: string | null | undefined): 'delivered' | 'failed' | 'pending' {
  const s = (status ?? '').toLowerCase();
  if (s === 'delivered') return 'delivered';
  if (/fail|undeliver|expired|rejected/.test(s)) return 'failed';
  return 'pending';
}

export type TelnyxEvent =
  | { kind: 'inbound'; messageId: string; from: string; text: string }
  | { kind: 'dlr'; messageId: string; to: string; status: string }
  | { kind: 'other'; eventType?: string };

/**
 * Classify a Telnyx Messaging webhook into the event we act on. Inbound replies
 * (direction 'inbound') and outbound delivery receipts (direction 'outbound'
 * carrying a recipient status) are extracted; everything else is 'other'.
 */
export function parseTelnyxWebhook(payload: unknown): TelnyxEvent {
  const data = (payload as { data?: Record<string, unknown> } | null)?.data;
  const p = data?.payload as
    | { id?: string; direction?: string; from?: { phone_number?: string }; to?: { phone_number?: string; status?: string }[]; text?: string }
    | undefined;
  const eventType = data?.event_type as string | undefined;
  if (!p || !p.id) return { kind: 'other', eventType };

  if (p.direction === 'inbound') {
    return { kind: 'inbound', messageId: p.id, from: p.from?.phone_number ?? '', text: p.text ?? '' };
  }
  if (p.direction === 'outbound') {
    const recipient = p.to?.[0];
    if (recipient?.status) {
      return { kind: 'dlr', messageId: p.id, to: recipient.phone_number ?? '', status: recipient.status };
    }
  }
  return { kind: 'other', eventType };
}
