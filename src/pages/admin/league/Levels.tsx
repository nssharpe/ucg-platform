import { useState } from 'react';
import { useDB, mutate } from '../../../lib/store';
import { useToast } from '../../../components/ui-hooks';
import { DISCIPLINES } from '../../../lib/types';
import type { Level } from '../../../lib/types';
import { pushLevel } from '../../../lib/supabase';

// ---------- Levels ----------
type LevelDraft = { name: string; svMax: string; vaults: string; order: string };

export function Levels() {
  const db = useDB();
  const toast = useToast();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<LevelDraft>({ name: '', svMax: '', vaults: '', order: '' });
  const [addingDisc, setAddingDisc] = useState<string | null>(null);
  const [newDraft, setNewDraft] = useState<LevelDraft>({ name: '', svMax: '', vaults: '1', order: '' });

  const startEdit = (l: Level) => {
    setEditingId(l.id);
    setDraft({ name: l.name, svMax: l.svMax == null ? '' : String(l.svMax), vaults: String(l.vaults), order: String(l.order) });
  };

  const saveEdit = (l: Level) => {
    const vaults = parseInt(draft.vaults, 10);
    const order = parseInt(draft.order, 10);
    if (!draft.name.trim()) { toast('Name is required.'); return; }
    if (isNaN(vaults)) { toast('Vaults must be a number.'); return; }
    const svMax = draft.svMax === '' ? null : parseFloat(draft.svMax);
    if (draft.svMax !== '' && isNaN(svMax as number)) { toast('SV max must be a number or blank for Open.'); return; }
    mutate((d) => {
      const x = d.levels.find((y) => y.id === l.id)!;
      x.name = draft.name.trim();
      x.svMax = svMax;
      x.vaults = vaults;
      x.order = isNaN(order) ? l.order : order;
      pushLevel(x);
    });
    setEditingId(null);
    toast('Level saved.');
  };

  // W12 task 4: soft-delete (retire) instead of hard delete — preserves past events.
  const retireLevel = (l: Level) => {
    if (!window.confirm(`Retire level "${l.name}"? It will be hidden from new events but preserved on past events and results.`)) return;
    mutate((d) => {
      const x = d.levels.find((y) => y.id === l.id)!;
      x.retired = true;
      pushLevel(x);
    });
    toast(`"${l.name}" retired — won't appear in new events. Unretire it to restore.`);
  };

  const unretireLevel = (l: Level) => {
    mutate((d) => {
      const x = d.levels.find((y) => y.id === l.id)!;
      x.retired = false;
      pushLevel(x);
    });
    toast(`"${l.name}" restored.`);
  };

  const startAdd = (disc: string) => {
    setAddingDisc(disc);
    const existing = db.levels.filter((l) => l.discipline === disc);
    const maxOrder = existing.length ? Math.max(...existing.map((l) => l.order)) : 0;
    setNewDraft({ name: '', svMax: '', vaults: '1', order: String(maxOrder + 10) });
  };

  const saveAdd = (disc: string) => {
    if (!newDraft.name.trim()) { toast('Name is required.'); return; }
    const vaults = parseInt(newDraft.vaults, 10);
    const order = parseInt(newDraft.order, 10);
    if (isNaN(vaults)) { toast('Vaults must be a number.'); return; }
    const svMax = newDraft.svMax === '' ? null : parseFloat(newDraft.svMax);
    if (newDraft.svMax !== '' && isNaN(svMax as number)) { toast('SV max must be a number or blank for Open.'); return; }
    // Generate a unique id
    let n = db.levels.filter((l) => l.discipline === disc).length + 1;
    let id = `lvl-${disc.toLowerCase()}-${n}`;
    while (db.levels.some((l) => l.id === id)) { n++; id = `lvl-${disc.toLowerCase()}-${n}`; }
    const newLevel: Level = {
      id, discipline: disc as Level['discipline'], name: newDraft.name.trim(),
      svMax, vaults, order: isNaN(order) ? 99 : order,
    };
    mutate((d) => { d.levels.push(newLevel); pushLevel(newLevel); });
    setAddingDisc(null);
    toast(`Added "${newLevel.name}" to ${disc}.`);
  };

  return (
    <div className="grid cols-3">
      {DISCIPLINES.map((disc) => {
        // W12 task 4: show ALL levels including retired (retired shown last, struck through)
        const discLevels = db.levels.filter((l) => l.discipline === disc).sort((a, b) => {
          if (a.retired && !b.retired) return 1;
          if (!a.retired && b.retired) return -1;
          return a.order - b.order;
        });
        return (
          <div className="card card-pad" key={disc}>
            <h3 className="card-title">{disc}</h3>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Level</th>
                  <th className="num">SV max</th>
                  <th className="num">Vaults</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {discLevels.map((l) => {
                  const isEditing = editingId === l.id;
                  const isRetired = !!l.retired;
                  return (
                    <tr key={l.id} style={isRetired ? { opacity: 0.55 } : undefined}>
                      {isEditing ? (
                        <>
                          <td>
                            <input
                              className="input"
                              style={{ width: 90 }}
                              value={draft.name}
                              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                            />
                          </td>
                          <td className="num">
                            <input
                              className="input"
                              style={{ width: 60 }}
                              placeholder="Open"
                              value={draft.svMax}
                              onChange={(e) => setDraft({ ...draft, svMax: e.target.value })}
                            />
                          </td>
                          <td className="num">
                            <input
                              className="input"
                              type="number"
                              min={1}
                              style={{ width: 50 }}
                              value={draft.vaults}
                              onChange={(e) => setDraft({ ...draft, vaults: e.target.value })}
                            />
                          </td>
                          <td style={{ whiteSpace: 'nowrap' }}>
                            <button className="btn small primary" onClick={() => saveEdit(l)}>✓</button>{' '}
                            <button className="btn small ghost" onClick={() => setEditingId(null)}>✕</button>
                          </td>
                        </>
                      ) : (
                        <>
                          <td style={isRetired ? { textDecoration: 'line-through', color: 'var(--ink-soft)' } : undefined}>
                            {l.name}
                            {isRetired && <span style={{ fontSize: 11, marginLeft: 5, color: 'var(--ink-soft)', textDecoration: 'none', display: 'inline-block' }}>retired</span>}
                          </td>
                          <td className="num">{l.svMax?.toFixed(1) ?? 'Open'}</td>
                          <td className="num">{l.vaults}</td>
                          <td style={{ whiteSpace: 'nowrap' }}>
                            {isRetired ? (
                              // W12 task 4: Unretire action for retired levels
                              <button className="btn small ghost" onClick={() => unretireLevel(l)}>Unretire</button>
                            ) : (
                              <>
                                <button className="btn small ghost" onClick={() => startEdit(l)}>Edit</button>{' '}
                                {/* W12 task 4: soft-delete (retire) instead of hard delete */}
                                <button className="btn small danger" onClick={() => retireLevel(l)}>Retire</button>
                              </>
                            )}
                          </td>
                        </>
                      )}
                    </tr>
                  );
                })}
                {addingDisc === disc && (
                  <tr>
                    <td>
                      <input
                        className="input"
                        style={{ width: 90 }}
                        placeholder="Name"
                        autoFocus
                        value={newDraft.name}
                        onChange={(e) => setNewDraft({ ...newDraft, name: e.target.value })}
                      />
                    </td>
                    <td className="num">
                      <input
                        className="input"
                        style={{ width: 60 }}
                        placeholder="Open"
                        value={newDraft.svMax}
                        onChange={(e) => setNewDraft({ ...newDraft, svMax: e.target.value })}
                      />
                    </td>
                    <td className="num">
                      <input
                        className="input"
                        type="number"
                        min={1}
                        style={{ width: 50 }}
                        value={newDraft.vaults}
                        onChange={(e) => setNewDraft({ ...newDraft, vaults: e.target.value })}
                      />
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn small primary" onClick={() => saveAdd(disc)}>✓</button>{' '}
                      <button className="btn small ghost" onClick={() => setAddingDisc(null)}>✕</button>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            {addingDisc !== disc && (
              <button className="btn small ghost" style={{ marginTop: 8 }} onClick={() => startAdd(disc)}>+ Add level</button>
            )}
          </div>
        );
      })}
    </div>
  );
}
