/**
 * RegistrationEditor — reusable registration editor for a single athlete at an event.
 *
 * CONTRACT
 * --------
 * Props:
 *   event        — the Event being registered for
 *   athlete     — the Athlete being registered
 *   clubId      — the club they are competing for
 *   existing    — current Registration[] for this athlete+event (may be [])
 *   allAthletes — full athlete list (for synchro partner combo)
 *   levels      — full Level[] from the DB
 *   season      — current Season (to check active memberships for partner search)
 *   onSave(regs: Registration[]) — called with the complete set of new/updated
 *                                  registrations (one per selected discipline).
 *                                  The parent is responsible for mutate+push.
 *   onCancel()  — called on cancel / close without changes
 *   changeFeeApplies — if true the save button label says "Add change to cart"
 *                      and the parent may charge a change fee; the editor itself
 *                      does not add the fee — that is the parent's job.
 *
 * The component is fully presentational + callback-driven.
 * It does NOT call mutate() or push*() directly.
 */

import { useState, useMemo } from 'react';
import { Combo, Field } from './ui';
import { useToast } from './ui-hooks';
import { DisciplineIcon } from './DisciplineIcon';
import { APPARATUS } from '../lib/types';
import type { Athlete, Discipline, Level, Event, EventSession, Registration, Season, WaitlistGroup } from '../lib/types';
import { changeIsEligible, regChangeHasDiff, lateFeeAnchor } from '../lib/pricing';
import type { RegChangeState, RegDisciplineEntry } from '../lib/pricing';
import { registrationEstimate, registrationEstimateLabel } from '../lib/reg-estimate';
import { checkCapacity, hasCapacityConfig } from '../lib/capacity';
import type { CapacityViolation } from '../lib/capacity';
import { membershipTypeOf } from '../lib/capabilities-core';

// Impure read lives at MODULE scope, outside React render — react-hooks/purity
// only governs component/hook bodies (same pattern as Sanction.tsx's
// isoDateInDays/genId). Used for the advisory (non-authoritative) capacity
// preview below; the server always recomputes at checkout.
const nowMs = () => Date.now();

// ---- per-discipline section -------------------------------------------------

interface DiscSectionProps {
  disc: Discipline;
  event: Event;
  athlete: Athlete;
  levels: Level[];
  existing: Registration | undefined; // existing reg for this disc, if any
  draft: DraftReg;
  onChange: (d: DraftReg) => void;
  allAthletes: Athlete[];
  season: Season;
  /** Athlete who already named this athlete as their synchro partner, if any. */
  incomingPartnerId?: string | null;
  /** That athlete's own SY level, if known (B4.4). */
  incomingPartnerSyLevel?: string | null;
  /** True when this discipline's only registration row is a refunded (kept,
   *  blanked) one — event-mgmt v2 Phase 3 spec §H: "all apparatus unchecked
   *  and un-recheckable except by league admins". */
  refunded: boolean;
  /** League admins may re-enable a refunded discipline, behind a confirm. */
  isAdmin: boolean;
  /** Advisory-only (server enforces at checkout): would this session already
   *  be at/over cap for the given apparatus selection (event-mgmt v2 P4)? */
  sessionIsFull: (
    session: EventSession,
    disc: Discipline,
    levelId: string,
    apparatus: string[],
    apparatusLevels: Record<string, string> | undefined,
  ) => boolean;
}

/** Draft shape for one discipline */
export interface DraftReg {
  enabled: boolean;
  levelId: string;
  apparatus: string[];
  apparatusLevels: Record<string, string>; // T&T per-apparatus levels
  partnerAthleteId: string | null; // synchro
  partnerUnknown: boolean;
  /** True once an admin has confirmed re-enabling a refunded discipline in
   *  this editing session — unlocks the apparatus checkboxes and tells
   *  `handleSave` to reuse (and un-refund) the original registration row. */
  refundOverridden?: boolean;
  /** By-session-mode session pick (event-mgmt v2 P4). Null ⇒ not yet chosen
   *  (required before Save for a by-session event). Always null for
   *  by-discipline events. */
  sessionId: string | null;
}

