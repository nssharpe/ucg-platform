// _shared/owner-checklist.ts — pure due-date + reminder-stage logic for the
// event-owner task checklist (event-mgmt v2 §B3-4). NO Deno/Supabase imports
// here — this module is unit-tested by vitest running under node (see
// tests/owner-checklist.test.ts) as well as imported by the scheduled-dispatch
// Edge Function at runtime once owner-checklist reminder emails ship (a later
// task — this phase only builds the data model + due-date logic + UI).

export type OwnerTaskId =
  | 'contact' | 'hotel' | 'medalsOrdered' | 'medalsTracking'
  | 'insurance' | 'onsiteRep' | 'payHost';

/** Ordered task metadata for rendering the checklist. */
export const OWNER_TASKS: { id: OwnerTaskId; label: string }[] = [
  { id: 'contact', label: 'Establish contact with host' },
  { id: 'hotel', label: 'Hotel-block link obtained' },
  { id: 'medalsOrdered', label: 'Medals ordered' },
  { id: 'medalsTracking', label: 'Medals tracking / host received' },
  { id: 'insurance', label: 'Insurance certificate on file' },
  { id: 'onsiteRep', label: 'Onsite rep assigned' },
  { id: 'payHost', label: 'Pay host' },
];

/** One checklist entry: `done`/`doneAt`/`note` are common to every task;
 *  the remaining fields are task-specific payloads (only the ones relevant
 *  to a given task id are ever populated for that task). */
export interface OwnerChecklistEntry {
  done?: boolean;
  doneAt?: string;
  note?: string;
  /** medalsOrdered payload. */
  orderedOn?: string;
  /** medalsTracking payload. */
  trackingLink?: string;
  hostReceived?: boolean;
  /** insurance payload (free-text path/link for now; upload wired later). */
  filePath?: string;
  /** onsiteRep payload. */
  name?: string;
  email?: string;
  /** payHost payload. */
  method?: 'check' | 'paypal';
  paidOn?: string;
}

export type OwnerChecklist = Partial<Record<OwnerTaskId, OwnerChecklistEntry>>;

/** Minimal event shape this module needs — matches the relevant slice of
 *  src/lib/types.ts Event. */
export interface OwnerChecklistEvent {
  createdAt?: string;
  regOpens: string;
  startDate: string;
  endDate: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Adds `days` days to an ISO datetime/date string; returns an ISO string, or
 *  null when `iso` is missing/invalid. */
function addDays(iso: string | null | undefined, days: number): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t + days * DAY_MS).toISOString();
}

/**
 * Computes a task's due date given the event and (for tasks whose due date
 * depends on another task's payload) the current checklist state.
 *
 * Rules (spec §B4):
 *   contact        — event creation + 7 days (null if no createdAt)
 *   hotel          — event regOpens
 *   medalsOrdered  — event creation + 7 days
 *   medalsTracking — medalsOrdered.orderedOn + 14 days (null until orderedOn is set)
 *   insurance      — event creation + 14 days
 *   onsiteRep      — event startDate − 14 days
 *   payHost        — event endDate + 7 days
 */
export function ownerTaskDueDate(
  taskId: OwnerTaskId,
  event: OwnerChecklistEvent,
  checklist?: OwnerChecklist,
): string | null {
  switch (taskId) {
    case 'contact': return addDays(event.createdAt, 7);
    case 'hotel': return event.regOpens || null;
    case 'medalsOrdered': return addDays(event.createdAt, 7);
    case 'medalsTracking': return addDays(checklist?.medalsOrdered?.orderedOn, 14);
    case 'insurance': return addDays(event.createdAt, 14);
    case 'onsiteRep': return addDays(event.startDate, -14);
    case 'payHost': return addDays(event.endDate, 7);
  }
}

export type OwnerReminderStage = '1w' | '1d' | `overdue-${string}` | null;

/**
 * Determines which reminder (if any) should fire for an owner task given the
 * current time and its computed due date, mirroring `sanctionReminderStage`
 * (_shared/reminder-logic.ts):
 *
 *   '1w'              — now in [due-7d, due-1d)
 *   '1d'              — now in [due-1d, due)
 *   'overdue-YYYY-MM-DD' — now >= due; the calendar date (UTC) is baked into
 *                       the stage string so the scheduler's notification_log
 *                       id is naturally idempotent per day (one reminder per
 *                       overdue day, not a flood of duplicates within a day).
 *   null              — before the 1-week window opens, `due` is invalid, or
 *                       (when overdue) `lastDailyKeyDate` already matches
 *                       today's date — i.e. today's overdue reminder already
 *                       went out.
 */
export function ownerReminderStage(now: Date, due: Date, lastDailyKeyDate?: string): OwnerReminderStage {
  const nowMs = now.getTime();
  const dueMs = due.getTime();
  if (Number.isNaN(nowMs) || Number.isNaN(dueMs)) return null;

  if (nowMs >= dueMs) {
    const dateKey = now.toISOString().slice(0, 10);
    if (lastDailyKeyDate === dateKey) return null;
    return `overdue-${dateKey}`;
  }

  const oneWeekMark = dueMs - 7 * DAY_MS;
  const oneDayMark = dueMs - 1 * DAY_MS;
  if (nowMs >= oneDayMark) return '1d';
  if (nowMs >= oneWeekMark) return '1w';
  return null;
}
