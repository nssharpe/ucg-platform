import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useDB, mutate } from '../lib/store';
import { useCapabilities } from '../lib/capabilities';
import { seasonForDate, clubHasActiveMembership, paidRegistrationClub } from '../lib/capabilities-core';
import { eventIsInPhase } from '../lib/events-core';
import { Badge, Field, Modal, Tabs } from '../components/ui';
import { useToast, useFmtDate } from '../components/ui-hooks';
import { EventWizard } from '../components/EventWizard';
import { RegistrationEditor } from '../components/RegistrationEditor';
import { EventStatusBadge } from './Home';
import { APPARATUS, SHIRT_SIZES } from '../lib/types';
import type { Athlete, CartItem, Discipline, Event, EventAdmin, EventSession, Registration } from '../lib/types';
import { DisciplineIcon } from '../components/DisciplineIcon';
import { deleteRegistration, grantEventAdmin, insuranceCertificateUrl, listSanctioningTeam, pushCart, pushEvent, pushEventSessions, pushRegistration, revokeEventAdmin, syncSynchroPartnerLevelRemote, uploadInsuranceCertificate } from '../lib/supabase';
import type { SanctioningTeamMember } from '../lib/supabase';
import { stateCode } from '../lib/sanction';
import { fmtMoney } from '../lib/scoring';
import { newRegistrationEntryTotal, registrationChangeFee, syncSynchroPartnerLevel, findIncomingSynchroPartner, lateFeeApplies, lateFeeAnchor } from '../lib/pricing';
import { OWNER_TASKS, ownerTaskDueDate } from '../../supabase/functions/_shared/owner-checklist';
import type { OwnerChecklist, OwnerChecklistEntry, OwnerTaskId } from '../../supabase/functions/_shared/owner-checklist';

const today = () => new Date().toISOString().slice(0, 10);

/** Registration state for an event from its open/close timestamps (vs now):
 *  `regOpen` = now within [opens, closes]; `regClosed` = now past closes. */
function regState(regOpens: string, regCloses: string): { regOpen: boolean; regClosed: boolean } {
  const now = Date.now();
  const regClosed = now > new Date(regCloses).getTime();
  return { regClosed, regOpen: !regClosed && now >= new Date(regOpens).getTime() };
}

// Sortable columns of the Events table. Each maps to a comparable underlying value.
type SortKey = 'name' | 'location' | 'date' | 'disciplines' | 'regOpens' | 'regCloses';

// Pure comparator: returns the underlying value (lowercased for text) for a column.
function sortValue(ev: Event, key: SortKey): string {
  switch (key) {
    case 'name': return ev.name.toLowerCase();
    case 'location': return `${ev.city}, ${ev.state}`.toLowerCase();
    case 'date': return ev.startDate; // ISO yyyy-mm-dd sorts lexicographically
    case 'disciplines': return ev.disciplines.join(' · ').toLowerCase();
    case 'regOpens': return ev.regOpens.slice(0, 10);
    case 'regCloses': return ev.regCloses.slice(0, 10);
  }
}

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: 'name', label: 'Event Name' },
  { key: 'location', label: 'Location' },
  { key: 'date', label: 'Date(s)' },
  { key: 'disciplines', label: 'Disciplines' },
  { key: 'regOpens', label: 'Reg Opens' },
  { key: 'regCloses', label: 'Reg Closes' },
];

/** Events list (MY UCG / public): all UCG-hosted & sanctioned events, split into
 *  Upcoming / Past (on `endDate >= today`), searchable by name/location/disciplines,
 *  and shown as a sortable, horizontally-scrollable table. Modeled on
 *  MyRegistrations.tsx. Admins can sanction a new event via the wizard. */
