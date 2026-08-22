import { lazy, Suspense, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { HashRouter, Routes, Route, Navigate, Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Layout } from './components/Layout';
import { ErrorBoundary } from './components/ErrorBoundary';
import { WriteStatus } from './components/WriteStatus';
import { ToastProvider } from './components/ui';
import { isUnlocked } from './lib/store';
import { useCapabilities } from './lib/capabilities';
import { isSupabaseConfigured } from './lib/supabase';
import { useSession, useAuthLoading, hasLikelySession, hasAuthCallbackInUrl, useRolesLoaded, useAal, initialSetPwKind } from './lib/auth';
import { needsMfaStepUp } from './lib/mfa-core';
import { useAdminMfaSatisfied } from './lib/mfa';
import { MyScoresBoot } from './lib/scores-slice';
import { MyRegistrationsBoot } from './lib/registrations-slice';
import { Gate } from './pages/Gate';
import { Home } from './pages/Home';
import { MfaChallenge } from './pages/MfaChallenge';

// McMaster-Carr-style "intelligent bundling": only the shell + home ship in the
// first chunk; every other page is its own chunk, then ALL of them are
// prefetched during idle time so navigation is instant from then on.
const loaders = {
  Membership: () => import('./pages/Membership'),
  Profile: () => import('./pages/Profile'),
  Club: () => import('./pages/Club'),
  Clubs: () => import('./pages/Clubs'),
  Sanction: () => import('./pages/Sanction'),
  Events: () => import('./pages/Events'),
  Judge: () => import('./pages/Judge'),
  ScoreDetail: () => import('./pages/ScoreDetail'),
  Results: () => import('./pages/Results'),
  Admin: () => import('./pages/Admin'),
  Nationals: () => import('./pages/Nationals'),
};

const Membership = lazy(() => loaders.Membership().then((m) => ({ default: m.Membership })));
const Profile = lazy(() => loaders.Profile().then((m) => ({ default: m.Profile })));
const AdminProfile = lazy(() => loaders.Profile().then((m) => ({ default: () => <m.Profile adminView /> })));
const ClubRoster = lazy(() => loaders.Club().then((m) => ({ default: () => <m.ClubPage view="roster" /> })));
const ClubRegistrations = lazy(() => loaders.Club().then((m) => ({ default: () => <m.ClubPage view="registrations" /> })));

/** Redirect bare /club/:clubId → /club/:clubId/roster (default view). */
function ClubIndexRedirect() {
  const { clubId } = useParams();
  return <Navigate to={`/club/${clubId}/roster`} replace />;
}

/** Retired route (unified-cart-b2): the per-club cart + receipts page was
 *  merged into the single `/cart` page (a section per managed club there). */
function ClubCartRedirect() {
  return <Navigate to="/cart" replace />;
}

/** Legacy /meets* → /events* redirects (the Meet→Event rename keeps old links
 *  alive). Each preserves the `:slug` param. */
function MeetsRedirect() {
  return <Navigate to="/events" replace />;
}
function MeetDetailRedirect() {
  const { slug } = useParams();
  return <Navigate to={`/events/${slug}`} replace />;
}
function MeetManageRedirect() {
  const { slug } = useParams();
  return <Navigate to={`/events/${slug}/manage`} replace />;
}
function MeetNationalsRedirect() {
  const { slug } = useParams();
  return <Navigate to={`/events/${slug}/nationals`} replace />;
}

/** H6 (2026-07-04 UI/UX review): unmatched hash routes (a typo like
 *  `#/profile` — the real route is `#/me` — or a stale/old link) used to
 *  silently render Home via the `*` catch-all below, giving no indication
 *  the URL didn't match anything. This is ONLY reached by the `*` route,
 *  which React Router ranks below every explicit path — it never intercepts
 *  the `/meets*`, `/club/:clubId/cart`, or `/set-password` routes above. */
function NotFound() {
  return (
    <div className="card card-pad" style={{ maxWidth: 480 }}>
      <h1 className="page-title display" style={{ fontSize: 22 }}>Page not found</h1>
      <p className="page-sub">That link doesn&rsquo;t exist — it may be old or mistyped.</p>
      <Link className="btn primary" to="/">Go to Home →</Link>
    </div>
  );
}
const Clubs = lazy(() => loaders.Clubs().then((m) => ({ default: m.Clubs })));
const SanctionRequestForm = lazy(() => loaders.Sanction().then((m) => ({ default: m.SanctionRequestForm })));
const SanctioningQueue = lazy(() => loaders.Sanction().then((m) => ({ default: m.SanctioningQueue })));
const SanctionVotePage = lazy(() => loaders.Sanction().then((m) => ({ default: m.SanctionVotePage })));
const Events = lazy(() => loaders.Events().then((m) => ({ default: m.Events })));
const EventDetail = lazy(() => loaders.Events().then((m) => ({ default: m.EventDetail })));
const EventManage = lazy(() => loaders.Events().then((m) => ({ default: m.EventManage })));
const EventHostPage = lazy(() => loaders.Events().then((m) => ({ default: m.EventHostPage })));
const EventCommunicate = lazy(() => import('./pages/EventCommunicate').then((m) => ({ default: m.EventCommunicate })));
const Nationals = lazy(() => loaders.Nationals().then((m) => ({ default: m.Nationals })));
const Judge = lazy(() => loaders.Judge().then((m) => ({ default: m.Judge })));
const ScoreDetail = lazy(() => loaders.ScoreDetail().then((m) => ({ default: m.ScoreDetail })));
const ResultsIndex = lazy(() => loaders.Results().then((m) => ({ default: m.ResultsIndex })));
const EventResults = lazy(() => loaders.Results().then((m) => ({ default: m.EventResults })));
const AdminMembers = lazy(() => loaders.Admin().then((m) => ({ default: m.AdminMembers })));
const AdminClubs = lazy(() => loaders.Admin().then((m) => ({ default: m.AdminClubs })));
const AdminLeague = lazy(() => loaders.Admin().then((m) => ({ default: m.AdminLeague })));
const Communicate = lazy(() => loaders.Admin().then((m) => ({ default: m.Communicate })));
const WaiverSign = lazy(() => import('./pages/WaiverSign'));
const JudgeAccess = lazy(() => import('./pages/JudgeAccess'));
const ManagerAccessReview = lazy(() => import('./pages/ManagerAccessReview'));
const SetPassword = lazy(() => import('./pages/SetPassword'));
const MyRegistrations = lazy(() => import('./pages/MyRegistrations').then((m) => ({ default: m.MyRegistrations })));
const PurchaseHistory = lazy(() => import('./pages/PurchaseHistory').then((m) => ({ default: m.PurchaseHistory })));
const ErrorLog = lazy(() => import('./pages/ErrorLog').then((m) => ({ default: m.ErrorLog })));
const RefundReview = lazy(() => import('./pages/admin/league/RefundReview').then((m) => ({ default: m.RefundReview })));
const Finance = lazy(() => import('./pages/admin/league/Finance').then((m) => ({ default: m.Finance })));
const UcgEvent = lazy(() => import('./pages/admin/UcgEvent').then((m) => ({ default: m.UcgEvent })));
const Cart = lazy(() => import('./pages/Cart').then((m) => ({ default: m.Cart })));
const MembershipsCheckout = lazy(() => import('./pages/Cart').then((m) => ({ default: m.MembershipsCheckout })));

/** Prefetch all route chunks once the browser is idle after first paint. */
function usePrefetchRoutes() {
  useEffect(() => {
    const idle = (cb: () => void) =>
      'requestIdleCallback' in window ? requestIdleCallback(cb, { timeout: 4000 }) : setTimeout(cb, 1500);
    idle(() => { Object.values(loaders).forEach((load) => { load().catch(() => {}); }); });
  }, []);
}

function PageFallback() {
  return <div style={{ padding: 40, textAlign: 'center', color: 'var(--ink-soft)' }}>Loading…</div>;
}

/** Per-route error boundary that resets on navigation, so one broken page shows
 *  an inline error while the layout/nav stay alive. */
function RouteErrorBoundary({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return (
    <ErrorBoundary variant="route" context={pathname} resetKeys={[pathname]}>
      {children}
    </ErrorBoundary>
  );
}

/** Gate account-only pages: guests can browse public routes (results, events),
 *  but reaching a member page shows the sign-in screen. In the unconfigured
 *  prototype `signedIn` is always true, so this is a no-op there. */
function RequireAccount({ children }: { children: ReactNode }) {
  const caps = useCapabilities();
  if (!caps.signedIn) return <Gate onUnlock={() => {}} />;
  return <>{children}</>;
}

/**
 * Gate admin pages to users with the admin role. This is the primary
 * access-control barrier for /admin/* routes — RequireAccount only checks
 * that someone is signed in, which is insufficient. Without this gate a
 * brand-new sign-up could browse admin UI and, in early versions, was offered
 * an "make me admin" escape hatch and triggered a duplicate stray person.
 *
 * Note: the duplicate-person risk (stray athlete created before email confirm)
 * is a link_or_create_person (DB) concern — see docs/specs/2026-06-16-auth-email-setup.md.
 * This wrapper stops the privilege-surface exposure on the client side.
 */
function RequireAdmin({ children }: { children: ReactNode }) {
  const caps = useCapabilities();
  const rolesLoaded = useRolesLoaded();
  // Always called (hooks can't be conditional) — resolves to `true` (n/a)
  // for non-admins, so it's cheap/harmless when the isAdmin check below
  // hasn't even run yet.
  const mfaSatisfied = useAdminMfaSatisfied();
  if (!caps.signedIn) return <Gate onUnlock={() => {}} />;
  // Roles load async after the session resolves. Until we know them, show the
  // loader rather than flashing "Admin access required" at an actual admin.
  if (!rolesLoaded) return <PageFallback />;
  if (!caps.isAdmin) {
    return (
      <div style={{ padding: '60px 24px', maxWidth: 480, margin: '0 auto', textAlign: 'center' }}>
        <div style={{ fontSize: 32, marginBottom: 16 }}>🔒</div>
        <h2 style={{ marginBottom: 8 }}>Admin access required</h2>
        <p style={{ color: 'var(--ink-soft)' }}>
          You don't have access to this page. Contact a UCG administrator if you believe this is an error.
        </p>
      </div>
    );
  }
  // Admin MFA hard gate (UAT A-11-01, S2, decided 2026-08-21): block ALL
  // admin pages — never a dismissable nag — until the admin has a verified
  // TOTP factor or is signed in via passkey. `/me` (ProfileMfa, the
  // enrollment UI) is NOT behind RequireAdmin, so there is always a way out.
  // Still resolving the factor list — show the loader, not the block panel.
  if (mfaSatisfied === null) return <PageFallback />;
  if (!mfaSatisfied) {
    return (
      <div style={{ padding: '60px 24px', maxWidth: 480, margin: '0 auto', textAlign: 'center' }}>
        <div style={{ fontSize: 32, marginBottom: 16 }}>🔒</div>
        <h2 style={{ marginBottom: 8 }}>Set up two-factor authentication to continue</h2>
        <p style={{ color: 'var(--ink-soft)' }}>
          League admin accounts require two-factor authentication (or signing in with a passkey)
          before reaching admin pages.
        </p>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center', marginTop: 20, flexWrap: 'wrap' }}>
          <Link className="btn primary" to="/me">Set up two-factor authentication →</Link>
          <Link className="btn ghost" to="/">Back to Home</Link>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}

/**
 * Gate the refund review queue (event-mgmt v2 Phase 3, spec §H) to admins OR
 * the 'refund_manager' role — NOT admin-only, so RequireAdmin doesn't fit
 * (a refund manager who isn't an admin must still reach this page). Mirrors
 * RequireAdmin's rolesLoaded-gated shape.
 */
function RequireRefundAccess({ children }: { children: ReactNode }) {
  const caps = useCapabilities();
  const rolesLoaded = useRolesLoaded();
  if (!caps.signedIn) return <Gate onUnlock={() => {}} />;
  if (!rolesLoaded) return <PageFallback />;
  if (!caps.isAdmin && !caps.isRefundManager) {
    return (
      <div style={{ padding: '60px 24px', maxWidth: 480, margin: '0 auto', textAlign: 'center' }}>
        <div style={{ fontSize: 32, marginBottom: 16 }}>🔒</div>
        <h2 style={{ marginBottom: 8 }}>Refund manager access required</h2>
        <p style={{ color: 'var(--ink-soft)' }}>
          You don't have access to this page. Contact a UCG administrator if you believe this is an error.
        </p>
      </div>
    );
  }
  return <>{children}</>;
}

/**
 * Gate the finance dashboards (event-mgmt v2 Phase 6, spec §M) to admins OR
 * the 'finance_admin' role — mirrors RequireRefundAccess's shape exactly.
 * finance_admin and refund_manager can coexist on one non-admin user, so
 * this check is independent of RequireRefundAccess's.
 */
function RequireFinanceAccess({ children }: { children: ReactNode }) {
  const caps = useCapabilities();
  const rolesLoaded = useRolesLoaded();
  if (!caps.signedIn) return <Gate onUnlock={() => {}} />;
  if (!rolesLoaded) return <PageFallback />;
  if (!caps.isAdmin && !caps.isFinanceAdmin) {
    return (
      <div style={{ padding: '60px 24px', maxWidth: 480, margin: '0 auto', textAlign: 'center' }}>
        <div style={{ fontSize: 32, marginBottom: 16 }}>🔒</div>
        <h2 style={{ marginBottom: 8 }}>Finance access required</h2>
        <p style={{ color: 'var(--ink-soft)' }}>
          You don't have access to this page. Contact a UCG administrator if you believe this is an error.
        </p>
      </div>
    );
  }
  return <>{children}</>;
}

/**
 * After clicking an invite / set-password email link, Supabase establishes the
 * session from the URL token and cleans the hash. The redirect carries
 * ?setpw=invite or ?setpw=reset. This component — mounted INSIDE the router so
 * it can use useNavigate — routes to /set-password once the session is ready
 * (or immediately on an expired-link error), which HashRouter actually
 * follows (history.replaceState alone does not).
 *
 * Reads the marker via `initialSetPwKind()` (auth.ts), NOT by re-parsing
 * `window.location.search` here, because the query param gets deleted below
 * once we land on /set-password — and Supabase's OWN implicit-grant handling
 * later does a direct `window.location.hash = ''` (auth-js
 * `_getSessionFromURL`) after its `_getUser` network round trip, which fires
 * a real hashchange and can bounce HashRouter back to `/` a few hundred ms
 * into the load. If this effect's re-navigation depended on the (by-then
 * deleted) query param, that bounce would strand the page on Home with no
 * way back — exactly Julia's "landed on the signed-out Home page with no
 * guidance" repro (A-07-02). `initialSetPwKind()` is captured ONCE at module
 * load (before any of that can happen), so this effect keeps re-navigating
 * to /set-password no matter how many times the hash gets rewritten out from
 * under it. See auth-and-mfa.md "HashRouter vs Supabase implicit flow".
 */
function SetPasswordRedirect() {
  const navigate = useNavigate();
  const location = useLocation();
  const setpwKind = initialSetPwKind();
  useEffect(() => {
    if (!setpwKind) return;
    if (location.pathname === '/set-password') {
      if (new URLSearchParams(window.location.search).has('setpw')) {
        const url = new URL(window.location.href);
        url.searchParams.delete('setpw');
        // Preserve history.state (React Router keeps its own entry there)
        // rather than wiping it with `null`.
        window.history.replaceState(window.history.state, '', url.toString());
      }
      return;
    }
    navigate('/set-password', { replace: true });
  }, [location.pathname, navigate, setpwKind]);
  return null;
}

export default function App() {
  const session = useSession();
  const authLoading = useAuthLoading();
  const aal = useAal();
  const [unlockedLocally, setUnlockedLocally] = useState(isUnlocked());
  usePrefetchRoutes();

  if (isSupabaseConfigured) {
    // Avoid flashing the gate for a signed-in user while getSession() resolves
    // on refresh (hasLikelySession) OR while a BRAND NEW session is being
    // established from a signup-confirmation/magic-link/recovery URL token
    // (hasAuthCallbackInUrl — hasLikelySession alone misses this since a
    // first-time confirmation has no prior localStorage session to find).
    // Guests with neither signal fall through to the app and browse public
    // pages; account routes are gated by RequireAccount below.
    if (!session && authLoading && (hasLikelySession() || hasAuthCallbackInUrl())) return <PageFallback />;
    // MFA step-up (auth-hardening, admins-require-aal2): a live aal1 session
    // whose account has a verified factor (nextLevel === 'aal2') must clear
    // the second factor before any protected UI renders — rendered here,
    // outside HashRouter, exactly like the auth-flash gate above. A
    // no-factor account (incl. every seeded dev/E2E user) has
    // nextLevel === 'aal1', so needsMfaStepUp is false and this never fires
    // for them. A passkey sign-in (amr 'passkey' in aal.methods) is exempt —
    // already a possession+user-verification factor (Nate, 2026-07-18).
    if (session && needsMfaStepUp(aal.currentLevel, aal.nextLevel, aal.methods)) return <MfaChallenge />;
  } else if (!unlockedLocally) {
    return <Gate onUnlock={() => setUnlockedLocally(true)} />;
  }

  return (
    <ToastProvider>
      <MyScoresBoot />
      <MyRegistrationsBoot />
      <HashRouter>
        <SetPasswordRedirect />
        <Layout>
          <RouteErrorBoundary>
          <Suspense fallback={<PageFallback />}>
            <Routes>
              {/* Public — no account required */}
              <Route path="/" element={<Home />} />
              <Route path="/events" element={<Events />} />
              <Route path="/events/:slug" element={<EventDetail />} />
              {/* Legacy /meets* redirects (preserve old links post-rename). */}
              <Route path="/meets" element={<MeetsRedirect />} />
              <Route path="/meets/:slug" element={<MeetDetailRedirect />} />
              <Route path="/results" element={<ResultsIndex />} />
              <Route path="/results/:slug" element={<EventResults />} />
              {/* Account required */}
              <Route path="/me" element={<RequireAccount><Profile /></RequireAccount>} />
              <Route path="/membership" element={<RequireAccount><Membership /></RequireAccount>} />
              <Route path="/me/registrations" element={<RequireAccount><MyRegistrations /></RequireAccount>} />
              <Route path="/me/purchases" element={<RequireAccount><PurchaseHistory /></RequireAccount>} />
              <Route path="/cart" element={<RequireAccount><Cart /></RequireAccount>} />
              <Route path="/cart/memberships" element={<RequireAccount><MembershipsCheckout /></RequireAccount>} />
              <Route path="/clubs" element={<RequireAccount><Clubs /></RequireAccount>} />
              <Route path="/sanction" element={<RequireAccount><SanctionRequestForm /></RequireAccount>} />
              <Route path="/sanctioning" element={<RequireAccount><SanctioningQueue /></RequireAccount>} />
              <Route path="/sanctioning/:requestId" element={<RequireAccount><SanctionVotePage /></RequireAccount>} />
              <Route path="/club/:clubId" element={<RequireAccount><ClubIndexRedirect /></RequireAccount>} />
              <Route path="/club/:clubId/roster" element={<RequireAccount><ClubRoster /></RequireAccount>} />
              <Route path="/club/:clubId/registrations" element={<RequireAccount><ClubRegistrations /></RequireAccount>} />
              <Route path="/club/:clubId/cart" element={<ClubCartRedirect />} />
              <Route path="/events/:slug/manage" element={<RequireAccount><EventManage /></RequireAccount>} />
              <Route path="/events/:slug/host" element={<RequireAccount><EventHostPage /></RequireAccount>} />
              <Route path="/events/:slug/communicate" element={<RequireAccount><EventCommunicate /></RequireAccount>} />
              <Route path="/events/:slug/nationals" element={<RequireAccount><Nationals /></RequireAccount>} />
              <Route path="/meets/:slug/manage" element={<MeetManageRedirect />} />
              <Route path="/meets/:slug/nationals" element={<MeetNationalsRedirect />} />
              {/* Public (no RequireAccount): an anonymous device that unlocked with a
                  judge access code must reach this page. Judge.tsx itself gates score
                  entry — privileged users (admin/host) get their normal path, everyone
                  else needs a stored code-unlock for the selected event. */}
              <Route path="/judge" element={<Judge />} />
              <Route path="/judge/access/:token" element={<JudgeAccess />} />
              <Route path="/scores/:scoreId" element={<RequireAccount><ScoreDetail /></RequireAccount>} />
              <Route path="/admin/members" element={<RequireAdmin><AdminMembers /></RequireAdmin>} />
              <Route path="/admin/members/:personId" element={<RequireAdmin><AdminProfile /></RequireAdmin>} />
              <Route path="/admin/clubs" element={<RequireAdmin><AdminClubs /></RequireAdmin>} />
              <Route path="/admin/league" element={<RequireAdmin><AdminLeague /></RequireAdmin>} />
              <Route path="/admin/ucg-event/:template/:seasonId" element={<RequireAdmin><UcgEvent /></RequireAdmin>} />
              <Route path="/admin/communicate" element={<RequireAdmin><Communicate /></RequireAdmin>} />
              <Route path="/admin/errors" element={<RequireAdmin><ErrorLog /></RequireAdmin>} />
              <Route path="/admin/refunds" element={<RequireRefundAccess><RefundReview /></RequireRefundAccess>} />
              <Route path="/admin/finance" element={<RequireFinanceAccess><Finance /></RequireFinanceAccess>} />
              <Route path="/waiver/sign/:token" element={<WaiverSign />} />
              <Route path="/manager-access/:token" element={<ManagerAccessReview />} />
              <Route path="/set-password" element={<SetPassword />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
          </RouteErrorBoundary>
        </Layout>
      </HashRouter>
      <WriteStatus />
    </ToastProvider>
  );
}
