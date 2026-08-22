// Pure event-phase derivation (B4). Kept free of React/runtime deps for
// Vitest coverage, mirroring capabilities-core.ts/pricing.ts.
import type { Club, Event, EventPhase, EventSession, ScoringConfig } from './types';

/** Default scoring config for an event with no `scoringConfig` set: one judge
 *  panel, calculator entry (today's behavior before the 2026-07-19 per-event
 *  scoring-config feature). */
export const DEFAULT_SCORING_CONFIG: ScoringConfig = { panels: 1, entryMode: 'calculator' };

/** Accessor for an event's effective scoring config — always use this rather
 *  than reading `event.scoringConfig` directly, so an absent config reads as
 *  the default instead of `undefined`. */
export function scoringConfigOf(event: { scoringConfig?: ScoringConfig } | null | undefined): ScoringConfig {
  return event?.scoringConfig ?? DEFAULT_SCORING_CONFIG;
}

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

/**
 * Whether an event is eligible for the refund-request flow at all (event-mgmt
 * v2 Phase 3, spec §H — Nate decision 2026-07-10): refunds are only offered
 * for events whose HOST club is the league's own club, flagged via the new
 * `clubs.is_league_host` boolean (set by admins on exactly the league's own
 * club — "UCG - Main" — in the admin clubs editor). Any other host club
 * (member clubs hosting their own competitions) is NOT refund-eligible.
 * Looks the host club up in `clubs` rather than trusting a denormalized flag
 * on the event, so it always reflects the club's current setting.
 *
 * UCG-hosted events (`event.ucgHosted` set — FlipFest/Nationals, PM feedback
 * 2026-07-22) are ALWAYS refund-eligible regardless of host club: they no
 * longer require a league-host club to be flagged/resolved at all (a
 * UCG-hosted event's `hostClubId` may be `''`), so the club lookup below
 * would otherwise wrongly deny refunds for them. Checked before the club
 * lookup. Mirror EXACTLY in `supabase/functions/request-refund/index.ts`. */
export function eventIsRefundEligible(
  event: { hostClubId: string; ucgHosted?: 'flipfest' | 'nationals' },
  clubs: Pick<Club, 'id' | 'isLeagueHost'>[],
): boolean {
  if (event.ucgHosted) return true;
  return clubs.some((c) => c.id === event.hostClubId && c.isLeagueHost === true);
}

/**
 * Session-list diff for a stable-id upsert+prune write (UAT Z-06 — Results
 * "not assigned to a session" relapse). Compares the sessions on file BEFORE
 * an edit to the ones about to be saved and returns exactly what changed:
 * every session to upsert (each keeps whatever id it already carries — an
 * existing session's id, or a freshly-minted one for a brand-new session)
 * and the ids of any session that's genuinely gone.
 *
 * This exists because the previous write path (`remoteReplace`) DELETEd
 * every `event_sessions` row for the event and re-INSERTed the whole set on
 * every save. `registrations.session_id`/`scores.session_id` are
 * `... references event_sessions(id) on delete set null` — so even
 * reinserting a row with the SAME id afterward does not undo the delete's
 * cascade: every registration/score that pointed at that session is already
 * nulled by the time the insert runs. Upserting only what changed, and
 * deleting only ids that are truly gone, avoids ever touching a row's FK
 * unless that row was actually intended to be removed.
 *
 * Does NOT invent or reconcile ids itself — the caller (EventWizard, via
 * `assignSessionIds` below) is responsible for keeping an existing session's
 * id attached to its own row across reorders/edits and for minting a fresh
 * id for a new one. Pure, so it's unit-testable without a store or Supabase.
 */
export function diffSessions(
  existing: EventSession[],
  next: EventSession[],
): { upsert: EventSession[]; deleteIds: string[] } {
  const nextIds = new Set(next.map((s) => s.id));
  const deleteIds = existing.filter((s) => !nextIds.has(s.id)).map((s) => s.id);
  return { upsert: next, deleteIds };
}

/**
 * One session id per draft, in order — the id-assignment half of the UAT
 * Z-06 fix, paired with `diffSessions` above. `draftIds[i]` is the existing
 * `EventSession.id` a session-editor draft was loaded from (undefined for a
 * brand-new draft: "+ Add session," a discipline just toggled on, or a
 * template-seeded create with no real id to keep). An existing id is
 * returned verbatim; a `${eventId}-sN` id is minted for each undefined slot.
 *
 * `previousIds` (the ids on the event BEFORE this edit, i.e.
 * `editEvent.sessions.map(s => s.id)`) matters for exactly one case: a
 * session removed in this same save. Without seeding the collision set from
 * it, a freshly-minted id could land on the very id that session just
 * vacated — `diffSessions` would then see that id present in both the
 * before and after lists and UPSERT in place instead of deleting it,
 * silently re-attaching anything still pointing at the old session (a
 * refunded registration, a stale score snapshot) to a session it never
 * actually competed in. Passing `[]` for `previousIds` (create mode, nothing
 * to have removed) is safe — it just means every draft's own id is the only
 * collision source, same as before this parameter existed.
 */
export function assignSessionIds(
  eventId: string,
  draftIds: (string | undefined)[],
  previousIds: string[],
): string[] {
  const used = new Set<string>([...previousIds, ...draftIds.filter((id): id is string => !!id)]);
  let seq = 1;
  const mint = (): string => {
    let id = `${eventId}-s${seq}`;
    while (used.has(id)) { seq++; id = `${eventId}-s${seq}`; }
    used.add(id);
    return id;
  };
  return draftIds.map((id) => id ?? mint());
}

/** Registration entry-point action, for one row of a list of events (UAT M-01-03):
 *  'self' → "Register yourself" (opens the self-registration modal for the viewer's
 *  own athlete profile); 'club' → "Register your club" (a manager registering OTHER
 *  athletes); 'edit' → "Edit registration" (the viewer already has one). */
export type EventRowAction = 'self' | 'club' | 'edit';

export interface EventRowActionsInput {
  /** Only the field this pure check needs from the event — kept for callers that
   *  already have the full `Event` on hand; `isCamp` below is what's actually read. */
  event: { eventType?: Event['eventType'] };
  /** Whether the viewer holds an active athlete membership — mirrors
   *  `Capabilities.canRegister`, never re-derived here. */
  viewer: { canRegister: boolean };
  /** Whether the viewer already holds a non-refunded registration of their own for
   *  this event — flips 'self' to 'edit' when true. */
  hasReg: boolean;
  /** Whether the viewer manages at least one club — gates the independent "Register
   *  your club" entry point (a manager registers OTHER athletes, so this is unaffected
   *  by `hasReg`, which is about the viewer's OWN registration). */
  isManager: boolean;
  /** Camps are individual self-registration ONLY (registrations-and-camps.md,
   *  Julia-confirmed 2026-08-19) — a manager can never register athletes for one, so
   *  'club' is suppressed regardless of `isManager`. */
  isCamp: boolean;
}

/** Which registration entry-point button(s) to show for one Events-list row.
 *  Pure — no store/caps re-derivation; callers pass in the already-resolved gates
 *  (`viewer.canRegister`, `isManager`) exactly as computed elsewhere (capabilities.ts /
 *  the detail page), per "reuse the exact gate logic, don't re-derive." Order in the
 *  returned array is the intended display order. */
export function eventRowActions({ viewer, hasReg, isManager, isCamp }: EventRowActionsInput): EventRowAction[] {
  const actions: EventRowAction[] = [];
  if (viewer.canRegister) actions.push(hasReg ? 'edit' : 'self');
  if (isManager && !isCamp) actions.push('club');
  return actions;
}
