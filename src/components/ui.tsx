import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ToastCtx, type ToastOptions } from './ui-hooks';
import { subscribeToast } from '../lib/toast-bus';

// ---- Toasts ----
// Toasts persist until the user dismisses them (✕) — they never auto-expire, so
// errors and confirmations can be read and screenshotted. `variant: 'error'`
// adds a coral accent. (The older `persist` option is accepted but now a no-op.)
type ToastItem = { id: number; msg: string; variant: 'info' | 'error' };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const remove = useCallback((id: number) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  const push = useCallback((msg: string, opts?: ToastOptions) => {
    const id = nextId.current++;
    setToasts((t) => [...t, { id, msg, variant: opts?.variant ?? 'info' }]);
  }, []);

  // Let non-component code (write-queue boot wiring, the offline mutation
  // gate in store.ts) surface a toast through this same provider via the
  // imperative lib/toast-bus escape hatch, instead of a parallel toast system.
  useEffect(() => subscribeToast(push), [push]);

  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-wrap">
        {toasts.length > 1 && (
          <button
            onClick={() => setToasts([])}
            style={{ alignSelf: 'flex-end', background: 'none', border: 'none', color: 'var(--ink-soft)', cursor: 'pointer', fontSize: 12, padding: '0 2px' }}
          >Clear all</button>
        )}
        {toasts.map((t) => (
          <div
            key={t.id}
            className="toast"
            role={t.variant === 'error' ? 'alert' : 'status'}
            style={{
              display: 'flex', alignItems: 'flex-start', gap: 10,
              ...(t.variant === 'error' ? { borderLeft: '4px solid var(--coral-600)' } : {}),
            }}
          >
            <span style={{ flex: 1 }}>{t.msg}</span>
            <button
              onClick={() => remove(t.id)}
              aria-label="Dismiss"
              style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0, fontSize: 16, lineHeight: 1, opacity: 0.7 }}
            >✕</button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ---- Modal ----
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  // Only close on a click that BOTH starts and ends on the veil. Without the
  // mousedown guard, drag-selecting text inside a field and releasing on the veil
  // (e.g. highlighting a number right-to-left) fires a click whose target is the
  // veil — which would close the modal and discard everything typed so far.
  const downOnVeil = useRef(false);
  return (
    <div
      className="modal-veil"
      onMouseDown={(e) => { downOnVeil.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (e.target === e.currentTarget && downOnVeil.current) onClose(); }}
    >
      <div className="modal">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: 16 }}>
          <h2 className="display" style={{ fontSize: 22 }}>{title}</h2>
          <button className="btn ghost small" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ---- Badge ----
export function Badge({ tone, children }: { tone: 'ok' | 'warn' | 'err' | 'info' | 'navy'; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

// ---- Type-to-search combo box (spec: all dropdowns searchable) ----
export interface ComboOption { value: string; label: string; sub?: string }
export function Combo({ options, value, onChange, placeholder, id }: {
  options: ComboOption[];
  value: string | null;
  onChange: (v: string) => void;
  placeholder?: string;
  id?: string;
}) {
  const [q, setQ] = useState<string | null>(null); // null = not editing
  const [open, setOpen] = useState(false);
  const [hl, setHl] = useState(0);
  const selected = options.find((o) => o.value === value);
  const shown = q === null ? options : options.filter(
    (o) => (o.label + ' ' + (o.sub ?? '')).toLowerCase().includes(q.toLowerCase()),
  );
  const commit = (v: string) => { onChange(v); setQ(null); setOpen(false); };
  return (
    <div className="combo">
      <input
        id={id}
        className="input"
        placeholder={placeholder ?? 'Type to search…'}
        value={q !== null ? q : selected?.label ?? ''}
        onFocus={() => { setOpen(true); setQ(''); setHl(0); }}
        onBlur={() => setTimeout(() => { setOpen(false); setQ(null); }, 150)}
        onChange={(e) => { setQ(e.target.value); setHl(0); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { setHl((h) => Math.min(h + 1, shown.length - 1)); e.preventDefault(); }
          if (e.key === 'ArrowUp') { setHl((h) => Math.max(h - 1, 0)); e.preventDefault(); }
          if (e.key === 'Enter' && shown[hl]) { commit(shown[hl].value); e.preventDefault(); }
        }}
      />
      {open && shown.length > 0 && (
        <div className="combo-list">
          {shown.slice(0, 50).map((o, i) => (
            <div
              key={o.value}
              className={`combo-item${i === hl ? ' hl' : ''}`}
              onMouseDown={() => commit(o.value)}
            >
              {o.label}
              {o.sub && <div className="sub">{o.sub}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Tabs ----
export function Tabs<T extends string>({ tabs, active, onChange }: {
  tabs: { id: T; label: string }[];
  active: T;
  onChange: (t: T) => void;
}) {
  return (
    <div className="tabs">
      {tabs.map((t) => (
        <button key={t.id} className={`tab${t.id === active ? ' active' : ''}`} onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ---- Stat card ----
export function Stat({ value, label, accent }: { value: ReactNode; label: string; accent?: boolean }) {
  return (
    <div className="card card-pad">
      <div className={`stat-big${accent ? ' stat-accent' : ''}`}>{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

// ---- Field ----
export function Field({ label, hint, children, tip, required }: { label: string; hint?: string; children: ReactNode; tip?: string; required?: boolean }) {
  return (
    <div className="field">
      <label>{label}{required && <span aria-hidden style={{ color: 'var(--coral-600)', marginLeft: 3 }}>*</span>}{tip && <span data-tip={tip} style={{ marginLeft: 6, cursor: 'help', color: 'var(--ink-soft)' }}>ⓘ</span>}</label>
      {children}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}
