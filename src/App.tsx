import { useState } from 'react';
import { HashRouter, Routes, Route } from 'react-router-dom';
import { Layout } from './components/Layout';
import { ToastProvider } from './components/ui';
import { isUnlocked } from './lib/store';
import { Gate } from './pages/Gate';
import { Home } from './pages/Home';
import { Membership } from './pages/Membership';
import { Profile } from './pages/Profile';
import { ClubPage, ClubCart } from './pages/Club';
import { Meets, MeetDetail, MeetManage } from './pages/Meets';
import { Judge } from './pages/Judge';
import { ScoreDetail } from './pages/ScoreDetail';
import { ResultsIndex, MeetResults } from './pages/Results';
import { AdminMembers, AdminClubs, AdminLeague, Communicate } from './pages/Admin';

export default function App() {
  const [unlocked, setUnlocked] = useState(isUnlocked());
  if (!unlocked) return <Gate onUnlock={() => setUnlocked(true)} />;
  return (
    <ToastProvider>
      <HashRouter>
        <Layout>
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
            <Route path="/admin/members/:personId" element={<Profile adminView />} />
            <Route path="/admin/clubs" element={<AdminClubs />} />
            <Route path="/admin/league" element={<AdminLeague />} />
            <Route path="/admin/communicate" element={<Communicate />} />
            <Route path="*" element={<Home />} />
          </Routes>
        </Layout>
      </HashRouter>
    </ToastProvider>
  );
}
