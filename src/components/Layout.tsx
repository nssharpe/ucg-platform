import { NavLink, Link, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import primaryLogoWhite from '../assets/brand/primary-logo-white.svg';
import { useDB } from '../lib/store';
import { useCapabilities } from '../lib/capabilities';
import { isSupabaseConfigured, supabase } from '../lib/supabase';
import { offeredMembershipTypes } from '../lib/pricing';
import { useSession } from '../lib/auth';
import { clearLegacyMfaNagDismissal } from '../lib/mfa';
import { TopbarMembership } from './TopbarMembership';
import { ReportProblemDialog } from './ReportProblemDialog';
import { useNavHistory, useGoBack, resolveLabel } from '../lib/navHistory';
import { currentSeason } from '../lib/season-lifecycle';

/** "vSHA · YYYY-MM-DD" build stamp shown at the bottom of the sidebar. */
const buildStampLabel = `v${__BUILD_INFO__.sha} · ${__BUILD_INFO__.date.slice(0, 10)}`;

interface NavGroup { group: string; items: { to: string; label: string }[] }

/** Build the sidebar from real capabilities (union, not a role toggle). */
function navFor(caps: ReturnType<typeof useCapabilities>): NavGroup[] {
  const groups: NavGroup[] = [];
  groups.push({ group: 'Browse', items: [
    { to: '/', label: 'Home' },
    { to: '/results', label: 'Live Results' },
    { to: '/events', label: 'Events' },
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
      { to: `/club/${cid}/roster`, label: 'Club Roster' },
      { to: `/club/${cid}/registrations`, label: 'Club Registrations' },
      { to: `/club/${cid}/cart`, label: 'Club Cart & Receipts' },
      { to: '/sanction', label: 'Request a Sanction' },
    ]});
  }
  if (caps.isSanctioning) {
    groups.push({ group: 'Sanctioning', items: [
      { to: '/sanctioning', label: 'Sanctioning Queue' },
    ]});
  }
  if (caps.isAdmin) {
    groups.push({ group: 'League', items: [
      { to: '/admin/members', label: 'Members' },
      { to: '/admin/clubs', label: 'Clubs' },
      { to: '/admin/league', label: 'League Controls' },
      { to: '/admin/communicate', label: 'Communicate' },
      { to: '/admin/errors', label: 'Error Log' },
      { to: '/admin/refunds', label: 'Refund Requests' },
      { to: '/admin/finance', label: 'Finance' },
    ]});
  } else {
    // isAdmin is never implicitly isRefundManager/isFinanceAdmin or vice
    // versa (CLAUDE.md) — a non-admin can hold either role, both, or
    // neither, so these two groups are independent checks, not an
    // else-if chain.
    if (caps.isRefundManager) {
      groups.push({ group: 'Refunds', items: [
        { to: '/admin/refunds', label: 'Refund Requests' },
      ]});
    }
    if (caps.isFinanceAdmin) {
      groups.push({ group: 'Finance', items: [
        { to: '/admin/finance', label: 'Finance' },
      ]});
    }
  }
  return groups;
}

export function Layout({ children }: { children: ReactNode }) {
  const caps = useCapabilities();
  const db = useDB();
  const loc = useLocation();
  const topbarRef = useRef<HTMLElement>(null);
  const [navOpen, setNavOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);

  // Close the drawer on navigation. Derive the close from a path change using
  // the store-previous-value pattern (setState during render bails out the
  // in-progress render) — this avoids both `set-state-in-effect` and the
  // ref-during-render lint errors that an effect/ref approach would trip.
  const [lastPath, setLastPath] = useState(loc.pathname);
  if (lastPath !== loc.pathname) {
    setLastPath(loc.pathname);
    if (navOpen) setNavOpen(false);
  }

  // Close on Escape; lock body scroll while the drawer is open.
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setNavOpen(false); };
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [navOpen]);
  const session = useSession();
  useNavHistory(db); // record each page visit into the module-level stack
  const goBack = useGoBack(); // null when no prior history

  const me = caps.person;
  const season = currentSeason(db);
  const myClubShort = me ? (db.clubs.find((c) => c.id === me.mainClubId)?.shortName
    || db.clubs.find((c) => c.id === me.mainClubId)?.name || 'your club') : 'your club';
  // Per-role membership status for the banner: a person who is an athlete and/or
  // coach should see each offered type's status separately. No badges (rather
  // than a crash) when no season is configured at all.
  const membershipBannerItems = (me && season) ? offeredMembershipTypes(
    me.roles ?? { athlete: me.kind !== 'coach', coach: me.kind === 'coach' },
  ).map((type) => ({
    type,
    label: type === 'coach' ? 'Coach' : 'Athlete',
    status: me.memberships.find((m) => m.seasonId === season.id && m.type === type)?.status ?? 'none',
  })) : [];

  return (
    <div className="shell">
      <aside id="app-sidebar" className={`sidebar${navOpen ? ' open' : ''}`}>
        <div className="brand-block">
          <Link to="/" className="brand-mark">
            <img src={primaryLogoWhite} alt="United Club Gymnastics" className="brand-mark-logo" />
          </Link>
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
          {isSupabaseConfigured && session && (
            <button
              type="button"
              className="btn small ghost signout-btn"
              style={{ width: '100%', justifyContent: 'center', marginTop: 8 }}
              onClick={() => {
                // Dev-only: mark an intentional sign-out so the seeded dev
                // auto-login (src/lib/dev-auth.ts) doesn't immediately log back
                // in on the next reload, letting the signed-out gate be tested.
                if (import.meta.env.DEV) sessionStorage.setItem('ucg-dev-signed-out', '1');
                clearLegacyMfaNagDismissal();
                void supabase!.auth.signOut();
              }}
            >
              Sign out
            </button>
          )}
          {isSupabaseConfigured && !session && (
            <div className="persona">Browsing as a guest · <Link to="/me">sign in</Link> to register.</div>
          )}
        </div>

        <div className="sidebar-footer">
          {isSupabaseConfigured && session && (
            <button type="button" className="sidebar-footer-link" onClick={() => setReportOpen(true)}>
              Report a problem
            </button>
          )}
          <div className="version-stamp">{buildStampLabel}</div>
        </div>
      </aside>
      {reportOpen && <ReportProblemDialog onClose={() => setReportOpen(false)} />}
      {navOpen && <div className="nav-overlay" onClick={() => setNavOpen(false)} aria-hidden="true" />}
      <div className="main">
        <header className="topbar" ref={topbarRef}>
          <button
            type="button"
            className="nav-toggle"
            aria-label={navOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={navOpen}
            aria-controls="app-sidebar"
            onClick={() => setNavOpen((o) => !o)}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
              <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
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
          <span className="crumb">{resolveLabel(loc.pathname, db)}</span>
          <div className="topbar-spacer" />
          {me && season && (
            <TopbarMembership
              items={membershipBannerItems}
              seasonName={season.name}
              clubShort={myClubShort}
              topbarRef={topbarRef}
            />
          )}
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
                {me.firstName} {me.lastName}
              </span>
            </Link>
          ) : isSupabaseConfigured && !session ? (
            <Link to="/me" className="topbar-user topbar-user-guest">Sign in</Link>
          ) : null}
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
