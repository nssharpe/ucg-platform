// Shared Telnyx SMS transport (event-mgmt v2 Phase 5, Task C1) — extracted
// verbatim from send-sms/index.ts so a SYSTEM/service-role context (the C3
// scheduler in scheduled-dispatch, which runs on a cron secret with no admin
// JWT) can send finals-lineup reminder texts through the exact same Telnyx
// call shape send-sms uses. This module does NOT touch the DB — the caller
// decides whether/how to record `sms_messages` (send-sms and the scheduler
// use different Supabase clients).
//
// A2P 10DLC status: the campaign is APPROVED (campaign id
// 4b30019e-f12c-f96d-859a-4d995c868e87, assigned number +16787988123), so
// real carrier delivery works. The sending number/profile comes from the
// `TELNYX_FROM_NUMBER`/`TELNYX_MESSAGING_PROFILE_ID` secrets — confirm at
// deploy time that the configured secret matches the assigned number.

/** Normalize loose input to E.164 (US default). Returns null if it can't. */
export function toE164(raw: string): string | null {
  const trimmed = raw.trim();
  if (/^\+[1-9]\d{7,14}$/.test(trimmed)) return trimmed;       // already E.164
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;              // US 10-digit
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

export interface TelnyxConfig {
  apiKey: string;
  fromNumber?: string;
  profileId?: string;
}

export interface TelnyxRecipient {
  to: string;
  name?: string;
}

export interface TelnyxSentRow {
  id: string;
  direction: string;
  phone: string;
  status: string;
}

export interface TelnyxSendResult {
  sent: string[];
  failed: { phone: string; error: string }[];
  sentRows: TelnyxSentRow[];
}

/** Send `text` to every recipient via the Telnyx Messaging API
 *  (POST https://api.telnyx.com/v2/messages), one request per recipient —
 *  the exact loop moved out of send-sms/index.ts. Does NOT record anything
 *  to `sms_messages`; returns `sentRows` so the caller can do that itself. */
export async function sendSmsBatch(
  cfg: TelnyxConfig,
  recipients: TelnyxRecipient[],
  text: string,
): Promise<TelnyxSendResult> {
  const sent: string[] = [];
  const failed: { phone: string; error: string }[] = [];
  const sentRows: TelnyxSentRow[] = [];

  for (const r of recipients) {
    const msg: Record<string, unknown> = { to: r.to, text };
    if (cfg.fromNumber) msg.from = cfg.fromNumber;
    if (cfg.profileId) msg.messaging_profile_id = cfg.profileId;
    try {
      const resp = await fetch('https://api.telnyx.com/v2/messages', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(msg),
      });
      if (resp.ok) {
        sent.push(r.to);
        const okBody = await resp.json().catch(() => ({}));
        const id = okBody?.data?.id;
        if (typeof id === 'string') sentRows.push({ id, direction: 'outbound', phone: r.to, status: 'sent' });
      } else {
        const errBody = await resp.json().catch(() => ({}));
        const detail = errBody?.errors?.[0]?.detail ?? errBody?.errors?.[0]?.title ?? `HTTP ${resp.status}`;
        failed.push({ phone: r.to, error: detail });
      }
    } catch (e) {
      failed.push({ phone: r.to, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return { sent, failed, sentRows };
}
