import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

// ---- Toasts ----
const ToastCtx = createContext<(msg: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<{ id: number; msg: string }[]>([]);
  const nextId = useRef(1);
  const push = useCallback((msg: string) => {
    const id = nextId.current++;
    setToasts((t) => [...t, { id, msg }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-wrap">
        {toasts.map((t) => <div key={t.id} className="toast">{t.msg}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}

// ---- Modal ----
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="modal-veil" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
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
export function Field({ label, hint, children, tip }: { label: string; hint?: string; children: ReactNode; tip?: string }) {
  return (
    <div className="field">
      <label>{label}{tip && <span data-tip={tip} style={{ marginLeft: 6, cursor: 'help', color: 'var(--ink-soft)' }}>ⓘ</span>}</label>
      {children}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

export function useFmtDate() {
  return useMemo(() => (iso: string) => new Date(iso + (iso.length === 10 ? 'T12:00' : '')).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }), []);
}
