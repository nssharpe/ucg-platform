import { useState } from 'react';
import { useDB, resetDemo } from '../../../lib/store';
import { useToast } from '../../../components/ui-hooks';
import { isSupabaseConfigured, pushAll } from '../../../lib/supabase';

// ---------- Demo tools ----------
export function DemoTools() {
  const db = useDB();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [pushStatus, setPushStatus] = useState('');
  return (
    <div className="card card-pad" style={{ maxWidth: 560 }}>
      <h3 className="card-title">Prototype demo tools</h3>
      <p style={{ fontSize: 14, color: 'var(--ink-soft)' }}>
        All data in this prototype lives in your browser (localStorage), seeded deterministically.
        Production replaces this layer with a real API + database with periodic backups.
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          className="btn primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const { loadNationals } = await import('../../../lib/nationals');
              const r = await loadNationals();
              toast(`Loaded NAIGC Nationals 2026 — ${r.athletes.toLocaleString()} athletes, ${r.scores.toLocaleString()} scores. See Live Results.`);
            } catch (e) {
              toast(`Import failed: ${e}`);
            } finally { setBusy(false); }
          }}
        >
          {busy ? 'Loading…' : 'Load Nationals 2026 results (real data)'}
        </button>
        <button className="btn danger" onClick={() => { resetDemo(); toast('Demo data reset to the original seed.'); }}>Reset demo data</button>
      </div>
      {isSupabaseConfigured && (
        <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--line)' }}>
          <p style={{ fontSize: 14, color: 'var(--ink-soft)', marginTop: 0 }}>
            Push the current browser snapshot to the live Supabase project — this is how production gets seeded.
          </p>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              className="btn"
              disabled={!!pushStatus && pushStatus !== 'Done' && pushStatus !== 'Error'}
              onClick={async () => {
                setPushStatus('Starting…');
                try {
                  await pushAll(db, (label) => setPushStatus(label));
                  setPushStatus('Done');
                } catch (e) {
                  console.error(e);
                  setPushStatus('Error');
                }
              }}
            >
              Push local DB → Supabase
            </button>
            {pushStatus && <span style={{ fontSize: 13, color: pushStatus === 'Error' ? 'var(--coral-600)' : 'var(--ink-soft)' }}>
              {pushStatus === 'Done' ? '✓ Done' : pushStatus === 'Error' ? '✕ Failed — see console' : `Pushing: ${pushStatus}…`}
            </span>}
          </div>
        </div>
      )}
    </div>
  );
}
