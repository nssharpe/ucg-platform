// Kind → native panel dispatcher. The parent owns the engine state (so it can
// store it on the Score as calcState v2) and computes the outcome separately
// via computeScoring.
import type { CalcKind } from '../../scoring';
import type { MagState } from '../../scoring/mag';
import type { MastersState } from '../../scoring/masters';
import type { WagOpenState } from '../../scoring/wagOpen';
import type { WagVaultState } from '../../scoring/wagVault';
import type { WagSvState } from '../../scoring/wagSv';
import type { TntState } from '../../scoring/tnt';
import { MagPanel } from './MagPanel';
import { MastersPanel } from './MastersPanel';
import { WagOpenPanel, WagVaultPanel } from './WagOpenPanel';
import { WagSvPanel } from './WagSvPanel';
import { TntPanel } from './TntPanel';

export function ScoringPanel({ kind, levelId, apparatusCode, value, onChange }: {
  kind: CalcKind;
  levelId: string;
  apparatusCode: string;
  value: unknown;
  onChange: (s: unknown) => void;
}) {
  switch (kind) {
    case 'mag':
      return <MagPanel levelId={levelId} apparatusCode={apparatusCode} value={value as MagState} onChange={onChange} />;
    case 'masters':
      return <MastersPanel levelId={levelId} apparatusCode={apparatusCode} value={value as MastersState} onChange={onChange} />;
    case 'wag-open':
      return <WagOpenPanel levelId={levelId} apparatusCode={apparatusCode} value={value as WagOpenState} onChange={onChange} />;
    case 'wag-vault':
      return <WagVaultPanel levelId={levelId} apparatusCode={apparatusCode} value={value as WagVaultState} onChange={onChange} />;
    case 'wag-sv':
      return <WagSvPanel levelId={levelId} apparatusCode={apparatusCode} value={value as WagSvState} onChange={onChange} />;
    case 'tnt':
      return <TntPanel levelId={levelId} apparatusCode={apparatusCode} value={value as TntState} onChange={onChange} />;
  }
}
