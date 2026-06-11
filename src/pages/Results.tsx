import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useDB } from '../lib/store';
import { Tabs, useFmtDate } from '../components/ui';
import { MeetStatusBadge } from './Home';
import { sessionResults, fmtScore } from '../lib/scoring';
import { EVENTS } from '../lib/types';

export function ResultsIndex() {
  const db = useDB();
  const fmtDate = useFmtDate();
  const meets = db.meets.filter((m) => m.status === 'in-progress' || m.status === 'complete' || m.status === 'reg-closed');
  return (
    <div>
      <h1 className="page-title display">Live results</h1>
      <p className="page-sub">Public — no login needed. Scores appear the moment a judge posts them.</p>
      <div className="grid cols-2">
        {meets.map((m) => (
          <div className="card card-pad" key={m.id}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <h3 style={{ fontSize: 18 }}>{m.status === 'in-progress' && <span className="pulse" />}{m.name}</h3>
              <MeetStatusBadge status={m.status} />
            </div>
            <p style={{ color: 'var(--ink-soft)', margin: '6px 0 12px' }}>{m.city}, {m.state} · {fmtDate(m.startDate)}</p>
            <Link className="btn small primary" to={`/results/${m.slug}`}>Open results →</Link>
          </div>
        ))}
      </div>
    </div>
  );
}

export function MeetResults() {
  const { slug } = useParams();
  const db = useDB();
  const meet = db.meets.find((m) => m.slug === slug);
  const scoredSessions = meet?.sessions.filter((s) => s.squads.length > 0) ?? [];
  const [sessionId, setSessionId] = useState(scoredSessions[0]?.id ?? meet?.sessions[0]?.id ?? '');
  const [view, setView] = useState<'aa' | 'events' | 'team'>('aa');
  if (!meet) return <p>Meet not found.</p>;
  const session = meet.sessions.find((s) => s.id === sessionId) ?? meet.sessions[0];
  if (!session) return <p>No sessions yet.</p>;
  const { byLevel, eventRankings, teamScores } = sessionResults(db, meet, session.id);
  const events = EVENTS[session.discipline];
  const clubName = (id: string) => db.clubs.find((c) => c.id === id)?.shortName ?? id;
  const athleteName = (athleteId: string) => {
    const a = db.people.find((p) => p.id === athleteId);
    return a ? `${a.firstName} ${a.lastName}` : athleteId;
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', gap: 10, flexWrap: 'wrap' }}>
        <div>
          <h1 className="page-title display">{meet.name}</h1>
          <p className="page-sub">
            {meet.status === 'in-progress' && <><span className="pulse" /><strong>Live</strong> — updates as judges post. </>}
            Unique URL per meet & session: <code>#/results/{meet.slug}</code>
          </p>
        </div>
        <MeetStatusBadge status={meet.status} />
      </div>

      <div className="grid cols-2" style={{ marginBottom: 14 }}>
        <select className="input" value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
          {meet.sessions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <Tabs
          tabs={[{ id: 'aa' as const, label: 'All-Around' }, { id: 'events' as const, label: 'By event' }, { id: 'team' as const, label: 'Team' }]}
          active={view}
          onChange={setView}
        />
      </div>

      {view === 'aa' && [...byLevel.entries()].map(([levelId, rows]) => rows.length > 0 && (
        <div key={levelId} style={{ marginBottom: 22 }}>
          <h2 className="display" style={{ fontSize: 20, marginBottom: 8 }}>{db.levels.find((l) => l.id === levelId)?.name ?? levelId}</h2>
          <div className="card" style={{ overflowX: 'auto' }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: 40 }}>#</th><th>Athlete</th><th>Club</th>
                  {events.map((ev) => <th key={ev.code} className="num" data-tip={ev.name}>{ev.code}</th>)}
                  <th className="num">AA</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.reg.id}>
                    <td><span className={`rank-chip r${i + 1}`}>{i + 1}</span></td>
                    <td><strong>{athleteName(r.reg.athleteId)}</strong></td>
                    <td>{clubName(r.reg.clubId)}</td>
                    {events.map((ev) => (
                      <td key={ev.code} className="num score" style={{ color: r.events[ev.code] ? undefined : 'var(--ink-soft)' }}>
                        {r.reg.events.includes(ev.code) ? fmtScore(r.events[ev.code]?.final) : ''}
                      </td>
                    ))}
                    <td className="num score" style={{ fontSize: 15 }}>
                      {fmtScore(r.aa)}{!r.aaComplete && <span style={{ color: 'var(--coral-600)' }} title="Events still to come">*</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {view === 'events' && (
        <div className="grid cols-2">
          {eventRankings.map((er) => (
            <div className="card card-pad" key={er.event}>
              <h3 className="card-title">{events.find((e) => e.code === er.event)?.name ?? er.event}</h3>
              <table className="tbl">
                <tbody>
                  {er.rows.slice(0, 10).map((row) => (
                    <tr key={row.reg.id}>
                      <td style={{ width: 36 }}><span className={`rank-chip r${row.rank}`}>{row.rank}</span></td>
                      <td><strong>{athleteName(row.reg.athleteId)}</strong> <span style={{ color: 'var(--ink-soft)', fontSize: 12.5 }}>{clubName(row.reg.clubId)}</span></td>
                      <td className="num score">{fmtScore(row.score.final)}</td>
                    </tr>
                  ))}
                  {er.rows.length === 0 && <tr><td style={{ color: 'var(--ink-soft)' }}>No scores yet.</td></tr>}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}

      {view === 'team' && (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 40 }}>#</th><th>Club</th>
                {events.map((ev) => <th key={ev.code} className="num">{ev.code}</th>)}
                <th className="num">Team total</th>
              </tr>
            </thead>
            <tbody>
              {teamScores.map((t, i) => (
                <tr key={t.clubId}>
                  <td><span className={`rank-chip r${i + 1}`}>{i + 1}</span></td>
                  <td><strong>{db.clubs.find((c) => c.id === t.clubId)?.name}</strong></td>
                  {events.map((ev) => <td key={ev.code} className="num score">{fmtScore(t.perEvent[ev.code])}</td>)}
                  <td className="num score" style={{ fontSize: 15 }}>{fmtScore(t.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', padding: '0 12px 12px' }}>Team score = top 3 scores per club per event, summed across events.</p>
        </div>
      )}
    </div>
  );
}