function DiscSection({ disc, event, athlete, levels, draft, onChange, allAthletes, season, incomingPartnerId, incomingPartnerSyLevel, refunded, isAdmin, sessionIsFull }: DiscSectionProps) {
  const discLevels = levels.filter((l) => l.discipline === disc && !l.retired);
  const apparatusDefs = APPARATUS[disc];
  const isTNT = disc === 'TNT';
  const isBySession = event.registrationMode === 'by-session';
  // Sessions offered for this discipline+level (by-session events only): the
  // event's sessions filtered to matching discipline whose levelIds include
  // the currently-chosen level.
  const candidateSessions = isBySession
    ? event.sessions.filter((s) => s.discipline === disc && s.levelIds.includes(draft.levelId))
    : [];

  // SY (Synchro) is an event within TNT, not its own discipline
  const synchroSelected = isTNT && draft.apparatus.includes('SY');

  // Athletes with an active ATHLETE-type membership for the partner combo —
  // a coach-only membership doesn't make someone eligible to compete
  // (typed-membership residuals T1).
  const partnerOptions = useMemo(() => {
    return allAthletes
      .filter((a) => a.id !== athlete.id && a.memberships.some(
        (m) => m.seasonId === season.id && m.status === 'active' && membershipTypeOf(m) === 'athlete',
      ))
      .map((a) => ({ value: a.id, label: `${a.firstName} ${a.lastName}`, sub: a.email }));
  }, [allAthletes, athlete.id, season.id]);

  const toggleEvent = (code: string): DraftReg => {
    const next = draft.apparatus.includes(code)
      ? draft.apparatus.filter((e) => e !== code)
      : [...draft.apparatus, code];

    // Update apparatusLevels for T&T — add/remove the key
    const nextEventLevels = { ...draft.apparatusLevels };
    if (isTNT) {
      if (next.includes(code) && !nextEventLevels[code]) {
        nextEventLevels[code] = draft.levelId;
      } else if (!next.includes(code)) {
        delete nextEventLevels[code];
      }
    }
    // Auto-link the synchro partner: if someone already named this athlete as
    // their partner, default this athlete's partner to them when they add SY.
    // B4.4: also default the SY level to THEIRS (whoever selects a partner
    // sets the level for both — this athlete is being auto-linked, so match
    // the level already chosen by the one who selected them).
    let partnerAthleteId = draft.partnerAthleteId;
    let partnerUnknown = draft.partnerUnknown;
    if (code === 'SY' && next.includes('SY') && !partnerAthleteId && incomingPartnerId) {
      partnerAthleteId = incomingPartnerId;
      partnerUnknown = false;
      if (incomingPartnerSyLevel) nextEventLevels.SY = incomingPartnerSyLevel;
    }
    return { ...draft, apparatus: next, apparatusLevels: nextEventLevels, partnerAthleteId, partnerUnknown };
  };

  const selectAllAround = (): DraftReg => {
    const allCodes = apparatusDefs.map((e) => e.code);
    const nextEventLevels: Record<string, string> = {};
    if (isTNT) {
      for (const code of allCodes) nextEventLevels[code] = draft.apparatusLevels[code] ?? draft.levelId;
    }
    // Auto-link synchro partner when selecting all (which includes SY for T&T),
    // and default the SY level to theirs (B4.4 — see toggleEvent).
    const autoLinking = allCodes.includes('SY') && !draft.partnerAthleteId && incomingPartnerId;
    const partnerAthleteId = autoLinking ? incomingPartnerId : draft.partnerAthleteId;
    if (autoLinking && incomingPartnerSyLevel) nextEventLevels.SY = incomingPartnerSyLevel;
    return { ...draft, apparatus: allCodes, apparatusLevels: nextEventLevels, partnerAthleteId };
  };

  const clearAll = (): DraftReg => ({ ...draft, apparatus: [], apparatusLevels: {} });

  // Guard apparatus-mutating actions when this discipline's registration was
  // refunded (spec §H: unchecked and un-recheckable except by league admins,
  // behind a confirm). Non-admins never reach the confirm — their checkboxes
  // are rendered `disabled` below, but this guard also covers the
  // select-all/clear-all buttons which aren't individually disabled.
  const applyChange = (nextDraft: DraftReg) => {
    if (refunded && !draft.refundOverridden) {
      if (!isAdmin) return;
      const ok = window.confirm(
        'This registration was refunded and the athlete cannot participate. Re-enable anyway?',
      );
      if (!ok) return;
      onChange({ ...nextDraft, refundOverridden: true });
      return;
    }
    onChange(nextDraft);
  };

  const isAA = draft.apparatus.length === apparatusDefs.length && apparatusDefs.every((e) => draft.apparatus.includes(e.code));

  const setMainLevel = (levelId: string) => {
    // When the main level changes, update any apparatusLevels that were still at the
    // previous main level (i.e. not individually overridden).
    const nextEventLevels: Record<string, string> = {};
    for (const [ev, lvl] of Object.entries(draft.apparatusLevels)) {
      nextEventLevels[ev] = lvl === draft.levelId ? levelId : lvl;
    }
    // A level change forces a session re-pick when the current session no
    // longer fits the new level (or is now full for this apparatus set) —
    // event-mgmt v2 P4. The level change alone already makes this edit
    // chargeable (`changeIsEligible`), so a forced session move never adds a
    // SECOND fee on top.
    let nextSessionId = draft.sessionId;
    if (isBySession && draft.sessionId) {
      const session = event.sessions.find((s) => s.id === draft.sessionId);
      const stillFits = !!session
        && session.levelIds.includes(levelId)
        && !sessionIsFull(session, disc, levelId, draft.apparatus, nextEventLevels);
      if (!stillFits) nextSessionId = null;
    }
    onChange({ ...draft, levelId, apparatusLevels: nextEventLevels, sessionId: nextSessionId });
  };

  return (
    <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14, marginTop: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
        <label className="checkrow" style={{ fontWeight: 700, fontSize: 15 }}>
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => onChange({ ...draft, enabled: e.target.checked })}
          />
          <DisciplineIcon discipline={disc} size={18} />
          {disc === 'TNT' ? 'T&T' : disc}
        </label>
      </div>

      {draft.enabled && (
        <div style={{ paddingLeft: 24 }}>
          {/* Level selector */}
          <div className="grid cols-2" style={{ gap: 10, marginBottom: 10 }}>
            <Field label={isTNT ? 'Default T&T level' : `${disc} level`}>
              <select
                className="input"
                value={draft.levelId}
                onChange={(e) => setMainLevel(e.target.value)}
              >
                <option value="" disabled>— select —</option>
                {discLevels.map((l) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </select>
            </Field>
          </div>

          {/* Session picker (by-session events only, event-mgmt v2 P4):
              required, filtered to this discipline+level, full sessions shown
              disabled with an advisory hint (server enforces at checkout). */}
          {isBySession && (
            <div className="grid cols-2" style={{ gap: 10, marginBottom: 10 }}>
              <Field
                label="Session"
                hint={candidateSessions.length === 0 ? 'No session offers this level yet.' : 'Required — pick the session matching your level.'}
              >
                <select
                  className="input"
                  value={draft.sessionId ?? ''}
                  onChange={(e) => onChange({ ...draft, sessionId: e.target.value || null })}
                >
                  <option value="" disabled>— select —</option>
                  {candidateSessions.map((s) => {
                    const full = sessionIsFull(s, disc, draft.levelId, draft.apparatus, draft.apparatusLevels);
                    return (
                      <option key={s.id} value={s.id} disabled={full}>
                        {s.name}{full ? ' (Full)' : ''}
                      </option>
                    );
                  })}
                </select>
              </Field>
              {draft.sessionId && candidateSessions.some((s) => s.id === draft.sessionId && sessionIsFull(s, disc, draft.levelId, draft.apparatus, draft.apparatusLevels)) && (
                <p style={{ fontSize: 12, color: 'var(--warn)', gridColumn: '1 / -1', margin: 0 }}>
                  This session is full for your apparatus — checkout will offer to join the waitlist instead.
                </p>
              )}
            </div>
          )}

          {/* Refunded-registration warning (spec §H): shown while the discipline's
              apparatus is locked (no admin override yet in this session). */}
          {refunded && !draft.refundOverridden && (
            <p
              role="alert"
              style={{
                fontSize: 13, color: 'var(--navy-800)', background: 'var(--coral-100)',
                borderRadius: 6, padding: '8px 10px', marginBottom: 10,
              }}
            >
              This registration was refunded — the athlete cannot participate.
              {isAdmin ? ' As a league admin, you can re-enable it below.' : ''}
            </p>
          )}

          {/* Apparatus checkboxes */}
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 13, color: 'var(--ink-soft)', marginBottom: 6 }}>
              Apparatus
              <button
                type="button"
                className="btn ghost small"
                style={{ marginLeft: 8 }}
                onClick={() => applyChange(isAA ? clearAll() : selectAllAround())}
              >
                {isAA ? 'Clear all' : (isTNT ? 'All Apparatuses' : 'All-Around')}
              </button>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px' }}>
              {apparatusDefs.map((ev) => (
                <label className="checkrow" key={ev.code} style={{ minWidth: 120 }}>
                  <input
                    type="checkbox"
                    checked={draft.apparatus.includes(ev.code)}
                    disabled={refunded && !isAdmin && !draft.refundOverridden}
                    onChange={() => applyChange(toggleEvent(ev.code))}
                  />
                  <span title={ev.name}>{ev.code} — {ev.name}</span>
                </label>
              ))}
            </div>
          </div>

          {/* T&T per-apparatus level overrides */}
          {isTNT && draft.apparatus.length > 0 && (
            <div style={{ marginTop: 10, marginBottom: 8 }}>
              <div style={{ fontSize: 13, color: 'var(--ink-soft)', marginBottom: 6 }}>
                Per-event level (T&T — defaults to main level above)
              </div>
              <div className="grid cols-2" style={{ gap: 8 }}>
                {draft.apparatus.map((code) => {
                  const evDef = apparatusDefs.find((e) => e.code === code);
                  return (
                    <Field key={code} label={`${code} — ${evDef?.name ?? code}`}>
                      <select
                        className="input"
                        value={draft.apparatusLevels[code] ?? draft.levelId}
                        onChange={(e) => {
                          onChange({
                            ...draft,
                            apparatusLevels: { ...draft.apparatusLevels, [code]: e.target.value },
                          });
                        }}
                      >
                        <option value="" disabled>— select —</option>
                        {discLevels.map((l) => (
                          <option key={l.id} value={l.id}>{l.name}</option>
                        ))}
                      </select>
                    </Field>
                  );
                })}
              </div>
            </div>
          )}

          {/* Synchro partner (TNT SY event) */}
          {synchroSelected && (
            <div style={{ marginTop: 10, padding: '10px 12px', background: 'var(--surface-raised, var(--surface))', borderRadius: 8, border: '1px solid var(--border)' }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Synchro partner</div>
              <label className="checkrow" style={{ marginBottom: 8 }}>
                <input
                  type="checkbox"
                  checked={draft.partnerUnknown}
                  onChange={(e) => onChange({ ...draft, partnerUnknown: e.target.checked, partnerAthleteId: e.target.checked ? null : draft.partnerAthleteId })}
                />
                Partner unknown / to be assigned later
              </label>
              {!draft.partnerUnknown && (
                <Field label="Partner athlete">
                  <Combo
                    options={partnerOptions}
                    value={draft.partnerAthleteId}
                    onChange={(v) => onChange({ ...draft, partnerAthleteId: v })}
                    placeholder="Search by name…"
                  />
                </Field>
              )}
              {!draft.partnerUnknown && !draft.partnerAthleteId && (
                <p style={{ fontSize: 12, color: 'var(--warn)', marginTop: 4 }}>
                  A synchro event can't go live until all entries have partners assigned.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---- main component ---------------------------------------------------------

export interface RegistrationEditorProps {
  event: Event;
  athlete: Athlete;
  clubId: string;
  /** The club the athlete is CURRENTLY registered with (before any edit). When
   *  provided and it differs from `clubId`, a club-only switch registers as an
   *  eligible/chargeable change. Defaults to `clubId` (no club change). */
  originalClubId?: string;
  existing: Registration[]; // all regs for this athlete+event (may be [])
  allAthletes: Athlete[];
  levels: Level[];
  season: Season;
  onSave: (regs: Registration[]) => void;
  onCancel: () => void;
  /** When true, save button says "Add change to cart" — the parent handles the fee */
  changeFeeApplies?: boolean;
  /** Athlete who already named this athlete as their synchro partner, if any. */
  incomingPartnerId?: string | null;
  /** That athlete's own SY level, if known (B4.4: whoever selects a partner
   *  sets the level for both — a fresh SY registration auto-linked to them
   *  should default to THEIR level, not an arbitrary one). */
  incomingPartnerSyLevel?: string | null;
  /** League admin viewing/editing (capabilities.isAdmin) — the only role that
   *  can re-enable a refunded, kept-but-blanked registration (spec §H). */
  isAdmin?: boolean;
  /** ALL non-refunded registrations for this event (every athlete/club), used
   *  ONLY for the advisory (event-mgmt v2 P4) capacity/session-fullness
   *  preview — never written back. The server is the authority at checkout.
   *  Read directly from the store each render by the caller (never memoized
   *  on it) per the in-place-mutation trap. Defaults to `[]` (no advisory UI)
   *  for callers not yet passing it. */
  allEventRegs?: Registration[];
  /** This event's waitlist groups, for the same advisory preview (a promoted
   *  group's live hold counts toward capacity). Defaults to `[]`. */
  waitlistGroups?: WaitlistGroup[];
}

export function RegistrationEditor({
  event,
  athlete,
  clubId,
  originalClubId,
  existing,
  allAthletes,
  levels,
  season,
  onSave,
  onCancel,
  changeFeeApplies = false,
  incomingPartnerId = null,
  incomingPartnerSyLevel = null,
  isAdmin = false,
  allEventRegs = [],
  waitlistGroups = [],
}: RegistrationEditorProps) {
  // Camps are session-less and level-less (PM feedback 2026-07-22): a
  // discipline is "in" purely by the enable checkbox — no apparatus, level,
  // or session selection applies. Derived from the event, not the caller, so
  // every caller (Club.tsx, MyRegistrations.tsx, Events.tsx self-reg) gets
  // this automatically.
  const isCamp = event.eventType === 'camp';

  // Camps ask NOTHING discipline-related (PM feedback 2026-07-23) — a camp
  // registration is a single on/off row, not one row per selected
  // discipline. New registrations always save exactly ONE row, carrying
  // `event.disciplines[0]` purely because `registrations.discipline` is a
  // NOT NULL enum — it is never shown or asked about. `campExistingRows` may
  // legitimately hold MULTIPLE rows for an athlete who registered before this
  // change (one per discipline they'd selected); editing that legacy set
  // must not delete/re-add rows (no churn, no double charge) — see
  // `handleSave` below.
  const campPrimaryDisc: Discipline = ((event.disciplines as Discipline[])[0]) ?? ('MAG' as Discipline);
  const campExistingRows = existing.filter((r) => !r.refunded);

  // Advisory-only capacity preview (event-mgmt v2 P4): server re-validates
  // and is the sole authority at checkout. `now`/groupsById are stable per
  // render — fine, since this is UX-only, not a security check.
  const capacityConfigured = hasCapacityConfig(event, event.sessions);
  const groupsById = useMemo(
    () => Object.fromEntries(waitlistGroups.map((g) => [g.id, g])),
    [waitlistGroups],
  );

  /** Would `session` already be at/over its per-apparatus cap if this
   *  discipline's draft (at `levelId`/`apparatus`) were assigned to it? Builds
   *  a throwaway incoming Registration reusing the discipline's existing reg
   *  id (if any) so it dedupes against its own current baseline row instead
   *  of double-counting. */
  const sessionIsFull = (
    session: EventSession,
    disc: Discipline,
    levelId: string,
    apparatus: string[],
    apparatusLevels: Record<string, string> | undefined,
  ): boolean => {
    if (!capacityConfigured || apparatus.length === 0) return false;
    const activeExisting = existing.find((r) => r.discipline === disc && !r.refunded);
    const incoming: Registration = {
      id: activeExisting?.id ?? `draft-${disc}`,
      eventId: event.id,
      athleteId: athlete.id,
      clubId,
      discipline: disc,
      levelId,
      apparatus: [...apparatus],
      sessionId: session.id,
      refunded: false,
      ...(apparatusLevels && Object.keys(apparatusLevels).length > 0 ? { apparatusLevels } : {}),
    };
    const violations = checkCapacity(event, event.sessions, allEventRegs, [incoming], groupsById, nowMs());
    return violations.some((v) => v.scope === 'session' && v.sessionId === session.id);
  };
  // A discipline whose ONLY registration row is refunded-but-kept (post-
  // edit-deadline refund: refunded:true, keepListed:true, apparatus blanked)
  // — shown visible-but-locked rather than as "no registration" (spec §H).
  const refundedRegFor = (disc: Discipline) =>
    existing.find((r) => r.discipline === disc && !r.refunded) === undefined
      ? existing.find((r) => r.discipline === disc && r.refunded)
      : undefined;

  // Build initial draft state from existing regs (or defaults from athlete.levels)
  const initDrafts = (): Record<Discipline, DraftReg> => {
    const out = {} as Record<Discipline, DraftReg>;
    for (const disc of event.disciplines as Discipline[]) {
      const reg = existing.find((r) => r.discipline === disc && !r.refunded);
      const refundedReg = refundedRegFor(disc);
      const discLevels = levels.filter((l) => l.discipline === disc && !l.retired);
      const defaultLevelId = athlete.levels[disc] ?? discLevels[0]?.id ?? '';
      if (reg) {
        out[disc] = {
          enabled: true,
          levelId: reg.levelId,
          apparatus: [...reg.apparatus],
          apparatusLevels: { ...(reg.apparatusLevels ?? {}) },
          partnerAthleteId: reg.partnerAthleteId ?? null,
          partnerUnknown: reg.partnerAthleteId === null && reg.apparatus.includes('SY'),
          sessionId: reg.sessionId ?? null,
        };
      } else if (refundedReg) {
        out[disc] = {
          enabled: true,
          levelId: refundedReg.levelId,
          apparatus: [...refundedReg.apparatus], // blanked ([]) by the refund
          apparatusLevels: { ...(refundedReg.apparatusLevels ?? {}) },
          partnerAthleteId: refundedReg.partnerAthleteId ?? null,
          partnerUnknown: false,
          refundOverridden: false,
          sessionId: refundedReg.sessionId ?? null,
        };
      } else {
        out[disc] = {
          enabled: false,
          levelId: defaultLevelId,
          apparatus: [],
          apparatusLevels: {},
          partnerAthleteId: null,
          partnerUnknown: false,
          sessionId: null,
        };
      }
    }
    return out;
  };

  const [drafts, setDrafts] = useState<Record<Discipline, DraftReg>>(initDrafts);
  const toast = useToast();

  // Editing an existing (already-saved) registration must always keep at least
  // one discipline enabled — fully deselecting the last one is a silent
  // withdrawal, not a discipline change, so block it instead of letting it
  // through as a no-op empty save. Only applies when editing (existing.length
  // > 0); a brand-new registration in progress may legitimately have zero
  // enabled while the athlete is still choosing.
  const updateDisc = (disc: Discipline, d: DraftReg) => {
    const wasEnabled = drafts[disc]?.enabled;
    if (wasEnabled && !d.enabled && existing.length > 0) {
      const othersEnabled = (event.disciplines as Discipline[]).some((x) => x !== disc && drafts[x]?.enabled);
      if (!othersEnabled) {
        toast('You must stay registered for at least 1 discipline. If you remove all selected events, the meet host will know that you do not plan to compete.');
        return;
      }
    }
    setDrafts((prev) => ({ ...prev, [disc]: d }));
  };

  const handleSave = () => {
    if (isCamp) {
      if (campExistingRows.length > 0) {
        // Editing an existing camp registration — possibly a legacy multi-row
        // set from before this change. Keep every row exactly as-is (no
        // delete/re-add churn, no re-priced/duplicated charges); only clubId
        // is refreshed so a club-only switch actually takes effect.
        onSave(campExistingRows.map((r) => ({ ...r, clubId })));
        return;
      }
      // Brand-new camp registration: exactly one row.
      const reg: Registration = {
        id: `reg-${nowMs()}-${athlete.id}-${campPrimaryDisc}`,
        eventId: event.id,
        athleteId: athlete.id,
        clubId,
        discipline: campPrimaryDisc,
        levelId: '',
        apparatus: [],
        sessionId: null,
      };
      onSave([reg]);
      return;
    }
    const regs: Registration[] = [];
    for (const disc of event.disciplines as Discipline[]) {
      const d = drafts[disc];
      if (!d.enabled || d.apparatus.length === 0) continue;
      const activeExisting = existing.find((r) => r.discipline === disc && !r.refunded);
      // An admin-confirmed re-enable of a refunded discipline reuses (and
      // un-refunds) the ORIGINAL row instead of creating a parallel one, so
      // the reg stays linked to its original invoice/refund-request history.
      const existing_ = activeExisting ?? (d.refundOverridden ? refundedRegFor(disc) : undefined);
      // By-session events: the athlete's explicit picker choice is the
      // session, full stop — never the discipline+level auto-pick below
      // (event-mgmt v2 P4). By-discipline events keep the pre-P4 auto-pick
      // (nationals prelim/final squads use `sessions` even outside by-session
      // mode) for any reg that doesn't already carry one.
      const session = event.sessions.find((s) => s.discipline === disc && s.levelIds.includes(d.levelId))
        ?? event.sessions.find((s) => s.discipline === disc);
      const sessionId = event.registrationMode === 'by-session'
        ? (d.sessionId ?? null)
        : (existing_?.sessionId ?? session?.id ?? null);

      const reg: Registration = {
        id: existing_?.id ?? `reg-${nowMs()}-${athlete.id}-${disc}`,
        eventId: event.id,
        athleteId: athlete.id,
        clubId,
        discipline: disc,
        levelId: d.levelId,
        apparatus: [...d.apparatus],
        sessionId,
        ...(Object.keys(d.apparatusLevels).length > 0 ? { apparatusLevels: d.apparatusLevels } : {}),
        ...(d.apparatus.includes('SY') ? { partnerAthleteId: d.partnerUnknown ? null : d.partnerAthleteId } : {}),
        // A confirmed admin override clears the refunded/keepListed flags on
        // the reused row — that IS the "re-enable" (spec §H).
        ...(existing_?.refunded !== undefined ? { refunded: d.refundOverridden ? false : existing_.refunded } : {}),
        ...(existing_?.refundRequested !== undefined ? { refundRequested: existing_.refundRequested } : {}),
        ...(existing_?.keepListed !== undefined ? { keepListed: d.refundOverridden ? false : existing_.keepListed } : {}),
        ...(existing_?.category !== undefined ? { category: existing_.category } : {}),
        ...(existing_?.quals !== undefined ? { quals: existing_.quals } : {}),
        // Carry forward any existing cart-add capacity hold — only the caller
        // (which knows whether this save creates/updates a cart line) stamps
        // a FRESH one; a free edit must not silently drop an active hold
        // (event-mgmt v2 P4, capacity.ts `holdStamp`).
        ...(existing_?.holdExpiresAt !== undefined ? { holdExpiresAt: existing_.holdExpiresAt } : {}),
      };
      regs.push(reg);
    }
    onSave(regs);
  };

  // Camps have no discipline/apparatus concept to enable — a camp
  // registration is implicitly "on" (new: about to register; existing: must
  // stay registered, see the guard above) the moment this editor is open.
  const anyEnabled = isCamp
    || (event.disciplines as Discipline[]).some((d) => drafts[d]?.enabled && drafts[d].apparatus.length > 0);

  // Are we editing an EXISTING registration (vs creating a brand-new one)? An
  // existing-reg edit must make an ELIGIBLE (chargeable) change before it can be
  // added to the cart (3h). A brand-new registration has no `existing` rows and
  // stays enabled as today.
  const isEditingExisting = existing.some((r) => !r.refunded);

  // Build before/after RegChangeState for the eligibility predicate (3h).
  const draftToEntries = (
    fromExisting: boolean,
  ): RegDisciplineEntry[] => {
    if (isCamp) {
      // Camps have no discipline-level distinction to diff — the only
      // chargeable change possible on a camp edit is a club switch (handled
      // via clubId in `eligible`/`hasChange` below), so before/after resolve
      // to the SAME synthetic "registered" entry as long as the athlete is
      // (and — since there's no deselect UI for camps — stays) registered.
      return (fromExisting ? campExistingRows.length > 0 : true)
        ? [{ discipline: campPrimaryDisc, levelId: '', apparatus: [] }]
        : [];
    }
    const out: RegDisciplineEntry[] = [];
    for (const disc of event.disciplines as Discipline[]) {
      if (fromExisting) {
        const reg = existing.find((r) => r.discipline === disc && !r.refunded);
        if (!reg) continue;
        out.push({
          discipline: disc,
          levelId: reg.levelId,
          apparatus: [...reg.apparatus],
          ...(reg.apparatusLevels ? { apparatusLevels: reg.apparatusLevels } : {}),
          ...(reg.sessionId ? { sessionId: reg.sessionId } : {}),
        });
      } else {
        const d = drafts[disc];
        if (!d?.enabled || d.apparatus.length === 0) continue;
        out.push({
          discipline: disc,
          levelId: d.levelId,
          apparatus: [...d.apparatus],
          ...(Object.keys(d.apparatusLevels).length > 0 ? { apparatusLevels: d.apparatusLevels } : {}),
          ...(d.sessionId ? { sessionId: d.sessionId } : {}),
        });
      }
    }
    return out;
  };

  const eligible = useMemo(() => {
    if (!isEditingExisting) return true; // new registration — always enabled
    // `before` uses the ORIGINAL club so a club-only switch (originalClubId !==
    // clubId) is recognized as an eligible change; `after` uses the live clubId.
    const before: RegChangeState = { clubId: originalClubId ?? clubId, athleteId: athlete.id, disciplines: draftToEntries(true) };
    const after: RegChangeState = { clubId, athleteId: athlete.id, disciplines: draftToEntries(false) };
    return changeIsEligible(before, after);
    // draftToEntries closes over `drafts` + `existing`; recompute on draft change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drafts, existing, clubId, originalClubId, athlete.id, isEditingExisting]);

  // Broader than `eligible`: also true for a FREE change (pure apparatus tweak
  // or discipline removal) that `eligible` deliberately excludes from being
  // chargeable. Gates the Save button's enabled state so those free edits can
  // still be committed instead of being stuck with no way to save (B8).
  const hasChange = useMemo(() => {
    if (!isEditingExisting) return true;
    const before: RegChangeState = { clubId: originalClubId ?? clubId, athleteId: athlete.id, disciplines: draftToEntries(true) };
    const after: RegChangeState = { clubId, athleteId: athlete.id, disciplines: draftToEntries(false) };
    return regChangeHasDiff(before, after);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drafts, existing, clubId, originalClubId, athlete.id, isEditingExisting]);

  // Live price estimate (S5, UI/UX review 2026-07-04) — derived ONLY from the
  // existing pure pricing helpers via `registrationEstimate` (never
  // duplicated here). `newDisciplineCount` only matters for the brand-new-
  // registration branch (ignored by `registrationEstimate` when editing); a
  // camp registration is always a single flat-fee row regardless of its
  // equipment-list "disciplines", never per-discipline.
  //
  // `eligible && changeFeeApplies`: `saveLabel` below intentionally shows
  // "Add change to cart" off `eligible` alone (pre-existing behavior, not
  // S5's to change) — but the actual fee the parent charges on save is
  // additionally gated on `changeFeeApplies` (the event's change-fee window
  // having opened; see saveRegs in MyRegistrations.tsx/Club.tsx). Folding
  // that gate in here (routing only, no fee math) keeps the estimate
  // truthful: before the window opens, an eligible edit is still free.
  // Disciplines being ADDED right now: enabled, apparatus chosen, and with no
  // existing non-refunded row — the editor-side analogue of `newOnlyRegs` in
  // Club.tsx's saveRegs. Counting every enabled discipline instead would
  // re-charge disciplines the athlete already holds.
  const newDisciplineCount = isCamp
    ? (existing.some((r) => !r.refunded) ? 0 : 1)
    : (event.disciplines as Discipline[]).filter((d) => (
      drafts[d]?.enabled
      && drafts[d].apparatus.length > 0
      && !existing.some((r) => r.discipline === d && !r.refunded)
    )).length;
  // Already-held disciplines, so an added one prices at the SECOND-discipline
  // rate (matches Club.tsx's `priorDisciplineCount`).
  const priorDisciplineCount = existing.filter((r) => !r.refunded && r.apparatus.length > 0).length;
  // Late-registration surcharge: the save path feeds `lateFeeAnchor` into
  // `newRegistrationEntryTotal`, so the estimate must too or it quotes low
  // inside a late window. Newly-added rows have no `createdAt` yet (they don't
  // exist), which `lateFeeAnchor` treats as "now" — exactly how the save path
  // sees them. `nowIso()` is a plain helper, not called textually inside the
  // useMemo, so react-hooks/purity's impure-call check doesn't fire (same
  // approach as `computeCapacityViolations` below).
  const nowIso = () => new Date(nowMs()).toISOString();
  const lateAnchor = (() => {
    if (!event.lateReg) return null;
    const outside = existing
      .filter((r) => !r.refunded && r.apparatus.length > 0)
      .map((r) => ({ id: r.id, createdAt: r.createdAt }));
    const line = Array.from({ length: newDisciplineCount }, (_, i) => ({ id: `pending-${i}` }));
    return lateFeeAnchor(line, outside, nowIso());
  })();
  const estimate = useMemo(
    () => registrationEstimate({
      event,
      competingClubId: clubId,
      isEditingExisting,
      // RAW `eligible` — `registrationEstimate` needs it and `changeFeeApplies`
      // separately to reproduce the save path's precedence (a discipline added
      // while the change-fee window is CLOSED is billed as an entry fee, not
      // free; see that module's header).
      eligible,
      changeFeeApplies,
      newDisciplineCount,
      priorDisciplineCount,
      ...(lateAnchor ? { late: { earliestCreatedAtISO: lateAnchor } } : {}),
    }),
    [event, clubId, isEditingExisting, eligible, changeFeeApplies, newDisciplineCount, priorDisciplineCount, lateAnchor],
  );
  const estimateLabel = registrationEstimateLabel(estimate);

  // By-session events (event-mgmt v2 P4) require an explicit session pick for
  // every enabled discipline with apparatus chosen before Save is allowed.
  const sessionsMissing = event.registrationMode === 'by-session'
    && (event.disciplines as Discipline[]).some((d) => {
      const dr = drafts[d];
      return !!dr?.enabled && dr.apparatus.length > 0 && !dr.sessionId;
    });

  const saveDisabled = !anyEnabled || (isEditingExisting && !hasChange) || sessionsMissing;
  const saveLabel = isEditingExisting
    ? (eligible ? 'Add change to cart' : 'Save')
    : (changeFeeApplies ? 'Add to cart' : 'Register');

  // Advisory capacity banner (event-mgmt v2 P4, checkout is the real
  // authority): reconstruct approximate Registration rows from the current
  // drafts and check them against every configured cap. The `Date.now()` read
  // is tucked inside this plain helper (not textually inside the `useMemo`
  // callback below) so react-hooks/purity's impure-call check — which flags
  // impure calls written directly in a hook body — doesn't fire; same
  // approach as `sessionIsFull` above.
  const computeCapacityViolations = (): CapacityViolation[] => {
    if (!capacityConfigured) return [];
    if (isCamp) {
      // Single synthetic row representing the one camp registration this
      // editor can produce — reuses the first existing row's id (if any) so
      // it dedupes against its own baseline instead of double-counting.
      const draftRegs: Registration[] = [{
        id: campExistingRows[0]?.id ?? `draft-${campPrimaryDisc}`,
        eventId: event.id,
        athleteId: athlete.id,
        clubId,
        discipline: campPrimaryDisc,
        levelId: '',
        apparatus: [],
        sessionId: null,
        refunded: false,
      }];
      return checkCapacity(event, event.sessions, allEventRegs, draftRegs, groupsById, nowMs());
    }
    const draftRegs: Registration[] = [];
    for (const disc of event.disciplines as Discipline[]) {
      const d = drafts[disc];
      if (!d?.enabled || d.apparatus.length === 0) continue;
      const activeExisting = existing.find((r) => r.discipline === disc && !r.refunded);
      draftRegs.push({
        id: activeExisting?.id ?? `draft-${disc}`,
        eventId: event.id,
        athleteId: athlete.id,
        clubId,
        discipline: disc,
        levelId: d.levelId,
        apparatus: [...d.apparatus],
        sessionId: d.sessionId ?? null,
        refunded: false,
        ...(Object.keys(d.apparatusLevels).length > 0 ? { apparatusLevels: d.apparatusLevels } : {}),
      });
    }
    return checkCapacity(event, event.sessions, allEventRegs, draftRegs, groupsById, nowMs());
  };

  const capacityViolations: CapacityViolation[] = useMemo(
    () => computeCapacityViolations(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [drafts, existing, event, athlete.id, clubId, allEventRegs, groupsById, capacityConfigured],
  );

  const levelName = (levelId: string) => levels.find((l) => l.id === levelId)?.name ?? levelId;
  const disciplineLabel = (d: Discipline) => (d === 'TNT' ? 'T&T' : d);
  const sessionName = (sessionId: string) => event.sessions.find((s) => s.id === sessionId)?.name ?? sessionId;

  const violationText = (v: CapacityViolation): string => {
    const scopeLabel = v.scope === 'level'
      ? `${disciplineLabel(v.discipline!)} — Level ${levelName(v.levelId!)}`
      : v.scope === 'discipline'
        ? disciplineLabel(v.discipline!)
        : `${sessionName(v.sessionId!)} (${v.apparatus})`;
    return `${scopeLabel} has ${v.remaining} spot${v.remaining === 1 ? '' : 's'} left — this selection needs ${v.requested}; checkout will offer a waitlist.`;
  };

  return (
    <div>
      <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span
          className="badge"
          style={{
            fontSize: 11,
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            padding: '2px 8px',
            borderRadius: 999,
            color: 'var(--ink-soft)',
            background: 'var(--surface-raised, var(--surface))',
            border: '1px solid var(--border)',
          }}
        >
          {isEditingExisting ? 'Editing registration' : 'New registration'}
        </span>
        <strong style={{ fontSize: 16 }}>{athlete.firstName} {athlete.lastName}</strong>
        <span style={{ fontSize: 13, color: 'var(--ink-soft)' }}>{event.name}</span>
      </div>

      {isCamp ? (
        // Camps ask NOTHING discipline-related (PM feedback 2026-07-23): a
        // single confirmation line replaces the per-discipline checkboxes —
        // registration is implicit on create and can't be undone via edit
        // (withdrawal stays a refund action).
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14, marginTop: 14, fontSize: 14 }}>
          {campExistingRows.length > 0
            ? <p style={{ margin: 0 }}>Registered for <strong>{event.name}</strong>.</p>
            : <p style={{ margin: 0 }}>{athlete.firstName} will be registered for <strong>{event.name}</strong>.</p>}
        </div>
      ) : (
        (event.disciplines as Discipline[]).map((disc) => (
          <DiscSection
            key={disc}
            disc={disc}
            event={event}
            athlete={athlete}
            levels={levels}
            existing={existing.find((r) => r.discipline === disc && !r.refunded)}
            draft={drafts[disc] ?? { enabled: false, levelId: '', apparatus: [], apparatusLevels: {}, partnerAthleteId: null, partnerUnknown: false, sessionId: null }}
            onChange={(d) => updateDisc(disc, d)}
            allAthletes={allAthletes}
            season={season}
            incomingPartnerId={disc === 'TNT' ? incomingPartnerId : null}
            incomingPartnerSyLevel={disc === 'TNT' ? incomingPartnerSyLevel : null}
            refunded={!!refundedRegFor(disc) && !(drafts[disc]?.refundOverridden)}
            isAdmin={isAdmin}
            sessionIsFull={sessionIsFull}
          />
        ))
      )}

      {/* Advisory capacity warning (event-mgmt v2 P4) — non-blocking; the
          server enforces the real cap at checkout and offers a waitlist. */}
      {capacityViolations.length > 0 && (
        <div
          role="status"
          style={{
            fontSize: 12.5, color: 'var(--warn)', background: 'var(--surface-raised, var(--surface))',
            border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px', marginTop: 12,
          }}
        >
          {capacityViolations.map((v, i) => (
            <p key={i} style={{ margin: i === 0 ? 0 : '4px 0 0' }}>{violationText(v)}</p>
          ))}
        </div>
      )}

      {/* Live price estimate (S5). Contrast: --ink (#1e2b38) on --surface
          (#fcfcfc) is well over AA (~15:1) — matches the app's default body
          text color, used here at 600 weight since it's money info. */}
      <p style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--ink)', marginTop: 16, marginBottom: 0 }}>
        {estimateLabel}
      </p>
      <p style={{ fontSize: 12, color: 'var(--ink-soft)', marginTop: 2, marginBottom: 0 }}>
        Estimated — the exact total is confirmed at checkout.
      </p>

      <div style={{ display: 'flex', gap: 10, marginTop: 12, alignItems: 'center' }}>
        <button
          className="btn primary"
          disabled={saveDisabled}
          onClick={handleSave}
        >
          {saveLabel}
        </button>
        <button className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>

      {/* Why the change can't be added yet (3h). Shown only while editing an
          existing registration that hasn't made a chargeable change. */}
      {isEditingExisting && anyEnabled && !eligible && (
        <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', marginTop: 8, maxWidth: 560 }}>
          Make a chargeable change — add a discipline, change a level, change club,
          or swap athlete — to continue. Adding or removing apparatus within a
          discipline you&apos;re already registered for isn&apos;t a chargeable change.
        </p>
      )}

      {/* Required session pick missing (by-session events, event-mgmt v2 P4). */}
      {sessionsMissing && (
        <p style={{ fontSize: 12.5, color: 'var(--warn)', marginTop: 8, maxWidth: 560 }}>
          Pick a session for every discipline before continuing.
        </p>
      )}
    </div>
  );
}
