// Native WAG Open panels: routine builder (UB/BB/FX) and the vault table (VT).
import { MAX_SKILLS, SKILL_LETTERS, SKILL_VALUES, compute, egLabels, init } from '../../scoring/wagOpen';
import type { WagOpenState } from '../../scoring/wagOpen';
import { VAULT_DATA, compute as computeVault, init as initVault } from '../../scoring/wagVault';
import type { WagVaultState } from '../../scoring/wagVault';
import { BreakdownLine, CheckRow, DecimalInput, PanelSection, StepperRow, WarnBox } from './parts';

export function WagOpenPanel({ levelId, apparatusCode, value, onChange }: {
  levelId: string; apparatusCode: string; value: WagOpenState; onChange: (s: WagOpenState) => void;
}) {
  const outcome = compute(value, levelId, apparatusCode);
  const total = SKILL_LETTERS.reduce((n, l) => n + (value.counts[l] || 0), 0);
  const reset = (
    <button className="btn ghost small" type="button" onClick={() => onChange(init(levelId, apparatusCode))}>Reset</button>
  );

  return (
    <div className="sp-panel">
      <PanelSection title="Top 8 skills"
        sub={`Count the top ${MAX_SKILLS} counting skills (${total}/${MAX_SKILLS} entered). Fewer than 6 deducts 1.0 each automatically.`}
        right={reset}>
        {SKILL_LETTERS.map((letter) => (
          <StepperRow key={letter}
            label={`Counting ${letter.toUpperCase()}'s (${SKILL_VALUES[letter].toFixed(2)} each)`}
            value={value.counts[letter] || 0} max={8}
            onChange={(n) => {
              const others = total - (value.counts[letter] || 0);
              onChange({ ...value, counts: { ...value.counts, [letter]: Math.min(n, Math.max(0, MAX_SKILLS - others)) } });
            }} />
        ))}
      </PanelSection>

      <PanelSection title="Element group bonus" sub="+0.30 for each group containing a B or better.">
        {egLabels(apparatusCode).map((label, i) => (
          <CheckRow key={label} checked={!!value.egs[i]}
            onChange={(v) => onChange({ ...value, egs: value.egs.map((x, j) => (j === i ? v : x)) })}>
            {label}
          </CheckRow>
        ))}
      </PanelSection>

      <PanelSection title="Deductions" sub="Total execution + neutral deductions lost (not the execution score).">
        <DecimalInput big value={value.deductions} step={0.05} onChange={(deductions) => onChange({ ...value, deductions })} />
      </PanelSection>

      <WarnBox warnings={outcome.warnings} />
      <BreakdownLine breakdown={outcome.breakdown} />
    </div>
  );
}

export function WagVaultPanel({ levelId, apparatusCode, value, onChange }: {
  levelId: string; apparatusCode: string; value: WagVaultState; onChange: (s: WagVaultState) => void;
}) {
  const outcome = computeVault(value, levelId, apparatusCode);
  return (
    <div className="sp-panel">
      <PanelSection title="Vault" sub="D-value is the FIG difficulty of the vault performed."
        right={<button className="btn ghost small" type="button" onClick={() => onChange(initVault(levelId, apparatusCode))}>Reset</button>}>
        <select className="input" value={value.vaultIndex}
          onChange={(e) => onChange({ ...value, vaultIndex: parseInt(e.target.value, 10) })}>
          {VAULT_DATA.map((v, i) => (v === null
            ? <option key={`sep-${i}`} disabled>──────────</option>
            : <option key={v.name} value={i}>{v.name} ({v.fig.toFixed(1)})</option>
          ))}
        </select>
      </PanelSection>
      <PanelSection title="Deductions" sub="Total execution + neutral deductions.">
        <DecimalInput big value={value.deductions} step={0.05} onChange={(deductions) => onChange({ ...value, deductions })} />
      </PanelSection>
      <WarnBox warnings={outcome.warnings} />
      <BreakdownLine breakdown={outcome.breakdown} />
    </div>
  );
}
