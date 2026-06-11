import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useDB, mutate, useRole, PERSONA } from '../lib/store';
import { Badge, Field, useToast } from '../components/ui';
import { EVENTS } from '../lib/types';
import { fmtScore } from '../lib/scoring';
import { calcForLevel } from '../lib/calculators';
import type { CalcMessage } from '../lib/calculators';
import { CalcPanel } from '../components/CalcPanel';
import type { CalcPanelHandle } from '../components/CalcPanel';

/** Score details: how the score was built, with the calculator restored exactly
 *  as it was filled in. Athletes see their own; admins see all and can adjust
 *  (score verification / inquiries). */
export function ScoreDetail() {
  const { scoreId } = useParams();
  const db = useDB();
  const role = useRole();
  const toast = useToast();
  const score = db.scores.find((s) => s.id === decodeURIComponent(scoreId ?? ''));
  const calcRef = useRef<CalcPanelHandle>(null);
  const [live, setLive] = useState<CalcMessage | null>(null);
  const [note, setNote] = useState('');

  if (!score) return <p>Score not found.</p>;

  const reg = db.registrations.find((r) => r.id === score.regId);
  const athlete = reg && db.people.find((p) => p.id === reg.athleteId);
  const meet = db.meets.find((m) => m.id === score.meetId);
  const session = meet?.sessions.find((s) => s.id === score.sessionId);
  const level = reg && db.levels.find((l) => l.id === reg.levelId);
  const club = reg && db.clubs.find((c) => c.id === reg.clubId);
  const eventName = session ? EVENTS[session.discipline].find((e) => e.code === score.event)?.name ?? score.event : score.event;

  const canView = role === 'admin' || role === 'judge' || role === 'meet-host'
    || (role === 'athlete' && reg?.athleteId === PERSONA.athleteId);
  const canAdjust = role === 'admin';

  if (!canView) {
    return (
      <div className="card card-pad" style={{ maxWidth: 520 }}>
        <h2 className="display" style={{ fontSize: 22 }}>Not available</h2>
        <p>Score details are visible to the athlete who earned the score and to league admins.</p>
      </div>
    );
  }

  const calcCfg = score.calc && reg && level ? calcForLevel(level.id, score.event) : null;
  const hasState = !!score.calcState && !!calcCfg;

  const saveAdjustment = async () => {
    const state = await calcRef.current?.requestState();
    const d = live?.d ?? score.sv;
    const e = live?.e ?? score.eScore;
    const final = live?.final ?? (calcCfg?.produces === 'd' && d != null && score.deductions != null
      ? Math.max(0, Math.round((d - score.deductions) * 1000) / 1000)
      : score.final);
    mutate((db2) => {
      const s = db2.scores.find((x) => x.id === score.id)!;
      if (calcCfg?.produces === 'full') {
        s.sv = d; s.eScore = e;
        s.deductions = e != null ? Math.round((10 - e) * 1000) / 1000 : s.deductions;
      } else {
        s.sv = d;
      }
      s.final = final;
      s.calcState = state ?? s.calcState;
      s.adjustNote = note || 'Adjusted after inquiry';
      s.adjustedAt = new Date().toISOString();
      s.enteredBy = 'admin-verification';
    });
    toast(`Score adjusted to ${fmtScore(final)} — change is live on results.`);
  };

  return (
    <div style={{ maxWidth: 860 }}>
      <h1 className="page-title display">{athlete ? `${athlete.firstName} ${athlete.lastName}` : 'Score'} — {eventName}</h1>
      <p className="page-sub">
        {meet && <Link to={`/results/${meet.slug}`}>{meet.name}</Link>} · {session?.name} · {club?.shortName} · {level?.name}
        {' '}· Unique URL: <code>#/scores/{encodeURIComponent(score.id)}</code>
      </p>

      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <ScoreStat label="D / Start value" value={fmtScore(score.sv)} />
        {score.eScore != null
          ? <ScoreStat label="E-score" value={fmtScore(score.eScore)} />
          : <ScoreStat label="Deductions" value={fmtScore(score.deductions)} />}
        <ScoreStat label="Final" value={fmtScore(score.final)} accent />
        <div className="card card-pad">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Badge tone={score.source === 'manual' ? 'warn' : 'ok'}>{score.source === 'manual' ? 'Manual entry' : 'Calculator scored'}</Badge>
            <span style={{ fontSize: 12, color: 'var(--ink-soft)' }}>
              {score.enteredBy} · {score.enteredAt.slice(0, 16).replace('T', ' ')}
            </span>
            {score.adjustedAt && <Badge tone="info">Adjusted {score.adjustedAt.slice(0, 10)}</Badge>}
            {score.adjustNote && <span style={{ fontSize: 12 }}>"{score.adjustNote}"</span>}
          </div>
        </div>
      </div>

      {hasState ? (
        <>
          <h3 style={{ marginBottom: 8 }}>Calculator as submitted{canAdjust && ' — edit to adjust'}</h3>
          <CalcPanel
            ref={calcRef}
            cfg={calcCfg!}
            eventCode={score.event}
            initialState={score.calcState}
            onLive={setLive}
            height={560}
          />
          {canAdjust && (
            <div className="card card-pad" style={{ marginTop: 14, borderLeft: '4px solid var(--coral-500)' }}>
              <h3 className="card-title">Score verification</h3>
              <div style={{ display: 'flex', gap: 14, alignItems: 'end', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 220 }}>
                  <Field label="Adjustment note (inquiry reference)">
                    <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Inquiry #12 — credit given for Barani" />
                  </Field>
                </div>
                <Readout label="New final" value={live?.final ?? score.final} />
                <button className="btn primary" style={{ marginBottom: 14 }} onClick={saveAdjustment}>Save adjusted score</button>
              </div>
              <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', margin: 0 }}>
                Edits above recompute live. Saving updates the official score, stamps the adjustment, and refreshes live results.
              </p>
            </div>
          )}
        </>
      ) : (
        <div className="card card-pad">
          <p style={{ margin: 0, color: 'var(--ink-soft)' }}>
            {score.source === 'manual'
              ? 'This score was entered manually — there is no calculator breakdown to show.'
              : 'No calculator state was captured with this score (e.g. seeded demo data).'}
            {canAdjust && <> Admins can re-score it from the <Link to={`/judge?meet=${score.meetId}`}>score entry pad</Link>.</>}
          </p>
        </div>
      )}
    </div>
  );
}

function ScoreStat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="card card-pad">
      <div className={`stat-big${accent ? ' stat-accent' : ''}`}>{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

function Readout({ label, value }: { label: string; value: number | null }) {
  return (
    <div style={{ textAlign: 'center', marginBottom: 14 }}>
      <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--ink-soft)', fontWeight: 700 }}>{label}</div>
      <div style={{ fontFamily: 'var(--font-display)', fontSize: 30, color: 'var(--coral-600)' }}>{fmtScore(value)}</div>
    </div>
  );
}
