import { useEffect, useMemo, useState } from 'react';
import { useDB } from '../lib/store';
import { Badge, Modal } from './ui';
import { fetchEventWaitlist, type WaitlistQueueRow } from '../lib/supabase';
import {
  disciplineProgress,
  sessionProgress,
  DISCIPLINE_LABELS,
  type DisciplineProgressRow,
  type SessionProgressRow,
} from '../lib/capacity-progress';
import type { Discipline, Event, Registration, WaitlistGroup } from '../lib/types';

// ---------------------------------------------------------------------------
// CapacityProgressCard — host/admin capacity progress summary (capacity
// rework, 2026-08-24 — T3). Rendered on the event page for anyone with
// host-level access (same `canManage` gate as WaitlistCard — see Events.tsx),
// for competitions only, only when the event actually has some capacity
// config (`hasCapacityConfig` — the Events.tsx call site gates on this so
// this component never has to render an empty/confusing card).
//
// Two independent views (by-discipline vs by-session — an event is only ever
// in one mode), math extracted into the pure src/lib/capacity-progress.ts.
//
// Waitlist visibility: like WaitlistCard, this reads the waitlist queue via
// `fetchEventWaitlist` (the manage-waitlist edge function's 'list' action)
// rather than a raw `db.waitlistGroups` read — that table's RLS only exposes
// a group to its OWN club/person (plus admins), so a host-club-manager
// viewer's `db.waitlistGroups` is missing every OTHER club's groups. Using
// the same RLS-safe source WaitlistCard uses keeps the held-routines math and
// the per-session waitlist counts correct for a host, not just an admin.
// ---------------------------------------------------------------------------

function queueRowToWaitlistGroup(g: WaitlistQueueRow, eventId: string): WaitlistGroup {
  return {
    id: g.id,
    eventId,
    clubId: g.clubId,
    personId: g.personId,
    discipline: g.discipline as Discipline,
    levelId: g.levelId,
    sessionId: g.sessionId,
    status: g.status,
    queuedAt: g.queuedAt,
    notifiedAt: g.notifiedAt,
    holdExpiresAt: g.holdExpiresAt,
  };
}

function ProgressBar({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(100, pct));
  const over = pct >= 100;
  return (
    <div style={{ height: 10, borderRadius: 999, background: 'var(--sunk)', overflow: 'hidden' }}>
      <div
        style={{
          height: '100%',
          width: `${clamped}%`,
          background: over ? 'var(--coral-600)' : 'var(--navy-800)',
          borderRadius: 999,
        }}
      />
    </div>
  );
}

function DisciplineRow({ row }: { row: DisciplineProgressRow }) {
  const pct = row.worstCaseTotalAthletes > 0 ? (row.paidAthletes / row.worstCaseTotalAthletes) * 100 : 0;
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{
        display: 'flex', justifyContent: row.levelId ? 'space-between' : 'flex-end',
        alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 4,
      }}
      >
        {row.levelId && <span style={{ fontSize: 13.5, fontWeight: 600 }}>{row.label}</span>}
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)', fontVariantNumeric: 'tabular-nums' }}>
          {row.paidAthletes} of {row.worstCaseTotalAthletes} athletes
        </span>
      </div>
      <ProgressBar pct={pct} />
      <div style={{ fontSize: 12, color: 'var(--ink-soft)', marginTop: 3 }}>
        {row.paidRoutines} of {row.capRoutines} routines used
        {row.heldRoutines > 0 ? ` (+${row.heldRoutines} in carts/holds)` : ''}
      </div>
    </div>
  );
}

