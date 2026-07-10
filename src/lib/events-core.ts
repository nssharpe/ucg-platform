// Pure event-phase derivation (B4). Kept free of React/runtime deps for
// Vitest coverage, mirroring capabilities-core.ts/pricing.ts.
import type { EventPhase } from './types';

export interface EventPhaseInput {
  regOpens: string;
  regCloses: string;
  startDate: string; // date-only, YYYY-MM-DD
  endDate: string; // date-only, YYYY-MM-DD
}

/**
 * Derive a LIVE event's real-time phase from its dates. Only meaningful when
 * `status === 'live'` — a 'draft' event has no phase (callers should check
 * status first). Precedence: complete > in-progress > reg-closed > reg-open;
 * "not yet open" (now < regOpens) reads as 'reg-closed' too since the GATING
 * behavior (registration disallowed) is identical — display code that wants
 * to distinguish "not yet open" from "closed" (e.g. Events.tsx's date-column
 * badges) does its own separate regOpens/regCloses comparison.
 */
export function deriveEventPhase(event: EventPhaseInput, now: Date = new Date()): EventPhase {
  const t = now.getTime();
  if (t > new Date(`${event.endDate}T23:59:59`).getTime()) return 'complete';
  if (t >= new Date(`${event.startDate}T00:00:00`).getTime()) return 'in-progress';
  if (t > new Date(event.regCloses).getTime()) return 'reg-closed';
  if (t >= new Date(event.regOpens).getTime()) return 'reg-open';
  return 'reg-closed';
}

/** True iff a LIVE event is currently in the given phase (a 'draft' event is
 *  never in any phase, regardless of its dates). Convenience wrapper around
 *  `deriveEventPhase` for the common `status==='live' && phase===X` check. */
export function eventIsInPhase(
  event: { status: string } & EventPhaseInput,
  phase: EventPhase,
  now: Date = new Date(),
): boolean {
  return event.status === 'live' && deriveEventPhase(event, now) === phase;
}

/**
 * Coerce a stored date-time into the exact string an
 * `<input type="datetime-local">` accepts: `YYYY-MM-DDTHH:MM` (minute
 * precision, NO seconds and NO zone designator).
 *
 * The event's `regOpens`/`regCloses`/`lastDateToEdit`/`ageCalcAt` are backed
 * by Postgres `timestamptz` COLUMNS, so PostgREST returns them as full ISO
 * strings with seconds and a `Z`/offset (e.g. `2026-02-01T12:00:00Z`). A
 * datetime-local input silently BLANKS any value it can't parse — and a
 * trailing `Z` makes the whole string invalid — so seeding the edit wizard
 * straight from the stored value shows an empty field, and (if the user
 * doesn't retype it) the old value is written straight back, i.e. reg-date
 * edits appear not to persist. Trimming to minute precision restores the
 * app's naive-local convention (the value is entered/displayed as-is, no zone
 * math — matching how new events are authored). Non-matching input (empty,
 * already-clean, or a plain date) is returned unchanged.
 */
export function toDatetimeLocalValue(s?: string | null): string {
  if (!s) return '';
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
  return m ? `${m[1]}T${m[2]}` : s;
}

/**
 * Client-side mirror of the `registrations_edit_lockout` DB trigger (B4) —
 * for UX only (a friendly disabled state / message), NOT the authoritative
 * gate; the trigger enforces this server-side regardless of what the client
 * thinks. Past `lastDateToEdit`, only an admin or the event's HOST club's
 * managers may still edit (pass `caps.isEventHost(event.id)` as `bypasses` —
 * it already covers both). No `lastDateToEdit` set ⇒ always editable.
 */
export function canStillEditRegistration(
  event: { lastDateToEdit?: string | null },
  bypasses: boolean,
  now: Date = new Date(),
): boolean {
  if (!event.lastDateToEdit) return true;
  if (now.getTime() <= new Date(event.lastDateToEdit).getTime()) return true;
  return bypasses;
}
