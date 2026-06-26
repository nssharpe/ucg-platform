import { useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useDB, mutate } from '../lib/store';
import { useCapabilities } from '../lib/capabilities';
import { Badge, Field } from '../components/ui';
import { useToast } from '../components/ui-hooks';
import { pushScore } from '../lib/supabase';
import { EVENTS } from '../lib/types';
import type { Score } from '../lib/types';
import { fmtScore } from '../lib/scoring';
import { calcForLevel } from '../lib/calculators';
import type { CalcMessage } from '../lib/calculators';
import { computeScoring, isCalcStateV2 } from '../scoring';
import { ScoringPanel } from '../components/scoring/ScoringPanel';
import { CalcPanel } from '../components/CalcPanel';
import type { CalcPanelHandle } from '../components/CalcPanel';

/** Score details: how the score was built, with the calculator restored exactly
 *  as it was filled in. Athletes see their own; admins see all and can adjust
 *  (score verification / inquiries). Scores posted before the native panels
 *  carry a legacy iframe DOM snapshot and re-open in the embedded calculator. */
export function ScoreDetail() {
  const { scoreId } = useParams();
  const db = useDB();
  const score = db.scores.find((s) => s.id === decodeURIComponent(scoreId ?? ''));
  if (!score) return <p>Score not found.</p>;
  // Keyed so panel state resets when navigating between scores.
  return <ScoreDetailInner key={score.id} score={score} />;
}

function ScoreDetailInner({ score }: { score: Score }) {
  const db = useDB();
  const caps = useCapabilities();
  const toast = useToast();

  const reg = db.registrations.find((r) => r.id === score.regId);
  const level = reg && db.levels.find((l) => l.id === reg.levelId);
  const calcCfg = score.calc && reg && level ? calcForLevel(level.id, score.event) : null;
  const v2 = isCalcStateV2(score.calcState) && calcCfg && score.calcState.kind === calcCfg.kind
    ? score.calcState : null;

  // Legacy iframe restore (pre-native scores).
  const calcRef = useRef<CalcPanelHandle>(null);
  const [live, setLive] = useState<CalcMessage | null>(null);
  // Native panel state, editable in place.
  const [nativeSt, setNativeSt] = useState<unknown>(() => v2?.state ?? null);
  const [note, setNote] = useState('');

  const athlete = reg && db.people.find((p) => p.id === reg.athleteId);
  const event = db.events.find((m) => m.id === score.eventId);
  const session = event?.sessions.find((s) => s.id === score.sessionId);
  const club = reg && db.clubs.find((c) => c.id === reg.clubId);
  const eventName = session ? EVENTS[session.discipline].find((e) => e.code === score.event)?.name ?? score.event : score.event;

  const canView = caps.isAdmin || caps.isEventHost(score.eventId)
    || (!!reg && caps.personId === reg.athleteId);
  const canAdjust = caps.isAdmin;

  if (!canView) {
    return (
      <div className="card card-pad" style={{ maxWidth: 520 }}>
        <h2 className="display" style={{ fontSize: 22 }}>Not available</h2>
        <p>Score details are visible to the athlete who earned the score and to league admins.</p>
      </div>
    );
  }

  const isNative = !!v2 && nativeSt != null && !!calcCfg && !!level;
  const isLegacy = !isNative && !!score.calcState && !!calcCfg;
  const outcome = isNative ? computeScoring(calcCfg!.kind, nativeSt, level!.id, score.event) : null;

  // Live values for the adjustment readout: native outcome, else legacy bridge message.
  const liveD = outcome?.d ?? live?.d ?? score.sv;
  const liveE = outcome?.e ?? live?.e ?? score.eScore;
  const liveFinal = calcCfg?.produces === 'd'
    ? (liveD != null && score.deductions != null
      ? Math.max(0, Math.round((liveD - score.deductions) * 1000) / 1000)
      : score.final)
    : (outcome?.final ?? live?.final ?? score.final);

  const saveAdjustment = async () => {
    const legacyState = isLegacy ? await calcRef.current?.requestState() : null;
    mutate((db2) => {
      const s = db2.scores.find((x) => x.id === score.id)!;
      if (calcCfg?.produces === 'full') {
        s.sv = liveD; s.eScore = liveE;
        s.deductions = liveE != null ? Math.round((10 - liveE) * 1000) / 1000 : s.deductions;
      } else {
        s.sv = liveD;
      }
      s.final = liveFinal;
      if (isNative) s.calcState = { v: 2, kind: calcCfg!.kind, state: nativeSt };
      else s.calcState = legacyState ?? s.calcState;
      s.adjustNote = note || 'Adjusted after inquiry';
      s.adjustedAt = new Date().toISOString();
      s.enteredBy = 'admin-verification';
      pushScore(s);
    });
    toast(`Score adjusted to ${fmtScore(liveFinal)} — change is live on results.`);
  };

  return (
    <div style={{ maxWidth: 860 }}>
      <h1 className="page-title display">{athlete ? `${athlete.firstName} ${athlete.lastName}` : 'Score'} — {eventName}</h1>
      <p className="page-sub">
        {event && <Link to={`/results/${event.slug}`}>{event.name}</Link>} · {session?.name} · {club?.shortName} · {level?.name}
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

      {isNative || isLegacy ? (
        <>
          <h3 style={{ marginBottom: 8 }}>Calculator as submitted{canAdjust && ' — edit to adjust'}</h3>
          {isNative ? (
            <div className="card card-pad">
              <ScoringPanel kind={calcCfg!.kind} levelId={level!.id} eventCode={score.event} value={nativeSt} onChange={setNativeSt} />
            </div>
          ) : (
            <CalcPanel
              ref={calcRef}
              cfg={calcCfg!}
              eventCode={score.event}
              initialState={score.calcState}
              onLive={setLive}
              height={560}
            />
          )}
          {canAdjust && (
            <div className="card card-pad" style={{ marginTop: 14, borderLeft: '4px solid var(--coral-500)' }}>
              <h3 className="card-title">Score verification</h3>
              <div style={{ display: 'flex', gap: 14, alignItems: 'end', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 220 }}>
                  <Field label="Adjustment note (inquiry reference)">
                    <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Inquiry #12 — credit given for Barani" />
                  </Field>
                </div>
                <Readout label="New final" value={liveFinal} />
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
            {canAdjust && <> Admins can re-score it from the <Link to={`/judge?event=${score.eventId}`}>score entry pad</Link>.</>}
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
