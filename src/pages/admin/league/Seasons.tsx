import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useDB, mutate } from '../../../lib/store';
import { Badge } from '../../../components/ui';
import { useToast } from '../../../components/ui-hooks';
import type { DB, Season } from '../../../lib/types';
import { pushSeason } from '../../../lib/supabase';
import { fmtMoney } from '../../../lib/scoring';
import { isFutureSeason } from '../../../lib/season-lifecycle';
import { findUcgEvent } from '../../../lib/ucg-event-templates';

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
    const applied = mutate((d) => {
      const x = d.seasons.find((y) => y.id === s.id)!;
      x.name = draft.name.trim() || x.name;
      x.startsOn = draft.startsOn || x.startsOn;
      x.endsOn = draft.endsOn || x.endsOn;
      x.athleteFee = athleteFee;
      x.coachFee = coachFee;
      x.clubFee = clubFee;  // W12 task 2
      pushSeason(x);
    });
    if (!applied) return; // offline read-only gate — no false success toast
    setEditingId(null);
    toast('Season updated.');
  };

  // P3 (2026-07-20): "current" and "launched" are gone as stored flags —
  // purchasability is now derived from today's date against the season's
  // window (see season-lifecycle.ts `purchasableSeasons`). Past → never;
  // current-by-date → always; future → the `active` toggle below.
  const today = new Date().toISOString().slice(0, 10);

  // Same tense-aware Purchasable cell in both edit and display mode: past
  // seasons are never purchasable (no toggle to flip), the current-by-date
  // season is always purchasable, and only a FUTURE season shows the
  // `active` admin toggle.
  const purchasableCell = (s: Season) => {
    const isCurrent = !!(s.startsOn && s.endsOn && today >= s.startsOn && today <= s.endsOn);
    if (isCurrent) return <Badge tone="ok">Yes (current)</Badge>;
    if (isFutureSeason(db, s, today)) {
      return (
        <label className="checkrow" style={{ margin: 0 }}>
          <input type="checkbox" checked={s.active} onChange={() => mutate((d) => {
            const x = d.seasons.find((y) => y.id === s.id)!;
            x.active = !x.active;
            pushSeason(x);
          })} />
          {s.active ? 'Yes' : 'No'}
        </label>
      );
    }
    return <span style={{ color: 'var(--ink-soft)' }}>No (ended)</span>;
  };

  // FlipFest/Nationals columns (P4 2026-07-20): Create when the season has no
  // instance yet, Edit once one exists — both navigate to the dedicated page.
  const ucgCell = (db: DB, s: Season, which: 'flipfest' | 'nationals') => {
    const existing = findUcgEvent(db, s, which);
    const to = `/admin/ucg-event/${which}/${s.id}`;
    if (existing) return <Link className="btn small ghost" to={to}>Edit</Link>;
    // No instance and the season already ended — nothing to create anymore.
    if (s.endsOn < today) return <span style={{ color: 'var(--ink-soft)' }}>—</span>;
    return <Link className="btn small primary" to={to}>Create</Link>;
  };

  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      {/* The table is wider than a phone — scroll it inside the card rather
          than letting it stretch the page. */}
      <div style={{ overflowX: 'auto' }}>
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
            <th>FlipFest</th>
            <th>Nationals</th>
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
                      {purchasableCell(s)}
                    </td>
                    <td>{ucgCell(db, s, 'flipfest')}</td>
                    <td>{ucgCell(db, s, 'nationals')}</td>
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
                      {purchasableCell(s)}
                    </td>
                    <td>{ucgCell(db, s, 'flipfest')}</td>
                    <td>{ucgCell(db, s, 'nationals')}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn small ghost" onClick={() => startEdit(s)}>Edit</button>
                      {!db.seasons.some((x) => x.startsOn > s.startsOn) && (
                        <>
                          {' '}
                          <button className="btn small ghost" data-tip="Copy fees, waivers & levels into a new season" onClick={() => {
                            const applied = mutate((d) => {
                              const yr = +s.startsOn.slice(0, 4) + 1;
                              const next = { ...s, id: `s${yr - 1999}`, name: `${yr}–${String(yr + 1).slice(2)}`, startsOn: `${yr}-07-01`, endsOn: `${yr + 1}-06-30`, active: false };
                              d.seasons.push(next);
                              pushSeason(next);
                            });
                            if (!applied) return; // offline read-only gate
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
    </div>
  );
}
