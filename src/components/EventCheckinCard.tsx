import { useState } from 'react';
import { useDB, mutate } from '../lib/store';
import { useCapabilities } from '../lib/capabilities';
import { pushEventCheckin, confirmEventCheckin } from '../lib/supabase';
import { checkinAthleteCount } from '../lib/pricing';
import { Modal, Field, Badge } from './ui';
import type { EventCheckin } from '../lib/types';

/** Exactly one of `clubId`/`personId` — mirrors `EventCheckin`'s own dual
 *  scoping (club variant vs. independent-athlete variant). */
export type EventCheckinScope = { clubId: string; personId?: undefined } | { clubId?: undefined; personId: string };

/**
 * Nationals check-in card (event-mgmt v2 Phase 5 E1, spec §L.4): shows the
 * scope's athlete/gift count, and — once a league/meet admin has OPENED
 * check-in for this scope — lets the club manager (or the independent
 * athlete themself) confirm with a checkbox + typed signature, behind an
 * "are you sure" popup. Renders nothing meaningful (just the not-yet-opened
 * note) until an admin opens it; a `db.eventCheckins` row for this
 * (eventId, scope) is the only signal that's happened.
 *
 * Reads `db.*` directly on every render (never destructures/caches a nested
 * path) — `mutate()` mutates the shared store object in place, so a stale
 * local copy would never see a later push (the in-place-mutation trap,
 * CLAUDE.md).
 */
export function EventCheckinCard({ eventId, scope }: { eventId: string; scope: EventCheckinScope }) {
  const db = useDB();
  const caps = useCapabilities();

  const regs = db.registrations.filter((r) => {
    if (r.eventId !== eventId || r.refunded || r.waitlisted) return false;
    return scope.clubId ? r.clubId === scope.clubId : r.athleteId === scope.personId;
  });
  const athleteCount = checkinAthleteCount(regs);

  const row = (db.eventCheckins ?? []).find((c) => {
    if (c.eventId !== eventId) return false;
    return scope.clubId ? c.clubId === scope.clubId : c.personId === scope.personId;
  });

  const isClub = !!scope.clubId;

  return (
    <div className="card card-pad" style={{ marginBottom: 18 }}>
      <h3 className="card-title">Check-in</h3>
      <p style={{ margin: '0 0 12px', fontSize: 14 }}>
        Athlete gift count: <strong>{athleteCount}</strong>
      </p>

      {!row && (
        <p style={{ margin: 0, fontSize: 13, color: 'var(--ink-soft)' }}>
          Check-in has not been opened yet by the event admins.
        </p>
      )}

      {row && row.status === 'open' && (
        <CheckinOpenForm row={row} isClub={isClub} myPersonId={caps.personId ?? null} />
      )}

      {row && row.status === 'checked-in' && (
        <div>
          <Badge tone="ok">{isClub ? 'Your club is checked in' : 'You are checked in'}</Badge>
          <p style={{ margin: '8px 0 0', fontSize: 13, color: 'var(--ink-soft)' }}>
            Signed by {row.signedName}
            {row.checkedInAt ? ` on ${new Date(row.checkedInAt).toLocaleString()}` : ''}
          </p>
        </div>
      )}
    </div>
  );
}

