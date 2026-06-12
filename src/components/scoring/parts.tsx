// Shared UCG-branded building blocks for the native scoring panels.
// All controls are controlled components — panels keep zero internal score state.
import type { ReactNode } from 'react';
import type { Breakdown } from '../../scoring/types';
import { fmtScore } from '../../lib/scoring';

/** Section inside a scoring panel: small uppercase title + body. */
export function PanelSection({ title, sub, children, right }: {
  title: string; sub?: ReactNode; right?: ReactNode; children: ReactNode;
}) {
  return (
    <section className="sp-section">
      <div className="sp-section-head">
        <div>
          <div className="sp-section-title">{title}</div>
          {sub && <div className="sp-section-sub">{sub}</div>}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

/** − [n] + counter, tablet-friendly hit targets. */
export function Stepper({ value, onChange, min = 0, max = 99, disabled }: {
  value: number; onChange: (v: number) => void; min?: number; max?: number; disabled?: boolean;
}) {
  const set = (v: number) => onChange(Math.min(max, Math.max(min, v)));
  return (
    <div className={`sp-stepper${disabled ? ' disabled' : ''}`}>
      <button type="button" tabIndex={-1} disabled={disabled || value <= min} onClick={() => set(value - 1)}>−</button>
      <input
        type="number" inputMode="numeric" value={value} min={min} max={max} disabled={disabled}
        onChange={(e) => set(parseInt(e.target.value, 10) || 0)}
      />
      <button type="button" tabIndex={-1} disabled={disabled || value >= max} onClick={() => set(value + 1)}>+</button>
    </div>
  );
}

/** Labelled stepper row (label left, stepper right). */
export function StepperRow({ label, hint, ...rest }: {
  label: ReactNode; hint?: string;
  value: number; onChange: (v: number) => void; min?: number; max?: number; disabled?: boolean;
}) {
  return (
    <div className="sp-row">
      <label>{label}{hint && <span className="sp-row-hint">{hint}</span>}</label>
      <Stepper {...rest} />
    </div>
  );
}

export type ChipState = 'off' | 'on' | 'excluded' | 'contrib';

/** One-of chip group (MAG skill letters, EGs, Masters dismount level…).
 *  Tapping the active chip clears it when allowClear is set. */
export function ChipGroup<T extends string>({ options, value, onChange, allowClear, chipState, dense }: {
  options: { value: T; label?: string }[];
  value: T | null;
  onChange: (v: T | null) => void;
  allowClear?: boolean;
  /** Optional per-chip visual override (excluded = red, contrib = green). */
  chipState?: (v: T) => ChipState | undefined;
  dense?: boolean;
}) {
  return (
    <div className={`sp-chips${dense ? ' dense' : ''}`}>
      {options.map((o) => {
        const sel = o.value === value;
        const st = (chipState?.(o.value)) ?? (sel ? 'on' : 'off');
        return (
          <button
            key={o.value} type="button"
            className={`sp-chip ${st}${sel ? ' sel' : ''}`}
            onClick={() => onChange(sel ? (allowClear ? null : o.value) : o.value)}
          >
            {o.label ?? o.value}
          </button>
        );
      })}
    </div>
  );
}

/** Branded checkbox row. */
export function CheckRow({ checked, onChange, children }: {
  checked: boolean; onChange: (v: boolean) => void; children: ReactNode;
}) {
  return (
    <label className="checkrow sp-check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}</span>
    </label>
  );
}

/** Decimal entry for deductions/execution — keeps the raw string so judges can type freely. */
export function DecimalInput({ value, onChange, step = 0.1, max = 10, big, autoFocus }: {
  value: string; onChange: (v: string) => void; step?: number; max?: number; big?: boolean; autoFocus?: boolean;
}) {
  return (
    <input
      type="number" inputMode="decimal" className={`input sp-decimal${big ? ' big' : ''}`}
      min={0} max={max} step={step} value={value} placeholder="0.0" autoFocus={autoFocus}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** Live D / E / Final (or SV) strip shown under a panel. */
export function ScoreStrip({ items }: { items: { label: string; value: number | null; accent?: boolean }[] }) {
  return (
    <div className="sp-strip">
      {items.map((it) => (
        <div key={it.label} className="sp-strip-item">
          <div className="sp-strip-label">{it.label}</div>
          <div className={`sp-strip-value${it.accent ? ' accent' : ''}`}>{fmtScore(it.value)}</div>
        </div>
      ))}
    </div>
  );
}

/** Rule warnings (level caps, EG limits…). */
export function WarnBox({ warnings }: { warnings: string[] }) {
  if (!warnings.length) return null;
  return (
    <div className="sp-warn">
      {warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
    </div>
  );
}

/** Compact signed breakdown line, e.g. "base 9.70 + bonus 0.10 − SR 0.50". */
export function BreakdownLine({ breakdown }: { breakdown: Breakdown[] }) {
  const parts = breakdown.filter((b) => b.value !== 0 || /base|skills/i.test(b.label));
  if (!parts.length) return null;
  return (
    <div className="sp-breakdown">
      {parts.map((b, i) => (
        <span key={i}>
          {i > 0 && (b.value < 0 ? ' − ' : ' + ')}
          {b.label} {Math.abs(b.value).toFixed(2)}
        </span>
      ))}
    </div>
  );
}
