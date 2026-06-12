// Native MAG start-value panel (routine builder + bonus + neutral deductions).
import {
  EG_VALUES, SKILL_LETTERS, VAULT_VALUES, bonusOptions, compute, deductionOptions,
  init, magRuleset, rowFlags,
} from '../../scoring/mag';
import type { MagOption, MagState } from '../../scoring/mag';
import { BreakdownLine, CheckRow, ChipGroup, PanelSection, StepperRow, WarnBox } from './parts';

function OptionControls({ options, values, onChange }: {
  options: MagOption[];
  values: Record<string, number | boolean>;
  onChange: (v: Record<string, number | boolean>) => void;
}) {
  const set = (key: string, v: number | boolean, exclusiveWith?: string) => {
    const next = { ...values, [key]: v };
    if (v && exclusiveWith) next[exclusiveWith] = false;
    onChange(next);
  };
  return (
    <>
      {options.map((opt) => {
        if (opt.kind === 'check') {
          return (
            <CheckRow key={opt.key} checked={!!values[opt.key]} onChange={(v) => set(opt.key, v, opt.exclusiveWith)}>
              {opt.label}
            </CheckRow>
          );
        }
        if (opt.kind === 'count') {
          return (
            <StepperRow key={opt.key} label={opt.label} max={5}
              value={typeof values[opt.key] === 'number' ? values[opt.key] as number : 0}
              onChange={(v) => set(opt.key, v)} />
          );
        }
        return (
          <div key={opt.key} className="sp-row">
            <label>{opt.label}</label>
            <select className="input" style={{ width: 'auto' }}
              value={String(typeof values[opt.key] === 'number' ? values[opt.key] : 0)}
              onChange={(e) => set(opt.key, parseFloat(e.target.value))}>
              {opt.choices!.map((c) => <option key={c.label} value={c.value}>{c.label}</option>)}
            </select>
          </div>
        );
      })}
    </>
  );
}

export function MagPanel({ levelId, eventCode, value, onChange }: {
  levelId: string; eventCode: string; value: MagState; onChange: (s: MagState) => void;
}) {
  const ruleset = magRuleset(levelId);
  const isVault = eventCode === 'VT';
  const outcome = compute(value, levelId, eventCode);
  const flags = isVault ? null : rowFlags(value, levelId, eventCode);
  const bonusOpts = bonusOptions(ruleset, eventCode);
  const dedOpts = deductionOptions(ruleset, eventCode);

  const reset = (
    <button className="btn ghost small" type="button" onClick={() => onChange(init(levelId, eventCode))}>Reset</button>
  );

  return (
    <div className="sp-panel">
      {isVault ? (
        <PanelSection title="Vault" sub="Select the vault's difficulty value." right={reset}>
          <div className="sp-row">
            <label>Vault value</label>
            <select className="input" style={{ width: 'auto' }} value={value.vaultValue}
              onChange={(e) => onChange({ ...value, vaultValue: parseFloat(e.target.value) })}>
              {VAULT_VALUES.map((v) => <option key={v} value={v}>{v.toFixed(1)}</option>)}
            </select>
          </div>
        </PanelSection>
      ) : (
        <PanelSection title={`Routine — ${ruleset}`}
          sub="Pick each counting skill's value and element group. Red = not counting (EG limits); green = earns the EG bonus." right={reset}>
          <div className="sp-skillgrid">
            {value.skills.map((skill, i) => (
              <div key={i} className="sp-skillrow">
                <span className="sp-skillnum">{i + 1}</span>
                <ChipGroup dense allowClear
                  options={SKILL_LETTERS.map((s) => ({ value: s }))}
                  value={skill}
                  chipState={(s) => (skill === s && flags!.excluded[i] ? 'excluded' : undefined)}
                  onChange={(s) => onChange({ ...value, skills: value.skills.map((x, j) => (j === i ? s : x)) })} />
                <div className="sp-sep" />
                <ChipGroup dense allowClear
                  options={EG_VALUES.map((eg) => ({ value: eg, label: `EG ${eg}` }))}
                  value={value.egs[i]}
                  chipState={(eg) => {
                    if (value.egs[i] !== eg) return undefined;
                    if (flags!.excluded[i]) return 'excluded';
                    if (flags!.egContrib[i]) return 'contrib';
                    return undefined;
                  }}
                  onChange={(eg) => onChange({ ...value, egs: value.egs.map((x, j) => (j === i ? eg : x)) })} />
              </div>
            ))}
          </div>
        </PanelSection>
      )}

      {bonusOpts.length > 0 && (
        <PanelSection title="Bonus">
          <OptionControls options={bonusOpts} values={value.bonus} onChange={(bonus) => onChange({ ...value, bonus })} />
        </PanelSection>
      )}

      {dedOpts.length > 0 && (
        <PanelSection title="Neutral deductions"
          right={(
            <CheckRow checked={value.hideNeutral} onChange={(hideNeutral) => onChange({ ...value, hideNeutral })}>
              Hide
            </CheckRow>
          )}>
          {!value.hideNeutral && (
            <OptionControls options={dedOpts} values={value.deductions} onChange={(deductions) => onChange({ ...value, deductions })} />
          )}
        </PanelSection>
      )}

      <WarnBox warnings={outcome.warnings} />
      <BreakdownLine breakdown={outcome.breakdown} />
    </div>
  );
}
