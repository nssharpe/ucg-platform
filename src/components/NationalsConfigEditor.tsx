import { useMemo, useState } from 'react';
import { mutate, useDB } from '../lib/store';
import { pushEvent } from '../lib/supabase';
import { useToast } from './ui-hooks';
import { PLACEMENT_CATEGORIES, scaffoldNationalsConfig } from '../lib/nationals-adapter';
import type { Level, Event, NationalsConfig, PlacementCategory } from '../lib/types';

const discLabel = (d: string) => (d === 'TNT' ? 'T&T' : d);

/** Levels actually competing in this event, grouped/ordered by discipline. */
function competingLevels(event: Event, levels: Level[]): Level[] {
  const ids = new Set(event.sessions.flatMap((s) => s.levelIds));
  const order: Record<string, number> = { WAG: 0, MAG: 1, TNT: 2 };
  return levels
    .filter((l) => ids.has(l.id))
    .sort((a, b) => (order[a.discipline] - order[b.discipline]) || a.order - b.order);
}

/** Deep-ish clone of a NationalsConfig for local editing. */
function clone(cfg: NationalsConfig): NationalsConfig {
  return JSON.parse(JSON.stringify(cfg));
}

/**
 * Edit a Nationals event's qualification cutoffs ("blue numbers") and finals
 * levels. Mirrors the reference tool's config.ini but in-app and keyed by
 * platform levelId. Admin/host only — gated by the caller.
 */
export function NationalsConfigEditor({ event }: { event: Event }) {
  const db = useDB();
  const toast = useToast();
  const levels = useMemo(() => competingLevels(event, db.levels), [event, db.levels]);
  const artistic = levels.filter((l) => l.discipline === 'WAG' || l.discipline === 'MAG');
  const tnt = levels.filter((l) => l.discipline === 'TNT');

  // Local editable copy, re-scaffolded so newly-added levels appear.
  const [cfg, setCfg] = useState<NationalsConfig>(() =>
    scaffoldNationalsConfig(db.levels, event.disciplines, event.nationalsConfig?.finalsLevelIds ?? [], event.nationalsConfig),
  );
  const [dirty, setDirty] = useState(false);

  const edit = (fn: (c: NationalsConfig) => void) => {
    setCfg((prev) => { const next = clone(prev); fn(next); return next; });
    setDirty(true);
  };

  const setCut = (scope: 'event' | 'aa' | 'team', cat: PlacementCategory, levelId: string, v: number) =>
    edit((c) => { (c.cutoffs[scope][cat] ??= {})[levelId] = v; });
  const setMixed = (levelId: string, v: number) => edit((c) => { c.cutoffs.teamMixed[levelId] = v; });
  const setTnt = (levelId: string, v: number) => edit((c) => { (c.tntCutoffs ??= {})[levelId] = v; });
  const toggleFinals = (levelId: string, on: boolean) =>
    edit((c) => { c.finalsLevelIds = on ? [...c.finalsLevelIds, levelId] : c.finalsLevelIds.filter((id) => id !== levelId); });

  const save = () => {
    const applied = mutate((d) => {
      const m = d.events.find((x) => x.id === event.id);
      if (m) { m.nationalsConfig = cfg; pushEvent(m); }
    });
    if (!applied) return; // offline read-only gate — no false success toast
    setDirty(false);
    toast('Qualification config saved.');
  };

  const numCell = (value: number, onChange: (v: number) => void) => (
    <input
      className="input" type="number" min={0} step={1} value={value}
      onChange={(e) => onChange(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
      style={{ width: 60, padding: '3px 6px', textAlign: 'center' }}
    />
  );

  const scopeGrid = (scope: 'event' | 'aa' | 'team', title: string) => (
    <div style={{ marginBottom: 18, overflowX: 'auto' }}>
      <h4 style={{ fontSize: 14, margin: '0 0 6px' }}>{title}</h4>
      <table className="res-tbl" style={{ fontSize: 13 }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left' }}>Level</th>
            {PLACEMENT_CATEGORIES.map((c) => <th key={c}>{c}</th>)}
          </tr>
        </thead>
        <tbody>
          {artistic.map((l) => (
            <tr key={l.id}>
              <td style={{ textAlign: 'left', whiteSpace: 'nowrap' }}>{discLabel(l.discipline)} {l.name}</td>
              {PLACEMENT_CATEGORIES.map((c) => (
                <td key={c} style={{ textAlign: 'center' }}>{numCell(cfg.cutoffs[scope][c]?.[l.id] ?? 0, (v) => setCut(scope, c, l.id, v))}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <p style={{ fontSize: 13, color: 'var(--ink-soft)', margin: 0, maxWidth: 560 }}>
          Cutoffs are the top-N places that qualify for an award/finals, per level &amp; category. The 50%
          cross-club rule applies automatically when a cutoff is ≥ 6.
        </p>
        <button className="btn primary" disabled={!dirty} onClick={save}>{dirty ? 'Save config' : 'Saved'}</button>
      </div>

      <h3 className="card-title" style={{ margin: '8px 0' }}>Finals levels</h3>
      <p style={{ fontSize: 13, color: 'var(--ink-soft)', margin: '0 0 6px' }}>Levels that hold finals (awards from finals); others award from prelims.</p>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        {artistic.map((l) => (
          <label key={l.id} style={{ display: 'flex', gap: 5, alignItems: 'center', fontSize: 13.5 }}>
            <input type="checkbox" checked={cfg.finalsLevelIds.includes(l.id)} onChange={(e) => toggleFinals(l.id, e.target.checked)} />
            {discLabel(l.discipline)} {l.name}
          </label>
        ))}
        {artistic.length === 0 && <span style={{ fontSize: 13, color: 'var(--ink-soft)' }}>No WAG/MAG levels in this event.</span>}
      </div>

      {artistic.length > 0 && (
        <>
          {scopeGrid('aa', 'All-Around cutoffs')}
          {scopeGrid('event', 'Per-event cutoffs')}
          {scopeGrid('team', 'Team cutoffs')}
          <div style={{ marginBottom: 18, overflowX: 'auto' }}>
            <h4 style={{ fontSize: 14, margin: '0 0 6px' }}>Mixed-team cutoffs</h4>
            <table className="res-tbl" style={{ fontSize: 13 }}>
              <tbody>
                {artistic.map((l) => (
                  <tr key={l.id}>
                    <td style={{ textAlign: 'left', whiteSpace: 'nowrap' }}>{discLabel(l.discipline)} {l.name}</td>
                    <td style={{ textAlign: 'center' }}>{numCell(cfg.cutoffs.teamMixed[l.id] ?? 0, (v) => setMixed(l.id, v))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tnt.length > 0 && (
        <div style={{ marginBottom: 18, overflowX: 'auto' }}>
          <h4 style={{ fontSize: 14, margin: '0 0 6px' }}>T&amp;T cutoffs (per level)</h4>
          <table className="res-tbl" style={{ fontSize: 13 }}>
            <tbody>
              {tnt.map((l) => (
                <tr key={l.id}>
                  <td style={{ textAlign: 'left', whiteSpace: 'nowrap' }}>{l.name}</td>
                  <td style={{ textAlign: 'center' }}>{numCell(cfg.tntCutoffs?.[l.id] ?? 0, (v) => setTnt(l.id, v))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
