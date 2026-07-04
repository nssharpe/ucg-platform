import { useState } from 'react';
import { useDB, mutate } from '../../../lib/store';
import { Badge } from '../../../components/ui';
import { useToast } from '../../../components/ui-hooks';
import type { Season } from '../../../lib/types';
import { pushSeason } from '../../../lib/supabase';
import { fmtMoney } from '../../../lib/scoring';

// ---------- Seasons ----------
type SeasonEditState = {
  name: string;
  startsOn: string;
  endsOn: string;
  athleteFee: string;
  coachFee: string;
  clubFee: string;
};

export function Seasons() {
  const db = useDB();
  const toast = useToast();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<SeasonEditState>({ name: '', startsOn: '', endsOn: '', athleteFee: '', coachFee: '', clubFee: '' });

  const startEdit = (s: Season) => {
    setEditingId(s.id);
    setDraft({
      name: s.name, startsOn: s.startsOn, endsOn: s.endsOn,
      athleteFee: String(s.athleteFee), coachFee: String(s.coachFee),
      clubFee: String(s.clubFee ?? 109),  // W12 task 2: clubFee
    });
  };

  const saveEdit = (s: Season) => {
    const athleteFee = parseFloat(draft.athleteFee);
    const coachFee = parseFloat(draft.coachFee);
    const clubFee = parseFloat(draft.clubFee);  // W12 task 2
    if (isNaN(athleteFee) || isNaN(coachFee) || isNaN(clubFee)) { toast('Fees must be numbers.'); return; }
    mutate((d) => {
      const x = d.seasons.find((y) => y.id === s.id)!;
      x.name = draft.name.trim() || x.name;
      x.startsOn = draft.startsOn || x.startsOn;
      x.endsOn = draft.endsOn || x.endsOn;
      x.athleteFee = athleteFee;
      x.coachFee = coachFee;
      x.clubFee = clubFee;  // W12 task 2
      pushSeason(x);
    });
    setEditingId(null);
    toast('Season updated.');
  };

  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      <table className="tbl">
        <thead>
          <tr>
            <th>Season</th>
            <th>Valid</th>
            <th className="num">Athlete fee</th>
            <th className="num">Coach fee</th>
            {/* W12 task 2: Club fee column */}
            <th className="num">Club fee</th>
            <th>Purchasable</th>
            <th>Current</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {db.seasons.map((s) => {
            const isEditing = editingId === s.id;
            return (
              <tr key={s.id}>
                {isEditing ? (
                  <>
                    <td>
                      <input
                        className="input"
                        style={{ width: 110 }}
                        value={draft.name}
                        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                      />
                    </td>
                    <td style={{ fontSize: 13 }}>
                      <input
                        className="input"
                        type="date"
                        style={{ width: 130 }}
                        value={draft.startsOn}
                        onChange={(e) => setDraft({ ...draft, startsOn: e.target.value })}
                      />
                      {' → '}
                      <input
                        className="input"
                        type="date"
                        style={{ width: 130 }}
                        value={draft.endsOn}
                        onChange={(e) => setDraft({ ...draft, endsOn: e.target.value })}
                      />
                    </td>
                    <td className="num">
                      <input
                        className="input"
                        type="number"
                        min={0}
                        step={1}
                        style={{ width: 80 }}
                        value={draft.athleteFee}
                        onChange={(e) => setDraft({ ...draft, athleteFee: e.target.value })}
                      />
                    </td>
                    <td className="num">
                      <input
                        className="input"
                        type="number"
                        min={0}
                        step={1}
                        style={{ width: 80 }}
                        value={draft.coachFee}
                        onChange={(e) => setDraft({ ...draft, coachFee: e.target.value })}
                      />
                    </td>
                    {/* W12 task 2: club fee inline edit */}
                    <td className="num">
                      <input
                        className="input"
                        type="number"
                        min={0}
                        step={1}
                        style={{ width: 80 }}
                        value={draft.clubFee}
                        onChange={(e) => setDraft({ ...draft, clubFee: e.target.value })}
                      />
                    </td>
                    <td>
                      <label className="checkrow" style={{ margin: 0 }}>
                        <input type="checkbox" checked={s.active} onChange={() => mutate((d) => {
                          const x = d.seasons.find((y) => y.id === s.id)!;
                          x.active = !x.active;
                          pushSeason(x);
                        })} />
                        {s.active ? 'Yes' : 'No'}
                      </label>
                    </td>
                    <td>
                      <label className="checkrow" style={{ margin: 0 }}>
                        <input type="checkbox" checked={s.current} onChange={() => mutate((d) => {
                          // Only one season can be current
                          d.seasons.forEach((x) => { x.current = x.id === s.id ? !s.current : false; pushSeason(x); });
                        })} />
                        {s.current ? 'Yes' : 'No'}
                      </label>
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn small primary" onClick={() => saveEdit(s)}>Save</button>{' '}
                      <button className="btn small ghost" onClick={() => setEditingId(null)}>Cancel</button>
                    </td>
                  </>
                ) : (
                  <>
                    <td><strong>{s.name}</strong></td>
                    <td style={{ fontSize: 13 }}>{s.startsOn} → {s.endsOn}</td>
                    <td className="num">{fmtMoney(s.athleteFee)}</td>
                    <td className="num">{fmtMoney(s.coachFee)}</td>
                    {/* W12 task 2: club fee display */}
                    <td className="num">{fmtMoney(s.clubFee ?? 109)}</td>
                    <td>
                      <label className="checkrow" style={{ margin: 0 }}>
                        <input type="checkbox" checked={s.active} onChange={() => mutate((d) => {
                          const x = d.seasons.find((y) => y.id === s.id)!;
                          x.active = !x.active;
                          pushSeason(x);
                        })} />
                        {s.active ? 'Yes' : 'No'}
                      </label>
                    </td>
                    <td>
                      {s.current
                        ? <Badge tone="ok">Current</Badge>
                        : (
                          <button className="btn small ghost" onClick={() => mutate((d) => {
                            d.seasons.forEach((x) => { x.current = x.id === s.id; pushSeason(x); });
                            toast(`${s.name} is now the current season.`);
                          })}>Set current</button>
                        )
                      }
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn small ghost" onClick={() => startEdit(s)}>Edit</button>
                      {!db.seasons.some((x) => x.startsOn > s.startsOn) && (
                        <>
                          {' '}
                          <button className="btn small ghost" data-tip="Copy fees, waivers & levels into a new season" onClick={() => {
                            mutate((d) => {
                              const yr = +s.startsOn.slice(0, 4) + 1;
                              const next = { ...s, id: `s${yr - 1999}`, name: `${yr}–${String(yr + 1).slice(2)}`, startsOn: `${yr}-07-01`, endsOn: `${yr + 1}-06-30`, active: false, current: false };
                              d.seasons.push(next);
                              pushSeason(next);
                            });
                            toast('Season copied — update fees & waiver, then mark purchasable.');
                          }}>Copy → next year</button>
                        </>
                      )}
                    </td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
