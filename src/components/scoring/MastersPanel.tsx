// Native NAIGC Masters panel — D/E/Final with age-decade skill values.
import {
  SKILL_LABELS, SKILL_LEVELS, VAULT_AGE_BONUS, apparatusFor, compute, egLabels, init,
  skillValue, vaultList,
} from '../../scoring/masters';
import type { AgeDecade, MastersDismountLevel, MastersState } from '../../scoring/masters';
import { BreakdownLine, CheckRow, ChipGroup, DecimalInput, PanelSection, StepperRow, WarnBox } from './parts';

const AGES: { value: AgeDecade; label: string }[] = [
  { value: '30', label: '30–39' }, { value: '40', label: '40–49' }, { value: '50', label: '50–59' },
  { value: '60', label: '60–69' }, { value: '70', label: '70+' },
];

export function MastersPanel({ levelId, eventCode, value, onChange }: {
  levelId: string; eventCode: string; value: MastersState; onChange: (s: MastersState) => void;
}) {
  const apparatus = apparatusFor(value.discipline, eventCode);
  const isVault = apparatus === 'vault';
  const outcome = compute(value, levelId, eventCode);
  const totalSkills = SKILL_LEVELS.reduce((n, l) => n + value.counts[l], 0);
  const dedStep = value.discipline === 'WAG' ? 0.05 : 0.1;

  const reset = (
    <button className="btn ghost small" type="button"
      onClick={() => onChange({ ...init(levelId, eventCode), discipline: value.discipline, age: value.age })}>
      Reset
    </button>
  );

  return (
    <div className="sp-panel">
      <PanelSection title="Age decade" sub="Masters skill values and the vault age bonus scale with the athlete's decade." right={reset}>
        <ChipGroup options={AGES} value={value.age} onChange={(age) => age && onChange({ ...value, age })} />
      </PanelSection>

      {isVault ? (
        <>
          <PanelSection title="Vault"
            sub={`Age bonus +${VAULT_AGE_BONUS[value.discipline][value.age].toFixed(1)} is added to the table value.`}>
            <select className="input" value={value.vaultIndex === null ? '-1' : String(value.vaultIndex)}
              onChange={(e) => {
                const v = e.target.value;
                onChange({ ...value, vaultIndex: v === '-1' ? null : v === 'custom' ? 'custom' : parseInt(v, 10) });
              }}>
              <option value="-1">— Select a vault —</option>
              <option value="custom">Other / Not Listed (Base: 0.00)</option>
              {vaultList(value.discipline).map((v, i) => (v === null
                ? <option key={`sep-${i}`} disabled>──────────</option>
                : <option key={v.name} value={i}>{v.name} ({(v.fig + VAULT_AGE_BONUS[value.discipline][value.age]).toFixed(1)})</option>
              ))}
            </select>
          </PanelSection>
          <PanelSection title="Deductions" sub="Total execution + neutral deductions.">
            <DecimalInput big value={value.vaultDeductions} step={dedStep}
              onChange={(vaultDeductions) => onChange({ ...value, vaultDeductions })} />
          </PanelSection>
        </>
      ) : (
        <>
          <PanelSection title="Top 6 skills" sub="Count each skill at its level — 6 counting skills max; missing skills deduct 1.0 each.">
            {SKILL_LEVELS.map((level) => {
              const val = skillValue(value.age, level);
              return (
                <StepperRow key={level}
                  label={`${SKILL_LABELS[level]} (${val === null ? 'N/A' : val.toFixed(2)} each)`}
                  disabled={val === null}
                  value={value.counts[level]} max={6}
                  onChange={(n) => {
                    const others = totalSkills - value.counts[level];
                    onChange({ ...value, counts: { ...value.counts, [level]: Math.min(n, Math.max(0, 6 - others)) } });
                  }} />
              );
            })}
          </PanelSection>

          <PanelSection title="Element group bonus" sub="+0.50 per fulfilled element group.">
            {egLabels(value.discipline, apparatus).map((label, i) => (
              <CheckRow key={label} checked={!!value.egs[i]}
                onChange={(v) => {
                  const egs = [...value.egs];
                  while (egs.length <= i) egs.push(false);
                  egs[i] = v;
                  onChange({ ...value, egs });
                }}>
                {label}
              </CheckRow>
            ))}
            {value.discipline === 'MAG' && apparatus !== 'floor' && (
              <div style={{ marginTop: 10 }}>
                <div className="sp-section-sub" style={{ marginBottom: 6 }}>
                  EG IV dismount bonus = the dismount's difficulty value (also count it in the top 6 above).
                </div>
                <ChipGroup
                  options={(['none', 'misc', 'me', 'a', 'b', 'c', 'd+'] as MastersDismountLevel[]).map((l) => ({
                    value: l, label: l === 'none' ? 'None' : l === 'misc' ? 'Misc.' : l.toUpperCase(),
                  }))}
                  value={value.dismountLevel}
                  onChange={(dismountLevel) => dismountLevel && onChange({ ...value, dismountLevel })} />
              </div>
            )}
          </PanelSection>

          <PanelSection title="Deductions" sub="Total execution/neutral deductions lost (short-routine deduction is automatic).">
            <DecimalInput big value={value.deductions} step={dedStep}
              onChange={(deductions) => onChange({ ...value, deductions })} />
          </PanelSection>
        </>
      )}

      <WarnBox warnings={outcome.warnings} />
      <BreakdownLine breakdown={outcome.breakdown} />
    </div>
  );
}
