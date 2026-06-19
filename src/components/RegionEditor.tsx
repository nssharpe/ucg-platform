import { useState } from 'react';
import { mutate } from '../lib/store';
import { pushRegionOverrides } from '../lib/supabase';
import { STATE_REGIONS } from '../lib/types';
import type { DB, Region } from '../lib/types';
import { useToast } from './ui';

const ALL_REGIONS: Region[] = [
  'Northeast', 'Mid-Atlantic', 'Southeast', 'Mideast',
  'Midwest', 'South Central', 'West', 'Other',
];

interface Props {
  regionOverrides?: DB['regionOverrides'];
}

export function RegionEditor({ regionOverrides }: Props) {
  const toast = useToast();
  // Build working copy: start from overrides if present, else defaults.
  const effective: Record<string, Region> = regionOverrides
    ? { ...regionOverrides }
    : { ...STATE_REGIONS };

  // Track pending local changes before save.
  const [pending, setPending] = useState<Record<string, Region>>({ ...effective });
  const [dirty, setDirty] = useState(false);

  const allStates = Object.keys(STATE_REGIONS).sort();

  const handleChange = (state: string, newRegion: Region) => {
    setPending((prev) => {
      const next = { ...prev, [state]: newRegion };
      setDirty(true);
      return next;
    });
  };

  const save = () => {
    mutate((d) => {
      d.regionOverrides = { ...pending };
      pushRegionOverrides(d.regionOverrides);
    });
    setDirty(false);
    toast('Region assignments saved.');
  };

  const reset = () => {
    setPending({ ...STATE_REGIONS });
    setDirty(true);
  };

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
        <p style={{ margin: 0, fontSize: 13.5, color: 'var(--ink-soft)', flex: 1 }}>
          Assign each state to a region. Changes take effect immediately for new meets and athlete grouping.
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn small ghost" onClick={reset} title="Reset to built-in defaults">
            Reset to defaults
          </button>
          <button className="btn small primary" disabled={!dirty} onClick={save}>
            Save changes
          </button>
        </div>
      </div>

      <div className="grid cols-4">
        {ALL_REGIONS.map((region) => {
          const statesInRegion = allStates.filter((s) => pending[s] === region);
          return (
            <div className="card card-pad" key={region}>
              <h3 className="card-title" style={{ marginBottom: 8 }}>{region}</h3>
              <div style={{ fontSize: 13, color: 'var(--ink-soft)', marginBottom: 6 }}>
                {statesInRegion.length} state{statesInRegion.length !== 1 ? 's' : ''}
              </div>
              <div style={{ fontSize: 13, lineHeight: 1.8 }}>
                {statesInRegion.map((st) => (
                  <span key={st} style={{ display: 'inline-flex', alignItems: 'center', gap: 2, marginRight: 4 }}>
                    {st}
                  </span>
                ))}
                {statesInRegion.length === 0 && (
                  <em style={{ color: 'var(--ink-soft)' }}>No states</em>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="card" style={{ overflow: 'hidden', marginTop: 20 }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>State</th>
              <th>Region</th>
              <th>Default region</th>
            </tr>
          </thead>
          <tbody>
            {allStates.map((state) => {
              const cur = pending[state] ?? STATE_REGIONS[state] ?? 'Other';
              const def = STATE_REGIONS[state] ?? 'Other';
              const changed = cur !== def;
              return (
                <tr key={state} style={changed ? { background: 'var(--surface-1)' } : undefined}>
                  <td style={{ fontWeight: changed ? 600 : undefined }}>{state}</td>
                  <td>
                    <select
                      className="input"
                      style={{ fontSize: 13, padding: '2px 6px' }}
                      value={cur}
                      onChange={(e) => handleChange(state, e.target.value as Region)}
                    >
                      {ALL_REGIONS.map((r) => (
                        <option key={r} value={r}>{r}</option>
                      ))}
                    </select>
                  </td>
                  <td style={{ fontSize: 13, color: changed ? 'var(--ink-soft)' : undefined }}>
                    {def}
                    {changed && <span style={{ color: 'var(--coral-500)', marginLeft: 4 }}>●</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {dirty && (
        <div style={{ marginTop: 12, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn ghost" onClick={() => { setPending({ ...effective }); setDirty(false); }}>
            Discard changes
          </button>
          <button className="btn primary" onClick={save}>
            Save region assignments
          </button>
        </div>
      )}
    </div>
  );
}
