// _shared/reminder-logic.ts — pure scheduling logic for sanction-vote reminder
// emails. NO Deno/Supabase imports here — this module is unit-tested by vitest
// running under node (see tests/reminder-logic.test.ts) as well as imported by
// the scheduled-dispatch Edge Function at runtime.

export type SanctionReminderStage = '3d' | '1d' | 'closed' | null;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Determines which reminder (if any) should fire for a sanction request given
 * the current time and its voting deadline.
 *
 *   '3d'    — now in [deadline-3d, deadline-1d)
 *   '1d'    — now in [deadline-1d, deadline)
 *   'closed'— now >= deadline
 *   null    — before the 3-day window opens, or deadlineISO is missing/invalid
 */
export function sanctionReminderStage(nowISO: string, deadlineISO: string | null | undefined): SanctionReminderStage {
  if (!deadlineISO) return null;
  const deadline = Date.parse(deadlineISO);
  const now = Date.parse(nowISO);
  if (Number.isNaN(deadline) || Number.isNaN(now)) return null;

  const threeDayMark = deadline - 3 * DAY_MS;
  const oneDayMark = deadline - 1 * DAY_MS;

  if (now >= deadline) return 'closed';
  if (now >= oneDayMark) return '1d';
  if (now >= threeDayMark) return '3d';
  return null;
}

/** Deterministic notification_log id: `<kind>:<ref_id>:<recipient>`. Recipient
 *  should already be normalized (lowercased) by the caller. */
export function notificationLogId(kind: string, refId: string, recipient: string): string {
  return `${kind}:${refId}:${recipient}`;
}
