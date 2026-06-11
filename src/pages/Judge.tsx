import { useMemo, useState } from 'react';
import { useDB, mutate } from '../lib/store';
import { Badge, Field, useToast } from '../components/ui';
import { EVENTS } from '../lib/types';
import { fmtScore } from '../lib/scoring';

/** Tablet-first judge pad. SV + deductions entry mirrors the UCG SV calculators
 *  so judges are forced through them — catching SV errors at entry time. */
export function Judge() {
  const db = useDB();
  const toast = useToast();
  const liveMeets = db.meets.filter((m) => m.status === 'in-progress' || m.status === 'reg-closed');
  const [meetId, setMeetId] = useState(liveMeets[0]?.id ?? db.meets[0].id);
  const meet = db.meets.find((m) => m.id === meetId)!;
  const [sessionId, setSessionId] = useState(meet.sessions[0].id);
  const session = meet.sessions.find((s) => s.id === sessionId) ?? meet.sessions[0];
  const events = EVENTS[session.discipline];
  const [event, setEvent] = useState(events[0].code);
  const [flash, setFlash] = useState<{ name: string; score: number } | null>(null);

  const regs = useMemo(() => {
    const inSession = db.registrations.filter((r) => r.meetId === meet.id && r.sessionId === session.id && !r.refunded && r.events.includes(event));
    return inSession.sort((a, b) => {
      const an = db.people.find((p) => p.id === a.athleteId)!;
      const bn = db.people.find((p) => p.id === b.athleteId)!;
      return an.lastName.localeCompare(bn.lastName);
    });
  }, [db, meet.id, session.id, event]);

  const scoreFor = (regId: string) => db.scores.find((s) => s.id === `${meet.id}|${regId}|${event}`);

  const [activeReg, setActiveReg] = useState<string | null>(null);
  const [sv, setSv] = useState('');
  const [ded, setDed] = useState('');

  const active = regs.find((r) => r.id === activeReg);
  const activeAthlete = active && db.people.find((p) => p.id === active.athleteId);
  const activeLevel = active && db.levels.find((l) => l.id === active.levelId);
  const svMax = activeLevel?.svMax;
  const svNum = parseFloat(sv);
  const dedNum = parseFloat(ded);
  const svError = sv !== '' && svMax != null && svNum > svMax;
  const finalScore = !isNaN(svNum) && !isNaN(dedNum) ? Math.max(0, Math.round((svNum - dedNum) * 1000) / 1000) : null;

  const submit = () => {
    if (!active || finalScore == null) return;
    const athleteName = `${activeAthlete!.firstName} ${activeAthlete!.lastName}`;
    mutate((d) => {
      const id = `${meet.id}|${active.id}|${event}`;
      d.scores = d.scores.filter((s) => s.id !== id);
      d.scores.push({
        id, meetId: meet.id, sessionId: session.id, regId: active.id, event,
        sv: svNum, deductions: dedNum, final: finalScore,
        enteredBy: 'judge-you', enteredAt: new Date().toISOString(), flashed: true,
      });
    });
    setFlash({ name: athleteName, score: finalScore });
    setActiveReg(null); setSv(''); setDed('');
    toast(`Score posted: ${athleteName} — ${fmtScore(finalScore)}`);
  };

  return (
    <div className="judge-pad">
      <h1 className="page-title display">Score entry</h1>
      <p className="page-sub">Built for tablets at the judges' table. Posting a score flashes it and pushes it to live results instantly.</p>

      <div className="grid cols-3" style={{ marginBottom: 14 }}>
        <Field label="Meet">
          <select className="input" value={meetId} onChange={(e) => { setMeetId(e.target.value); const m = db.meets.find((x) => x.id === e.target.value)!; setSessionId(m.sessions[0].id); setEvent(EVENTS[m.sessions[0].discipline][0].code); }}>
            {db.meets.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </Field>
        <Field label="Session">
          <select className="input" value={sessionId} onChange={(e) => { setSessionId(e.target.value); const s = meet.sessions.find((x) => x.id === e.target.value)!; setEvent(EVENTS[s.discipline][0].code); }}>
            {meet.sessions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="Event">
          <select className="input" value={event} onChange={(e) => setEvent(e.target.value)}>
            {events.map((ev) => <option key={ev.code} value={ev.code}>{ev.name}</option>)}
          </select>
        </Field>
      </div>

      {flash && (
        <div className="flash-score" style={{ marginBottom: 16, cursor: 'pointer' }} onClick={() => setFlash(null)} title="Tap to dismiss">
          <div className="name">{flash.name}</div>
          <div className="val">{flash.score.toFixed(3)}</div>
          <div style={{ fontSize: 12, color: 'var(--ice-300)', marginTop: 8 }}>tap to dismiss · score is live</div>
        </div>
      )}

      {active ? (
        <div className="card card-pad">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: 10 }}>
            <div>
              <h2 className="display" style={{ fontSize: 26 }}>{activeAthlete!.firstName} {activeAthlete!.lastName}</h2>
              <div style={{ color: 'var(--ink-soft)', fontSize: 14 }}>
                {db.clubs.find((c) => c.id === active.clubId)?.shortName} · {activeLevel?.name} · {events.find((e) => e.code === event)?.name}
              </div>
            </div>
            <button className="btn ghost small" onClick={() => { setActiveReg(null); setSv(''); setDed(''); }}>Cancel</button>
          </div>
          <div className="grid cols-2">
            <Field
              label={`Start value (D)${svMax != null ? ` — max ${svMax.toFixed(1)} for ${activeLevel!.name}` : ' — open'}`}
              hint="Production embeds the full MAG SV / Masters / WAG Open calculators here, capturing routine composition."
            >
              <input type="number" inputMode="decimal" step="0.1" style={{ fontSize: 22, fontWeight: 700 }} value={sv} onChange={(e) => setSv(e.target.value)} placeholder="0.0" autoFocus />
            </Field>
            <Field label="Total deductions (E)" hint="Execution + neutral deductions, summed.">
              <input type="number" inputMode="decimal" step="0.05" style={{ fontSize: 22, fontWeight: 700 }} value={ded} onChange={(e) => setDed(e.target.value)} placeholder="0.00" />
            </Field>
          </div>
          {svError && (
            <div className="card card-pad" style={{ background: 'var(--coral-100)', border: 'none', marginBottom: 12, padding: 10, fontSize: 14 }}>
              ⚠ SV {svNum.toFixed(1)} exceeds the {activeLevel!.name} cap of {svMax!.toFixed(1)}. Check the routine card.
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 44 }}>
              {finalScore != null ? finalScore.toFixed(3) : '—'}
            </div>
            <button className="btn primary" style={{ fontSize: 16, padding: '12px 28px' }} disabled={finalScore == null || svError} onClick={submit}>
              Post & flash score →
            </button>
          </div>
        </div>
      ) : (
        <div className="card" style={{ overflow: 'hidden' }}>
          <table className="tbl">
            <thead><tr><th>Athlete</th><th>Club</th><th>Level</th><th className="num">Score</th><th /></tr></thead>
            <tbody>
              {regs.map((r) => {
                const a = db.people.find((p) => p.id === r.athleteId)!;
                const sc = scoreFor(r.id);
                return (
                  <tr key={r.id}>
                    <td><strong>{a.firstName} {a.lastName}</strong></td>
                    <td>{db.clubs.find((c) => c.id === r.clubId)?.shortName}</td>
                    <td style={{ fontSize: 13 }}>{db.levels.find((l) => l.id === r.levelId)?.name}</td>
                    <td className="num score">{sc ? fmtScore(sc.final) : <Badge tone="info">awaiting</Badge>}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn small" onClick={() => { setActiveReg(r.id); setSv(sc?.sv?.toString() ?? ''); setDed(sc?.deductions?.toString() ?? ''); }}>
                        {sc ? 'Edit' : 'Score'}
                      </button>
                    </td>
                  </tr>
                );
              })}
              {regs.length === 0 && <tr><td colSpan={5} style={{ color: 'var(--ink-soft)' }}>No athletes registered on this event in this session.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
