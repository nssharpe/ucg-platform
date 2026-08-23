import { Children, cloneElement, isValidElement, useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { ToastCtx, type ToastOptions } from './ui-hooks';
import { subscribeToast } from '../lib/toast-bus';

// ---- Toasts ----
// Toasts persist until the user dismisses them (✕) — they never auto-expire, so
// errors and confirmations can be read and screenshotted. `variant: 'error'`
// adds a coral accent. (The older `persist` option is accepted but now a no-op.)
type ToastItem = { id: number; msg: string; variant: 'info' | 'error'; action?: { label: string; to: string } };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const remove = useCallback((id: number) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  const push = useCallback((msg: string, opts?: ToastOptions) => {
    const id = nextId.current++;
    setToasts((t) => [...t, { id, msg, variant: opts?.variant ?? 'info', action: opts?.action }]);
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
            <span style={{ flex: 1 }}>
              {t.msg}
              {t.action && (
                <>
                  {' '}
                  <button
                    type="button"
                    onClick={() => { window.location.hash = t.action!.to; remove(t.id); }}
                    style={{
                      background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                      color: 'var(--ice-200)', fontWeight: 700, textDecoration: 'underline',
                      font: 'inherit',
                    }}
                  >
                    {t.action.label} →
                  </button>
                </>
              )}
            </span>
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
  // A11y (audit 2026-08-04, finding A4). Verified broken before this: opening a
  // modal left focus outside it, Escape did nothing, and three Tabs put focus on
  // the nav BEHIND the veil. Fixed here so all 33 call sites get it at once.
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  // Kept in a ref (updated in an effect, never during render) so the Escape/Tab
  // handler below can stay mounted once instead of re-binding on every render.
  useEffect(() => { onCloseRef.current = onClose; });

  useEffect(() => {
    // Remember what to hand focus back to, so closing doesn't dump the user at
    // the top of the document.
    const opener = document.activeElement as HTMLElement | null;
    const controls = () => Array.from(
      dialogRef.current?.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
        'input,select,textarea',
      ) ?? [],
    );
    const readValues = () => controls().map((el) => (
      el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')
        ? String(el.checked) : el.value
    ));
    // Snapshot what the user started with, so Escape can tell "nothing typed yet"
    // (close silently) from "work in progress" (confirm first). See onKey.
    const initialValues = readValues();

    const focusables = () => Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
      ) ?? [],
    ).filter((el) => el.offsetParent !== null || el === document.activeElement);

    // Move focus in. Prefer the first real control; fall back to the dialog itself
    // (it carries tabIndex={-1}) so focus is never left outside the modal.
    (focusables()[0] ?? dialogRef.current)?.focus();

    // Nested dialogs: every mounted Modal installs this handler on `document`, so
    // without a depth check one Escape would collapse the whole stack and one Tab
    // would be trapped by the wrong dialog. Only the LAST [role=dialog] in the DOM
    // — the topmost — handles keys.
    const isTopmost = () => {
      const all = document.querySelectorAll('[role="dialog"]');
      return all.length === 0 || all[all.length - 1] === dialogRef.current;
    };

    const onKey = (e: KeyboardEvent) => {
      if (!isTopmost()) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        // Escape is a THIRD way to discard, alongside ✕ and a veil click — and the
        // easiest to hit by accident, which matters because several of these dialogs
        // are multi-step registration/refund flows. The veil already carries a
        // mousedown guard for exactly this reason (see above), so Escape gets the
        // equivalent: silent close when nothing has been entered, an explicit
        // confirm once there is work to lose. ✕/veil behaviour is unchanged.
        const dirty = readValues().some((v, i) => v !== initialValues[i]);
        if (dirty && !window.confirm('Discard your changes?')) return;
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      // Focus trap: wrap at both ends rather than escaping to the page behind.
      const els = focusables();
      if (els.length === 0) { e.preventDefault(); dialogRef.current?.focus(); return; }
      const first = els[0], last = els[els.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (!dialogRef.current?.contains(active)) { e.preventDefault(); first.focus(); return; }
      if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    const dialogEl = dialogRef.current;
    return () => {
      document.removeEventListener('keydown', onKey, true);
      // Restore focus to the opener ONLY if focus is still inside this (now
      // closing) dialog. If the app deliberately moved focus elsewhere on close,
      // yanking it back to a stale opener would be the bug, not the fix.
      const active = document.activeElement;
      const focusStillHere = !active || active === document.body || dialogEl?.contains(active);
      if (focusStillHere && opener?.isConnected) opener.focus();
    };
  }, []);

  return (
    <div
      className="modal-veil"
      onMouseDown={(e) => { downOnVeil.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (e.target === e.currentTarget && downOnVeil.current) onClose(); }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={dialogRef}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: 16 }}>
          <h2 className="display" id={titleId} style={{ fontSize: 22 }}>{title}</h2>
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
/** Controls whose label association `Field` can wire up automatically.
 *  Native form controls are labelable elements; `Combo` is included because it
 *  accepts an `id` prop and forwards it to its own <input>. */
function isLabelableChild(child: ReactNode): child is ReactElement<{ id?: string }> {
  if (!isValidElement(child)) return false;
  if (typeof child.type === 'string') return ['input', 'select', 'textarea'].includes(child.type);
  return child.type === Combo;
}

export function Field({ label, hint, children, tip, required, htmlFor }: { label: string; hint?: string; children: ReactNode; tip?: string; required?: boolean; htmlFor?: string }) {
  // A11y (audit 2026-08-04, finding A1): this <label> is a SIBLING of the control,
  // so without `htmlFor` it is visible but programmatically inert — a screen
  // reader announced "edit text, blank" for a field sighted users read as
  // "First name" (19 of 33 controls on /me had no accessible name). We generate an
  // id and wire label→control here so all ~248 <Field> call sites are fixed at once.
  //
  // Only a SINGLE labelable child can be wired this way. When `children` is a
  // fragment, an array, or a custom wrapper (a checkbox group, a pair of inputs),
  // there is no one control the label belongs to — HTML has no valid association
  // for that — so we leave it alone and those call sites need their own
  // `aria-label`/`aria-labelledby`. `htmlFor` lets a caller point at its own
  // control explicitly instead.
  const autoId = useId();
  // Children are very often an ARRAY — the control plus conditional inline
  // validation messages ("Required", an age error). The label still belongs to
  // the control, so wire the FIRST labelable element and leave the messages be.
  // (Before handling this case, /me was still leaving 9 controls unnamed.)
  const kids = Children.toArray(children);
  const idx = htmlFor ? -1 : kids.findIndex((k) => isLabelableChild(k) && !k.props.id);
  const wire = idx >= 0;
  const id = htmlFor ?? (wire ? autoId : undefined);
  const control = wire
    ? kids.map((k, i) => (i === idx ? cloneElement(k as ReactElement<{ id?: string }>, { id: autoId }) : k))
    : children;
  return (
    <div className="field">
      <label htmlFor={id}>{label}{required && <span aria-hidden style={{ color: 'var(--coral-text)', marginLeft: 3 }}>*</span>}{tip && <span data-tip={tip} style={{ marginLeft: 6, cursor: 'help', color: 'var(--ink-soft)' }}>ⓘ</span>}</label>
      {control}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}
