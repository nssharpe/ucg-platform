import { useState, type CSSProperties } from 'react';
import {
  DndContext, DragOverlay, PointerSensor, TouchSensor, KeyboardSensor,
  closestCenter, useSensor, useSensors,
} from '@dnd-kit/core';
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core';
import {
  SortableContext, useSortable, verticalListSortingStrategy, sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useDB, mutate } from '../lib/store';
import { useEventRegistrations } from '../lib/registrations-slice';
import { pushFinalsLineup } from '../lib/supabase';
import { APPARATUS } from '../lib/types';
import type { Event, FinalsLineup } from '../lib/types';
import type { NationalsTeam } from '../lib/nationals-teams';
import { finalsLineupValid, moveInLineup, toggleInLineup, FINALS_LINEUP_MAX } from '../lib/finals-lineup';
import { useCapabilities } from '../lib/capabilities';
import { Badge } from './ui';

/**
 * Finals-lineup editor (event-mgmt v2 Phase 5 C2, spec §E7/§L.3). Attaches
 * under each eligible-team row in `NationalsDashboard`'s "Eligible teams"
 * section: one apparatus card per `team.eligibleApparatus`, letting the club
 * pick up to `FINALS_LINEUP_MAX` athletes and drag them into competing order.
 * Auto-saves every change via `pushFinalsLineup` (upsert keyed by
 * event+club+level+category+apparatus). Mirrors `CompetitionOrderCard`'s
 * @dnd-kit structure/sensors/contrast/responsive approach (B2) so the two
 * drag UIs feel consistent.
 *
 * Gates (both soft — correctness to the hour is fine per spec):
 * - Closed until 8pm local time on the event's day 1 (`finalsOpenAt`) unless
 *   the viewer is an admin.
 * - Read-only (no toggle/drag) once `event.finalsRosterLocked` is true,
 *   unless the viewer is an admin — mirrors `CompetitionOrderCard`'s lock
 *   gating exactly (RLS enforces the same rule server-side, C1).
 *
 * Renders nothing if the team has no eligible apparatus (nothing to line up).
 */
