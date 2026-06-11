import { useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useDB, mutate } from '../lib/store';
import { Badge, Field, useToast } from '../components/ui';
import { EVENTS } from '../lib/types';
import type { Score } from '../lib/types';
import { fmtScore } from '../lib/scoring';
import { calcForLevel, scoreFromCalc, scoreDetailPath } from '../lib/calculators';
import type { CalcMessage } from '../lib/calculators';
import { CalcPanel } from '../components/CalcPanel';
import type { CalcPanelHandle } from '../components/CalcPanel';

/** Tablet-first judge pad. The level's scoring calculator is embedded directly in
 *  the scoring view — judges build the routine there and the score posts live.
 *  A manual override is always available. */
export function Judge() {
  const db = useDB();
  const toast = useToast();
  const [searchParams] = useSearchParams();
  const requestedMeet = searchParams.get('meet');
  const liveMeets = db.meets.filter((m) => m.status === 'in-progress' || m.status === 'reg-closed');
  const [meetId, setMeetId] = useState(
    (requestedMeet && db.meets.find((m) => m.id === requestedMeet || m.slug === requestedMeet)?.id)
    || liveMeets[0]?.id || db.meets[0].id,
  );
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
  const [override, setOverride] = useState(false);
  const [live, setLive] = useState<CalcMessage | null>(null);
  const calcRef = useRef<CalcPanelHandle>(null);

  const active = regs.find((r) => r.id === activeReg);
  const activeAthlete = active && db.people.find((p) => p.id === active.athleteId);
  const activeLevel = active && db.levels.find((l) => l.id === active.levelId);
  const calcCfg = activeLevel ? calcForLevel(activeLevel.id, event) : null;
  const svMax = activeLevel?.svMax;
  const svNum = parseFloat(sv);
  const dedNum = parseFloat(ded);
  const svError = sv !== '' && svMax != null && svNum > svMax;

  // What would post right now?
  const usingCalcFull = !!calcCfg && calcCfg.produces === 'full' && !override;
  const finalScore = usingCalcFull
    ? (live?.final ?? null)
    : (!isNaN(svNum) && !isNaN(dedNum) ? Math.max(0, Math.round((svNum - dedNum) * 1000) / 1000) : null);

  const openScoring = (reg: typeof regs[number]) => {
    const sc = scoreFor(reg.id);
    setActiveReg(reg.id);
    setSv(sc?.sv?.toString() ?? '');
    setDed(sc?.deductions?.toString() ?? '');
    setOverride(false);
    setLive(null);
  };

  const onCalcLive = (msg: CalcMessage) => {
    setLive(msg);
    // SV-only calculators stream the start value into the form unless overridden.
    if (calcCfg && calcCfg.produces === 'd' && !override && msg.d != null) setSv(String(msg.d));
  };

  const submit = async () => {
    if (!active || finalScore == null) return;
    const athleteName = `${activeAthlete!.firstName} ${activeAthlete!.lastName}`;
    const calcState = calcCfg ? await calcRef.current?.requestState() : null;
    let fields: Partial<Score>;
    if (usingCalcFull && live) {
      fields = scoreFromCalc(calcCfg!, live);
    } else {
      fields = { sv: isNaN(svNum) ? null : svNum, deductions: isNaN(dedNum) ? null : dedNum, eScore: null, source: 'manual' };
    }
    mutate((d) => {
      const id = `${meet.id}|${active.id}|${event}`;
      d.scores = d.scores.filter((s) => s.id !== id);
      d.scores.push({
        id, meetId: meet.id, sessionId: session.id, regId: active.id, event,
        sv: fields.sv ?? null, deductions: fields.deductions ?? null, eScore: fields.eScore ?? null,
        final: finalScore, source: fields.source,
        calc: calcCfg?.kind, calcState: calcState ?? undefined,
        enteredBy: 'judge-you', enteredAt: new Date().toISOString(), flashed: true,
      });
    });
    setFlash({ name: athleteName, score: finalScore });
    setActiveReg(null); setSv(''); setDed(''); setLive(null);
    toast(`Score posted: ${athleteName} — ${fmtScore(finalScore)}`);
  };

  return (
    <div className="judge-pad">
      <h1 className="page-title display">Score entry</h1>
      <p className="page-sub">Built for tablets at the judges' table. The level's calculator is part of the scoring view; posting flashes the score and pushes it to live results instantly.</p>

      <div className="grid cols-3" style={{ marginBottom: 14 }}>
        <Field label="Meet">
          <select className="input" value={meetId} onChange={(e) => { setMeetId(e.target.value); const m = db.meets.find((x) => x.id === e.target.value)!; setSessionId(m.sessions[0].id); setEvent(EVENTS[m.sessions[0].discipline][0].code); setActiveReg(null); }}>
            {db.meets.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </Field>
        <Field label="Session">
          <select className="input" value={sessionId} onChange={(e) => { setSessionId(e.target.value); const s = meet.sessions.find((x) => x.id === e.target.value)!; setEvent(EVENTS[s.discipline][0].code); setActiveReg(null); }}>
            {meet.sessions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="Event">
          <select className="input" value={event} onChange={(e) => { setEvent(e.target.value); setActiveReg(null); }}>
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
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: 10, gap: 10, flexWrap: 'wrap' }}>
            <div>
              <h2 className="display" style={{ fontSize: 26 }}>{activeAthlete!.firstName} {activeAthlete!.lastName}</h2>
              <div style={{ color: 'var(--ink-soft)', fontSize: 14 }}>
                {db.clubs.find((c) => c.id === active.clubId)?.shortName} · {activeLevel?.name} · {events.find((e) => e.code === event)?.name}
                {calcCfg && <> · <strong>{calcCfg.label}</strong></>}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {calcCfg && (
                <label className="checkrow" style={{ margin: 0 }} data-tip="Type the scores yourself instead of using the calculator">
                  <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} /> Manual override
                </label>
              )}
              <button className="btn ghost small" onClick={() => { setActiveReg(null); setSv(''); setDed(''); setLive(null); }}>Cancel</button>
            </div>
          </div>

          {calcCfg && (
            <div style={{ marginBottom: 14 }}>
              <CalcPanel ref={calcRef} cfg={calcCfg} eventCode={event} onLive={onCalcLive} />
            </div>
          )}

          {usingCalcFull ? (
            <div style={{ display: 'flex', gap: 22, alignItems: 'center', flexWrap: 'wrap' }}>
              <Readout label="D" value={live?.d} />
              <Readout label="E" value={live?.e} />
              <Readout label="Final" value={live?.final} accent />
              <button className="btn primary" style={{ fontSize: 16, padding: '12px 28px' }} disabled={finalScore == null} onClick={submit}>
                Post & flash score →
              </button>
            </div>
          ) : (
            <>
              <div className="grid cols-2">
                <Field
                  label={`Start value (D)${svMax != null ? ` — max ${svMax.toFixed(1)} for ${activeLevel!.name}` : ' — open'}`}
                  hint={calcCfg && !override ? 'Streams from the calculator above. Tick manual override to type it.' : 'Enter the start value.'}
                >
                  <input type="number" inputMode="decimal" step="0.1" style={{ fontSize: 22, fontWeight: 700 }} value={sv}
                    readOnly={!!calcCfg && !override}
                    onChange={(e) => setSv(e.target.value)} placeholder="0.0" />
                </Field>
                <Field label="Total deductions (E)" hint="Execution + neutral deductions, summed.">
                  <input type="number" inputMode="decimal" step="0.05" style={{ fontSize: 22, fontWeight: 700 }} value={ded} onChange={(e) => setDed(e.target.value)} placeholder="0.00" autoFocus={!!calcCfg} />
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
            </>
          )}
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
                    <td className="num score">
                      {sc ? <Link to={scoreDetailPath(sc.id)} data-tip="Score details">{fmtScore(sc.final)}</Link> : <Badge tone="info">awaiting</Badge>}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn small" onClick={() => openScoring(r)}>
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

function Readout({ label, value, accent }: { label: string; value: number | null | undefined; accent?: boolean }) {
  return (
    <div style={{ textAlign: 'center', minWidth: 64 }}>
      <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--ink-soft)', fontWeight: 700 }}>{label}</div>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: 34, color: accent ? 'var(--coral-600)' : 'var(--ink)' }}>{fmtScore(value)}</div>
    </div>
  );
}
