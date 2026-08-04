import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useDB } from '../lib/store';
import { useCapabilities } from '../lib/capabilities';
import { Badge } from '../components/ui';
import { CLUB_ACCESS_LABELS } from '../lib/types';
import type { Region } from '../lib/types';
import { useAllCompetitors } from '../lib/people-slice';

const REGIONS: Region[] = [
  'Northeast',
  'Mid-Atlantic',
  'Southeast',
  'Mideast',
  'Midwest',
  'South Central',
  'West',
  'Other',
];

export function Clubs() {
  const db = useDB();
  const caps = useCapabilities();

  const [search, setSearch] = useState('');
  const [regionFilter, setRegionFilter] = useState<Region | ''>('');

  const clubs = useMemo(() => {
    const q = search.trim().toLowerCase();
    return db.clubs
      .filter((c) => {
        const matchesSearch =
          !q ||
          c.name.toLowerCase().includes(q) ||
          (c.shortName && c.shortName.toLowerCase().includes(q)) ||
          (c.state && c.state.toLowerCase().includes(q));
        const matchesRegion = !regionFilter || c.region === regionFilter;
        return matchesSearch && matchesRegion;
      })
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [db.clubs, search, regionFilter]);

  // Phase 4 (data-layer-scale.md): db.people at boot no longer covers the
  // whole league, and this directory is reachable by ANY signed-in account
  // (RequireAccount, not admin-gated) — league-wide via the thin
  // public_competitors-backed shape (works for every viewer regardless of
  // club affiliation, unlike people-admin-slice's useAdminPeople which is
  // RLS-gated to admin/managed-club/self).
  const { rows: allCompetitors, status: competitorsStatus } = useAllCompetitors();
  const competitorsReady = competitorsStatus === 'ready';

  // Pre-compute member counts: people whose mainClubId === club.id
  const memberCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const p of allCompetitors) {
      if (p.mainClubId) {
        counts[p.mainClubId] = (counts[p.mainClubId] ?? 0) + 1;
      }
    }
    return counts;
  }, [allCompetitors]);

  return (
    <div>
      <h1 className="page-title display">Club Directory</h1>
      <p className="page-sub">
        All {db.clubs.length} registered club{db.clubs.length !== 1 ? 's' : ''} in the league.
        {clubs.length !== db.clubs.length && ` Showing ${clubs.length} matching.`}
      </p>

      {/* Filters */}
      <div
        style={{
          display: 'flex',
          gap: 10,
          marginBottom: 20,
          flexWrap: 'wrap',
          alignItems: 'flex-end',
        }}
      >
        <div style={{ flex: '1 1 220px', minWidth: 180 }}>
          <input
            type="search"
            className="input"
            placeholder="Search by name, short name, or state…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: '100%' }}
          />
        </div>
        <div style={{ flex: '0 0 180px' }}>
          {/* Standalone filter — no <Field>, so it needs its own accessible name (a11y A1). */}
          <select
            aria-label="Filter clubs by region"
            className="input"
            value={regionFilter}
            onChange={(e) => setRegionFilter(e.target.value as Region | '')}
            style={{ width: '100%' }}
          >
            <option value="">All regions</option>
            {REGIONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
        {(search || regionFilter) && (
          <button
            className="btn ghost small"
            onClick={() => {
              setSearch('');
              setRegionFilter('');
            }}
          >
            Clear
          </button>
        )}
      </div>

      {clubs.length === 0 ? (
        <div className="card card-pad" style={{ color: 'var(--ink-soft)', textAlign: 'center' }}>
          No clubs match your search.
        </div>
      ) : (
        <div className="card" style={{ overflow: 'hidden' }}>
          {/* H4.7: the Region badge (white-space: nowrap) clips at the card's
              right edge around 800px viewport width — wrap the table in its
              own horizontal scroller (same technique as the Events table's
              `.events-table-wrap`) so the table can scroll WITHIN the card
              instead of clipping content or overflowing the page. */}
          <div style={{ overflowX: 'auto' }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Club</th>
                <th>Short name</th>
                <th>State</th>
                <th>Region</th>
                <th>Access policy</th>
                <th className="num">Members</th>
                <th>Managers</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {clubs.map((club) => {
                const count = competitorsReady ? (memberCounts[club.id] ?? 0) : null;
                const managerNames = club.managerIds
                  .map((id) => allCompetitors.find((p) => p.id === id))
                  .filter((p): p is NonNullable<typeof p> => !!p)
                  .map((p) => `${p.firstName} ${p.lastName}`);

                const canManage =
                  caps.isAdmin || caps.managedClubIds.includes(club.id);

                return (
                  <tr key={club.id}>
                    <td>
                      <strong>{club.name}</strong>
                      {club.email && (
                        <>
                          {' '}
                          <a
                            href={`mailto:${club.email}`}
                            style={{ fontSize: 12, color: 'var(--ink-soft)' }}
                          >
                            {club.email}
                          </a>
                        </>
                      )}
                    </td>
                    <td style={{ fontSize: 13.5 }}>
                      {club.shortName && club.shortName !== club.name
                        ? club.shortName
                        : <span style={{ color: 'var(--ink-soft)' }}>—</span>}
                    </td>
                    <td style={{ fontSize: 13.5 }}>{club.state || <span style={{ color: 'var(--ink-soft)' }}>—</span>}</td>
                    <td>
                      <Badge tone="info">{club.region}</Badge>
                    </td>
                    <td style={{ fontSize: 13, color: 'var(--ink-soft)' }}>
                      {CLUB_ACCESS_LABELS[club.access] ?? club.access}
                    </td>
                    <td className="num">{count ?? '…'}</td>
                    <td style={{ fontSize: 13 }}>
                      {managerNames.length > 0
                        ? managerNames.join(', ')
                        : <span style={{ color: 'var(--ink-soft)' }}>—</span>}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      {canManage && (
                        <Link className="btn small ghost" to={`/club/${club.id}`}>
                          Manage
                        </Link>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        </div>
      )}
    </div>
  );
}