// Kept at module scope (not nested in EventCheckinCard's render) so the
// checkbox/name-input draft state doesn't get recreated on every parent
// re-render. Owns the checkbox+signature draft AND the confirm-dialog open
// flag — the dialog reuses this same draft rather than re-collecting it, so
// the user never has to retype their name.
function CheckinOpenForm({ row, isClub, myPersonId }: {
  row: EventCheckin;
  isClub: boolean;
  myPersonId: string | null;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [name, setName] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const canSubmit = confirmed && name.trim().length > 0 && !!myPersonId;

  const submit = () => {
    if (!canSubmit || !myPersonId) return;
    const checkedInAt = new Date().toISOString();
    const signedName = name.trim();
    const applied = mutate((d) => {
      const list = d.eventCheckins ?? (d.eventCheckins = []);
      const idx = list.findIndex((c) => c.id === row.id);
      const updated: EventCheckin = { ...row, status: 'checked-in', signedName, checkedInAt, checkedInBy: myPersonId };
      if (idx >= 0) list[idx] = updated; else list.push(updated);
    });
    if (!applied) return; // offline read-only gate — don't push or claim success
    confirmEventCheckin(row.id, { status: 'checked-in', signedName, checkedInAt, checkedInBy: myPersonId });
    setDialogOpen(false);
  };

  return (
    <div>
      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13.5, marginBottom: 10 }}>
        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} style={{ marginTop: 2 }} />
        <span>I confirm all information is correct and I counted all items.</span>
      </label>
      <Field label="Signature (type your full name)" required>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" />
      </Field>
      <button
        className="btn primary small"
        style={{ marginTop: 10 }}
        disabled={!canSubmit}
        onClick={() => setDialogOpen(true)}
      >
        Check in
      </button>
      {!myPersonId && (
        <p style={{ margin: '8px 0 0', fontSize: 12, color: 'var(--warn-600, #b45309)' }}>
          Sign in to check {isClub ? 'your club' : 'yourself'} in.
        </p>
      )}

      {dialogOpen && (
        <Modal title="Confirm check-in" onClose={() => setDialogOpen(false)}>
          <div
            className="card card-pad"
            style={{ borderLeft: '4px solid var(--coral-500)', marginBottom: 14, fontSize: 13, lineHeight: 1.5 }}
          >
            <strong>Are you sure?</strong> Once you check in, you can't claim missing items later.
          </div>
          <p style={{ fontSize: 13, margin: '0 0 14px' }}>
            Signing as <strong>{name.trim()}</strong> {isClub ? 'for your club' : 'for yourself'}.
          </p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn ghost" onClick={() => setDialogOpen(false)}>Cancel</button>
            <button className="btn primary" onClick={submit} disabled={!canSubmit}>
              {isClub ? 'Check my club in' : 'Check myself in'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/**
 * Admin card (spec §L.4): lists every club/independent athlete registered
 * for the event with their check-in status, an "Open check-in" button per
 * row, and a view-as selector rendering the full `EventCheckinCard` for the
 * chosen scope (mirrors `NationalsAdminViewCard`'s pattern in Events.tsx).
 */
export function EventCheckinAdminCard({ eventId }: { eventId: string }) {
  const db = useDB();
  const caps = useCapabilities();
  const regs = db.registrations.filter((r) => r.eventId === eventId && !r.refunded && !r.waitlisted);

  const clubOptions = [...new Set(regs.map((r) => r.clubId))]
    .map((clubId) => db.clubs.find((c) => c.id === clubId))
    .filter((c): c is NonNullable<typeof c> => !!c)
    .sort((a, b) => a.name.localeCompare(b.name));

  const independentOptions = [...new Set(
    regs.filter((r) => db.people.find((p) => p.id === r.athleteId)?.mainClubId === null).map((r) => r.athleteId),
  )]
    .map((athleteId) => db.people.find((p) => p.id === athleteId))
    .filter((p): p is NonNullable<typeof p> => !!p)
    .sort((a, b) => `${a.firstName} ${a.lastName}`.localeCompare(`${b.firstName} ${b.lastName}`));

  type ScopeRow = { key: string; label: string; scope: EventCheckinScope };
  const rows: ScopeRow[] = [
    ...clubOptions.map((c): ScopeRow => ({ key: `club:${c.id}`, label: `${c.name} (club)`, scope: { clubId: c.id } })),
    ...independentOptions.map((p): ScopeRow => ({ key: `person:${p.id}`, label: `${p.firstName} ${p.lastName} (independent)`, scope: { personId: p.id } })),
  ];

  const [selected, setSelected] = useState<string>('');
  const selectedRow = rows.find((r) => r.key === selected);

  const findExisting = (scope: EventCheckinScope) => (db.eventCheckins ?? []).find((c) => {
    if (c.eventId !== eventId) return false;
    return scope.clubId ? c.clubId === scope.clubId : c.personId === scope.personId;
  });

  const openCheckin = (scope: EventCheckinScope) => {
    if (!caps.personId) return;
    if (findExisting(scope)) return; // already opened (or further along) — nothing to do
    const row: EventCheckin = {
      id: crypto.randomUUID(),
      eventId,
      clubId: scope.clubId ?? null,
      personId: scope.personId ?? null,
      status: 'open',
      openedBy: caps.personId,
    };
    const applied = mutate((d) => {
      const list = d.eventCheckins ?? (d.eventCheckins = []);
      list.push(row);
    });
    if (!applied) return; // offline read-only gate — don't push a row local state lacks
    pushEventCheckin(row);
  };

  const explainer = (
    <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--ink-soft)' }}>
      On-site check-in for Nationals: "Open check-in" lets a club (or independent athlete) complete their
      check-in from their own account; the selector below previews a specific club's check-in screen.
    </p>
  );

  if (rows.length === 0) {
    return (
      <div className="card card-pad" style={{ marginBottom: 18 }}>
        <h3 className="card-title">Check-in — open &amp; view as</h3>
        {explainer}
        <p style={{ margin: 0, fontSize: 13, color: 'var(--ink-soft)' }}>No registrations yet for this event.</p>
      </div>
    );
  }

  return (
    <div style={{ marginBottom: 18 }}>
      <div className="card card-pad" style={{ marginBottom: 18, overflowX: 'auto' }}>
        <h3 className="card-title">Check-in — open &amp; view as</h3>
        {explainer}
        <table className="tbl">
          <thead><tr><th>Club / athlete</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {rows.map((r) => {
              const existing = findExisting(r.scope);
              return (
                <tr key={r.key}>
                  <td>{r.label}</td>
                  <td>
                    {!existing && <Badge tone="warn">Not opened</Badge>}
                    {existing?.status === 'open' && <Badge tone="info">Open</Badge>}
                    {existing?.status === 'checked-in' && <Badge tone="ok">Checked in</Badge>}
                  </td>
                  <td>
                    {!existing && (
                      <button className="btn small ghost" onClick={() => openCheckin(r.scope)}>Open check-in</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <div style={{ maxWidth: 360, marginTop: 14 }}>
          <Field label="Preview as">
            <select className="input" value={selected} onChange={(e) => setSelected(e.target.value)}>
              <option value="">Choose…</option>
              {rows.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
            </select>
          </Field>
        </div>
      </div>
      {selectedRow && <EventCheckinCard eventId={eventId} scope={selectedRow.scope} />}
    </div>
  );
}
