import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { CalcConfig, CalcMessage } from '../lib/calculators';
import { calcUrl } from '../lib/calculators';

export interface CalcPanelHandle {
  /** Capture the calculator's current form state (resolves null on timeout). */
  requestState: () => Promise<unknown>;
}

/** Embeds a scoring calculator inline and streams its live D/E/Final to the parent.
 *  Optionally restores a previously captured form state (score review/adjustment). */
export const CalcPanel = forwardRef<CalcPanelHandle, {
  cfg: CalcConfig;
  eventCode: string;
  initialState?: unknown;
  onLive?: (msg: CalcMessage) => void;
  height?: number;
}>(function CalcPanel({ cfg, eventCode, initialState, onLive, height = 520 }, ref) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const pending = useRef(new Map<string, (s: unknown) => void>());
  const [ready, setReady] = useState(false);
  const onLiveRef = useRef(onLive);
  onLiveRef.current = onLive;
  const initialStateRef = useRef(initialState);
  initialStateRef.current = initialState;

  useEffect(() => {
    const onMsg = (ev: MessageEvent) => {
      const d = ev.data;
      if (!d || ev.source !== frameRef.current?.contentWindow) return;
      if (d.type === 'ucg-calc') onLiveRef.current?.(d as CalcMessage);
      else if (d.type === 'ucg-calc-ready') {
        setReady(true);
        if (initialStateRef.current) {
          frameRef.current?.contentWindow?.postMessage({ type: 'ucg-calc-set-state', state: initialStateRef.current }, '*');
        }
      } else if (d.type === 'ucg-calc-state' && d.reqId && pending.current.has(d.reqId)) {
        pending.current.get(d.reqId)!(d.state);
        pending.current.delete(d.reqId);
      }
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  useImperativeHandle(ref, () => ({
    requestState: () =>
      new Promise((resolve) => {
        const reqId = `r${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
        pending.current.set(reqId, resolve);
        frameRef.current?.contentWindow?.postMessage({ type: 'ucg-calc-get-state', reqId }, '*');
        setTimeout(() => {
          if (pending.current.has(reqId)) { pending.current.delete(reqId); resolve(null); }
        }, 800);
      }),
  }), []);

  return (
    <div style={{ border: '1px solid var(--line)', borderRadius: 'var(--radius)', overflow: 'hidden', background: 'var(--white)' }}>
      <iframe
        ref={frameRef}
        title={cfg.label}
        src={calcUrl(cfg, eventCode)}
        style={{ border: 'none', width: '100%', height, display: 'block', opacity: ready ? 1 : 0.4, transition: 'opacity 0.2s' }}
      />
    </div>
  );
});
