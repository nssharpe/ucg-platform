import { useState, type CSSProperties } from 'react';
import {
  DndContext, DragOverlay, PointerSensor, TouchSensor, KeyboardSensor,
  closestCenter, useDroppable, useSensor, useSensors,
} from '@dnd-kit/core';
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core';
import {
  SortableContext, useSortable, verticalListSortingStrategy, sortableKeyboardCoordinates,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useDB, mutate } from '../lib/store';
import { useEventRegistrations } from '../lib/registrations-slice';
import { pushCompetitionOrder } from '../lib/supabase';
import { APPARATUS } from '../lib/types';
import type { Event, CompetitionOrder, Level } from '../lib/types';
import {
  sectionCap, splitIntoSections, flattenSections, sectionsValid, moveInSections, reconcileSections, computeDropIndex,
} from '../lib/competition-order';
import { Field, Badge } from './ui';

/**
 * Club-facing "Set Competition Order" drag UI (event-mgmt v2 Phase 5 B2, spec
 * §E6). MAG/WAG only — never rendered for a T&T-only event. Renders one
 * column per apparatus for a club-chosen level; each column is split into
 * sections (capped 12 WAG / 15 MAG) the club controls via drag-and-drop, and
 * every change auto-saves (`pushCompetitionOrder`). View-only (no drag) once
 * `event.competitionOrderLocked` is true, unless the viewer is an admin.
 *
 * Renders nothing when: the event has no MAG/WAG discipline, the club has no
 * MAG/WAG registrations for the event, or the caller can't manage this club
 * (mirrors `ClubAddonsCard`'s internal-early-return gating convention).
 */
