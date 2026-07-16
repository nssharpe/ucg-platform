import { useDB } from '../../../lib/store';
import { RegionEditor } from '../../../components/RegionEditor';

// ---------- Regions tab (W12 task 3) ----------
// Renamed RegionsTab so AdminLeague can reference the new name without conflict.
export function RegionsTab() {
  const db = useDB();
  return (
    <div>
      <div className="card card-pad" style={{ marginBottom: 16, borderLeft: '4px solid var(--bluegreen)' }}>
        <p style={{ margin: 0, fontSize: 13.5 }}>
          <strong>Edit state→region assignments below.</strong> Changes are persisted via{' '}
          <code>db.regionOverrides</code> and override the built-in <code>STATE_REGIONS</code> map
          everywhere — event filtering, athlete grouping, and communications. Resetting returns to
          the compiled defaults.
        </p>
      </div>
      {/* W12 task 3: RegionEditor component */}
      <RegionEditor regionOverrides={db.regionOverrides} />
    </div>
  );
}