export function Events() {
  const db = useDB();
  const caps = useCapabilities();
  const fmtDate = useFmtDate();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [tab, setTab] = useState<'upcoming' | 'past'>('upcoming');
  const [q, setQ] = useState('');
  // Single sort state. `null` dir ⇒ apply the tab-appropriate default (date asc for
  // Upcoming, date desc for Past). A user click sets an explicit key + direction.
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const t = today();
  const lq = q.trim().toLowerCase();

  const inTab = db.events.filter((ev) => (tab === 'upcoming' ? ev.endDate >= t : ev.endDate < t));
  const matched = inTab.filter((ev) => {
    if (!lq) return true;
    const hay = `${ev.name} ${ev.city}, ${ev.state} ${ev.disciplines.join(' · ')}`.toLowerCase();
    return hay.includes(lq);
  });

  // Effective sort: explicit user choice, or the per-tab default (date, asc for
  // upcoming / desc for past).
  const effKey: SortKey = sortKey ?? 'date';
  const effDir: 'asc' | 'desc' = sortKey ? sortDir : (tab === 'upcoming' ? 'asc' : 'desc');
  const rows = [...matched].sort((a, b) => {
    const cmp = sortValue(a, effKey).localeCompare(sortValue(b, effKey));
    return effDir === 'asc' ? cmp : -cmp;
  });

  const onSort = (key: SortKey) => {
    if (effKey === key) {
      setSortKey(key);
      setSortDir(effDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const switchTab = (id: 'upcoming' | 'past') => {
    setTab(id);
    setSortKey(null); // re-apply the tab-appropriate default sort
  };

  return (
    <div>
      <h1 className="page-title display">Events</h1>
      <p className="page-sub">Current and Past UCG Hosted (Nationals, FlipFest, etc.) and UCG Sanctioned (Regular Season Meets) Events</p>
      {caps.isAdmin && (
        <button className="btn primary" style={{ marginBottom: 18 }} onClick={() => setWizardOpen(true)}>+ Sanction New Event</button>
      )}
      {wizardOpen && <EventWizard onClose={() => setWizardOpen(false)} />}

      <Tabs
        tabs={[{ id: 'upcoming' as const, label: 'Upcoming' }, { id: 'past' as const, label: 'Past' }]}
        active={tab}
        onChange={switchTab}
      />

      <input
        type="search" className="input" placeholder="Search by name, location, or discipline…"
        value={q} onChange={(e) => setQ(e.target.value)}
        style={{ maxWidth: 320, margin: '12px 0' }}
      />

      {rows.length === 0 ? (
        <p style={{ color: 'var(--ink-soft)' }}>No {tab} events.</p>
      ) : (
        <div className="card" style={{ overflow: 'hidden' }}>
          <div className="events-table-wrap">
            <table className="tbl events-table">
              <thead>
                <tr>
                  {COLUMNS.map((c) => (
                    <th
                      key={c.key}
                      onClick={() => onSort(c.key)}
                      style={{ cursor: 'pointer', userSelect: 'none', color: 'var(--ink)' }}
                    >
                      {c.label}
                      {effKey === c.key && <span style={{ marginLeft: 4 }}>{effDir === 'asc' ? '▲' : '▼'}</span>}
                    </th>
                  ))}
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((ev) => {
                  const dates = ev.startDate === ev.endDate
                    ? fmtDate(ev.startDate)
                    : `${fmtDate(ev.startDate)}–${fmtDate(ev.endDate)}`;
                  // Registration state drives the date-cell highlighting:
                  //  • open   → Reg Opens date highlighted green (badge ok)
                  //  • closed → Reg Closes date highlighted coral (badge err)
                  const { regOpen, regClosed } = regState(ev.regOpens, ev.regCloses);
                  return (
                    <tr key={ev.id}>
                      <td data-label="Event">
                        <Link to={`/events/${ev.slug}`}>{ev.name}</Link>
                      </td>
                      <td data-label="Location" style={{ whiteSpace: 'nowrap' }}>{ev.city}, {stateCode(ev.state)}</td>
                      <td data-label="Date(s)" style={{ whiteSpace: 'nowrap' }}>{dates}</td>
                      <td data-label="Disciplines" style={{ color: 'var(--ink-soft)' }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          {(ev.disciplines as Discipline[]).map((d, i) => (
                            <span key={d} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                              {i > 0 && <span style={{ color: 'var(--line)' }}>·</span>}
                              <DisciplineIcon discipline={d} size={14} />
                              {d}
                            </span>
                          ))}
                        </span>
                      </td>
                      <td data-label="Reg Opens" style={{ whiteSpace: 'nowrap' }}>
                        {regOpen
                          ? <span className="badge ok">{fmtDate(ev.regOpens.slice(0, 10))}</span>
                          : <span style={{ color: 'var(--ink-soft)' }}>{fmtDate(ev.regOpens.slice(0, 10))}</span>}
                      </td>
                      <td data-label="Reg Closes" style={{ whiteSpace: 'nowrap' }}>
                        {regClosed
                          ? <span className="badge err">{fmtDate(ev.regCloses.slice(0, 10))}</span>
                          : <span style={{ color: 'var(--ink-soft)' }}>{fmtDate(ev.regCloses.slice(0, 10))}</span>}
                      </td>
                      <td data-label=""><Link className="btn small" to={`/events/${ev.slug}`}>Details</Link></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Timezone abbreviation helper
// ---------------------------------------------------------------------------
function tzAbbrev(timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'short' })
      .formatToParts(new Date());
    return parts.find((p) => p.type === 'timeZoneName')?.value ?? timezone;
  } catch {
    return timezone;
  }
}

// ---------------------------------------------------------------------------
// EventDetail
// ---------------------------------------------------------------------------
export function EventDetail() {
  const { slug } = useParams();
  const db = useDB();
  const caps = useCapabilities();
  const toast = useToast();
  const fmtDate = useFmtDate();
  const event = db.events.find((m) => m.slug === slug);
  const [editWizardOpen, setEditWizardOpen] = useState(false);
  const [selfRegOpen, setSelfRegOpen] = useState(false);

  if (!event) return <p>Event not found.</p>;
  const host = db.clubs.find((c) => c.id === event.hostClubId);
  const regs = db.registrations.filter((r) => r.eventId === event.id && !r.refunded);
  const canManage = caps.isEventHost(event.id);
  const tz = tzAbbrev(event.timezone);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 className="page-title display">{event.name}</h1>
          <p className="page-sub">
            {event.city}, {event.state} · {fmtDate(event.startDate)}–{fmtDate(event.endDate)} ({event.timezone}) ·
            hosted by {host?.name} · <code>#/events/{event.slug}</code>
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 6 }}>
            {(event.disciplines as Discipline[]).map((d) => (
              <span key={d} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 13, fontWeight: 700, color: 'var(--ink-soft)' }}>
                <DisciplineIcon discipline={d} size={20} />
                {d === 'TNT' ? 'T&T' : d}
              </span>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <EventStatusBadge event={event} />
          {canManage && (
            <button className="btn small ghost" onClick={() => setEditWizardOpen(true)}>Edit event</button>
          )}
        </div>
      </div>

      {editWizardOpen && <EventWizard editEvent={event} onClose={() => setEditWizardOpen(false)} />}

      {/* Event-owner assignment + task checklist (event-mgmt v2 §B3-4) — visible to
          the Sanctioning Team (not just the event's host manager) for competitions,
          which is what actually goes through the sanctioning workflow. */}
      {caps.isSanctioning && event.eventType !== 'camp' && (
        <>
          <OwnerAssignBlock event={event} toast={toast} />
          <OwnerChecklistCard event={event} fmtDate={fmtDate} toast={toast} />
        </>
      )}

      {/* Per-event admin grants (event-mgmt v2 §C) — visible to anyone with
          host-level access (host-club managers, league admins, and granted
          event admins themselves). */}
      {canManage && <EventAdminsCard event={event} toast={toast} />}

      <div className="grid cols-3" style={{ marginBottom: 18 }}>
        <div className="card card-pad">
          <h3 className="card-title">Registration</h3>
          <p style={{ margin: '0 0 8px', fontSize: 14 }}>
            Opens {fmtDate(event.regOpens.slice(0, 10))} · closes <strong>{fmtDate(event.regCloses.slice(0, 10))}</strong> ({tz})<br />
            {fmtMoney(event.entryFee)} / discipline · {fmtMoney(event.secondDisciplineFee)} each additional
            {event.banquet && <><br />{event.banquet.name}: {fmtMoney(event.banquet.price)}</>}
            {event.tshirtAddon && <><br />T-shirt: {fmtMoney(event.tshirtAddon.price)}</>}
            {event.bannerAddon && <><br />Club banner: {fmtMoney(event.bannerAddon.price)}</>}
            {event.changeFee && (
              <><br /><span style={{ color: 'var(--warn)' }}>Change fee {fmtMoney(event.changeFee.amount)} after {new Date(event.changeFee.startsAt).toLocaleDateString()}</span></>
            )}
          </p>
          {event.status === 'draft' ? (
            <Badge tone="info">Draft — not yet published</Badge>
          ) : eventIsInPhase(event, 'reg-open') ? (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {caps.managedClubIds.length > 0 && (
                <Link className="btn primary small" to={`/club/${caps.managedClubIds[0]}`}>Register your club →</Link>
              )}
              {caps.canRegister && (
                <button className="btn primary small" onClick={() => setSelfRegOpen(true)}>Register yourself →</button>
              )}
              {!caps.canRegister && caps.managedClubIds.length === 0 && (
                <Badge tone="warn">Registration open</Badge>
              )}
            </div>
          ) : (
            <Badge tone="warn">Registration closed{canManage ? ' — edit the event to adjust dates' : ''}</Badge>
          )}
          {canManage && event.status === 'live' && !eventIsInPhase(event, 'reg-open') && (
            <div style={{ marginTop: 10, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button className="btn small ghost" onClick={() => setEditWizardOpen(true)}>Edit event to adjust registration dates</button>
              <button className="btn small ghost" data-tip="Generates a private reg link + password for late adds" onClick={() => toast(`Private link: ucg.org/#/events/${event.slug}?code=LATE26 (demo)`)}>Private reg link</button>
            </div>
          )}
        </div>
        <div className="card card-pad">
          <h3 className="card-title">Field</h3>
          <div className="stat-big stat-accent">{regs.length}</div>
          <div className="stat-label">registrations · {[...new Set(regs.map((r) => r.athleteId))].length} athletes · {[...new Set(regs.map((r) => r.clubId))].length} clubs</div>
        </div>
        <div className="card card-pad">
          <h3 className="card-title">Quick links</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Link to={`/results/${event.slug}`}>→ Live results</Link>
            {canManage && event.kind === 'nationals' && (
              <Link to={`/events/${event.slug}/nationals`} style={{ fontWeight: 700 }}>→ Finals qualification &amp; awards</Link>
            )}
            {canManage && <Link to={`/events/${event.slug}/manage`}>→ Manage sessions & squads</Link>}
            {canManage && <Link to={`/judge?event=${event.id}`}>→ Score entry</Link>}
            {canManage && <a href="#" onClick={(e) => { e.preventDefault(); exportCsv(db, event); }}>→ Export registrations (CSV)</a>}
            {canManage && <a href="#" onClick={(e) => { e.preventDefault(); exportScoresCsv(db, event); }}>→ Export scores incl. calculator detail (CSV)</a>}
          </div>
        </div>
      </div>

      <div className="card" style={{ overflow: 'hidden' }}>
        <table className="tbl">
          <thead><tr><th>Session</th><th>Date</th><th>Levels</th><th className="num">Athletes</th><th className="num">Squads</th></tr></thead>
          <tbody>
            {event.sessions.map((s) => (
              <tr key={s.id}>
                <td><strong>{s.name}</strong></td>
                <td>{fmtDate(s.date)} {s.time}</td>
                <td style={{ fontSize: 13 }}>{s.levelIds.map((l) => db.levels.find((x) => x.id === l)?.name).join(', ')}</td>
                <td className="num">{regs.filter((r) => r.sessionId === s.id).length}</td>
                <td className="num">{s.squads.filter((q) => !q.holding).length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Self-registration modal */}
      {selfRegOpen && caps.personId && (() => {
        const athlete = db.people.find((p) => p.id === caps.personId);
        if (!athlete) return null;
        return (
          <SelfRegModal
            event={event}
            athlete={athlete}
            onClose={() => setSelfRegOpen(false)}
            toast={toast}
          />
        );
      })()}
    </div>
  );
}

// ---------------------------------------------------------------------------
// OwnerAssignBlock — event-owner assignment (event-mgmt v2 §B3)
// ---------------------------------------------------------------------------

function saveEventOwner(event: Event, owner: Event['owner']) {
  const updated: Event = { ...event, owner };
  mutate((d) => {
    const idx = d.events.findIndex((e) => e.id === event.id);
    if (idx >= 0) d.events[idx] = updated;
  });
  pushEvent(updated);
}

function OwnerAssignBlock({ event, toast }: { event: Event; toast: (msg: string, opts?: { variant?: 'info' | 'error' }) => void }) {
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [team, setTeam] = useState<SanctioningTeamMember[] | null>(null);
  const [selectedId, setSelectedId] = useState('');

  const openEditor = async () => {
    setEditing(true);
    setSelectedId(event.owner?.userId ?? '');
    if (team !== null) return;
    setLoading(true);
    const list = await listSanctioningTeam();
    setLoading(false);
    setTeam(list);
    if (list.length === 0) toast('Could not load the sanctioning team — try again.', { variant: 'error' });
  };

  const save = () => {
    const member = (team ?? []).find((m) => m.userId === selectedId);
    if (!member) return;
    saveEventOwner(event, { userId: member.userId, name: member.name, email: member.email });
    setEditing(false);
  };

  return (
    <div className="card card-pad" style={{ marginBottom: 18, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <strong>Event owner:</strong>
      {event.owner ? (
        <span>{event.owner.name} <span style={{ color: 'var(--ink-soft)' }}>({event.owner.email})</span></span>
      ) : (
        <Badge tone="err">Unassigned</Badge>
      )}
      {!editing ? (
        <button className="btn small ghost" onClick={openEditor}>{event.owner ? 'Reassign' : 'Assign owner'}</button>
      ) : (
        <>
          <select className="input" style={{ maxWidth: 280 }} value={selectedId} onChange={(e) => setSelectedId(e.target.value)} disabled={loading}>
            <option value="">{loading ? 'Loading team…' : 'Select a team member'}</option>
            {(team ?? []).map((m) => (
              <option key={m.userId} value={m.userId}>{m.name} ({m.email})</option>
            ))}
          </select>
          <button className="btn small primary" disabled={!selectedId} onClick={save}>Save</button>
          <button className="btn small ghost" onClick={() => setEditing(false)}>Cancel</button>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// EventAdminsCard — per-event admin grants (event-mgmt v2 §C)
// ---------------------------------------------------------------------------
// Hosts grant other ACCOUNTS host-level access to this ONE event. Writes go
// through the grant_event_admin/revoke_event_admin SECURITY DEFINER RPCs
// (exact-email account lookup server-side — deliberately no name search);
// this card only reflects the result into the local db.

function EventAdminsCard({ event, toast }: { event: Event; toast: (msg: string, opts?: { variant?: 'info' | 'error' }) => void }) {
  const db = useDB();
  const admins = (db.eventAdmins ?? []).filter((ea) => ea.eventId === event.id);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);

  const add = async () => {
    const addr = email.trim();
    if (!addr) return;
    setBusy(true);
    const res = await grantEventAdmin(event.id, addr);
    setBusy(false);
    if (!res.ok) { toast(res.error, { variant: 'error' }); return; }
    mutate((d) => {
      const list = d.eventAdmins ?? (d.eventAdmins = []);
      const existing = list.find((ea) => ea.eventId === event.id && ea.userId === res.userId);
      if (existing) { existing.email = res.email; existing.name = res.name; }
      // Local-only synthetic id — the server generated its own; the next full
      // sync replaces this row. Uniqueness per (event, user) matches the DB.
      else list.push({ id: `ea-${event.id}-${res.userId}`, eventId: event.id, userId: res.userId, email: res.email, name: res.name });
    });
    setEmail('');
    toast(`${res.name || res.email} can now manage this event.`);
  };

  const remove = async (ea: EventAdmin) => {
    const err = await revokeEventAdmin(event.id, ea.userId);
    if (err) { toast(err, { variant: 'error' }); return; }
    mutate((d) => {
      d.eventAdmins = (d.eventAdmins ?? []).filter((x) => !(x.eventId === event.id && x.userId === ea.userId));
    });
    toast(`Removed ${ea.name || ea.email} as an event admin.`);
  };

  return (
    <div className="card card-pad" style={{ marginBottom: 18 }}>
      <h3 className="card-title">Event admins</h3>
      <p style={{ margin: '0 0 10px', fontSize: 13, color: 'var(--ink-soft)' }}>
        Grant another account the same management access as the host — for this event only.
      </p>
      {admins.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
          {admins.map((ea) => (
            <div key={ea.id} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <strong>{ea.name || ea.email}</strong>
              {ea.name && <span style={{ color: 'var(--ink-soft)', fontSize: 13 }}>({ea.email})</span>}
              <button className="btn small ghost" aria-label={`Remove ${ea.name || ea.email}`} onClick={() => remove(ea)}>✕</button>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          type="email" className="input" style={{ maxWidth: 280 }} placeholder="Account email"
          value={email} onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
        />
        <button className="btn small primary" disabled={busy || !email.trim()} onClick={add}>
          {busy ? 'Adding…' : 'Add admin'}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// OwnerChecklistCard — event-owner task checklist (event-mgmt v2 §B4)
// ---------------------------------------------------------------------------

function OwnerChecklistCard({ event, fmtDate, toast }: { event: Event; fmtDate: (iso: string) => string; toast: (msg: string, opts?: { variant?: 'info' | 'error' }) => void }) {
  const checklist: OwnerChecklist = event.ownerChecklist ?? {};
  const [uploading, setUploading] = useState(false);

  const patchTask = (taskId: OwnerTaskId, patch: Partial<OwnerChecklistEntry>) => {
    const entry = { ...checklist[taskId], ...patch };
    const updated: Event = { ...event, ownerChecklist: { ...checklist, [taskId]: entry } };
    mutate((d) => {
      const idx = d.events.findIndex((e) => e.id === event.id);
      if (idx >= 0) d.events[idx] = updated;
    });
    pushEvent(updated);
  };

  const toggleDone = (taskId: OwnerTaskId) => {
    const entry = checklist[taskId];
    const done = !entry?.done;
    patchTask(taskId, { done, doneAt: done ? new Date().toISOString() : undefined });
  };

  return (
    <div className="card card-pad" style={{ marginBottom: 18 }}>
      <h3 className="card-title">Owner task checklist</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {OWNER_TASKS.map(({ id, label }) => {
          const entry = checklist[id];
          const due = ownerTaskDueDate(id, event, checklist);
          const overdue = !entry?.done && !!due && new Date(due).getTime() < new Date().getTime();
          return (
            <div key={id} style={{ paddingBottom: 12, borderBottom: '1px solid var(--line)' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', cursor: 'pointer' }}>
                <input type="checkbox" checked={!!entry?.done} onChange={() => toggleDone(id)} />
                <strong>{label}</strong>
                <span style={{ fontSize: 13, fontWeight: overdue ? 700 : 400, color: overdue ? 'var(--coral-700)' : 'var(--ink-soft)' }}>
                  {due ? `Due ${fmtDate(due.slice(0, 10))}` : 'No due date yet'}
                </span>
              </label>

              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8, marginLeft: 24 }}>
                {id === 'medalsOrdered' && (
                  <Field label="Ordered on">
                    <input type="date" className="input" value={entry?.orderedOn ?? ''} onChange={(e) => patchTask(id, { orderedOn: e.target.value })} />
                  </Field>
                )}
                {id === 'medalsTracking' && (
                  <>
                    <Field label="Tracking link">
                      <input type="text" className="input" value={entry?.trackingLink ?? ''} onChange={(e) => patchTask(id, { trackingLink: e.target.value })} placeholder="https://…" />
                    </Field>
                    <Field label="Host received?">
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <input type="checkbox" checked={!!entry?.hostReceived} onChange={(e) => patchTask(id, { hostReceived: e.target.checked })} /> Yes
                      </label>
                    </Field>
                  </>
                )}
                {id === 'insurance' && (
                  <Field label="Certificate file" hint="PDF, JPG, or PNG — up to 10MB.">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      <input
                        type="file" accept=".pdf,.jpg,.jpeg,.png" disabled={uploading}
                        onChange={async (e) => {
                          const file = e.target.files?.[0];
                          e.target.value = '';
                          if (!file) return;
                          setUploading(true);
                          const result = await uploadInsuranceCertificate(event.id, file);
                          setUploading(false);
                          if (!result.ok) { toast(result.error, { variant: 'error' }); return; }
                          patchTask(id, { filePath: result.path });
                          toast('Certificate uploaded.');
                        }}
                      />
                      {uploading && <span style={{ fontSize: 13, color: 'var(--ink-soft)' }}>Uploading…</span>}
                      {entry?.filePath && !uploading && <InsuranceCertificateLink filePath={entry.filePath} />}
                    </div>
                  </Field>
                )}
                {id === 'onsiteRep' && (
                  <>
                    <Field label="Rep name">
                      <input type="text" className="input" value={entry?.name ?? ''} onChange={(e) => patchTask(id, { name: e.target.value })} />
                    </Field>
                    <Field label="Rep email">
                      <input type="email" className="input" value={entry?.email ?? ''} onChange={(e) => patchTask(id, { email: e.target.value })} />
                    </Field>
                  </>
                )}
                {id === 'payHost' && (
                  <>
                    <Field label="Method">
                      <select className="input" value={entry?.method ?? ''} onChange={(e) => patchTask(id, { method: (e.target.value || undefined) as OwnerChecklistEntry['method'] })}>
                        <option value="">Select…</option>
                        <option value="check">Check</option>
                        <option value="paypal">PayPal</option>
                      </select>
                    </Field>
                    <Field label="Paid on">
                      <input type="date" className="input" value={entry?.paidOn ?? ''} onChange={(e) => patchTask(id, { paidOn: e.target.value })} />
                    </Field>
                  </>
                )}
                <Field label="Note">
                  <input type="text" className="input" value={entry?.note ?? ''} onChange={(e) => patchTask(id, { note: e.target.value })} placeholder="Optional note" />
                </Field>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Link that resolves a signed URL for a stored insurance certificate ON
 *  CLICK (not on render) — signed URLs expire (~10 min), so resolving eagerly
 *  would churn them for no reason. Reusable by the host-facing page (event-mgmt
 *  v2 §C status card) as well as this owner checklist. */
function InsuranceCertificateLink({ filePath }: { filePath: string }) {
  const [loading, setLoading] = useState(false);
  return (
    <button
      type="button" className="btn small ghost" disabled={loading}
      onClick={async () => {
        setLoading(true);
        const result = await insuranceCertificateUrl(filePath);
        setLoading(false);
        if (!result.ok) { window.alert(result.error); return; }
        window.open(result.url, '_blank', 'noopener,noreferrer');
      }}
    >
      {loading ? 'Opening…' : 'View certificate'}
    </button>
  );
}

// ---------------------------------------------------------------------------
// SelfRegModal — individual self-registration
// ---------------------------------------------------------------------------

interface SelfRegModalProps {
  event: Event;
  athlete: Athlete;
  onClose: () => void;
  toast: (msg: string, opts?: { variant?: 'info' | 'error' }) => void;
}

function SelfRegModal({ event, athlete, onClose, toast }: SelfRegModalProps) {
  const db = useDB();
  const navigate = useNavigate();

  // Clubs the athlete is affiliated with (main + alt)
  const myClubs = [
    ...(athlete.mainClubId ? [db.clubs.find((c) => c.id === athlete.mainClubId)] : []),
    ...athlete.altClubIds.map((id) => db.clubs.find((c) => c.id === id)),
  ].filter((c): c is NonNullable<typeof c> => !!c);

  // Cross-club lock (3d): if the athlete already has a PAID, non-refunded reg for
  // this event under one of their clubs, they're locked to it — they can't compete
  // for a DIFFERENT club. (excludeClubId omitted ⇒ returns ANY paid-reg club.)
  const lockedClubId = paidRegistrationClub(db.registrations, {
    athleteId: athlete.id, eventId: event.id,
  });
  const lockedClubShort = lockedClubId
    ? db.clubs.find((c) => c.id === lockedClubId)?.shortName ?? 'another club'
    : null;

  // Default to the locked club when one applies, else the athlete's first club.
  const [selectedClubId, setSelectedClubId] = useState(lockedClubId ?? myClubs[0]?.id ?? '');
  const [step, setStep] = useState<'reg' | 'addons'>('reg');
  // Add-on selections
  const [tshirtSize, setTshirtSize] = useState('');
  const [bannerText, setBannerText] = useState('');
  // Saved regs from editor (used in add-on step)
  const [pendingRegs, setPendingRegs] = useState<Registration[] | null>(null);

  const season = db.seasons.find((s) => s.current)!;
  const existingRegs = db.registrations.filter(
    (r) => r.eventId === event.id && r.athleteId === athlete.id && !r.refunded,
  );

  const changeFeeApplies = !!(
    event.changeFee && new Date() >= new Date(event.changeFee.startsAt)
  );

  const hasAddons = !!(event.tshirtAddon || event.bannerAddon);

  // Called by RegistrationEditor when the athlete confirms their selections
  const handleRegSave = (regs: Registration[]) => {
    // Cross-club lock (3d): block registering under a DIFFERENT club than the one
    // this athlete is already paid-registered with. (Belt-and-suspenders for the
    // single-club case where the selector — and its disabled options — isn't shown.)
    if (lockedClubId && selectedClubId !== lockedClubId) {
      toast(`You're already registered with ${lockedClubShort} for this event — you can't register under a different club. Edit your existing registration instead.`, { variant: 'error' });
      return;
    }
    // Gate: the competing club must hold an active membership for the event's season.
    const seasonId = seasonForDate(db, event.startDate);
    if (!clubHasActiveMembership(db, selectedClubId, seasonId)) {
      const sName = db.seasons.find((s) => s.id === seasonId)?.name ?? 'this season';
      const club = db.clubs.find((c) => c.id === selectedClubId);
      toast(`${club?.shortName ?? 'Your club'} needs an active ${sName} club membership before anyone can register for this event. A club manager can purchase it on the club page.`, { variant: 'error' });
      return;
    }
    if (hasAddons) {
      setPendingRegs(regs);
      setStep('addons');
    } else {
      persistRegs(regs, [], []);
    }
  };

  const persistRegs = (regs: Registration[], tshirtItems: CartItem[], bannerItems: CartItem[]) => {
    let hostFree = false;
    mutate((d) => {
      const existingForAthlete = d.registrations.filter(
        (r) => r.eventId === event.id && r.athleteId === athlete.id && !r.refunded,
      );
      const newDiscSet = new Set(regs.map((r) => r.discipline));
      const alreadyHadRegs = existingForAthlete.length > 0;
      const competingClubId = selectedClubId;

      // Disciplines already registered for that we are KEEPING (count toward
      // "second discipline" pricing for the ones being added now).
      const priorDisciplineCount = existingForAthlete.filter((r) => newDiscSet.has(r.discipline)).length;
      // Brand-new disciplines (not previously registered).
      const addedRegs = regs.filter((r) => !existingForAthlete.some((e) => e.discipline === r.discipline));

      // Late-registration fee attachment (emv2 P0 Task 3, corrected): the
      // surcharge attaches ONLY to the line containing the athlete's
      // earliest-created reg for this event — `lateFeeAnchor` returns that
      // line's anchor or null (⇒ no surcharge on this line; the athlete's
      // FIRST entry line carried it). Once per athlete+event across repeat
      // purchases, not per discipline or per save.
      const lateAnchor = lateFeeAnchor(addedRegs, existingForAthlete, new Date().toISOString());

      // Entry total for the newly-added disciplines, host-club aware ($0 ⇒ free).
      const entryTotal = newRegistrationEntryTotal(event, {
        competingClubId,
        priorDisciplineCount,
        newDisciplineCount: addedRegs.length,
        late: lateAnchor ? { earliestCreatedAtISO: lateAnchor } : undefined,
      });
      const changeFee = changeFeeApplies && alreadyHadRegs
        ? registrationChangeFee(event, { competingClubId })
        : 0;
      hostFree = !alreadyHadRegs && entryTotal === 0;

      // Remove dropped disciplines
      for (const old of existingForAthlete) {
        if (!newDiscSet.has(old.discipline)) {
          d.registrations = d.registrations.filter((r) => r.id !== old.id);
          deleteRegistration(old.id);
        }
      }

      // Upsert regs. New regs: paid=true when nothing is owed (host club / $0),
      // else paid=false ("Pending Purchase"). For a chargeable EDIT, flip any
      // previously-paid reg back to a re-pending state ("Updated pending
      // purchase") so paying the change fee restores it.
      const addedIds = new Set(addedRegs.map((r) => r.id));
      for (const reg of regs) {
        const prior = existingForAthlete.find((e) => e.id === reg.id);
        if (addedIds.has(reg.id) || !prior) {
          reg.paid = entryTotal === 0; // host-club / $0 ⇒ immediately registered
          reg.updatedPending = false;
        } else if (changeFee > 0 && prior.paid) {
          reg.paid = false;
          reg.updatedPending = true;
        } else {
          // Preserve prior payment state on a non-chargeable edit.
          reg.paid = prior.paid ?? false;
          reg.updatedPending = prior.updatedPending ?? false;
        }
        const idx = d.registrations.findIndex((r) => r.id === reg.id);
        if (idx >= 0) d.registrations[idx] = reg;
        else d.registrations.push(reg);
        pushRegistration(reg);
      }

      // Synchro same-level auto-sync (B4.4): whoever actively saves a partner
      // selection sets the SY level for BOTH — not a validation, an active
      // sync. Update the local snapshot optimistically; the actual remote
      // write goes through sync_synchro_partner_level (an RPC, NOT a plain
      // upsert) because the caller typically lacks RLS write access to the
      // PARTNER's own registration row (a different athlete, often a
      // different club) — the RPC re-derives + authorizes it server-side
      // from the caller's OWN just-saved registration.
      const eventRegsForSync = d.registrations.filter((r) => r.eventId === event.id && !r.refunded);
      for (const reg of regs) {
        const partnerUpdate = syncSynchroPartnerLevel(eventRegsForSync, reg);
        const mySyLevel = reg.apparatusLevels?.SY;
        if (partnerUpdate && mySyLevel) {
          const idx = d.registrations.findIndex((r) => r.id === partnerUpdate.id);
          if (idx >= 0) d.registrations[idx] = partnerUpdate;
          syncSynchroPartnerLevelRemote(reg.id, mySyLevel);
        }
      }

      // Cart: entry / change fee for new or re-pending registrations.
      const cart = d.carts[athlete.id] ?? (d.carts[athlete.id] = []);

      if (!alreadyHadRegs && entryTotal > 0) {
        const lateSuffix = lateAnchor !== null && lateFeeApplies(event, lateAnchor) ? ' (incl. late fee)' : '';
        cart.push({
          id: `ci-self-${Date.now()}-${athlete.id}`,
          label: `${event.name} entry — ${athlete.firstName} ${athlete.lastName} (${addedRegs.map((r) => r.discipline).join('+')})${lateSuffix}`,
          amount: entryTotal,
          kind: 'meet-entry',
          refUserId: athlete.id,
          refRegIds: addedRegs.map((r) => r.id),
          refEventId: event.id,
          refLineType: 'entry',
        });
      }
      if (changeFee > 0) {
        cart.push({
          id: `ci-change-${Date.now()}-${athlete.id}`,
          label: `${event.name} change fee — ${athlete.firstName} ${athlete.lastName}`,
          amount: changeFee,
          kind: 'meet-entry',
          refUserId: athlete.id,
          refRegIds: regs.map((r) => r.id),
          refEventId: event.id,
          refLineType: 'change',
        });
      }

      // Add-on cart items
      for (const item of [...tshirtItems, ...bannerItems]) {
        cart.push(item);
      }

      pushCart(athlete.id, cart, false);
      // No client-side invoice stub: the cart is the pre-payment source of truth and
      // the Stripe webhook writes the authoritative paid invoice on fulfillment.
      // (The old stub reused cart-item ids as invoice_items PKs, colliding across
      // registrations — `invoice_items_pkey` duplicate-key error.)
    });

    toast(
      hostFree
        ? 'Registration complete — no entry fee for your host club.'
        : changeFeeApplies
          ? 'Registration updated. Change fee added to your cart.'
          : 'Registration saved! Check your cart to complete payment.',
    );
    onClose();
    // Always land on the cart so the member can complete payment (both the add-on
    // and no-add-on paths funnel through here).
    navigate('/cart');
  };

  const handleAddons = () => {
    if (!pendingRegs) return;
    const ts = Date.now();
    const tshirtItems: CartItem[] = [];
    const bannerItems: CartItem[] = [];

    if (event.tshirtAddon && tshirtSize) {
      tshirtItems.push({
        id: `ci-tshirt-${ts}`,
        label: `${event.name} t-shirt — ${athlete.firstName} ${athlete.lastName} (${tshirtSize})`,
        amount: event.tshirtAddon.price,
        kind: 'addon',
        refUserId: athlete.id,
        refEventId: event.id,
        refLineType: 'tshirt',
      });
    }
    if (event.bannerAddon && bannerText.trim()) {
      bannerItems.push({
        id: `ci-banner-${ts}`,
        label: `${event.name} club banner — "${bannerText.trim()}"`,
        amount: event.bannerAddon.price,
        kind: 'addon',
        refUserId: athlete.id,
        refEventId: event.id,
        refLineType: 'banner',
      });
    }

    persistRegs(pendingRegs, tshirtItems, bannerItems);
  };

  const title = step === 'reg'
    ? `Register for ${event.name}`
    : `Add-ons — ${event.name}`;

  return (
    <Modal title={title} onClose={onClose}>
      {/* Club selector (only if athlete has >1 affiliated club) */}
      {step === 'reg' && myClubs.length > 1 && (
        <Field label="Compete for" hint="Choose which club you will compete under at this event.">
          <select
            className="input"
            value={selectedClubId}
            onChange={(e) => setSelectedClubId(e.target.value)}
          >
            {myClubs.map((c) => (
              <option key={c.id} value={c.id} disabled={!!lockedClubId && c.id !== lockedClubId}>
                {c.name}{!!lockedClubId && c.id !== lockedClubId ? ' — unavailable' : ''}
              </option>
            ))}
          </select>
          {lockedClubShort && (
            <p style={{ fontSize: 13, color: 'var(--warn)', marginTop: 6 }}>
              Already registered with {lockedClubShort} for this event — you can only edit that registration.
            </p>
          )}
        </Field>
      )}

      {step === 'reg' && (
        <RegistrationEditor
          event={event}
          athlete={athlete}
          clubId={selectedClubId}
          existing={existingRegs}
          allAthletes={db.people.filter((p) => p.kind === 'athlete')}
          levels={db.levels}
          season={season}
          onSave={handleRegSave}
          onCancel={onClose}
          changeFeeApplies={changeFeeApplies}
          incomingPartnerId={findIncomingSynchroPartner(db.registrations, event.id, athlete.id)?.athleteId ?? null}
          incomingPartnerSyLevel={(() => {
            const r = findIncomingSynchroPartner(db.registrations, event.id, athlete.id);
            return r ? (r.apparatusLevels?.SY ?? r.levelId) : null;
          })()}
        />
      )}

      {step === 'addons' && (
        <div>
          <p style={{ fontSize: 14, color: 'var(--ink-soft)', marginBottom: 14 }}>
            Optional add-ons for this event — leave a field blank to omit it.
          </p>

          {event.tshirtAddon && (
            <div className="card card-pad" style={{ marginBottom: 14 }}>
              <h3 className="card-title">T-shirt — {fmtMoney(event.tshirtAddon.price)}</h3>
              <Field label="Size (leave blank to skip)">
                <select className="input" value={tshirtSize} onChange={(e) => setTshirtSize(e.target.value)}>
                  <option value="">— no t-shirt —</option>
                  {(event.tshirtAddon.sizes.length > 0 ? event.tshirtAddon.sizes : SHIRT_SIZES).map((sz) => (
                    <option key={sz} value={sz}>{sz}</option>
                  ))}
                </select>
              </Field>
            </div>
          )}

          {event.bannerAddon && (
            <div className="card card-pad" style={{ marginBottom: 14 }}>
              <h3 className="card-title">Club banner — {fmtMoney(event.bannerAddon.price)}</h3>
              <Field label="Banner text (leave blank to skip)" hint="Text to print on the banner.">
                <input
                  className="input"
                  value={bannerText}
                  onChange={(e) => setBannerText(e.target.value)}
                  placeholder="e.g. Springfield Gymnastics Club"
                />
              </Field>
            </div>
          )}

          <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
            <button className="btn primary" onClick={handleAddons}>Continue to cart</button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// exportCsv helpers (unchanged from original)
// ---------------------------------------------------------------------------

function exportCsv(db: ReturnType<typeof useDB>, event: Event) {
  // Spec: "just export all the things and let the user trim"
  const rows = [['Athlete', 'Club', 'Discipline', 'Level', 'Session', 'Events', 'Shirt', 'Dietary', 'Email', 'Phone', 'Emergency contact', 'Student', 'Region']];
  for (const r of db.registrations.filter((x) => x.eventId === event.id && !x.refunded)) {
    const a = db.people.find((p) => p.id === r.athleteId)!;
    const club = db.clubs.find((c) => c.id === r.clubId)!;
    rows.push([
      `${a.firstName} ${a.lastName}`, club.name, r.discipline,
      db.levels.find((l) => l.id === r.levelId)?.name ?? '',
      event.sessions.find((s) => s.id === r.sessionId)?.name ?? '',
      r.apparatus.join('|'), a.shirt, a.dietary.join('|'), a.email, a.phone,
      `${a.emergency.contact} ${a.emergency.phone}`, a.studentStatus, club.region,
    ]);
  }
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  downloadCsv(csv, `${event.slug}-export.csv`);
}

/** Scores export — includes the captured calculator state so verification has
 *  the full breakdown of how every score was built. */
function exportScoresCsv(db: ReturnType<typeof useDB>, event: Event) {
  const rows = [['Athlete', 'Club', 'Session', 'Event', 'Level', 'D/SV', 'Deductions', 'E-score', 'Final', 'Source', 'Calculator', 'Entered by', 'Entered at', 'Adjusted at', 'Adjust note', 'Calculator state (JSON)']];
  for (const s of db.scores.filter((x) => x.eventId === event.id)) {
    const reg = db.registrations.find((r) => r.id === s.regId);
    const a = reg && db.people.find((p) => p.id === reg.athleteId);
    const club = reg && db.clubs.find((c) => c.id === reg.clubId);
    const session = event.sessions.find((x) => x.id === s.sessionId);
    rows.push([
      a ? `${a.firstName} ${a.lastName}` : s.regId, club?.name ?? '', session?.name ?? '', s.apparatus,
      db.levels.find((l) => l.id === reg?.levelId)?.name ?? '',
      s.sv ?? '', s.deductions ?? '', s.eScore ?? '', s.final ?? '',
      s.source ?? 'manual', s.calc ?? '', s.enteredBy, s.enteredAt,
      s.adjustedAt ?? '', s.adjustNote ?? '',
      s.calcState ? JSON.stringify(s.calcState) : '',
    ].map(String));
  }
  const csv = rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(',')).join('\n');
  downloadCsv(csv, `${event.slug}-scores.csv`);
}

function downloadCsv(csv: string, filename: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = filename;
  a.click();
}

// ---------------------------------------------------------------------------
// EventManage: sessions & squads (unchanged logic, updated imports)
// ---------------------------------------------------------------------------
export function EventManage() {
  const { slug } = useParams();
  const db = useDB();
  const caps = useCapabilities();
  const event = db.events.find((m) => m.slug === slug);
  const [sessionId, setSessionId] = useState(event?.sessions[0]?.id ?? '');
  if (!event) return <p>Event not found.</p>;
  const session = event.sessions.find((s) => s.id === sessionId) ?? event.sessions[0];
  const canScore = caps.isEventHost(event.id);

  return (
    <div>
      <h1 className="page-title display">Manage — {event.name}</h1>
      <p className="page-sub">Build squads per session, copy a squad setup to other sessions, and save everything at once. New athletes land in the Holding squad until placed.</p>
      {canScore && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
          <Link className="btn primary" to={`/judge?event=${event.id}`}>Score entry →</Link>
          <Link className="btn ghost" to={`/results/${event.slug}`}>Live results</Link>
        </div>
      )}
      <Tabs
        tabs={event.sessions.map((s) => ({ id: s.id, label: s.name.split('—')[0].trim() }))}
        active={session.id}
        onChange={setSessionId}
      />
      <SquadBuilder event={event} session={session} />
    </div>
  );
}

function SquadBuilder({ event, session }: { event: Event; session: EventSession }) {
  const db = useDB();
  const toast = useToast();
  const regs = db.registrations.filter((r) => r.eventId === event.id && r.sessionId === session.id && !r.refunded);
  const events = APPARATUS[session.discipline];
  const placed = new Set(session.squads.flatMap((q) => q.athleteRegIds));
  const holding = regs.filter((r) => !placed.has(r.id));
  const name = (regId: string) => {
    const reg = regs.find((r) => r.id === regId);
    const a = db.people.find((p) => p.id === reg?.athleteId);
    return a ? `${a.firstName} ${a.lastName}` : regId;
  };
  const clubShort = (regId: string) => {
    const reg = regs.find((r) => r.id === regId);
    return db.clubs.find((c) => c.id === reg?.clubId)?.shortName ?? '';
  };

  const applyDefault = (n: number) => {
    mutate((d) => {
      const m = d.events.find((x) => x.id === event.id)!;
      const s = m.sessions.find((x) => x.id === session.id)!;
      const sregs = d.registrations.filter((r) => r.eventId === event.id && r.sessionId === session.id && !r.refunded);
      s.squads = Array.from({ length: n }, (_, i) => ({
        id: `${s.id}-q${i + 1}`, name: `Squad ${String.fromCharCode(65 + i)}`,
        startEvent: Math.floor((i * events.length) / n) % events.length,
        athleteRegIds: [],
      }));
      sregs.forEach((r, i) => s.squads[i % n].athleteRegIds.push(r.id));
      pushEventSessions(m, d.registrations);
    });
    toast(`Split ${regs.length} athletes into ${n} squads. Adjust then Save.`);
  };

  const copyToOthers = () => {
    mutate((d) => {
      const m = d.events.find((x) => x.id === event.id)!;
      for (const s of m.sessions) {
        if (s.id === session.id || s.discipline !== session.discipline) continue;
        const sregs = d.registrations.filter((r) => r.eventId === event.id && r.sessionId === s.id && !r.refunded);
        const n = Math.max(1, session.squads.filter((q) => !q.holding).length);
        s.squads = Array.from({ length: n }, (_, i) => ({
          id: `${s.id}-q${i + 1}`, name: `Squad ${String.fromCharCode(65 + i)}`,
          startEvent: session.squads[i]?.startEvent ?? 0,
          athleteRegIds: [],
        }));
        sregs.forEach((r, i) => s.squads[i % n].athleteRegIds.push(r.id));
      }
      pushEventSessions(m, d.registrations);
    });
    toast('Squad setup copied to other ' + session.discipline + ' sessions.');
  };

  const move = (regId: string, toSquadId: string | 'holding') => {
    mutate((d) => {
      const m = d.events.find((x) => x.id === event.id)!;
      const s = m.sessions.find((x) => x.id === session.id)!;
      for (const q of s.squads) q.athleteRegIds = q.athleteRegIds.filter((id) => id !== regId);
      if (toSquadId !== 'holding') s.squads.find((q) => q.id === toSquadId)!.athleteRegIds.push(regId);
      pushEventSessions(m, d.registrations);
    });
  };

  const defaults = session.discipline === 'MAG' ? [2, 3, 6] : session.discipline === 'WAG' ? [4, 8] : [2, 3];

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink-soft)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Default rotations:</span>
        {defaults.map((n) => (
          <button key={n} className="btn small ghost" onClick={() => applyDefault(n)}>{n} squads</button>
        ))}
        <div style={{ flex: 1 }} />
        <button className="btn small" onClick={copyToOthers} data-tip="Replicate this squad count & rotation starts to other sessions of this discipline">Copy setup to other sessions</button>
        <button className="btn small primary" onClick={() => toast('Squads saved & published to the schedule.')}>Save all squads</button>
      </div>

      <div className="grid cols-3">
        <div className="card card-pad" style={{ borderStyle: 'dashed', background: 'var(--ice-100)' }}>
          <h3 className="card-title">Holding squad ({holding.length})</h3>
          <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', marginTop: 0 }}>Unplaced athletes — the holding squad can&apos;t compete.</p>
          {holding.map((r) => (
            <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 6, padding: '5px 0', borderBottom: '1px solid var(--line)', fontSize: 13.5 }}>
              <span>{name(r.id)} <span style={{ color: 'var(--ink-soft)' }}>({clubShort(r.id)})</span></span>
              <select className="input" style={{ width: 'auto', padding: '2px 6px', fontSize: 12 }} value="" onChange={(e) => move(r.id, e.target.value)}>
                <option value="" disabled>→</option>
                {session.squads.filter((q) => !q.holding).map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}
              </select>
            </div>
          ))}
          {holding.length === 0 && <p style={{ color: 'var(--green-600)', fontWeight: 600, fontSize: 13.5 }}>✓ Everyone placed</p>}
        </div>

        {session.squads.filter((q) => !q.holding).map((q) => (
          <div className="card card-pad" key={q.id}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <h3 className="card-title" style={{ marginBottom: 4 }}>{q.name} ({q.athleteRegIds.length})</h3>
              <span style={{ fontSize: 12, color: 'var(--coral-600)', fontWeight: 700 }}>starts on {events[q.startEvent]?.name ?? events[0].name}</span>
            </div>
            {q.athleteRegIds.map((regId) => (
              <div key={regId} style={{ display: 'flex', justifyContent: 'space-between', gap: 6, padding: '5px 0', borderBottom: '1px solid var(--line)', fontSize: 13.5 }}>
                <span>{name(regId)} <span style={{ color: 'var(--ink-soft)' }}>({clubShort(regId)})</span></span>
                <button className="btn small ghost" style={{ padding: '1px 8px' }} data-tip="Back to holding" onClick={() => move(regId, 'holding')}>↩</button>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
