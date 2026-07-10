import { Field } from './ui';
import { fmtMoney } from '../lib/scoring';

// ---------------------------------------------------------------------------
// Per-unit add-on pickers (event-mgmt v2 Phase 2 T3, extracted to a shared
// module in T4 so the club-manager Add-ons card can reuse the sized-item
// picker without importing from a page file). Kept at MODULE scope (not
// nested in any component's render) per the ESLint rule against components
// defined inside another component's render.
// ---------------------------------------------------------------------------

/** A shirt-like (t-shirt or camp leotard) picker. Competitions: a quantity
 *  stepper + one size select per unit (buying for others is normal — e.g. a
 *  parent buying a second shirt). Camps (`forceSingle`): a single REQUIRED
 *  select with an explicit "no shirt/leotard" option alongside real sizes —
 *  no pre-selected default, so skipping is always an active choice (spec §G). */
export function SizedAddonPicker({
  title, price, sizes, deadline, forceSingle, noneLabel, units, onChange, fmtDate,
}: {
  title: string;
  price: number;
  sizes: string[];
  deadline?: string;
  forceSingle: boolean;
  noneLabel: string;
  units: string[];
  onChange: (units: string[]) => void;
  fmtDate: (iso: string) => string;
}) {
  const priceLabel = price === 0 ? 'Free' : fmtMoney(price);
  const addUnit = () => onChange([...units, sizes[0] ?? '']);
  const removeUnit = () => onChange(units.slice(0, -1));
  const setUnit = (i: number, val: string) => onChange(units.map((u, idx) => (idx === i ? val : u)));

  return (
    <div className="card card-pad" style={{ marginBottom: 14 }}>
      <h3 className="card-title">{title} — {priceLabel}</h3>
      {deadline && (
        <p style={{ fontSize: 12, color: 'var(--ink-soft)', margin: '0 0 8px' }}>
          Purchase by {fmtDate(deadline.slice(0, 10))}
        </p>
      )}
      {forceSingle ? (
        <Field label={title} required>
          <select className="input" value={units[0] ?? ''} onChange={(e) => onChange([e.target.value])}>
            <option value="" disabled>Choose an option…</option>
            <option value="none">{noneLabel}</option>
            {sizes.map((sz) => <option key={sz} value={sz}>{sz}</option>)}
          </select>
        </Field>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: units.length > 0 ? 10 : 0 }}>
            <span style={{ fontSize: 14 }}>Quantity</span>
            <button type="button" className="btn small ghost" onClick={removeUnit} disabled={units.length === 0} aria-label={`Remove a ${title.toLowerCase()}`}>−</button>
            <span style={{ minWidth: 18, textAlign: 'center' }}>{units.length}</span>
            <button type="button" className="btn small ghost" onClick={addUnit} aria-label={`Add a ${title.toLowerCase()}`}>+</button>
          </div>
          {units.map((u, i) => (
            <Field key={i} label={`${title} #${i + 1} size`}>
              <select className="input" value={u} onChange={(e) => setUnit(i, e.target.value)}>
                {sizes.map((sz) => <option key={sz} value={sz}>{sz}</option>)}
              </select>
            </Field>
          ))}
        </>
      )}
    </div>
  );
}