function SessionRow({ row, waitingCount, onOpen }: {
  row: SessionProgressRow; waitingCount: number; onOpen: () => void;
}) {
  const availablePct = Math.max(0, 100 - row.pctUsed);
  return (
    <button
      type="button"
      onClick={onOpen}
      style={{
        display: 'block', width: '100%', textAlign: 'left', font: 'inherit', color: 'inherit',
        background: 'none', border: 'none', borderTop: '1px solid var(--line)', padding: '10px 0 12px', cursor: 'pointer',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
        <span style={{ fontSize: 13.5, fontWeight: 600 }}>{row.label}</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)', fontVariantNumeric: 'tabular-nums' }}>
            {availablePct}% of routines available
          </span>
          {waitingCount > 0 && <Badge tone="warn">Waitlist {waitingCount}</Badge>}
        </span>
      </div>
      <ProgressBar pct={row.pctUsed} />
      <div style={{ fontSize: 12, color: 'var(--ink-soft)', marginTop: 3 }}>
        {row.routinesLeft} routines left of {row.totalCap} · includes carts/holds
      </div>
    </button>
  );
}

export function CapacityProgressCard({ event, regs }: {
  event: Event;
  regs: Registration[];
}) {
  const db = useDB();
  const [queue, setQueue] = useState<WaitlistQueueRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [openSessionId, setOpenSessionId] = useState<string | null>(null);
  // Snapshot once per mount via the lazy-initializer idiom (Cart.tsx's
  // HoldCountdown / Finance.tsx use the same pattern) rather than calling
  // Date.now() directly in the render body — react-hooks' purity rule flags
  // that as an impure render. No live ticking needed here (unlike
  // HoldCountdown): this is a summary card, not a live countdown.
  const [now] = useState(() => Date.now());

  useEffect(() => {
    let live = true;
    void fetchEventWaitlist(event.id).then((res) => {
      if (!live) return;
      if (!res.ok) {
        setLoadError(res.error ?? 'Could not load hold/waitlist data — routine totals below may undercount carts and holds.');
        setQueue([]);
        return;
      }
      setLoadError(null);
      setQueue(res.groups ?? []);
    }).catch(() => {
      if (!live) return;
      setLoadError('Could not load hold/waitlist data — routine totals below may undercount carts and holds.');
      setQueue([]);
    });
    return () => { live = false; };
  }, [event.id]);

  const groupsById = useMemo<Record<string, WaitlistGroup>>(
    () => Object.fromEntries((queue ?? []).map((g) => [g.id, queueRowToWaitlistGroup(g, event.id)])),
    [queue, event.id],
  );

  const isBySession = (event.registrationMode ?? 'by-discipline') === 'by-session';
  const discRows = isBySession ? [] : disciplineProgress(event, regs, db.levels, groupsById, now);
  const sessRows = isBySession ? sessionProgress(event, event.sessions, regs, groupsById, now) : [];

  const waitingCountFor = (sessionId: string) =>
    (queue ?? []).filter((g) => g.status === 'waiting' && g.sessionId === sessionId).length;

  const openSession = sessRows.find((r) => r.sessionId === openSessionId) ?? null;

  if (discRows.length === 0 && sessRows.length === 0) return null;

  // Group discipline-mode rows for rendering: one block per discipline. A
  // 'discipline'-mode discipline contributes exactly one row (no levelId); a
  // 'perLevel'-mode discipline contributes one row per capped level, all
  // sharing that discipline.
  const byDiscipline = new Map<Discipline, DisciplineProgressRow[]>();
  for (const row of discRows) {
    const list = byDiscipline.get(row.discipline);
    if (list) list.push(row); else byDiscipline.set(row.discipline, [row]);
  }

  return (
    <div className="card card-pad" style={{ marginBottom: 18 }}>
      <h3 className="card-title">Capacity</h3>
      {loadError && (
        <p style={{ margin: '0 0 10px', fontSize: 12.5, color: 'var(--coral-700)' }}>{loadError}</p>
      )}
      {!isBySession && (
        <>
          <p style={{ margin: '0 0 14px', fontSize: 12.5, color: 'var(--ink-soft)' }}>
            Registered counts paid athletes only. Totals assume every remaining registrant
            competes all-around, so the denominator shifts with the mix.
          </p>
          {Array.from(byDiscipline.entries()).map(([discipline, rows]) => (
            <div key={discipline} style={{ marginBottom: 16 }}>
              <div className="crumb" style={{ marginBottom: 6 }}>{DISCIPLINE_LABELS[discipline]}</div>
              {rows.map((row) => <DisciplineRow key={row.key} row={row} />)}
            </div>
          ))}
        </>
      )}
      {isBySession && sessRows.length > 0 && (
        <div>
          {sessRows.map((row) => (
            <SessionRow
              key={row.sessionId}
              row={row}
              waitingCount={waitingCountFor(row.sessionId)}
              onOpen={() => setOpenSessionId(row.sessionId)}
            />
          ))}
        </div>
      )}
      {openSession && (
        <Modal title={openSession.label} onClose={() => setOpenSessionId(null)}>
          <div style={{ overflowX: 'auto' }}>
            <table className="tbl">
              <thead>
                <tr><th>Apparatus</th><th className="num">Cap</th><th className="num">Used</th><th className="num">Left</th></tr>
              </thead>
              <tbody>
                {openSession.apparatusRows.map((a) => (
                  <tr key={a.apparatus}>
                    <td>{a.apparatus}</td>
                    <td className="num">{a.cap}</td>
                    <td className="num">{a.used}</td>
                    <td className="num" style={{ fontWeight: 700, color: a.left > 0 ? 'var(--ink)' : 'var(--coral-700)' }}>{a.left}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', marginTop: 12 }}>
            {(() => {
              const waiting = waitingCountFor(openSession.sessionId);
              return waiting > 0
                ? `Waitlist: ${waiting} group${waiting > 1 ? 's' : ''} waiting — includes carts/holds above.`
                : 'No one is currently waitlisted for this session.';
            })()}
          </p>
        </Modal>
      )}
    </div>
  );
}
