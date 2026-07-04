import { useState } from 'react';
import { Tabs } from '../../components/ui';
import { Seasons } from './league/Seasons';
import { Levels } from './league/Levels';
import { RegionsTab } from './league/Regions';
import { Waivers } from './league/Waivers';
import { Promos } from './league/Promos';
import { UserRoles } from './league/UserRoles';
import { DemoTools } from './league/DemoTools';

// ---------- League Controls ----------
export function AdminLeague() {
  const [tab, setTab] = useState<'seasons' | 'levels' | 'regions' | 'waivers' | 'promos' | 'roles' | 'demo'>('seasons');
  return (
    <div>
      <h1 className="page-title display">League controls</h1>
      <p className="page-sub">Seasons, fees, levels, waivers, regions, roles, and promo codes — the knobs that drive everything else.</p>
      <Tabs
        tabs={[
          { id: 'seasons' as const, label: 'Seasons & fees' },
          { id: 'levels' as const, label: 'Levels' },
          { id: 'regions' as const, label: 'Regions' },
          { id: 'waivers' as const, label: 'Waivers' },
          { id: 'promos' as const, label: 'Promo codes' },
          { id: 'roles' as const, label: 'User roles' },
          { id: 'demo' as const, label: 'Demo tools' },
        ]}
        active={tab}
        onChange={setTab}
      />
      {tab === 'seasons' && <Seasons />}
      {tab === 'levels' && <Levels />}
      {tab === 'regions' && <RegionsTab />}
      {tab === 'waivers' && <Waivers />}
      {tab === 'promos' && <Promos />}
      {tab === 'roles' && <UserRoles />}
      {tab === 'demo' && <DemoTools />}
    </div>
  );
}
