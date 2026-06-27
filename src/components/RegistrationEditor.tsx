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
import { APPARATUS } from '../lib/types';
import type { Athlete, Discipline, Level, Event, Registration, Season } from '../lib/types';
import { changeIsEligible } from '../lib/pricing';
import type { RegChangeState, RegDisciplineEntry } from '../lib/pricing';

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
}

/** Draft shape for one discipline */
export interface DraftReg {
  enabled: boolean;
  levelId: string;
  apparatus: string[];
  eventLevels: Record<string, string>; // T&T per-event levels
  partnerAthleteId: string | null; // synchro
  partnerUnknown: boolean;
}

function DiscSection({ disc, athlete, levels, draft, onChange, allAthletes, season, incomingPartnerId }: DiscSectionProps) {
  const discLevels = levels.filter((l) => l.discipline === disc && !l.retired);
  const apparatusDefs = APPARATUS[disc];
  const isTNT = disc === 'TNT';

  // SY (Synchro) is an event within TNT, not its own discipline
  const synchroSelected = isTNT && draft.apparatus.includes('SY');

  // Athletes with active memberships for the partner combo
  const partnerOptions = useMemo(() => {
    return allAthletes
      .filter((a) => a.id !== athlete.id && a.memberships.some((m) => m.seasonId === season.id && m.status === 'active'))
      .map((a) => ({ value: a.id, label: `${a.firstName} ${a.lastName}`, sub: a.email }));
  }, [allAthletes, athlete.id, season.id]);

  const toggleEvent = (code: string) => {
    const next = draft.apparatus.includes(code)
      ? draft.apparatus.filter((e) => e !== code)
      : [...draft.apparatus, code];

    // Update eventLevels for T&T — add/remove the key
    const nextEventLevels = { ...draft.eventLevels };
    if (isTNT) {
      if (next.includes(code) && !nextEventLevels[code]) {
        nextEventLevels[code] = draft.levelId;
      } else if (!next.includes(code)) {
        delete nextEventLevels[code];
      }
    }
    // Auto-link the synchro partner: if someone already named this athlete as
    // their partner, default this athlete's partner to them when they add SY.
    let partnerAthleteId = draft.partnerAthleteId;
    let partnerUnknown = draft.partnerUnknown;
    if (code === 'SY' && next.includes('SY') && !partnerAthleteId && incomingPartnerId) {
      partnerAthleteId = incomingPartnerId;
      partnerUnknown = false;
    }
    onChange({ ...draft, apparatus: next, eventLevels: nextEventLevels, partnerAthleteId, partnerUnknown });
  };

  const selectAllAround = () => {
    const allCodes = apparatusDefs.map((e) => e.code);
    const nextEventLevels: Record<string, string> = {};
    if (isTNT) {
      for (const code of allCodes) nextEventLevels[code] = draft.eventLevels[code] ?? draft.levelId;
    }
    // Auto-link synchro partner when selecting all (which includes SY for T&T).
    const partnerAthleteId = (allCodes.includes('SY') && !draft.partnerAthleteId && incomingPartnerId)
      ? incomingPartnerId : draft.partnerAthleteId;
    onChange({ ...draft, apparatus: allCodes, eventLevels: nextEventLevels, partnerAthleteId });
  };

  const clearAll = () => {
    onChange({ ...draft, apparatus: [], eventLevels: {} });
  };

  const isAA = draft.apparatus.length === apparatusDefs.length && apparatusDefs.every((e) => draft.apparatus.includes(e.code));

  const setMainLevel = (levelId: string) => {
    // When the main level changes, update any eventLevels that were still at the
    // previous main level (i.e. not individually overridden).
    const nextEventLevels: Record<string, string> = {};
    for (const [ev, lvl] of Object.entries(draft.eventLevels)) {
      nextEventLevels[ev] = lvl === draft.levelId ? levelId : lvl;
    }
    onChange({ ...draft, levelId, eventLevels: nextEventLevels });
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

          {/* Event checkboxes */}
          <div style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 13, color: 'var(--ink-soft)', marginBottom: 6 }}>
              Events
              <button
                type="button"
                className="btn ghost small"
                style={{ marginLeft: 8 }}
                onClick={isAA ? clearAll : selectAllAround}
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
                    onChange={() => toggleEvent(ev.code)}
                  />
                  <span title={ev.name}>{ev.code} — {ev.name}</span>
                </label>
              ))}
            </div>
          </div>

          {/* T&T per-event level overrides */}
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
                        value={draft.eventLevels[code] ?? draft.levelId}
                        onChange={(e) => {
                          onChange({
                            ...draft,
                            eventLevels: { ...draft.eventLevels, [code]: e.target.value },
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
}: RegistrationEditorProps) {
  // Build initial draft state from existing regs (or defaults from athlete.levels)
  const initDrafts = (): Record<Discipline, DraftReg> => {
    const out = {} as Record<Discipline, DraftReg>;
    for (const disc of event.disciplines as Discipline[]) {
      const reg = existing.find((r) => r.discipline === disc && !r.refunded);
      const discLevels = levels.filter((l) => l.discipline === disc && !l.retired);
      const defaultLevelId = athlete.levels[disc] ?? discLevels[0]?.id ?? '';
      if (reg) {
        out[disc] = {
          enabled: true,
          levelId: reg.levelId,
          apparatus: [...reg.apparatus],
          eventLevels: { ...(reg.eventLevels ?? {}) },
          partnerAthleteId: reg.partnerAthleteId ?? null,
          partnerUnknown: reg.partnerAthleteId === null && reg.apparatus.includes('SY'),
        };
      } else {
        out[disc] = {
          enabled: false,
          levelId: defaultLevelId,
          apparatus: [],
          eventLevels: {},
          partnerAthleteId: null,
          partnerUnknown: false,
        };
      }
    }
    return out;
  };

  const [drafts, setDrafts] = useState<Record<Discipline, DraftReg>>(initDrafts);

  const updateDisc = (disc: Discipline, d: DraftReg) =>
    setDrafts((prev) => ({ ...prev, [disc]: d }));

  const handleSave = () => {
    const regs: Registration[] = [];
    for (const disc of event.disciplines as Discipline[]) {
      const d = drafts[disc];
      if (!d.enabled || d.apparatus.length === 0) continue;
      const existing_ = existing.find((r) => r.discipline === disc && !r.refunded);
      const session = event.sessions.find((s) => s.discipline === disc && s.levelIds.includes(d.levelId))
        ?? event.sessions.find((s) => s.discipline === disc);

      const reg: Registration = {
        id: existing_?.id ?? `reg-${Date.now()}-${athlete.id}-${disc}`,
        eventId: event.id,
        athleteId: athlete.id,
        clubId,
        discipline: disc,
        levelId: d.levelId,
        apparatus: [...d.apparatus],
        sessionId: existing_?.sessionId ?? session?.id ?? null,
        ...(Object.keys(d.eventLevels).length > 0 ? { eventLevels: d.eventLevels } : {}),
        ...(d.apparatus.includes('SY') ? { partnerAthleteId: d.partnerUnknown ? null : d.partnerAthleteId } : {}),
        ...(existing_?.refunded !== undefined ? { refunded: existing_.refunded } : {}),
        ...(existing_?.refundRequested !== undefined ? { refundRequested: existing_.refundRequested } : {}),
        ...(existing_?.keepListed !== undefined ? { keepListed: existing_.keepListed } : {}),
        ...(existing_?.category !== undefined ? { category: existing_.category } : {}),
        ...(existing_?.quals !== undefined ? { quals: existing_.quals } : {}),
      };
      regs.push(reg);
    }
    onSave(regs);
  };

  const anyEnabled = (event.disciplines as Discipline[]).some((d) => drafts[d]?.enabled && drafts[d].apparatus.length > 0);

  // Are we editing an EXISTING registration (vs creating a brand-new one)? An
  // existing-reg edit must make an ELIGIBLE (chargeable) change before it can be
  // added to the cart (3h). A brand-new registration has no `existing` rows and
  // stays enabled as today.
  const isEditingExisting = existing.some((r) => !r.refunded);

  // Build before/after RegChangeState for the eligibility predicate (3h).
  const draftToEntries = (
    fromExisting: boolean,
  ): RegDisciplineEntry[] => {
    const out: RegDisciplineEntry[] = [];
    for (const disc of event.disciplines as Discipline[]) {
      if (fromExisting) {
        const reg = existing.find((r) => r.discipline === disc && !r.refunded);
        if (!reg) continue;
        out.push({
          discipline: disc,
          levelId: reg.levelId,
          apparatus: [...reg.apparatus],
          ...(reg.eventLevels ? { eventLevels: reg.eventLevels } : {}),
        });
      } else {
        const d = drafts[disc];
        if (!d?.enabled || d.apparatus.length === 0) continue;
        out.push({
          discipline: disc,
          levelId: d.levelId,
          apparatus: [...d.apparatus],
          ...(Object.keys(d.eventLevels).length > 0 ? { eventLevels: d.eventLevels } : {}),
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

  const saveDisabled = !anyEnabled || (isEditingExisting && !eligible);
  const saveLabel = isEditingExisting
    ? 'Add change to cart'
    : (changeFeeApplies ? 'Add to cart' : 'Register');

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

      {(event.disciplines as Discipline[]).map((disc) => (
        <DiscSection
          key={disc}
          disc={disc}
          event={event}
          athlete={athlete}
          levels={levels}
          existing={existing.find((r) => r.discipline === disc && !r.refunded)}
          draft={drafts[disc] ?? { enabled: false, levelId: '', apparatus: [], eventLevels: {}, partnerAthleteId: null, partnerUnknown: false }}
          onChange={(d) => updateDisc(disc, d)}
          allAthletes={allAthletes}
          season={season}
          incomingPartnerId={disc === 'TNT' ? incomingPartnerId : null}
        />
      ))}

      <div style={{ display: 'flex', gap: 10, marginTop: 18, alignItems: 'center' }}>
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
    </div>
  );
}
