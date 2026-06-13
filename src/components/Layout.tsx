import { NavLink, Link, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useDB, useViewPersonId, setViewPersonId } from '../lib/store';
import { useCapabilities } from '../lib/capabilities';
import { isSupabaseConfigured, supabase } from '../lib/supabase';
import { useSession } from '../lib/auth';
import { Combo } from './ui';

interface NavGroup { group: string; items: { to: string; label: string }[] }

/** Build the sidebar from real capabilities (union, not a role toggle). */
function navFor(caps: ReturnType<typeof useCapabilities>): NavGroup[] {
  const groups: NavGroup[] = [];
  groups.push({ group: 'Browse', items: [
    { to: '/', label: 'Home' },
    { to: '/results', label: 'Live Results' },
    { to: '/meets', label: 'Meets' },
  ]});
  if (caps.person) {
    groups.push({ group: 'My UCG', items: [
      { to: '/me', label: 'Profile' },
      { to: '/membership', label: 'Membership' },
    ]});
  }
  if (caps.managedClubIds.length > 0) {
    const cid = caps.managedClubIds[0];
    groups.push({ group: 'My Club', items: [
      { to: `/club/${cid}`, label: 'Roster & meet reg' },
      { to: `/club/${cid}/cart`, label: 'Club Cart & Invoices' },
    ]});
  }
  if (caps.isAdmin || caps.managedClubIds.length > 0) {
    groups.push({ group: 'Scoring', items: [{ to: '/judge', label: 'Score Entry' }] });
  }
  if (caps.isAdmin) {
    groups.push({ group: 'League', items: [
      { to: '/admin/members', label: 'Members' },
      { to: '/admin/clubs', label: 'Clubs' },
      { to: '/admin/league', label: 'League Controls' },
      { to: '/admin/communicate', label: 'Communicate' },
    ]});
  }
  return groups;
}

export function Layout({ children }: { children: ReactNode }) {
  const caps = useCapabilities();
  const db = useDB();
  const loc = useLocation();
  const viewPersonId = useViewPersonId();
  const session = useSession();

  const me = caps.person;
  const season = db.seasons.find((s) => s.current)!;
  const myMembership = me?.memberships.find((m) => m.seasonId === season.id);

  // Admin-only "view as (person)" impersonation.
  const personOptions = db.people.map((p) => ({
    value: p.id,
    label: `${p.firstName} ${p.lastName}`,
    sub: `${p.kind}${p.mainClubId ? ` · ${db.clubs.find((c) => c.id === p.mainClubId)?.shortName ?? ''}` : ''}`,
  }));

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand-block">
          <Link to="/" className="brand-mark">UCG<span className="spark">.</span></Link>
          <div className="brand-sub">United Club Gymnastics</div>
        </div>
        {navFor(caps).map((g) => (
          <nav className="nav-group" key={g.group}>
            <div className="nav-group-label">{g.group}</div>
            {g.items.map((it) => (
              <NavLink
                key={it.to}
                to={it.to}
                end={it.to === '/'}
                className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
              >
                {it.label}
              </NavLink>
            ))}
          </nav>
        ))}

        <div className="role-card">
          {caps.isAdmin && (
            <>
              <label>View as (admin)</label>
              <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
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
                    title="Stop viewing as this person"
                    onClick={() => setViewPersonId(null)}
                    style={{ padding: '2px 8px' }}
                  >✕</button>
                )}
              </div>
            </>
          )}
          {caps.impersonating && me && (
            <div className="persona" style={{ marginTop: caps.isAdmin ? 8 : 0 }}>
              Viewing as <strong>{me.firstName} {me.lastName}</strong>
            </div>
          )}
          {isSupabaseConfigured && session && (
            <button
              type="button"
              className="btn small ghost"
              style={{ width: '100%', justifyContent: 'center', marginTop: 8 }}
              onClick={() => supabase!.auth.signOut()}
            >
              Sign out
            </button>
          )}
          {isSupabaseConfigured && !session && (
            <div className="persona">Browsing as a guest · <Link to="/me">sign in</Link> to register.</div>
          )}
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          <span className="crumb">{loc.pathname === '/' ? 'Home' : loc.pathname.replace(/^\//, '').split('/').join(' / ')}</span>
          <div style={{ flex: 1 }} />
          {me && (
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
