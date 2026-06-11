import { lazy, Suspense, useEffect, useState } from 'react';
import { HashRouter, Routes, Route } from 'react-router-dom';
import { Layout } from './components/Layout';
import { ToastProvider } from './components/ui';
import { isUnlocked } from './lib/store';
import { Gate } from './pages/Gate';
import { Home } from './pages/Home';

// McMaster-Carr-style "intelligent bundling": only the shell + home ship in the
// first chunk; every other page is its own chunk, then ALL of them are
// prefetched during idle time so navigation is instant from then on.
const loaders = {
  Membership: () => import('./pages/Membership'),
  Profile: () => import('./pages/Profile'),
  Club: () => import('./pages/Club'),
  Meets: () => import('./pages/Meets'),
  Judge: () => import('./pages/Judge'),
  ScoreDetail: () => import('./pages/ScoreDetail'),
  Results: () => import('./pages/Results'),
  Admin: () => import('./pages/Admin'),
};

const Membership = lazy(() => loaders.Membership().then((m) => ({ default: m.Membership })));
const Profile = lazy(() => loaders.Profile().then((m) => ({ default: m.Profile })));
const AdminProfile = lazy(() => loaders.Profile().then((m) => ({ default: () => <m.Profile adminView /> })));
const ClubPage = lazy(() => loaders.Club().then((m) => ({ default: m.ClubPage })));
const ClubCart = lazy(() => loaders.Club().then((m) => ({ default: m.ClubCart })));
const Meets = lazy(() => loaders.Meets().then((m) => ({ default: m.Meets })));
const MeetDetail = lazy(() => loaders.Meets().then((m) => ({ default: m.MeetDetail })));
const MeetManage = lazy(() => loaders.Meets().then((m) => ({ default: m.MeetManage })));
const Judge = lazy(() => loaders.Judge().then((m) => ({ default: m.Judge })));
const ScoreDetail = lazy(() => loaders.ScoreDetail().then((m) => ({ default: m.ScoreDetail })));
const ResultsIndex = lazy(() => loaders.Results().then((m) => ({ default: m.ResultsIndex })));
const MeetResults = lazy(() => loaders.Results().then((m) => ({ default: m.MeetResults })));
const AdminMembers = lazy(() => loaders.Admin().then((m) => ({ default: m.AdminMembers })));
const AdminClubs = lazy(() => loaders.Admin().then((m) => ({ default: m.AdminClubs })));
const AdminLeague = lazy(() => loaders.Admin().then((m) => ({ default: m.AdminLeague })));
const Communicate = lazy(() => loaders.Admin().then((m) => ({ default: m.Communicate })));

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

export default function App() {
  const [unlocked, setUnlocked] = useState(isUnlocked());
  usePrefetchRoutes();
  if (!unlocked) return <Gate onUnlock={() => setUnlocked(true)} />;
  return (
    <ToastProvider>
      <HashRouter>
        <Layout>
          <Suspense fallback={<PageFallback />}>
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/me" element={<Profile />} />
              <Route path="/membership" element={<Membership />} />
              <Route path="/club/:clubId" element={<ClubPage />} />
              <Route path="/club/:clubId/cart" element={<ClubCart />} />
              <Route path="/meets" element={<Meets />} />
              <Route path="/meets/:slug" element={<MeetDetail />} />
              <Route path="/meets/:slug/manage" element={<MeetManage />} />
              <Route path="/judge" element={<Judge />} />
              <Route path="/scores/:scoreId" element={<ScoreDetail />} />
              <Route path="/results" element={<ResultsIndex />} />
              <Route path="/results/:slug" element={<MeetResults />} />
              <Route path="/admin/members" element={<AdminMembers />} />
              <Route path="/admin/members/:personId" element={<AdminProfile />} />
              <Route path="/admin/clubs" element={<AdminClubs />} />
              <Route path="/admin/league" element={<AdminLeague />} />
              <Route path="/admin/communicate" element={<Communicate />} />
              <Route path="*" element={<Home />} />
            </Routes>
          </Suspense>
        </Layout>
      </HashRouter>
    </ToastProvider>
  );
}
