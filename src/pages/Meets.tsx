import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useDB, mutate, useRole } from '../lib/store';
import { Badge, Tabs, useToast, useFmtDate } from '../components/ui';
import { MeetWizard } from '../components/MeetWizard';
import { MeetStatusBadge } from './Home';
import { EVENTS } from '../lib/types';
import type { Meet, MeetSession } from '../lib/types';
import { pushMeet, pushMeetSessions } from '../lib/supabase';
import { fmtMoney } from '../lib/scoring';

export function Meets() {
  const db = useDB();
  const role = useRole();
  const fmtDate = useFmtDate();
  const [wizardOpen, setWizardOpen] = useState(false);
  return (
    <div>
      <h1 className="page-title display">Meets</h1>
      <p className="page-sub">Every meet gets its own unique URL, sessions, squads, and live results page.</p>
      {role === 'admin' && (
        <button className="btn primary" style={{ marginBottom: 18 }} onClick={() => setWizardOpen(true)}>+ Sanction new meet</button>
      )}
      {wizardOpen && <MeetWizard onClose={() => setWizardOpen(false)} />}
      <div className="grid cols-3">
        {db.meets.map((m) => {
          const regs = db.registrations.filter((r) => r.meetId === m.id && !r.refunded);
          return (
            <div className="card card-pad" key={m.id} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <h3 style={{ fontSize: 17 }}><Link to={`/meets/${m.slug}`} style={{ textDecoration: 'none' }}>{m.name}</Link></h3>
                <MeetStatusBadge status={m.status} />
              </div>
              <div style={{ fontSize: 13.5, color: 'var(--ink-soft)' }}>
                {m.city}, {m.state} · {fmtDate(m.startDate)}<br />
                {m.disciplines.join(' · ')} · {regs.length} athletes · hosted by {db.clubs.find((c) => c.id === m.hostClubId)?.shortName}
              </div>
              <div style={{ marginTop: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <Link className="btn small" to={`/meets/${m.slug}`}>Details</Link>
                {(m.status === 'in-progress' || m.status === 'complete') && <Link className="btn small primary" to={`/results/${m.slug}`}>Results</Link>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function MeetDetail() {
  const { slug } = useParams();
  const db = useDB();
  const role = useRole();
  const toast = useToast();
  const fmtDate = useFmtDate();
  const meet = db.meets.find((m) => m.slug === slug);
  if (!meet) return <p>Meet not found.</p>;
  const host = db.clubs.find((c) => c.id === meet.hostClubId);
  const regs = db.registrations.filter((r) => r.meetId === meet.id && !r.refunded);
  const canManage = role === 'admin' || role === 'meet-host';

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 className="page-title display">{meet.name}</h1>
          <p className="page-sub">
            {meet.city}, {meet.state} · {fmtDate(meet.startDate)}–{fmtDate(meet.endDate)} ({meet.timezone}) ·
            hosted by {host?.name} · <code>#/meets/{meet.slug}</code>
          </p>
        </div>
        <MeetStatusBadge status={meet.status} />
      </div>

      <div className="grid cols-3" style={{ marginBottom: 18 }}>
        <div className="card card-pad">
          <h3 className="card-title">Registration</h3>
          <p style={{ margin: '0 0 8px', fontSize: 14 }}>
            Opens {fmtDate(meet.regOpens.slice(0, 10))} · closes <strong>{fmtDate(meet.regCloses.slice(0, 10))}</strong> ({meet.timezone})<br />
            {fmtMoney(meet.entryFee)} / discipline · {fmtMoney(meet.secondDisciplineFee)} each additional
            {meet.banquet && <><br />{meet.banquet.name}: {fmtMoney(meet.banquet.price)}</>}
          </p>
          {meet.status === 'reg-open'
            ? <Link className="btn primary small" to="/club/club-1">Register your club →</Link>
            : <Badge tone="warn">Registration closed{role === 'admin' ? ' — admin can override below' : ''}</Badge>}
          {role === 'admin' && meet.status !== 'reg-open' && (
            <div style={{ marginTop: 10, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button className="btn small ghost" onClick={() => { mutate((d) => { const m = d.meets.find((m) => m.id === meet.id)!; m.status = 'reg-open'; pushMeet(m); }); toast('Deadline overridden — registration re-opened.'); }}>Override: reopen reg</button>
              <button className="btn small ghost" data-tip="Generates a private reg link + password for late adds" onClick={() => toast(`Private link: ucg.org/#/meets/${meet.slug}?code=LATE26 (demo)`)}>Private reg link</button>
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
            <Link to={`/results/${meet.slug}`}>→ Live results</Link>
            {canManage && <Link to={`/meets/${meet.slug}/manage`}>→ Manage sessions & squads</Link>}
            {canManage && <Link to={`/judge?meet=${meet.id}`}>→ Score entry</Link>}
            {canManage && <a href="#" onClick={(e) => { e.preventDefault(); exportCsv(db, meet); }}>→ Export registrations (CSV)</a>}
            {canManage && <a href="#" onClick={(e) => { e.preventDefault(); exportScoresCsv(db, meet); }}>→ Export scores incl. calculator detail (CSV)</a>}
          </div>
        </div>
      </div>

      <div className="card" style={{ overflow: 'hidden' }}>
        <table className="tbl">
          <thead><tr><th>Session</th><th>Date</th><th>Levels</th><th className="num">Athletes</th><th className="num">Squads</th></tr></thead>
          <tbody>
            {meet.sessions.map((s) => (
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
    </div>
  );
}

function exportCsv(db: ReturnType<typeof useDB>, meet: Meet) {
  // Spec: "just export all the things and let the user trim"
  const rows = [['Athlete', 'Club', 'Discipline', 'Level', 'Session', 'Events', 'Shirt', 'Dietary', 'Email', 'Phone', 'Emergency contact', 'Student', 'Region']];
  for (const r of db.registrations.filter((x) => x.meetId === meet.id && !x.refunded)) {
    const a = db.people.find((p) => p.id === r.athleteId)!;
    const club = db.clubs.find((c) => c.id === r.clubId)!;
    rows.push([
      `${a.firstName} ${a.lastName}`, club.name, r.discipline,
      db.levels.find((l) => l.id === r.levelId)?.name ?? '',
      meet.sessions.find((s) => s.id === r.sessionId)?.name ?? '',
      r.events.join('|'), a.shirt, a.dietary.join('|'), a.email, a.phone,
      `${a.emergency.contact} ${a.emergency.phone}`, a.studentStatus, club.region,
    ]);
  }
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  downloadCsv(csv, `${meet.slug}-export.csv`);
}

/** Scores export — includes the captured calculator state so verification has
 *  the full breakdown of how every score was built. */
function exportScoresCsv(db: ReturnType<typeof useDB>, meet: Meet) {
  const rows = [['Athlete', 'Club', 'Session', 'Event', 'Level', 'D/SV', 'Deductions', 'E-score', 'Final', 'Source', 'Calculator', 'Entered by', 'Entered at', 'Adjusted at', 'Adjust note', 'Calculator state (JSON)']];
  for (const s of db.scores.filter((x) => x.meetId === meet.id)) {
    const reg = db.registrations.find((r) => r.id === s.regId);
    const a = reg && db.people.find((p) => p.id === reg.athleteId);
    const club = reg && db.clubs.find((c) => c.id === reg.clubId);
    const session = meet.sessions.find((x) => x.id === s.sessionId);
    rows.push([
      a ? `${a.firstName} ${a.lastName}` : s.regId, club?.name ?? '', session?.name ?? '', s.event,
      db.levels.find((l) => l.id === reg?.levelId)?.name ?? '',
      s.sv ?? '', s.deductions ?? '', s.eScore ?? '', s.final ?? '',
      s.source ?? 'manual', s.calc ?? '', s.enteredBy, s.enteredAt,
      s.adjustedAt ?? '', s.adjustNote ?? '',
      s.calcState ? JSON.stringify(s.calcState) : '',
    ].map(String));
  }
  const csv = rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(',')).join('\n');
  downloadCsv(csv, `${meet.slug}-scores.csv`);
}

function downloadCsv(csv: string, filename: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = filename;
  a.click();
}

// ---------- Host management: sessions & squads ----------
export function MeetManage() {
  const { slug } = useParams();
  const db = useDB();
  const role = useRole();
  const meet = db.meets.find((m) => m.slug === slug);
  const [sessionId, setSessionId] = useState(meet?.sessions[0]?.id ?? '');
  if (!meet) return <p>Meet not found.</p>;
  const session = meet.sessions.find((s) => s.id === sessionId) ?? meet.sessions[0];
  const canScore = role === 'admin' || role === 'meet-host' || role === 'judge';

  return (
    <div>
      <h1 className="page-title display">Manage — {meet.name}</h1>
      <p className="page-sub">Build squads per session, copy a squad setup to other sessions, and save everything at once. New athletes land in the Holding squad until placed.</p>
      {canScore && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
          <Link className="btn primary" to={`/judge?meet=${meet.id}`}>Score entry →</Link>
          <Link className="btn ghost" to={`/results/${meet.slug}`}>Live results</Link>
        </div>
      )}
      <Tabs
        tabs={meet.sessions.map((s) => ({ id: s.id, label: s.name.split('—')[0].trim() }))}
        active={session.id}
        onChange={setSessionId}
      />
      <SquadBuilder meet={meet} session={session} />
    </div>
  );
}

function SquadBuilder({ meet, session }: { meet: Meet; session: MeetSession }) {
  const db = useDB();
  const toast = useToast();
  const regs = db.registrations.filter((r) => r.meetId === meet.id && r.sessionId === session.id && !r.refunded);
  const events = EVENTS[session.discipline];
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
      const m = d.meets.find((x) => x.id === meet.id)!;
      const s = m.sessions.find((x) => x.id === session.id)!;
      const sregs = d.registrations.filter((r) => r.meetId === meet.id && r.sessionId === session.id && !r.refunded);
      s.squads = Array.from({ length: n }, (_, i) => ({
        id: `${s.id}-q${i + 1}`, name: `Squad ${String.fromCharCode(65 + i)}`,
        startEvent: Math.floor((i * events.length) / n) % events.length,
        athleteRegIds: [],
      }));
      sregs.forEach((r, i) => s.squads[i % n].athleteRegIds.push(r.id));
      pushMeetSessions(m, d.registrations);
    });
    toast(`Split ${regs.length} athletes into ${n} squads. Adjust then Save.`);
  };

  const copyToOthers = () => {
    mutate((d) => {
      const m = d.meets.find((x) => x.id === meet.id)!;
      for (const s of m.sessions) {
        if (s.id === session.id || s.discipline !== session.discipline) continue;
        const sregs = d.registrations.filter((r) => r.meetId === meet.id && r.sessionId === s.id && !r.refunded);
        const n = Math.max(1, session.squads.filter((q) => !q.holding).length);
        s.squads = Array.from({ length: n }, (_, i) => ({
          id: `${s.id}-q${i + 1}`, name: `Squad ${String.fromCharCode(65 + i)}`,
          startEvent: session.squads[i]?.startEvent ?? 0,
          athleteRegIds: [],
        }));
        sregs.forEach((r, i) => s.squads[i % n].athleteRegIds.push(r.id));
      }
      pushMeetSessions(m, d.registrations);
    });
    toast('Squad setup copied to other ' + session.discipline + ' sessions.');
  };

  const move = (regId: string, toSquadId: string | 'holding') => {
    mutate((d) => {
      const m = d.meets.find((x) => x.id === meet.id)!;
      const s = m.sessions.find((x) => x.id === session.id)!;
      for (const q of s.squads) q.athleteRegIds = q.athleteRegIds.filter((id) => id !== regId);
      if (toSquadId !== 'holding') s.squads.find((q) => q.id === toSquadId)!.athleteRegIds.push(regId);
      pushMeetSessions(m, d.registrations);
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
          <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', marginTop: 0 }}>Unplaced athletes — the holding squad can't compete.</p>
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