export function FinalsLineupEditor({ event, team }: { event: Event; team: NationalsTeam }) {
  const caps = useCapabilities();
  const isAdmin = caps.isAdmin;

  if (team.eligibleApparatus.length === 0) return null;

  const opensAt = finalsOpenAt(event);
  const isOpen = isAdmin || new Date() >= opensAt;
  const locked = !!event.finalsRosterLocked;
  const editable = isOpen && (!locked || isAdmin);

  return (
    <div style={{ marginTop: 6, marginBottom: 12, paddingLeft: 12, borderLeft: '2px solid var(--line)' }}>
      <div style={{ fontSize: 12.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--ink-soft)', marginBottom: 6 }}>
        Finals lineups
      </div>

      {!isOpen ? (
        <p style={{ fontSize: 13, color: 'var(--ink-soft)', margin: 0 }}>
          Finals lineups open at 8pm on {event.startDate}.
        </p>
      ) : (
        <>
          {locked && (
            <p style={{ fontSize: 13, color: 'var(--ink-soft)', margin: '0 0 10px' }}>
              {isAdmin ? 'Finals rosters are locked for club managers — as an admin you can still edit.' : 'Finals rosters are locked.'}
            </p>
          )}
          <div style={{ overflowX: 'auto', paddingBottom: 4 }}>
            <div style={{ display: 'flex', gap: 16, minWidth: 'min-content' }}>
              {team.eligibleApparatus.map((apparatus) => (
                <ApparatusLineupCard
                  key={apparatus}
                  event={event}
                  team={team}
                  apparatus={apparatus}
                  editable={editable}
                />
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** Moment finals lineups open: 8pm local time (event.timezone) on
 *  `event.startDate` (day 1). Computed via the standard "round-trip through
 *  Intl.DateTimeFormat to recover the tz offset" trick — no tz library in
 *  this codebase and this is a soft gate (correctness to the hour is fine,
 *  per spec). `event.startDate` is a plain `YYYY-MM-DD` local date. */
function finalsOpenAt(event: Event): Date {
  const [y, m, d] = event.startDate.split('-').map(Number);
  const naiveUtcMs = Date.UTC(y, (m ?? 1) - 1, d ?? 1, 20, 0, 0);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: event.timezone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(naiveUtcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const hour = get('hour') % 24; // Intl can format midnight as "24"
  const asIfUtcMs = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
  const offsetMs = asIfUtcMs - naiveUtcMs;
  return new Date(naiveUtcMs - offsetMs);
}

const containerId = (apparatus: string, levelId: string, clubId: string) => `fl-${clubId}-${levelId}-${apparatus}`;

const apparatusName = (discipline: NationalsTeam['discipline'], code: string): string =>
  APPARATUS[discipline].find((a) => a.code === code)?.name ?? code;

function ApparatusLineupCard({
  event, team, apparatus, editable,
}: {
  event: Event;
  team: NationalsTeam;
  apparatus: string;
  editable: boolean;
}) {
  const db = useDB();
  // Phase 3 (data-layer-scale): reads the by-event slice instead of
  // db.registrations — nameOf only ever resolves ids already known to be
  // "candidates" for this event (team.apparatusRegIds), so no extra loading
  // guard is needed here (a not-yet-loaded slice just briefly shows
  // "Unknown athlete", matching the existing fallback for a genuinely
  // missing reg).
  const { rows: eventRegs } = useEventRegistrations(event.id);
  const candidateRegIds = team.apparatusRegIds[apparatus] ?? [];
  const existing = (db.finalsLineups ?? []).find(
    (l) => l.eventId === event.id && l.clubId === team.clubId && l.levelId === team.levelId
      && l.category === team.category && l.apparatus === apparatus,
  );
  const regIds = (existing?.regIds ?? []).filter((id) => candidateRegIds.includes(id));
  const valid = finalsLineupValid(regIds);
  const [activeId, setActiveId] = useState<string | null>(null);
  const dropId = containerId(apparatus, team.levelId, team.clubId);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const nameOf = (regId: string): string => {
    const reg = eventRegs.find((r) => r.id === regId);
    const p = reg ? db.people.find((x) => x.id === reg.athleteId) : undefined;
    return p ? `${p.firstName} ${p.lastName}` : 'Unknown athlete';
  };

  const persist = (nextRegIds: string[]) => {
    const row: FinalsLineup = {
      id: existing?.id ?? crypto.randomUUID(),
      eventId: event.id,
      clubId: team.clubId,
      levelId: team.levelId,
      category: team.category,
      apparatus,
      regIds: nextRegIds,
      updatedAt: new Date().toISOString(),
    };
    mutate((d) => {
      const list = d.finalsLineups ?? (d.finalsLineups = []);
      const idx = list.findIndex((l) => l.id === row.id);
      if (idx >= 0) list[idx] = row; else list.push(row);
      pushFinalsLineup(row);
    });
  };

  const toggle = (regId: string) => {
    if (!editable) return;
    persist(toggleInLineup(regIds, regId));
  };

  const onDragStart = (evt: DragStartEvent) => setActiveId(String(evt.active.id));

  const onDragEnd = (evt: DragEndEvent) => {
    setActiveId(null);
    if (!editable) return;
    const { active, over } = evt;
    if (!over) return;
    const fromId = String(active.id);
    const overId = String(over.id);
    if (overId === fromId) return;
    const from = regIds.indexOf(fromId);
    const to = regIds.indexOf(overId);
    if (from < 0 || to < 0) return;
    persist(moveInLineup(regIds, from, to));
  };

  return (
    <div className="card card-pad" style={{ minWidth: 230, flex: '0 0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8, gap: 8 }}>
        <h4 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>{apparatusName(team.discipline, apparatus)}</h4>
        {!valid && <Badge tone="warn">Over cap</Badge>}
      </div>

      <div style={{ fontSize: 11.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--ink-soft)', marginBottom: 6 }}>
        Lineup — {regIds.length}/{FINALS_LINEUP_MAX}
      </div>

      {editable ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onDragCancel={() => setActiveId(null)}
        >
          <SortableContext id={dropId} items={regIds} strategy={verticalListSortingStrategy}>
            {regIds.length === 0 ? (
              <div style={{ fontSize: 12.5, color: 'var(--ink-soft)', padding: '10px 0', textAlign: 'center' }}>No athletes picked yet</div>
            ) : (
              regIds.map((regId) => <SortableChip key={regId} id={regId} name={nameOf(regId)} onRemove={() => toggle(regId)} />)
            )}
          </SortableContext>
          <DragOverlay>
            {activeId ? <Chip name={nameOf(activeId)} dragging /> : null}
          </DragOverlay>
        </DndContext>
      ) : (
        regIds.length === 0
          ? <div style={{ fontSize: 12.5, color: 'var(--ink-soft)', padding: '10px 0', textAlign: 'center' }}>No athletes picked</div>
          : regIds.map((regId) => <Chip key={regId} name={nameOf(regId)} />)
      )}

      {editable && (
        <div style={{ marginTop: 10, borderTop: '1px solid var(--line)', paddingTop: 8 }}>
          <div style={{ fontSize: 11.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--ink-soft)', marginBottom: 6 }}>
            Candidates
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {candidateRegIds.map((regId) => {
              const picked = regIds.includes(regId);
              const full = !picked && regIds.length >= FINALS_LINEUP_MAX;
              return (
                <button
                  key={regId}
                  type="button"
                  className="btn small ghost"
                  disabled={full}
                  onClick={() => toggle(regId)}
                  style={picked ? { background: 'var(--ice-100)', borderColor: 'var(--navy-600)' } : undefined}
                  aria-pressed={picked}
                >
                  {picked ? '✓ ' : ''}{nameOf(regId)}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function SortableChip({ id, name, onRemove }: { id: string; name: string; onRemove: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: transition ?? undefined,
    opacity: isDragging ? 0.4 : 1,
  };
  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <Chip name={name} onRemove={onRemove} />
    </div>
  );
}

/** Athlete chip — mirrors `CompetitionOrderCard`'s `Chip` (`--ice-100` fill,
 *  `--ink` text: a light neutral that stays legible in both themes). */
function Chip({ name, dragging, onRemove }: { name: string; dragging?: boolean; onRemove?: () => void }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 10px',
        marginBottom: 6,
        borderRadius: 6,
        background: 'var(--ice-100)',
        color: 'var(--ink)',
        fontSize: 13,
        border: '1px solid var(--line)',
        cursor: dragging ? 'grabbing' : (onRemove ? 'grab' : 'default'),
        touchAction: 'none',
        boxShadow: dragging ? 'var(--shadow)' : 'none',
      }}
    >
      <span aria-hidden style={{ color: 'var(--ink-soft)' }}>⠿</span>
      <span style={{ flex: 1 }}>{name}</span>
      {onRemove && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          aria-label={`Remove ${name}`}
          style={{ background: 'none', border: 'none', color: 'var(--ink-soft)', cursor: 'pointer', padding: 0, fontSize: 13, lineHeight: 1 }}
        >
          ✕
        </button>
      )}
    </div>
  );
}
