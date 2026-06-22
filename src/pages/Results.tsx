import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useDB } from '../lib/store';
import { useCapabilities } from '../lib/capabilities';
import { Tabs, Badge } from '../components/ui';
import { useFmtDate } from '../components/ui-hooks';
import { MeetStatusBadge } from './Home';
import { sessionResults, fmtScore } from '../lib/scoring';
import { scoreDetailPath } from '../lib/calculators';
import { EVENTS } from '../lib/types';
import type { Registration, Score, DB } from '../lib/types';
import type { AthleteResult } from '../lib/scoring';
import { isSupabaseConfigured, subscribeMeetScores, applyScorePatch } from '../lib/supabase';

export function ResultsIndex() {
  const db = useDB();
  const fmtDate = useFmtDate();
  const meets = db.meets.filter((m) => m.status === 'in-progress' || m.status === 'complete' || m.status === 'reg-closed');
  return (
    <div>
      <h1 className="page-title display">Live results</h1>
      <p className="page-sub">Public — no login needed. Scores appear the moment a judge posts them.</p>
      <div className="grid cols-2">
        {meets.map((m) => (
          <div className="card card-pad" key={m.id}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <h3 style={{ fontSize: 18 }}>{m.status === 'in-progress' && <span className="pulse" />}{m.name}</h3>
              <MeetStatusBadge status={m.status} />
            </div>
            <p style={{ color: 'var(--ink-soft)', margin: '6px 0 12px' }}>{m.city}, {m.state} · {fmtDate(m.startDate)}</p>
            <Link className="btn small primary" to={`/results/${m.slug}`}>Open results →</Link>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Meet results — presentation ported from the Nationals 2026 results viewer:
// collapsible level groups, per-group column sorting, search/category/level
// filters, tie-aware places (1,2,2,4), medal colors, qualifier highlighting.
// ---------------------------------------------------------------------------

type SortSpec = { key: string; dir: 1 | -1 };

export function MeetResults() {
  const { slug } = useParams();
  const db = useDB();
  const caps = useCapabilities();
  const meet = db.meets.find((m) => m.slug === slug);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [view, setView] = useState<'aa' | 'events' | 'team'>('aa');
  const [search, setSearch] = useState('');
  const [catFilter, setCatFilter] = useState('');
  const [levelFilter, setLevelFilter] = useState('');
  const [sort, setSort] = useState<SortSpec>({ key: '_aa', dir: -1 });
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const session = meet?.sessions.find((s) => s.id === sessionId) ?? meet?.sessions[0];

  // Realtime score overlay: a patch map (id → Score | null) accumulated from
  // `subscribeMeetScores` postgres_changes events, overlaid on the store's
  // scores at render time so store refreshes stay reconciled.
  const [livePatches, setLivePatches] = useState<ReadonlyMap<string, Score | null>>(new Map());
  // Reset the overlay when the meet changes. Done during render (the documented
  // "adjusting state on prop change" pattern) rather than in the effect below, so
  // it doesn't trigger a cascading render every time the subscription re-runs.
  const patchedMeetId = useRef(meet?.id);
  if (patchedMeetId.current !== meet?.id) {
    patchedMeetId.current = meet?.id;
    setLivePatches(new Map());
  }
  useEffect(() => {
    if (!isSupabaseConfigured || !meet) return;
    const unsubscribe = subscribeMeetScores(meet.id, (payload) => {
      setLivePatches((prev) => applyScorePatch(prev, payload));
    });
    return unsubscribe;
  }, [meet?.id]);

  const effectiveDb: DB = useMemo(() => {
    if (livePatches.size === 0 || !meet) return db;
    const scores = db.scores
      .filter((s) => livePatches.get(s.id) !== null) // drop realtime-deleted rows
      .map((s) => livePatches.get(s.id) ?? s);
    const known = new Set(db.scores.map((s) => s.id));
    for (const [id, s] of livePatches) if (s && !known.has(id)) scores.push(s);
    return { ...db, scores };
  }, [db, livePatches, meet]);

  const computed = useMemo(
    () => (meet && session ? sessionResults(effectiveDb, meet, session.id) : null),
    [effectiveDb, meet, session],
  );

  // Tie-aware places (1,2,2,4) per (level, category) group — the viewer's
  // recomputePlaces. Returns rank maps for AA and each event. Computed before the
  // early return below so the hook always runs; no-ops to empty maps when there's
  // nothing to rank yet.
  const places = useMemo(() => {
    const aa = new Map<string, number>();
    const ev = new Map<string, number>(); // key `${regId}|${event}`
    if (!computed || !session) return { aa, ev };
    const sessionEvents = EVENTS[session.discipline];
    for (const [levelId, rows] of computed.byLevel.entries()) {
      const cats = [...new Set(rows.map((r) => r.reg.category ?? ''))];
      for (const cat of cats) {
        const group = rows.filter((r) => (r.reg.category ?? '') === cat);
        rank(group.filter((r) => r.aa > 0), (r) => r.aa).forEach((p, r) => aa.set(r.reg.id, p));
        for (const e of sessionEvents) {
          const scored = group.filter((r) => r.events[e.code]?.final != null);
          rank(scored, (r) => r.events[e.code]!.final!).forEach((p, r) => ev.set(`${r.reg.id}|${e.code}`, p));
        }
      }
      void levelId;
    }
    return { aa, ev };
  }, [computed, session]);

  if (!meet || !session || !computed) return <p>Meet not found.</p>;
  const { byLevel, eventRankings, teamScores } = computed;
  const events = EVENTS[session.discipline];
  const clubName = (id: string) => db.clubs.find((c) => c.id === id)?.shortName ?? id;
  const athleteName = (athleteId: string) => {
    const a = db.people.find((p) => p.id === athleteId);
    return a ? `${a.firstName} ${a.lastName}` : athleteId;
  };

  // Categories present in this session (drives badge column + filter).
  const categories = [...new Set([...byLevel.values()].flat().map((r) => r.reg.category).filter(Boolean))] as string[];

  const canOpenScore = (athleteId: string) =>
    caps.isAdmin || caps.isMeetHost(meet?.id ?? '') || caps.personId === athleteId;

  const matchesFilters = (r: AthleteResult) => {
    if (catFilter && (r.reg.category ?? '') !== catFilter) return false;
    if (search) {
      const a = db.people.find((p) => p.id === r.reg.athleteId);
      const hay = `${a?.firstName} ${a?.lastName} ${clubName(r.reg.clubId)}`.toLowerCase();
      if (!hay.includes(search.toLowerCase())) return false;
    }
    return true;
  };

  const sortRows = (rows: AthleteResult[]): AthleteResult[] => {
    const val = (r: AthleteResult): string | number => {
      if (sort.key === '_name') { const a = db.people.find((p) => p.id === r.reg.athleteId); return `${a?.lastName} ${a?.firstName}`.toLowerCase(); }
      if (sort.key === '_club') return clubName(r.reg.clubId).toLowerCase();
      if (sort.key === '_cat') return r.reg.category ?? '';
      if (sort.key === '_aa') return r.aa;
      return r.events[sort.key]?.final ?? -1;
    };
    return [...rows].sort((a, b) => {
      const va = val(a), vb = val(b);
      if (typeof va === 'string' || typeof vb === 'string') return String(va).localeCompare(String(vb)) * sort.dir * -1;
      return (va - vb) * sort.dir;
    });
  };

  const clickSort = (key: string, isText = false) =>
    setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: isText ? 1 : -1 }));
  const arrow = (key: string) => (sort.key === key ? (sort.dir === -1 ? ' ↓' : ' ↑') : '');

  const levelEntries = [...byLevel.entries()].filter(([lid, rows]) =>
    rows.length > 0 && (!levelFilter || lid === levelFilter));

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', gap: 10, flexWrap: 'wrap' }}>
        <div>
          <h1 className="page-title display">{meet.name}</h1>
          <p className="page-sub">
            {meet.status === 'in-progress' && <><span className="pulse" /><strong>Live</strong> — updates as judges post. </>}
            Unique URL per meet & session: <code>#/results/{meet.slug}</code>
          </p>
        </div>
        <MeetStatusBadge status={meet.status} />
      </div>

      <div className="grid cols-2" style={{ marginBottom: 14 }}>
        <select className="input" value={session.id} onChange={(e) => { setSessionId(e.target.value); setLevelFilter(''); setCatFilter(''); }}>
          {meet.sessions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <Tabs
          tabs={[{ id: 'aa' as const, label: 'All-Around' }, { id: 'events' as const, label: 'By event' }, { id: 'team' as const, label: 'Team' }]}
          active={view}
          onChange={setView}
        />
      </div>

      {view === 'aa' && (
        <>
          <div className="res-filters">
            <input className="input" style={{ maxWidth: 260 }} placeholder="Search athlete or club…" value={search} onChange={(e) => setSearch(e.target.value)} />
            {categories.length > 0 && (
              <select className="input" style={{ maxWidth: 220 }} value={catFilter} onChange={(e) => setCatFilter(e.target.value)}>
                <option value="">All categories</option>
                {categories.map((c) => <option key={c}>{c}</option>)}
              </select>
            )}
            <select className="input" style={{ maxWidth: 220 }} value={levelFilter} onChange={(e) => setLevelFilter(e.target.value)}>
              <option value="">All levels</option>
              {[...byLevel.keys()].map((lid) => <option key={lid} value={lid}>{db.levels.find((l) => l.id === lid)?.name ?? lid}</option>)}
            </select>
            <span className="res-legend">
              <span className="res-medal res-medal-1">●</span> 1st <span className="res-medal res-medal-2">●</span> 2nd <span className="res-medal res-medal-3">●</span> 3rd
              <span className="res-qual-dot" /> qualifier
            </span>
          </div>

          {levelEntries.map(([levelId, rows]) => {
            const shown = sortRows(rows.filter(matchesFilters));
            if (shown.length === 0) return null;
            const isCollapsed = collapsed.has(levelId);
            return (
              <div key={levelId} style={{ marginBottom: 18 }}>
                <button
                  className="res-group-header display"
                  onClick={() => setCollapsed((c) => { const n = new Set(c); if (n.has(levelId)) n.delete(levelId); else n.add(levelId); return n; })}
                >
                  <span>{db.levels.find((l) => l.id === levelId)?.name ?? levelId}</span>
                  <span style={{ fontSize: 12, fontFamily: 'var(--font-body)', fontWeight: 600 }}>{shown.length} athletes {isCollapsed ? '▸' : '▾'}</span>
                </button>
                {!isCollapsed && (
                  <div className="card" style={{ overflowX: 'auto', borderTopLeftRadius: 0, borderTopRightRadius: 0 }}>
                    <table className="tbl res-tbl">
                      <thead>
                        <tr>
                          <th onClick={() => clickSort('_name', true)} className="res-sortable">Athlete{arrow('_name')}</th>
                          <th onClick={() => clickSort('_club', true)} className="res-sortable">Club{arrow('_club')}</th>
                          {categories.length > 0 && <th onClick={() => clickSort('_cat', true)} className="res-sortable">Category{arrow('_cat')}</th>}
                          {events.map((ev) => (
                            <th key={ev.code} className="num res-sortable" data-tip={ev.name} onClick={() => clickSort(ev.code)}>{ev.code}{arrow(ev.code)}</th>
                          ))}
                          <th className="num res-sortable" onClick={() => clickSort('_aa')}>AA{arrow('_aa')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {shown.map((r) => (
                          <ResultRow
                            key={r.reg.id}
                            r={r}
                            events={events.map((e) => e.code)}
                            name={athleteName(r.reg.athleteId)}
                            club={clubName(r.reg.clubId)}
                            showCat={categories.length > 0}
                            aaPlace={places.aa.get(r.reg.id)}
                            evPlace={(ev) => places.ev.get(`${r.reg.id}|${ev}`)}
                            linkScores={canOpenScore(r.reg.athleteId)}
                          />
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}

      {view === 'events' && (
        <div className="grid cols-2">
          {eventRankings.map((er) => (
            <div className="card card-pad" key={er.event}>
              <h3 className="card-title">{events.find((e) => e.code === er.event)?.name ?? er.event}</h3>
              <table className="tbl">
                <tbody>
                  {er.rows.slice(0, 10).map((row) => (
                    <tr key={row.reg.id}>
                      <td style={{ width: 36 }}><span className={`rank-chip r${row.rank}`}>{row.rank}</span></td>
                      <td><strong>{athleteName(row.reg.athleteId)}</strong> <span style={{ color: 'var(--ink-soft)', fontSize: 12.5 }}>{clubName(row.reg.clubId)}</span></td>
                      <td className="num score">{scoreLink(row.score, canOpenScore(row.reg.athleteId))}</td>
                    </tr>
                  ))}
                  {er.rows.length === 0 && <tr><td style={{ color: 'var(--ink-soft)' }}>No scores yet.</td></tr>}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}

      {view === 'team' && (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 40 }}>#</th><th>Club</th>
                {events.map((ev) => <th key={ev.code} className="num">{ev.code}</th>)}
                <th className="num">Team total</th>
              </tr>
            </thead>
            <tbody>
              {teamScores.map((t, i) => (
                <tr key={t.clubId}>
                  <td><span className={`rank-chip r${i + 1}`}>{i + 1}</span></td>
                  <td><strong>{db.clubs.find((c) => c.id === t.clubId)?.name}</strong></td>
                  {events.map((ev) => <td key={ev.code} className="num score">{fmtScore(t.perEvent[ev.code])}</td>)}
                  <td className="num score" style={{ fontSize: 15 }}>{fmtScore(t.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', padding: '0 12px 12px' }}>Team score = top 3 scores per club per event, summed across events.</p>
        </div>
      )}
    </div>
  );
}

/** Standard competition ranking (1, 2, 2, 4) descending by score. */
function rank<T>(rows: T[], score: (r: T) => number): Map<T, number> {
  const sorted = [...rows].sort((a, b) => score(b) - score(a));
  const out = new Map<T, number>();
  sorted.forEach((r, i) => {
    out.set(r, i > 0 && score(sorted[i - 1]) === score(r) ? out.get(sorted[i - 1])! : i + 1);
  });
  return out;
}

function medalClass(place?: number): string {
  return place === 1 ? ' res-medal-1' : place === 2 ? ' res-medal-2' : place === 3 ? ' res-medal-3' : '';
}

function scoreLink(sc: Score | undefined, canOpen: boolean) {
  if (!sc || sc.final == null) return '—';
  const text = sc.final.toFixed(3);
  return canOpen
    ? <Link to={scoreDetailPath(sc.id)} data-tip="Score details" style={{ textDecoration: 'none', borderBottom: '1px dotted var(--ink-soft)' }}>{text}</Link>
    : text;
}

function ResultRow({ r, events, name, club, showCat, aaPlace, evPlace, linkScores }: {
  r: AthleteResult;
  events: string[];
  name: string;
  club: string;
  showCat: boolean;
  aaPlace?: number;
  evPlace: (ev: string) => number | undefined;
  linkScores: boolean;
}) {
  const reg: Registration = r.reg;
  return (
    <tr>
      <td className={reg.quals?.AA ? 'res-qual' : ''}><strong>{name}</strong></td>
      <td style={{ fontSize: 13 }}>{club}</td>
      {showCat && <td>{reg.category ? <Badge tone="info">{reg.category}</Badge> : ''}</td>}
      {events.map((ev) => {
        const sc = r.events[ev];
        const p = evPlace(ev);
        return (
          <td key={ev} className={`num score${medalClass(p)}${reg.quals?.[ev] ? ' res-qual' : ''}`}>
            {reg.events.includes(ev) ? <>{scoreLink(sc, linkScores)}{p != null && p <= 3 && <span className="res-place"> {p}</span>}</> : ''}
          </td>
        );
      })}
      <td className={`num score${medalClass(aaPlace)}${reg.quals?.AA ? ' res-qual' : ''}`} style={{ fontSize: 15 }}>
        {r.aa > 0 ? r.aa.toFixed(3) : '—'}{!r.aaComplete && r.aa > 0 && <span style={{ color: 'var(--coral-600)' }} title="Events still to come">*</span>}
        {aaPlace != null && aaPlace <= 3 && <span className="res-place"> {aaPlace}</span>}
      </td>
    </tr>
  );
}
