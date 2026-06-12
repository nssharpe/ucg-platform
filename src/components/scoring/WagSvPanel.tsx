// Native Xcel / Level 9 start-value panel (judge applies deductions in the score form).
import { LEVELS, SR, compute, init, vaultsFor, vpParts, wagSvLevel } from '../../scoring/wagSv';
import type { WagSvState } from '../../scoring/wagSv';
import { BreakdownLine, CheckRow, PanelSection, StepperRow, WarnBox } from './parts';

export function WagSvPanel({ levelId, eventCode, value, onChange }: {
  levelId: string; eventCode: string; value: WagSvState; onChange: (s: WagSvState) => void;
}) {
  const level = wagSvLevel(levelId);
  const lvl = LEVELS[level];
  const outcome = compute(value, levelId, eventCode);
  const reset = (
    <button className="btn ghost small" type="button" onClick={() => onChange(init(levelId, eventCode))}>Reset</button>
  );

  if (eventCode === 'VT') {
    return (
      <div className="sp-panel">
        <PanelSection title={`Vault — ${level}`} sub="The vault's table value is the start value; deductions are applied directly." right={reset}>
          <select className="input" value={value.vaultIndex}
            onChange={(e) => onChange({ ...value, vaultIndex: parseInt(e.target.value, 10) })}>
            {vaultsFor(level).map(([name, sv], i) => (
              <option key={name} value={i}>{name} ({sv.toFixed(1)})</option>
            ))}
          </select>
        </PanelSection>
        <BreakdownLine breakdown={outcome.breakdown} />
      </div>
    );
  }

  const req = Object.entries(lvl.req).filter(([, n]) => n > 0).map(([k, n]) => `${n}×"${k}"`).join(' + ');
  const srList = SR[level][eventCode as 'UB' | 'BB' | 'FX'] ?? [];

  return (
    <div className="sp-panel">
      <PanelSection title={`Value parts — ${level} (${lvl.program})`}
        sub={`Required: ${req}. Higher value parts fill lower slots. Missing: A −0.10, B −0.30, C −0.50.`}
        right={reset}>
        {vpParts(level).map((p) => (
          <StepperRow key={p}
            label={p === 'C' ? `C performed${lvl.program === 'DP' ? ' (incl. allowable D/E → "C")' : ' / D'}` : `${p} performed`}
            value={value.vp[p]}
            onChange={(n) => onChange({ ...value, vp: { ...value.vp, [p]: n } })} />
        ))}
      </PanelSection>

      <PanelSection title="Special requirements" sub="0.50 each — uncheck anything missed.">
        {srList.map((txt, i) => (
          <CheckRow key={txt} checked={!!value.sr[i]}
            onChange={(v) => onChange({ ...value, sr: value.sr.map((x, j) => (j === i ? v : x)) })}>
            {txt}
          </CheckRow>
        ))}
      </PanelSection>

      <PanelSection title="Penalties & bonus">
        <CheckRow checked={value.noDismount} onChange={(noDismount) => onChange({ ...value, noDismount })}>
          No dismount performed (−0.30)
        </CheckRow>
        <StepperRow label="Restricted elements performed (−0.50 each)" value={value.restricted}
          onChange={(restricted) => onChange({ ...value, restricted })} />
        {lvl.bonus && (
          <div className="sp-row">
            <label>Bonus earned (CV / D-E, max {(lvl.bonusMax ?? 0).toFixed(2)})</label>
            <select className="input" style={{ width: 'auto' }} value={value.bonus}
              onChange={(e) => onChange({ ...value, bonus: parseFloat(e.target.value) })}>
              {[0, 0.1, 0.2, 0.3].map((b) => <option key={b} value={b}>{b.toFixed(2)}</option>)}
            </select>
          </div>
        )}
      </PanelSection>

      <div className="sp-section-sub">
        {lvl.program === 'DP'
          ? 'Level 9 builds from a 9.70 base + bonus (max +0.30), capped at 10.0.'
          : 'Xcel builds from 10.0 with no bonus system. Final = start value − execution deductions.'}
      </div>
      <WarnBox warnings={outcome.warnings} />
      <BreakdownLine breakdown={outcome.breakdown} />
    </div>
  );
}