export function CompetitionOrderCard({
  event, clubId, canManage, isAdmin,
}: {
  event: Event;
  clubId: string;
  canManage: boolean;
  isAdmin: boolean;
}) {
  const db = useDB();

  // Phase 3 (data-layer-scale): registrations read from the by-event slice
  // instead of db.registrations — also sidesteps the M6 in-place-mutation
  // trap (mutate() never reassigns db.registrations on an update), since
  // eventRegs is a fresh array reference on every slice update.
  const { rows: eventRegs, status: regsStatus } = useEventRegistrations(event.id);
  const clubRegs = eventRegs.filter(
    (r) => r.eventId === event.id && r.clubId === clubId
      && (r.discipline === 'MAG' || r.discipline === 'WAG')
      && !r.refunded && !r.waitlisted,
  );

  const levelIds = [...new Set(clubRegs.map((r) => r.levelId))];
  const levels = levelIds
    .map((id) => db.levels.find((l) => l.id === id))
    .filter((l): l is Level => !!l)
    .sort((a, b) => a.discipline.localeCompare(b.discipline) || a.order - b.order);

  const [levelId, setLevelId] = useState<string | undefined>(undefined);

  if (!canManage) return null;
  // Distinguish "still loading" from "genuinely no MAG/WAG registrations" —
  // the latter is this card's real empty state and stays a silent `null`
  // (mirrors the pre-slice behavior); the former would otherwise render
  // nothing while data is in flight, which reads as "nothing to set up here"
  // rather than "still loading".
  if (regsStatus === 'loading') {
    return (
      <div className="card card-pad" style={{ marginBottom: 18 }}>
        <h3 className="card-title">Set competition order</h3>
        <p style={{ fontSize: 13, color: 'var(--ink-soft)' }}>Loading…</p>
      </div>
    );
  }
  if (levels.length === 0) return null;

  const level = levels.find((l) => l.id === levelId) ?? levels[0];
  const locked = !!event.competitionOrderLocked;
  const editable = !locked || isAdmin;

  const levelRegs = clubRegs.filter((r) => r.levelId === level.id);
  const apparatusCodes = new Set(levelRegs.flatMap((r) => r.apparatus));
  const orderedCodes = APPARATUS[level.discipline]
    .map((a) => a.code)
    .filter((c) => apparatusCodes.has(c));

  const nameOf = (regId: string): string => {
    const reg = eventRegs.find((r) => r.id === regId);
    const p = reg ? db.people.find((x) => x.id === reg.athleteId) : undefined;
    return p ? `${p.firstName} ${p.lastName}` : 'Unknown athlete';
  };

  return (
    <div className="card card-pad" style={{ marginBottom: 18 }}>
      <h3 className="card-title">Set competition order</h3>
      {locked && (
        <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--ink-soft)' }}>
          {isAdmin
            ? 'Competition orders are locked for club managers — as an admin you can still edit.'
            : 'Competition orders are locked for this event. Contact a league admin for changes.'}
        </p>
      )}
      <div style={{ maxWidth: 320, marginBottom: 14 }}>
        <Field label="Level">
          <select
            className="input"
            value={level.id}
            onChange={(e) => setLevelId(e.target.value)}
          >
            {levels.map((l) => (
              <option key={l.id} value={l.id}>{l.discipline} — {l.name}</option>
            ))}
          </select>
        </Field>
      </div>

      {orderedCodes.length === 0 ? (
        <p style={{ fontSize: 13, color: 'var(--ink-soft)' }}>No apparatus entries yet at this level.</p>
      ) : (
        <div style={{ overflowX: 'auto', paddingBottom: 4 }}>
          <div style={{ display: 'flex', gap: 16, minWidth: 'min-content' }}>
            {orderedCodes.map((code) => (
              <ApparatusColumn
                key={`${level.id}-${code}`}
                event={event}
                clubId={clubId}
                level={level}
                apparatus={code}
                eligibleRegIds={levelRegs.filter((r) => r.apparatus.includes(code)).map((r) => r.id)}
                nameOf={nameOf}
                editable={editable}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const containerId = (apparatus: string, index: number) => `co-sec-${apparatus}-${index}`;

const apparatusName = (level: Level, code: string): string =>
  APPARATUS[level.discipline].find((a) => a.code === code)?.name ?? code;

function ApparatusColumn({
  event, clubId, level, apparatus, eligibleRegIds, nameOf, editable,
}: {
  event: Event;
  clubId: string;
  level: Level;
  apparatus: string;
  eligibleRegIds: string[];
  nameOf: (regId: string) => string;
  editable: boolean;
}) {
  const db = useDB();
  const cap = sectionCap(level.discipline as 'WAG' | 'MAG');
  const existing = (db.competitionOrders ?? []).find(
    (o) => o.eventId === event.id && o.clubId === clubId && o.levelId === level.id && o.apparatus === apparatus,
  );
  const sections = reconcileSections(existing?.sections, eligibleRegIds, cap);
  const valid = sectionsValid(sections, cap);
  const [activeId, setActiveId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const persist = (next: string[][]) => {
    const row: CompetitionOrder = {
      id: existing?.id ?? crypto.randomUUID(),
      eventId: event.id,
      clubId,
      levelId: level.id,
      apparatus,
      sections: next,
      updatedAt: new Date().toISOString(),
    };
    mutate((d) => {
      const list = d.competitionOrders ?? (d.competitionOrders = []);
      const idx = list.findIndex((o) => o.id === row.id);
      if (idx >= 0) list[idx] = row; else list.push(row);
      pushCompetitionOrder(row);
    });
  };

  const findSectionIndex = (id: string): number => {
    const asContainer = sections.findIndex((_, i) => containerId(apparatus, i) === id);
    if (asContainer >= 0) return asContainer;
    return sections.findIndex((sec) => sec.includes(id));
  };

  const onDragStart = (evt: DragStartEvent) => setActiveId(String(evt.active.id));

  const onDragEnd = (evt: DragEndEvent) => {
    setActiveId(null);
    if (!editable) return;
    const { active, over } = evt;
    if (!over) return;
    const regId = String(active.id);
    const overId = String(over.id);
    if (overId === regId) return;

    const toSection = findSectionIndex(overId);
    if (toSection < 0) return;

    const overIsContainer = containerId(apparatus, toSection) === overId;
    const toIndex = computeDropIndex(sections, regId, toSection, overId, overIsContainer);

    persist(moveInSections(sections, regId, toSection, toIndex));
  };

  const addSection = () => persist([...sections, []]);

  const removeSection = (idx: number) => {
    if (sections.length <= 1) return;
    const next = sections.slice();
    const [removed] = next.splice(idx, 1);
    const mergeInto = Math.min(idx, next.length - 1);
    next[mergeInto] = [...next[mergeInto], ...removed];
    persist(next);
  };

  const autoSplit = () => persist(splitIntoSections(flattenSections(sections), cap));

  return (
    <div className="card card-pad" style={{ minWidth: 230, flex: '0 0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8, gap: 8 }}>
        <h4 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>{apparatusName(level, apparatus)}</h4>
        {!valid && <Badge tone="warn">Over cap</Badge>}
      </div>

      {editable && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
          <button className="btn small ghost" onClick={autoSplit}>Auto-split evenly</button>
          <button className="btn small ghost" onClick={addSection}>+ Add section</button>
        </div>
      )}

      {editable ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onDragCancel={() => setActiveId(null)}
        >
          {sections.map((sec, i) => (
            <SectionBlock
              key={containerId(apparatus, i)}
              id={containerId(apparatus, i)}
              index={i}
              regIds={sec}
              cap={cap}
              nameOf={nameOf}
              removable={sections.length > 1}
              onRemove={() => removeSection(i)}
            />
          ))}
          <DragOverlay>
            {activeId ? <Chip name={nameOf(activeId)} dragging /> : null}
          </DragOverlay>
        </DndContext>
      ) : (
        sections.map((sec, i) => (
          <StaticSectionBlock key={containerId(apparatus, i)} index={i} regIds={sec} cap={cap} nameOf={nameOf} />
        ))
      )}
    </div>
  );
}

function SectionBlock({
  id, index, regIds, cap, nameOf, removable, onRemove,
}: {
  id: string;
  index: number;
  regIds: string[];
  cap: number;
  nameOf: (regId: string) => string;
  removable: boolean;
  onRemove: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  const over = regIds.length > cap;
  return (
    <div
      ref={setNodeRef}
      style={{
        border: `1px dashed ${isOver ? 'var(--navy-600)' : 'var(--line)'}`,
        borderRadius: 8,
        padding: 8,
        marginBottom: 10,
        background: isOver ? 'var(--ice-100)' : 'transparent',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, gap: 6 }}>
        <span style={{
          fontSize: 11.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em',
          color: over ? 'var(--coral-700)' : 'var(--ink-soft)',
        }}
        >
          Section {index + 1} — {regIds.length}/{cap}
        </span>
        {removable && (
          <button className="btn small ghost" style={{ padding: '1px 8px' }} onClick={onRemove}>Remove</button>
        )}
      </div>
      <SortableContext id={id} items={regIds} strategy={verticalListSortingStrategy}>
        {regIds.length === 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--ink-soft)', padding: '10px 0', textAlign: 'center' }}>Drop athletes here</div>
        ) : (
          regIds.map((regId) => <SortableChip key={regId} id={regId} name={nameOf(regId)} />)
        )}
      </SortableContext>
    </div>
  );
}

function StaticSectionBlock({
  index, regIds, cap, nameOf,
}: {
  index: number;
  regIds: string[];
  cap: number;
  nameOf: (regId: string) => string;
}) {
  const over = regIds.length > cap;
  return (
    <div style={{ border: '1px dashed var(--line)', borderRadius: 8, padding: 8, marginBottom: 10 }}>
      <div style={{
        fontSize: 11.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6,
        color: over ? 'var(--coral-700)' : 'var(--ink-soft)',
      }}
      >
        Section {index + 1} — {regIds.length}/{cap}
      </div>
      {regIds.length === 0 ? (
        <div style={{ fontSize: 12.5, color: 'var(--ink-soft)', padding: '10px 0', textAlign: 'center' }}>No athletes</div>
      ) : (
        regIds.map((regId) => <Chip key={regId} name={nameOf(regId)} />)
      )}
    </div>
  );
}

function SortableChip({ id, name }: { id: string; name: string }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: transition ?? undefined,
    opacity: isDragging ? 0.4 : 1,
  };
  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <Chip name={name} />
    </div>
  );
}

/** Athlete chip — used both inside the sortable list and inside `DragOverlay`
 *  (which renders a plain, non-sortable copy that follows the cursor). Fill
 *  is `--ice-100` (pale) with `--ink` text — resolves to a light neutral in
 *  both themes with `--ink` already the app's default body-text token, so
 *  contrast holds without a bespoke pairing. */
function Chip({ name, dragging }: { name: string; dragging?: boolean }) {
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
        cursor: dragging ? 'grabbing' : 'grab',
        touchAction: 'none',
        boxShadow: dragging ? 'var(--shadow)' : 'none',
      }}
    >
      <span aria-hidden style={{ color: 'var(--ink-soft)' }}>⠿</span>
      {name}
    </div>
  );
}
