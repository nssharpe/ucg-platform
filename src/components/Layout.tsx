import { NavLink, Link, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useDB, useRole, setRole, ROLES, usePersona, useViewPersonId, setViewPersonId } from '../lib/store';
import type { RoleId } from '../lib/types';
import { Combo } from './ui';

const NAV: Record<RoleId, { group: string; items: { to: string; label: string }[] }[]> = {
  admin: [
    { group: 'League', items: [
      { to: '/', label: 'Dashboard' },
      { to: '/admin/members', label: 'Members' },
      { to: '/admin/clubs', label: 'Clubs' },
      { to: '/admin/league', label: 'League Controls' },
      { to: '/admin/communicate', label: 'Communicate' },
    ]},
    { group: 'Competition', items: [
      { to: '/meets', label: 'Meets' },
      { to: '/results', label: 'Live Results' },
    ]},
  ],
  'club-manager': [
    { group: 'My Club', items: [
      { to: '/', label: 'Dashboard' },
      // club-1 is a placeholder rewritten to the impersonated persona's club at render time
      { to: '/club/club-1', label: 'Roster' },
      { to: '/club/club-1/cart', label: 'Club Cart & Invoices' },
    ]},
    { group: 'Competition', items: [
      { to: '/meets', label: 'Meets' },
      { to: '/results', label: 'Live Results' },
    ]},
  ],
  athlete: [
    { group: 'My UCG', items: [
      { to: '/', label: 'Dashboard' },
      { to: '/me', label: 'Profile' },
      { to: '/membership', label: 'Membership' },
    ]},
    { group: 'Competition', items: [
      { to: '/meets', label: 'Meets' },
      { to: '/results', label: 'Live Results' },
    ]},
  ],
  judge: [
    { group: 'Judging', items: [
      { to: '/', label: 'Dashboard' },
      { to: '/judge', label: 'Score Entry' },
      { to: '/results', label: 'Live Results' },
    ]},
  ],
  'meet-host': [
    { group: 'Hosting', items: [
      { to: '/', label: 'Dashboard' },
      { to: '/meets/midwest-regional-2026/manage', label: 'Manage My Meet' },
      { to: '/meets', label: 'All Meets' },
      { to: '/results', label: 'Live Results' },
    ]},
  ],
  spectator: [
    { group: 'Spectate', items: [
      { to: '/', label: 'Home' },
      { to: '/results', label: 'Live Results' },
      { to: '/meets', label: 'Meets' },
    ]},
  ],
};

export function Layout({ children }: { children: ReactNode }) {
  const role = useRole();
  const db = useDB();
  const loc = useLocation();
  const roleInfo = ROLES.find((r) => r.id === role)!;
  const persona = usePersona();
  const viewPersonId = useViewPersonId();

  // Membership banner for the athlete persona (spec: always-obvious status)
  const me = db.people.find((p) => p.id === persona.athleteId);
  const personOptions = db.people.map((p) => ({
    value: p.id,
    label: `${p.firstName} ${p.lastName}`,
    sub: `${p.kind}${p.mainClubId ? ` · ${db.clubs.find((c) => c.id === p.mainClubId)?.shortName ?? ''}` : ''}`,
  }));
  const personaName = me && viewPersonId ? `${me.firstName} ${me.lastName}` : roleInfo.personaName;
  const season = db.seasons.find((s) => s.current)!;
  const myMembership = me?.memberships.find((m) => m.seasonId === season.id);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand-block">
          <Link to="/" className="brand-mark">UCG<span className="spark">.</span></Link>
          <div className="brand-sub">United Club Gymnastics</div>
        </div>
        {NAV[role].map((g) => (
          <nav className="nav-group" key={g.group}>
            <div className="nav-group-label">{g.group}</div>
            {g.items.map((it) => (
              <NavLink
                key={it.to}
                to={it.to.replace('club-1', persona.clubId)}
                end={it.to === '/'}
                className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
              >
                {it.label}
              </NavLink>
            ))}
          </nav>
        ))}
        <div className="role-card">
          <label>Viewing as</label>
          <select value={role} onChange={(e) => setRole(e.target.value as RoleId)}>
            {ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </select>
          <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginTop: 6 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <Combo
                options={personOptions}
                value={viewPersonId}
                onChange={(v) => setViewPersonId(v)}
                placeholder="View as person…"
              />
            </div>
            {viewPersonId && (
              <button
                type="button"
                className="btn ghost"
                title="Reset to default persona"
                onClick={() => setViewPersonId(null)}
                style={{ padding: '2px 8px' }}
              >✕</button>
            )}
          </div>
          <div className="persona">{personaName} — {roleInfo.description}</div>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <span className="crumb">{loc.pathname === '/' ? 'Home' : loc.pathname.replace(/^\//, '').split('/').join(' / ')}</span>
          <div style={{ flex: 1 }} />
          {role === 'athlete' && me && (
            myMembership?.status === 'active' ? (
              <span className="member-banner ok">✓ {season.name} membership active</span>
            ) : myMembership?.status === 'pending-club-payment' ? (
              <span className="member-banner warn">⏳ Awaiting club payment — <Link to="/membership">details</Link></span>
            ) : (
              <span className="member-banner warn">✕ No {season.name} membership — <Link to="/membership">purchase now</Link></span>
            )
          )}
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
