import { NavLink, Link, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useDB, useViewPersonId, setViewPersonId } from '../lib/store';
import { useCapabilities } from '../lib/capabilities';
import { isSupabaseConfigured, supabase } from '../lib/supabase';
import { offeredMembershipTypes } from '../lib/pricing';
import { useSession } from '../lib/auth';
import { Combo } from './ui';
import { useNavHistory, useGoBack, labelFor } from '../lib/navHistory';

interface NavGroup { group: string; items: { to: string; label: string }[] }

/** Build the sidebar from real capabilities (union, not a role toggle). */
function navFor(caps: ReturnType<typeof useCapabilities>): NavGroup[] {
  const groups: NavGroup[] = [];
  groups.push({ group: 'Browse', items: [
    { to: '/', label: 'Home' },
    { to: '/results', label: 'Live Results' },
    { to: '/meets', label: 'Meets' },
    ...(caps.person ? [{ to: '/clubs', label: 'Club Directory' }] : []),
  ]});
  if (caps.person) {
    groups.push({ group: 'My UCG', items: [
      { to: '/me', label: 'Profile' },
      { to: '/membership', label: 'Membership' },
      { to: '/me/registrations', label: 'My Registrations' },
      { to: '/me/purchases', label: 'Purchase History' },
    ]});
  }
  if (caps.managedClubIds.length > 0) {
    const cid = caps.managedClubIds[0];
    groups.push({ group: 'My Club', items: [
      { to: `/club/${cid}`, label: 'Roster & Meet Reg' },
      { to: `/club/${cid}/cart`, label: 'Club Cart & Invoices' },
      { to: '/sanction', label: 'Request a Sanction' },
    ]});
  }
  if (caps.isSanctioning) {
    groups.push({ group: 'Sanctioning', items: [
      { to: '/sanctioning', label: 'Sanctioning Queue' },
    ]});
  }
  if (caps.actingAsAdmin) {
    groups.push({ group: 'League', items: [
      { to: '/admin/members', label: 'Members' },
      { to: '/admin/clubs', label: 'Clubs' },
      { to: '/admin/league', label: 'League Controls' },
      { to: '/admin/communicate', label: 'Communicate' },
      { to: '/admin/errors', label: 'Error Log' },
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
  useNavHistory(); // record each page visit into the module-level stack
  const goBack = useGoBack(); // null when no prior history

  const me = caps.person;
  const season = db.seasons.find((s) => s.current)!;
  const myClubShort = me ? (db.clubs.find((c) => c.id === me.mainClubId)?.shortName
    || db.clubs.find((c) => c.id === me.mainClubId)?.name || 'your club') : 'your club';
  // Per-role membership status for the banner: a person who is an athlete and/or
  // coach should see each offered type's status separately.
  const membershipBannerItems = me ? offeredMembershipTypes(
    me.roles ?? { athlete: me.kind !== 'coach', coach: me.kind === 'coach' },
  ).map((type) => ({
    type,
    label: type === 'coach' ? 'Coach' : 'Athlete',
    status: me.memberships.find((m) => m.seasonId === season.id && m.type === type)?.status ?? 'none',
  })) : [];

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
                end
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
                {/* Wrapper overrides combo-list to open upward so it stays on-screen,
                    and darkens combo-item text for readability. */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <style>{`
                    .role-card .combo .combo-list {
                      top: auto;
                      bottom: calc(100% + 4px);
                      max-height: min(240px, 60vh);
                    }
                    .role-card .combo .combo-item {
                      color: var(--navy-800);
                    }
                    .role-card .combo .combo-item .sub {
                      color: var(--navy-600);
                    }
                  `}</style>
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
              className="btn small ghost signout-btn"
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
          {goBack ? (
            <button
              type="button"
              onClick={goBack}
              style={{
                background: 'none',
                border: 'none',
                padding: '4px 8px 4px 0',
                cursor: 'pointer',
                fontSize: 13,
                color: 'var(--ink-soft)',
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                flexShrink: 0,
              }}
            >
              ← Back
            </button>
          ) : null}
          <span className="crumb">{labelFor(loc.pathname)}</span>
          <div style={{ flex: 1 }} />
          {me && (() => {
            const cartCount = (db.carts[me.id] ?? []).length;
            return (
              <Link to="/cart" className="topbar-user" title="View your cart" style={{ marginRight: 8 }}>
                🛒 Cart{cartCount > 0 ? ` (${cartCount})` : ''}
              </Link>
            );
          })()}
          {me ? (
            <Link to="/me" className="topbar-user" title="View your profile">
              <span className="topbar-user-avatar" aria-hidden="true">
                {(me.firstName?.[0] ?? '').toUpperCase()}{(me.lastName?.[0] ?? '').toUpperCase()}
              </span>
              <span className="topbar-user-name">
                {caps.impersonating ? 'Viewing as ' : ''}{me.firstName} {me.lastName}
              </span>
            </Link>
          ) : isSupabaseConfigured && !session ? (
            <Link to="/me" className="topbar-user topbar-user-guest">Sign in</Link>
          ) : null}
          {me && membershipBannerItems.length > 0 && (
            <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' }}>
              {membershipBannerItems.map(({ type, label, status }) => (
                status === 'active' ? (
                  <span key={type} className="member-banner ok">✓ {season.name} {label} membership active</span>
                ) : status === 'pending-club-payment' ? (
                  <span key={type} className="member-banner warn">⏳ {season.name} {label} membership — pending payment by {myClubShort} · <Link to="/membership">details</Link></span>
                ) : status === 'pending-waiver' ? (
                  <span key={type} className="member-banner warn">⏳ {season.name} {label} membership — pending guardian waiver · <Link to="/membership">details</Link></span>
                ) : (
                  <span key={type} className="member-banner warn">✕ No {season.name} {label} membership · <Link to="/membership">purchase now</Link></span>
                )
              ))}
            </span>
          )}
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
