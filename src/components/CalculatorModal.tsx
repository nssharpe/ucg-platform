import { useEffect, useRef, useState } from 'react';
import type { CalcConfig, CalcMessage } from '../lib/calculators';
import { calcUrl } from '../lib/calculators';
import { fmtScore } from '../lib/scoring';

/** Embeds a NAIGC calculator in an iframe and bridges its live score back. */
export function CalculatorModal({ cfg, eventCode, eventName, athleteName, onUse, onClose }: {
  cfg: CalcConfig;
  eventCode: string;
  eventName: string;
  athleteName: string;
  onUse: (msg: CalcMessage) => void;
  onClose: () => void;
}) {
  const [live, setLive] = useState<CalcMessage | null>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const onMsg = (ev: MessageEvent) => {
      const d = ev.data;
      if (d && d.type === 'ucg-calc') setLive(d as CalcMessage);
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  const hasScore = live && (live.final != null || live.d != null);
  const useDisabled = !hasScore;

  return (
    <div className="modal-veil" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ width: 'min(960px, 100%)', maxHeight: '92vh', padding: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--line)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <h2 className="display" style={{ fontSize: 19 }}>{cfg.label}</h2>
            <div style={{ fontSize: 13, color: 'var(--ink-soft)' }}>{athleteName} · {eventName}</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ display: 'flex', gap: 14, fontVariantNumeric: 'tabular-nums' }}>
              {cfg.produces === 'full' ? (
                <>
                  <ScoreReadout label="D" value={live?.d} />
                  <ScoreReadout label="E" value={live?.e} />
                  <ScoreReadout label="Final" value={live?.final} accent />
                </>
              ) : (
                <ScoreReadout label="Start value" value={live?.d} accent />
              )}
            </div>
            <button className="btn ghost small" onClick={onClose}>Close</button>
            <button className="btn primary" disabled={useDisabled} onClick={() => live && onUse(live)}>
              Use this {cfg.produces === 'full' ? 'score' : 'SV'} →
            </button>
          </div>
        </div>
        <iframe
          ref={frameRef}
          title={cfg.label}
          src={calcUrl(cfg, eventCode)}
          style={{ border: 'none', width: '100%', flex: 1, minHeight: 520, background: 'var(--white)' }}
        />
      </div>
    </div>
  );
}

function ScoreReadout({ label, value, accent }: { label: string; value: number | null | undefined; accent?: boolean }) {
  return (
    <div style={{ textAlign: 'center', minWidth: 56 }}>
      <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--ink-soft)', fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color: accent ? 'var(--coral-600)' : 'var(--ink)' }}>{fmtScore(value)}</div>
    </div>
  );
}
