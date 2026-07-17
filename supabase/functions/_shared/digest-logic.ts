// _shared/digest-logic.ts — pure scheduling/window logic for the daily
// "anything wrong?" digest (error_logs + stuck payments). NO Deno/Supabase
// imports here — unit-tested by vitest running under node (see
// tests/digest-logic.test.ts) as well as imported by scheduled-dispatch.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** UTC calendar-date key ('YYYY-MM-DD') for a given ISO instant — used as the
 *  notification_log `ref_id` so at most one digest claim can succeed per UTC
 *  day (mirrors the kind/ref_id/recipient dedupe idiom used elsewhere in
 *  scheduled-dispatch, just keyed by day instead of by request/task id). */
export function digestDateKey(nowISO: string): string {
  return nowISO.slice(0, 10);
}

/** The digest should only be considered once each UTC day has reached 13:00 —
 *  earlier cron runs (every 15 min) are no-ops for this consumer. Actual
 *  once-per-day enforcement is the notification_log claim keyed by
 *  `digestDateKey`; this only gates the "not before 13:00" part of the spec. */
export function isDigestFireWindow(nowISO: string): boolean {
  const now = new Date(nowISO);
  if (Number.isNaN(now.getTime())) return false;
  return now.getUTCHours() >= 13;
}

/** The start of the digest's reporting window: the previous digest's send
 *  time (`lastSentISO`) if one is on record, else 24h before now. */
export function digestWindowStart(nowISO: string, lastSentISO: string | null | undefined): string {
  if (lastSentISO) {
    const t = Date.parse(lastSentISO);
    if (!Number.isNaN(t)) return lastSentISO;
  }
  const now = Date.parse(nowISO);
  const fallback = Number.isNaN(now) ? Date.now() - DAY_MS : now - DAY_MS;
  return new Date(fallback).toISOString();
}

/** A payment is "stuck" when it's still pending more than 1h after creation —
 *  it represents unreconciled money and is reported regardless of the digest
 *  window (every currently-stuck payment, every time, until it resolves). */
export function isStuckPayment(nowISO: string, createdAtISO: string, status: string): boolean {
  if (status !== 'pending') return false;
  const created = Date.parse(createdAtISO);
  const now = Date.parse(nowISO);
  if (Number.isNaN(created) || Number.isNaN(now)) return false;
  return created < now - HOUR_MS;
}
