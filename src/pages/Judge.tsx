import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useDB, mutate } from '../lib/store';
import { pushScore, judgeUnlock, judgeSubmitScore } from '../lib/supabase';
import { Badge, Field } from '../components/ui';
import { useToast } from '../components/ui-hooks';
import { APPARATUS } from '../lib/types';
import type { Score } from '../lib/types';
import { fmtScore } from '../lib/scoring';
import { calcForLevel, calcSource, scoreFromOutcome, scoreDetailPath } from '../lib/calculators';
import { computeScoring, initScoring, isCalcStateV2 } from '../scoring';
import { ScoringPanel } from '../components/scoring/ScoringPanel';
import { useCapabilities } from '../lib/capabilities';
import { eventIsInPhase } from '../lib/events-core';
import { loadJudgeAccessMap, saveJudgeAccess, withJudgeAccess } from '../lib/judge-access-storage';

/** Tablet-first judge pad. The level's scoring panel is built into the scoring
 *  view — judges build the routine natively and the score posts live.
 *  A manual override is always available. */
export function Judge() {
  const db = useDB();
  const caps = useCapabilities();
  const toast = useToast();
  const [searchParams] = useSearchParams();
  const requestedEvent = searchParams.get('event');
  const liveEvents = db.events.filter((m) => eventIsInPhase(m, 'in-progress') || eventIsInPhase(m, 'reg-closed'));
  const [eventId, setEventId] = useState(
    (requestedEvent && db.events.find((m) => m.id === requestedEvent || m.slug === requestedEvent)?.id)
    || liveEvents[0]?.id || db.events[0]?.id || '',
  );
  const eventRec = db.events.find((m) => m.id === eventId);
  const [sessionId, setSessionId] = useState(eventRec?.sessions[0]?.id ?? '');
  const session = eventRec?.sessions.find((s) => s.id === sessionId) ?? eventRec?.sessions[0];
  const apparatusDefs = session ? APPARATUS[session.discipline] : [];
  const [apparatus, setApparatus] = useState(apparatusDefs[0]?.code ?? '');
  const [flash, setFlash] = useState<{ name: string; score: number } | null>(null);

  // Codeless judge access (2026-07-19): a device that unlocked with an
  // event's access code/link/QR can score that event with no signed-in
  // identity at all — see docs/specs (judge access codes). `accessMap` is
  // eventId -> token, persisted in localStorage across visits.
  const [accessMap, setAccessMap] = useState(() => loadJudgeAccessMap());
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState('');
  const [unlocking, setUnlocking] = useState(false);
  const [posting, setPosting] = useState(false);
  const privileged = caps.isAdmin || caps.managedClubIds.length > 0;
  const unlockedForEvent = !!eventRec && !!accessMap[eventRec.id];
  const canScore = privileged || unlockedForEvent;

  const unlockWithCode = async () => {
    const trimmed = code.trim();
    if (!/^\d{6}$/.test(trimmed)) { setCodeError('Enter the 6-digit code exactly as given.'); return; }
    setUnlocking(true); setCodeError('');
    const res = await judgeUnlock({ code: trimmed });
    setUnlocking(false);
    if (!res.ok || !res.eventId || !res.token) { setCodeError(res.error ?? 'Invalid or expired code.'); return; }
    saveJudgeAccess(res.eventId, res.token);
    setAccessMap((m) => withJudgeAccess(m, res.eventId!, res.token!));
    setEventId(res.eventId);
    const unlockedEvent = db.events.find((m) => m.id === res.eventId);
    if (unlockedEvent) { setSessionId(unlockedEvent.sessions[0]?.id ?? ''); setApparatus(APPARATUS[unlockedEvent.sessions[0]?.discipline]?.[0]?.code ?? ''); }
    setCode('');
    toast('Judge access unlocked for this event.');
  };

  // Non-privileged (code-unlocked) users only see events they've actually
  // unlocked — the full roster is public info but there's no reason to dead-
  // end them on an event they have no code for.
  const selectableEvents = privileged ? db.events : db.events.filter((m) => accessMap[m.id]);

  const regs = useMemo(() => {
    if (!eventRec || !session) return [];
    const inSession = db.registrations.filter((r) => r.eventId === eventRec.id && r.sessionId === session.id && !r.refunded && r.apparatus.includes(apparatus));
    return inSession.sort((a, b) => {
      const an = db.people.find((p) => p.id === a.athleteId)!;
      const bn = db.people.find((p) => p.id === b.athleteId)!;
      return an.lastName.localeCompare(bn.lastName);
    });
  }, [db, eventRec, session, apparatus]);

  const scoreFor = (regId: string) => db.scores.find((s) => s.id === `${eventRec?.id}|${regId}|${apparatus}`);

  const [activeReg, setActiveReg] = useState<string | null>(null);
  const [sv, setSv] = useState('');
  const [ded, setDed] = useState('');
  /** Execution-only deductions (judge-typed). Only used in usingCalcSv mode.
   *  Total deductions = execDed + neutralFromCalc; stored in `ded`. */
  const [execDed, setExecDed] = useState('');
  const [override, setOverride] = useState(false);
  const [calcSt, setCalcSt] = useState<unknown>(null);

  if (!eventRec || !session) {
    return (
      <div className="card card-pad" style={{ maxWidth: 520 }}>
        <h2 className="display" style={{ fontSize: 22 }}>No events yet</h2>
        <p>Score entry needs at least one event with a session. Create an event under
          Events to get started.</p>
      </div>
    );
  }

  const active = regs.find((r) => r.id === activeReg);
  const activeAthlete = active && db.people.find((p) => p.id === active.athleteId);
  const activeLevel = active && db.levels.find((l) => l.id === active.levelId);
  const calcCfg = activeLevel ? calcForLevel(activeLevel.id, apparatus) : null;
  const svMax = activeLevel?.svMax;

  // Pure and cheap — recompute every render (the React Compiler memoizes it).
  const outcome = calcCfg && activeLevel && calcSt != null
    ? computeScoring(calcCfg.kind, calcSt, activeLevel.id, apparatus)
    : null;

  const usingCalcFull = !!calcCfg && calcCfg.produces === 'full' && !override;
  const usingCalcSv = !!calcCfg && calcCfg.produces === 'd' && !override;

  /** Neutral option deductions from the calculator panel (OOB, floor time, etc.).
   *  These do NOT reduce the displayed start value — they are added to execution
   *  deductions to form total deductions.
   *  Derived from the 'Neutral deductions' breakdown row (negative value → abs). */
  const neutralFromCalc = usingCalcSv && outcome
    ? Math.abs(outcome.breakdown.find((b) => b.label === 'Neutral deductions')?.value ?? 0)
    : 0;

  const svNum = usingCalcSv ? (outcome?.d ?? NaN) : parseFloat(sv);
  const dedNum = parseFloat(ded);
  const svError = !isNaN(svNum) && svMax != null && svNum > svMax;

  // What would post right now?
  const finalScore = usingCalcFull
    ? (outcome?.final ?? null)
    : (!isNaN(svNum) && !isNaN(dedNum) ? Math.max(0, Math.round((svNum - dedNum) * 1000) / 1000) : null);

  const openScoring = (reg: typeof regs[number]) => {
    const sc = scoreFor(reg.id);
    const level = db.levels.find((l) => l.id === reg.levelId);
    const cfg = level ? calcForLevel(level.id, apparatus) : null;
    setActiveReg(reg.id);
    setSv(sc?.sv?.toString() ?? '');
    setDed(sc?.deductions?.toString() ?? '');
    setExecDed('');
    setOverride(false);
    // Editing a score re-opens the panel exactly as it was posted.
    if (cfg && level) {
      const prior = sc?.calcState;
      setCalcSt(isCalcStateV2(prior) && prior.kind === cfg.kind ? prior.state : initScoring(cfg.kind, level.id, apparatus));
    } else {
      setCalcSt(null);
    }
  };

  const close = () => { setActiveReg(null); setSv(''); setDed(''); setExecDed(''); setCalcSt(null); };

  const submit = async () => {
    if (!active || finalScore == null) return;
    const athleteName = `${activeAthlete!.firstName} ${activeAthlete!.lastName}`;
    let fields: Partial<Score>;
    if (usingCalcFull && outcome) {
      fields = scoreFromOutcome(calcCfg!, outcome);
    } else {
      // SV-only panels still credit the calculator as the SV source unless overridden.
      fields = {
        sv: isNaN(svNum) ? null : svNum, deductions: isNaN(dedNum) ? null : dedNum, eScore: null,
        source: usingCalcSv ? calcSource(calcCfg!.kind) : 'manual',
      };
    }
    const calcState = calcCfg && calcSt != null ? { v: 2 as const, kind: calcCfg.kind, state: calcSt } : undefined;
    const id = `${eventRec.id}|${active.id}|${apparatus}`;
    const base = {
      id, eventId: eventRec.id, sessionId: session.id, regId: active.id, apparatus,
      sv: fields.sv ?? null, deductions: fields.deductions ?? null, eScore: fields.eScore ?? null,
      final: finalScore, source: fields.source,
      calc: calcCfg?.kind, calcState, flashed: true,
    };

    if (privileged) {
      const applied = mutate((d) => {
        d.scores = d.scores.filter((s) => s.id !== id);
        const score = { ...base, enteredBy: 'judge-you', enteredAt: new Date().toISOString() };
        d.scores.push(score);
        pushScore(score);
      });
      if (!applied) return; // offline read-only gate — no false "Score posted"
    } else {
      // Codeless judge: an anonymous/unprivileged device can't write `scores`
      // under RLS at all — the judge-entry Edge Function (service role) does
      // the real write; this is a push-free LOCAL mutate for instant UI only
      // (never calls pushScore, which would try — and fail RLS — to enqueue
      // the same write again).
      const token = accessMap[eventRec.id];
      if (!token) { toast('Judge access for this event has expired — enter the code again.', { variant: 'error' }); return; }
      setPosting(true);
      const res = await judgeSubmitScore({
        token, regId: active.id, apparatus,
        sv: base.sv, deductions: base.deductions, eScore: base.eScore, final: base.final,
        source: base.source, calc: base.calc, calcState: base.calcState, flashed: true,
      });
      setPosting(false);
      if (!res.ok) { toast(res.error ?? 'Could not post the score.', { variant: 'error' }); return; }
      mutate((d) => {
        d.scores = d.scores.filter((s) => s.id !== id);
        d.scores.push({ ...base, enteredBy: 'judge-code', enteredAt: new Date().toISOString() });
      });
    }
    setFlash({ name: athleteName, score: finalScore });
    close();
    toast(`Score posted: ${athleteName} — ${fmtScore(finalScore)}`);
  };

  // Score entry is for the event host / league admins, OR a device that
  // unlocked this event with its judge access code (RLS also blocks score
  // writes for anyone without one of those; this is the matching UI gate).
  if (!canScore) {
    return (
      <div className="card card-pad" style={{ maxWidth: 520 }}>
        <h2 className="display" style={{ fontSize: 22 }}>Score entry is restricted</h2>
        <p>Only the event host, league admins, and unlocked judge devices can enter scores.</p>
        <div style={{ marginTop: 16, maxWidth: 260 }}>
          <Field label="Have a judge access code?" hint="Enter the 6-digit code from the event host, or open the link/QR they gave you.">
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                type="text" inputMode="numeric" className="input" maxLength={6}
                style={{ fontSize: 20, fontWeight: 700, letterSpacing: '0.15em', textAlign: 'center' }}
                value={code}
                onChange={(e) => { setCode(e.target.value.replace(/\D/g, '').slice(0, 6)); setCodeError(''); }}
                onKeyDown={(e) => { if (e.key === 'Enter') unlockWithCode(); }}
                placeholder="000000"
              />
              <button className="btn primary" disabled={unlocking || code.trim().length !== 6} onClick={unlockWithCode}>
                {unlocking ? 'Checking…' : 'Unlock'}
              </button>
            </div>
          </Field>
          {codeError && <p style={{ color: 'var(--coral-600)', fontSize: 13, marginTop: 6 }}>{codeError}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="judge-pad">
      <h1 className="page-title display">Score entry</h1>
      <p className="page-sub">Built for tablets at the judges' table. The level's calculator is part of the scoring view; posting flashes the score and pushes it to live results instantly.</p>

      <div className="grid cols-3" style={{ marginBottom: 14 }}>
        <Field label="Event">
          {/* Opened from a specific event's details page → lock the event so a host
              can't accidentally switch contexts mid-entry. */}
          {requestedEvent && eventRec ? (
            <input type="text" className="input" value={eventRec.name} readOnly disabled data-tip="Locked to the event you opened score entry from" />
          ) : (
            <select className="input" value={eventId} onChange={(e) => { setEventId(e.target.value); const m = db.events.find((x) => x.id === e.target.value)!; setSessionId(m.sessions[0].id); setApparatus(APPARATUS[m.sessions[0].discipline][0].code); close(); }}>
              {selectableEvents.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          )}
        </Field>
        <Field label="Session">
          <select className="input" value={sessionId} onChange={(e) => { setSessionId(e.target.value); const s = eventRec.sessions.find((x) => x.id === e.target.value)!; setApparatus(APPARATUS[s.discipline][0].code); close(); }}>
            {eventRec.sessions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="Apparatus">
          <select className="input" value={apparatus} onChange={(e) => { setApparatus(e.target.value); close(); }}>
            {apparatusDefs.map((a) => <option key={a.code} value={a.code}>{a.name}</option>)}
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
                {db.clubs.find((c) => c.id === active.clubId)?.shortName} · {activeLevel?.name} · {apparatusDefs.find((e) => e.code === apparatus)?.name}
                {calcCfg && <> · <strong>{calcCfg.label}</strong></>}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {calcCfg && (
                <label className="checkrow" style={{ margin: 0 }} data-tip="Type the scores yourself instead of using the calculator">
                  <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} /> Manual override
                </label>
              )}
              <button className="btn ghost small" onClick={close}>Cancel</button>
            </div>
          </div>

          {calcCfg && !override && calcSt != null && (
            <div style={{ marginBottom: 14 }}>
              <ScoringPanel kind={calcCfg.kind} levelId={activeLevel!.id} apparatusCode={apparatus} value={calcSt} onChange={setCalcSt} />
            </div>
          )}

          {usingCalcFull ? (
            <div style={{ display: 'flex', gap: 22, alignItems: 'center', flexWrap: 'wrap' }}>
              <Readout label="D" value={outcome?.d} />
              <Readout label="E" value={outcome?.e} />
              <Readout label="Final" value={outcome?.final} accent />
              <button className="btn primary" style={{ fontSize: 16, padding: '12px 28px' }} disabled={finalScore == null || posting} onClick={submit}>
                {posting ? 'Posting…' : 'Post & flash score →'}
              </button>
            </div>
          ) : (
            <>
              <div className="grid cols-2">
                <Field
                  label={`Start value (D)${svMax != null ? ` — max ${svMax.toFixed(1)} for ${activeLevel!.name}` : ' — open'}`}
                  hint={usingCalcSv ? 'Builds live from the routine above. Tick manual override to type it.' : 'Enter the start value.'}
                >
                  <input type="number" inputMode="decimal" step="0.1" style={{ fontSize: 22, fontWeight: 700 }}
                    value={usingCalcSv ? (outcome?.d ?? '') : sv}
                    readOnly={usingCalcSv}
                    onChange={(e) => setSv(e.target.value)} placeholder="0.0" />
                </Field>
                {usingCalcSv ? (
                  <Field
                    label="Execution deductions"
                    hint="Judge-assessed execution deductions only. Neutral deductions from the calculator are added automatically below."
                  >
                    <input
                      type="number" inputMode="decimal" step="0.05"
                      style={{ fontSize: 22, fontWeight: 700 }}
                      value={execDed}
                      onChange={(e) => {
                        setExecDed(e.target.value);
                        const exec = parseFloat(e.target.value);
                        if (!isNaN(exec)) setDed((Math.round((exec + neutralFromCalc) * 1000) / 1000).toString());
                        else setDed('');
                      }}
                      placeholder="0.00"
                      autoFocus
                    />
                  </Field>
                ) : (
                  <Field label="Total deductions (execution + neutral)" hint="Execution + neutral deductions, summed.">
                    <input type="number" inputMode="decimal" step="0.05" style={{ fontSize: 22, fontWeight: 700 }} value={ded} onChange={(e) => setDed(e.target.value)} placeholder="0.00" />
                  </Field>
                )}
              </div>
              {usingCalcSv && (
                <div style={{ marginBottom: 10 }}>
                  <Field
                    label={`Total deductions (execution + neutral)${neutralFromCalc > 0 ? ` — neutral: ${neutralFromCalc.toFixed(3)} from calculator` : ''}`}
                    hint="Auto-calculated from execution deductions above + neutral deductions from the calculator. Edit directly to override."
                  >
                    <input
                      type="number" inputMode="decimal" step="0.05"
                      style={{ fontSize: 18, fontWeight: 600 }}
                      value={ded}
                      onChange={(e) => { setDed(e.target.value); }}
                      placeholder="0.00"
                    />
                  </Field>
                </div>
              )}
              {svError && (
                <div className="card card-pad" style={{ background: 'var(--coral-100)', border: 'none', marginBottom: 12, padding: 10, fontSize: 14 }}>
                  ⚠ SV {svNum.toFixed(1)} exceeds the {activeLevel!.name} cap of {svMax!.toFixed(1)}. Check the routine card.
                </div>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                <div>
                  <div style={{ fontFamily: 'var(--font-display)', fontSize: 44 }}>
                    {finalScore != null ? finalScore.toFixed(3) : '—'}
                  </div>
                  {finalScore != null && !isNaN(svNum) && !isNaN(dedNum) && (
                    <div style={{ fontSize: 12, color: 'var(--ink-soft)', marginTop: 2 }}>
                      {svNum.toFixed(3)} (SV) − {dedNum.toFixed(3)} (total deductions)
                    </div>
                  )}
                </div>
                <button className="btn primary" style={{ fontSize: 16, padding: '12px 28px' }} disabled={finalScore == null || svError || posting} onClick={submit}>
                  {posting ? 'Posting…' : 'Post & flash score →'}
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
