import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useDB } from '../lib/store';
import { useCapabilities } from '../lib/capabilities';
import { Tabs, Badge } from '../components/ui';
import { useFmtDate, useToast } from '../components/ui-hooks';
import { EventStatusBadge } from './Home';
import { sessionResults, fmtScore, unplacedScoreCount, UNASSIGNED_SESSION_ID } from '../lib/scoring';
import { scoreDetailPath } from '../lib/calculators';
import { APPARATUS } from '../lib/types';
import type { Registration, Score } from '../lib/types';
import type { AthleteResult } from '../lib/scoring';
import { useEventScores } from '../lib/scores-slice';
import { useEventRegistrations } from '../lib/registrations-slice';
import { usePeopleNames, nameLookup } from '../lib/people-slice';
import { eventIsInPhase } from '../lib/events-core';
import { appBaseUrl, copyToClipboard } from '../lib/url';

// H1: the two standard empty-state messages for the results tables, matching
// the muted style used elsewhere (e.g. Club.tsx's "Active members not yet
// registered…").
const NO_MATCH_MSG = 'No athletes match your search.';
const NO_SCORES_MSG = 'No scores posted yet — results appear here live as judges enter them.';
/** Truthful empty state (2026-07-31): when scores exist for this event but their
 *  registrations carry no session, they can't appear under any session tab. Saying
 *  "No scores posted yet" there is actively wrong — it reads as "judging hasn't
 *  started" when judging has, which on meet day sends a host debugging the tablets
 *  instead of the roster. `unplaced` comes from `unplacedScoreCount` (scoring.ts). */
const unplacedMsg = (n: number) =>
  `${n} ${n === 1 ? 'score is' : 'scores are'} posted but not assigned to a session — `
  + 'assign each athlete a session on the event roster and they will appear here.';
function emptyMsg(hasFilter: boolean, unplaced: number): string {
  if (hasFilter) return NO_MATCH_MSG;
  return unplaced > 0 ? unplacedMsg(unplaced) : NO_SCORES_MSG;
}
function ResultsEmpty({ hasFilter, unplaced = 0 }: { hasFilter: boolean; unplaced?: number }) {
  return <p style={{ color: 'var(--ink-soft)', fontSize: 14 }}>{emptyMsg(hasFilter, unplaced)}</p>;
}

