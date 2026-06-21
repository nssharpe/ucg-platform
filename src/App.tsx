import { lazy, Suspense, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { HashRouter, Routes, Route, useLocation } from 'react-router-dom';
import { Layout } from './components/Layout';
import { ErrorBoundary } from './components/ErrorBoundary';
import { WriteStatus } from './components/WriteStatus';
import { ToastProvider } from './components/ui';
import { isUnlocked } from './lib/store';
import { useCapabilities } from './lib/capabilities';
import { isSupabaseConfigured } from './lib/supabase';
import { useSession, useAuthLoading, hasLikelySession } from './lib/auth';
import { Gate } from './pages/Gate';
import { Home } from './pages/Home';

// McMaster-Carr-style "intelligent bundling": only the shell + home ship in the
// first chunk; every other page is its own chunk, then ALL of them are
// prefetched during idle time so navigation is instant from then on.
const loaders = {
  Membership: () => import('./pages/Membership'),
  Profile: () => import('./pages/Profile'),
  Club: () => import('./pages/Club'),
  Clubs: () => import('./pages/Clubs'),
  Sanction: () => import('./pages/Sanction'),
  Meets: () => import('./pages/Meets'),
  Judge: () => import('./pages/Judge'),
  ScoreDetail: () => import('./pages/ScoreDetail'),
  Results: () => import('./pages/Results'),
  Admin: () => import('./pages/Admin'),
  Nationals: () => import('./pages/Nationals'),
};

const Membership = lazy(() => loaders.Membership().then((m) => ({ default: m.Membership })));
const Profile = lazy(() => loaders.Profile().then((m) => ({ default: m.Profile })));
const AdminProfile = lazy(() => loaders.Profile().then((m) => ({ default: () => <m.Profile adminView /> })));
const ClubPage = lazy(() => loaders.Club().then((m) => ({ default: m.ClubPage })));
const ClubCart = lazy(() => loaders.Club().then((m) => ({ default: m.ClubCart })));
const Clubs = lazy(() => loaders.Clubs().then((m) => ({ default: m.Clubs })));
const SanctionRequestForm = lazy(() => loaders.Sanction().then((m) => ({ default: m.SanctionRequestForm })));
const SanctioningQueue = lazy(() => loaders.Sanction().then((m) => ({ default: m.SanctioningQueue })));
const SanctionVotePage = lazy(() => loaders.Sanction().then((m) => ({ default: m.SanctionVotePage })));
const Meets = lazy(() => loaders.Meets().then((m) => ({ default: m.Meets })));
const MeetDetail = lazy(() => loaders.Meets().then((m) => ({ default: m.MeetDetail })));
const MeetManage = lazy(() => loaders.Meets().then((m) => ({ default: m.MeetManage })));
const Nationals = lazy(() => loaders.Nationals().then((m) => ({ default: m.Nationals })));
const Judge = lazy(() => loaders.Judge().then((m) => ({ default: m.Judge })));
const ScoreDetail = lazy(() => loaders.ScoreDetail().then((m) => ({ default: m.ScoreDetail })));
const ResultsIndex = lazy(() => loaders.Results().then((m) => ({ default: m.ResultsIndex })));
const MeetResults = lazy(() => loaders.Results().then((m) => ({ default: m.MeetResults })));
const AdminMembers = lazy(() => loaders.Admin().then((m) => ({ default: m.AdminMembers })));
const AdminClubs = lazy(() => loaders.Admin().then((m) => ({ default: m.AdminClubs })));
const AdminLeague = lazy(() => loaders.Admin().then((m) => ({ default: m.AdminLeague })));
const Communicate = lazy(() => loaders.Admin().then((m) => ({ default: m.Communicate })));
const WaiverSign = lazy(() => import('./pages/WaiverSign'));

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

/** Gate account-only pages: guests can browse public routes (results, meets),
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
  if (!caps.signedIn) return <Gate onUnlock={() => {}} />;
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
  return <>{children}</>;
}

export default function App() {
  const session = useSession();
  const authLoading = useAuthLoading();
  const [unlockedLocally, setUnlockedLocally] = useState(isUnlocked());
  usePrefetchRoutes();

  if (isSupabaseConfigured) {
    // Avoid flashing the gate for a signed-in user while getSession() resolves
    // on refresh. Guests (no token) fall through to the app and browse public
    // pages; account routes are gated by RequireAccount below.
    if (!session && authLoading && hasLikelySession()) return <PageFallback />;
  } else if (!unlockedLocally) {
    return <Gate onUnlock={() => setUnlockedLocally(true)} />;
  }

  return (
    <ToastProvider>
      <HashRouter>
        <Layout>
          <RouteErrorBoundary>
          <Suspense fallback={<PageFallback />}>
            <Routes>
              {/* Public — no account required */}
              <Route path="/" element={<Home />} />
              <Route path="/meets" element={<Meets />} />
              <Route path="/meets/:slug" element={<MeetDetail />} />
              <Route path="/results" element={<ResultsIndex />} />
              <Route path="/results/:slug" element={<MeetResults />} />
              {/* Account required */}
              <Route path="/me" element={<RequireAccount><Profile /></RequireAccount>} />
              <Route path="/membership" element={<RequireAccount><Membership /></RequireAccount>} />
              <Route path="/clubs" element={<RequireAccount><Clubs /></RequireAccount>} />
              <Route path="/sanction" element={<RequireAccount><SanctionRequestForm /></RequireAccount>} />
              <Route path="/sanctioning" element={<RequireAccount><SanctioningQueue /></RequireAccount>} />
              <Route path="/sanctioning/:requestId" element={<RequireAccount><SanctionVotePage /></RequireAccount>} />
              <Route path="/club/:clubId" element={<RequireAccount><ClubPage /></RequireAccount>} />
              <Route path="/club/:clubId/cart" element={<RequireAccount><ClubCart /></RequireAccount>} />
              <Route path="/meets/:slug/manage" element={<RequireAccount><MeetManage /></RequireAccount>} />
              <Route path="/meets/:slug/nationals" element={<RequireAccount><Nationals /></RequireAccount>} />
              <Route path="/judge" element={<RequireAccount><Judge /></RequireAccount>} />
              <Route path="/scores/:scoreId" element={<RequireAccount><ScoreDetail /></RequireAccount>} />
              <Route path="/admin/members" element={<RequireAdmin><AdminMembers /></RequireAdmin>} />
              <Route path="/admin/members/:personId" element={<RequireAdmin><AdminProfile /></RequireAdmin>} />
              <Route path="/admin/clubs" element={<RequireAdmin><AdminClubs /></RequireAdmin>} />
              <Route path="/admin/league" element={<RequireAdmin><AdminLeague /></RequireAdmin>} />
              <Route path="/admin/communicate" element={<RequireAdmin><Communicate /></RequireAdmin>} />
              <Route path="/waiver/sign/:token" element={<WaiverSign />} />
              <Route path="*" element={<Home />} />
            </Routes>
          </Suspense>
          </RouteErrorBoundary>
        </Layout>
      </HashRouter>
      <WriteStatus />
    </ToastProvider>
  );
}