export function ResultsIndex() {
  const db = useDB();
  const fmtDate = useFmtDate();
  const events = db.events.filter((m) =>
    eventIsInPhase(m, 'in-progress') || eventIsInPhase(m, 'complete') || eventIsInPhase(m, 'reg-closed'));
  return (
    <div>
      <h1 className="page-title display">Live results</h1>
      <p className="page-sub">Public — no login needed. Scores appear the moment a judge posts them.</p>
      <div className="grid cols-2">
        {events.map((m) => (
          <div className="card card-pad" key={m.id}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
              <h3 style={{ fontSize: 18 }}>{eventIsInPhase(m, 'in-progress') && <span className="pulse" />}{m.name}</h3>
              <EventStatusBadge event={m} />
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
// Event results — presentation ported from the Nationals 2026 results viewer:
// collapsible level groups, per-group column sorting, search/category/level
// filters, tie-aware places (1,2,2,4), medal colors, qualifier highlighting.
// ---------------------------------------------------------------------------

type SortSpec = { key: string; dir: 1 | -1 };

export function EventResults() {
  const { slug } = useParams();
  const db = useDB();
  const caps = useCapabilities();
  const toast = useToast();
  const event = db.events.find((m) => m.slug === slug);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [view, setView] = useState<'aa' | 'events' | 'team'>('aa');
  const [search, setSearch] = useState('');
  const [catFilter, setCatFilter] = useState('');
  const [levelFilter, setLevelFilter] = useState('');
  const [sort, setSort] = useState<SortSpec>({ key: '_aa', dir: -1 });
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // Scores slice (Phase 2, docs/specs/2026-07-24-data-layer-scale.md) — the
  // per-event realtime channel that used to feed this page's own patch-map
  // overlay is now wired as the slice's own invalidation signal
  // (scores-slice.ts), so this is just a normal by-event read.
  const { rows: eventScores, status: scoresStatus } = useEventScores(event?.id);
  const { rows: eventRegs, status: regsStatus } = useEventRegistrations(event?.id);

  // Scores that can't resolve to any REAL session tab (UAT Z-06) — they still
  // render, under the "Unassigned" tab below, so this drives that tab's
  // caption/count rather than a hidden/missing one. Only meaningful once
  // both slices are ready; a mid-load partial read would otherwise report a
  // scary count that resolves to 0 a moment later. Computed before
  // `isUnassignedView` below on purpose — that derivation needs it.
  const unplaced = useMemo(
    () => (scoresStatus === 'ready' && regsStatus === 'ready' && event
      ? unplacedScoreCount(eventScores, eventRegs, event.sessions.map((s) => s.id))
      : 0),
    [scoresStatus, regsStatus, eventScores, eventRegs, event],
  );

  // The explicit "Unassigned" group (UAT Z-06) is a pseudo-session, not a
  // real one — never let the `?? event?.sessions[0]` default below silently
  // redirect it back to a real session tab. Gated on `unplaced > 0` too: if
  // the count drops to 0 while this tab is still selected (its own `<option>`
  // disappears, but `sessionId` state doesn't reset on its own), falling
  // through to a real session avoids reprinting the exact false "0 scores are
  // posted but not assigned" statement the 2026-07-31 fix exists to prevent.
  const isUnassignedView = sessionId === UNASSIGNED_SESSION_ID && unplaced > 0;
  const session = isUnassignedView ? undefined : (event?.sessions.find((s) => s.id === sessionId) ?? event?.sessions[0]);

  // Phase 4 (data-layer-scale.md): db.people at boot no longer covers
  // cross-club competitors — this is a PUBLIC, no-login results page, so
  // names come from the thin public_competitors-backed shape (works for an
  // anonymous visitor too, unlike the real people table). Derived from the
  // full by-event registration set (not session-scoped) so switching the
  // session selector below doesn't need a refetch.
  const athleteIds = useMemo(() => [...new Set(eventRegs.map((r) => r.athleteId))], [eventRegs]);
  const { rows: competitorRefs, status: peopleStatus } = usePeopleNames(athleteIds);
  const athleteNameById = useMemo(() => nameLookup(competitorRefs), [competitorRefs]);
  const competitorById = useMemo(() => new Map(competitorRefs.map((r) => [r.id, r])), [competitorRefs]);

  const computed = useMemo(
    () => (event && (session || isUnassignedView)
      ? sessionResults(event, isUnassignedView ? UNASSIGNED_SESSION_ID : session!.id, eventScores, eventRegs)
      : null),
    [event, session, isUnassignedView, eventScores, eventRegs],
  );

  // Tie-aware places (1,2,2,4) per (level, category) group — the viewer's
  // recomputePlaces. Returns rank maps for AA and each event. Computed before the
  // early return below so the hook always runs; no-ops to empty maps when there's
  // nothing to rank yet.
  const places = useMemo(() => {
    const aa = new Map<string, number>();
    const ev = new Map<string, number>(); // key `${regId}|${event}`
    if (!computed || (!session && !isUnassignedView)) return { aa, ev };
    const sessionEvents = APPARATUS[computed.discipline];
    for (const [levelId, rows] of computed.byLevel.entries()) {
      const cats = [...new Set(rows.map((r) => r.reg.category ?? ''))];
      for (const cat of cats) {
        const group = rows.filter((r) => (r.reg.category ?? '') === cat);
        rank(group.filter((r) => r.aa > 0), (r) => r.aa).forEach((p, r) => aa.set(r.reg.id, p));
        for (const e of sessionEvents) {
          const scored = group.filter((r) => r.apparatus[e.code]?.final != null);
          rank(scored, (r) => r.apparatus[e.code]!.final!).forEach((p, r) => ev.set(`${r.reg.id}|${e.code}`, p));
        }
      }
      void levelId;
    }
    return { aa, ev };
  }, [computed, session, isUnassignedView]);

  if (!event || (!session && !isUnassignedView) || !computed) return <p>Event not found.</p>;
  const { byLevel, apparatusRankings, teamScores } = computed;
  const events = APPARATUS[computed.discipline];
  const clubName = (id: string) => db.clubs.find((c) => c.id === id)?.shortName ?? id;
  const athleteName = (athleteId: string) => athleteNameById.get(athleteId) ?? athleteId;

  // H3: absolute link to this results page. The session isn't part of the
  // route/query (`sessionId` is local component state only), so there's
  // nothing session-specific to fold in — copy the page URL as-is.
  const handleCopyLink = async () => {
    const ok = await copyToClipboard(`${appBaseUrl()}/#/results/${event.slug}`);
    if (ok) toast('Link copied');
  };

  // Categories present in this session (drives badge column + filter).
  const categories = [...new Set([...byLevel.values()].flat().map((r) => r.reg.category).filter(Boolean))] as string[];

  // H1: whether an active search/category/level filter could be responsible
  // for an empty result set (message copy differs from the "no data at all" case).
  const hasActiveFilter = !!search || !!catFilter || !!levelFilter;

  const canOpenScore = (athleteId: string) =>
    caps.isAdmin || caps.isEventHost(event?.id ?? '') || caps.personId === athleteId;

  const matchesFilters = (r: AthleteResult) => {
    if (catFilter && (r.reg.category ?? '') !== catFilter) return false;
    if (search) {
      const hay = `${athleteName(r.reg.athleteId)} ${clubName(r.reg.clubId)}`.toLowerCase();
      if (!hay.includes(search.toLowerCase())) return false;
    }
    return true;
  };

  const sortRows = (rows: AthleteResult[]): AthleteResult[] => {
    const val = (r: AthleteResult): string | number => {
      if (sort.key === '_name') {
        const a = competitorById.get(r.reg.athleteId);
        return `${a?.lastName ?? ''} ${a?.firstName ?? ''}`.toLowerCase();
      }
      if (sort.key === '_club') return clubName(r.reg.clubId).toLowerCase();
      if (sort.key === '_cat') return r.reg.category ?? '';
      if (sort.key === '_aa') return r.aa;
      return r.apparatus[sort.key]?.final ?? -1;
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
          <h1 className="page-title display">{event.name}</h1>
          {eventIsInPhase(event, 'in-progress') && (
            <p className="page-sub"><span className="pulse" /><strong>Live</strong> — updates as judges post.</p>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <EventStatusBadge event={event} />
          <button className="btn small ghost" onClick={handleCopyLink}>Copy link</button>
        </div>
      </div>

      <div className="grid cols-2" style={{ marginBottom: 14 }}>
        <select className="input" value={isUnassignedView ? UNASSIGNED_SESSION_ID : session!.id} onChange={(e) => { setSessionId(e.target.value); setLevelFilter(''); setCatFilter(''); }}>
          {event.sessions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          {/* UAT Z-06: a real, separate tab (always last) for scores that can't
              resolve to any session above — never hidden, per the honest-empty-
              state fix from 2026-07-31. Only offered when there's something in it. */}
          {unplaced > 0 && <option value={UNASSIGNED_SESSION_ID}>Unassigned ({unplaced})</option>}
        </select>
        <Tabs
          tabs={[{ id: 'aa' as const, label: 'All-Around' }, { id: 'events' as const, label: 'By apparatus' }, { id: 'team' as const, label: 'Team' }]}
          active={view}
          onChange={setView}
        />
      </div>
      {isUnassignedView && (
        <p style={{ color: 'var(--ink-soft)', fontSize: 13.5, margin: '-8px 0 14px' }}>{unplacedMsg(unplaced)}</p>
      )}

      {scoresStatus === 'loading' || regsStatus === 'loading' || peopleStatus === 'loading' ? (
        <p style={{ color: 'var(--ink-soft)', fontSize: 14 }}>Loading…</p>
      ) : (
      <>
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

          {(() => {
            const groupsWithShown = levelEntries.map(([levelId, rows]) => [levelId, sortRows(rows.filter(matchesFilters))] as const);
            const totalShown = groupsWithShown.reduce((n, [, shown]) => n + shown.length, 0);
            if (totalShown === 0) return <ResultsEmpty hasFilter={hasActiveFilter} unplaced={unplaced} />;
            return groupsWithShown.map(([levelId, shown]) => {
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
            });
          })()}
        </>
      )}

      {view === 'events' && (
        <div className="grid cols-2">
          {apparatusRankings.map((er) => (
            <div className="card card-pad" key={er.apparatus}>
              <h3 className="card-title">{events.find((e) => e.code === er.apparatus)?.name ?? er.apparatus}</h3>
              <table className="tbl">
                <tbody>
                  {er.rows.slice(0, 10).map((row) => (
                    <tr key={row.reg.id}>
                      <td style={{ width: 36 }}><span className={`rank-chip r${row.rank}`}>{row.rank}</span></td>
                      <td><strong>{athleteName(row.reg.athleteId)}</strong> <span style={{ color: 'var(--ink-soft)', fontSize: 12.5 }}>{clubName(row.reg.clubId)}</span></td>
                      <td className="num score">{scoreLink(row.score, canOpenScore(row.reg.athleteId))}</td>
                    </tr>
                  ))}
                  {er.rows.length === 0 && (
                    <tr><td style={{ color: 'var(--ink-soft)', fontSize: 13 }}>{emptyMsg(hasActiveFilter, unplaced)}</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}

      {view === 'team' && (
        teamScores.length === 0 ? (
          <div className="card card-pad">
            <ResultsEmpty hasFilter={hasActiveFilter} unplaced={unplaced} />
          </div>
        ) : (
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
                    {events.map((ev) => <td key={ev.code} className="num score">{fmtScore(t.perApparatus[ev.code])}</td>)}
                    <td className="num score" style={{ fontSize: 15 }}>{fmtScore(t.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', padding: '0 12px 12px' }}>Team score = top 3 scores per club per event, summed across events.</p>
          </div>
        )
      )}
      </>
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
        const sc = r.apparatus[ev];
        const p = evPlace(ev);
        return (
          <td key={ev} className={`num score${medalClass(p)}${reg.quals?.[ev] ? ' res-qual' : ''}`}>
            {reg.apparatus.includes(ev) ? <>{scoreLink(sc, linkScores)}{p != null && p <= 3 && <span className="res-place"> {p}</span>}</> : ''}
          </td>
        );
      })}
      <td className={`num score${medalClass(aaPlace)}${reg.quals?.AA ? ' res-qual' : ''}`} style={{ fontSize: 15 }}>
        {r.aa > 0 ? r.aa.toFixed(3) : '—'}{!r.aaComplete && r.aa > 0 && <span style={{ color: 'var(--coral-text)' }} title="Events still to come">*</span>}
        {aaPlace != null && aaPlace <= 3 && <span className="res-place"> {aaPlace}</span>}
      </td>
    </tr>
  );
}
