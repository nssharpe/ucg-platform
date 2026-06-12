// Native T&T panel — per-pass skill entry with DD chart lookup.
import { useId, useMemo } from 'react';
import { STRUCTURE, compute, init, levelNote, passDD, skillsFor, tntEvent } from '../../scoring/tnt';
import type { TntState } from '../../scoring/tnt';
import { BreakdownLine, DecimalInput, PanelSection, WarnBox } from './parts';

export function TntPanel({ levelId, eventCode, value, onChange }: {
  levelId: string; eventCode: string; value: TntState; onChange: (s: TntState) => void;
}) {
  const ev = tntEvent(eventCode);
  const outcome = compute(value, levelId, eventCode);
  const listId = useId();
  const skills = useMemo(() => skillsFor(eventCode), [eventCode]);
  const ddByName = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of skills) m.set(s.n.toLowerCase(), s.dd);
    return m;
  }, [skills]);

  const setSkill = (pi: number, si: number, patch: Partial<{ name: string; dd: string }>) => {
    onChange({
      ...value,
      passes: value.passes.map((p, i) => (i === pi ? {
        ...p,
        skills: p.skills.map((s, j) => (j === si ? { ...s, ...patch } : s)),
      } : p)),
    });
  };

  return (
    <div className="sp-panel">
      <datalist id={listId}>
        {skills.map((s) => <option key={s.n} value={s.n}>{s.dd.toFixed(1)}{s.fig ? ` · ${s.fig}` : ''}</option>)}
      </datalist>
      <div className="sp-section-sub">{levelNote(levelId, eventCode)}</div>

      {STRUCTURE[ev].passes.map((spec, pi) => {
        const pass = value.passes[pi];
        if (!pass) return null;
        return (
          <PanelSection key={spec.name}
            title={`${spec.name} — DD ${passDD(pass).toFixed(1)}`}
            right={(
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span className="sp-section-title">{spec.exec}</span>
                <DecimalInput value={pass.exec} step={0.1}
                  onChange={(exec) => onChange({ ...value, passes: value.passes.map((p, i) => (i === pi ? { ...p, exec } : p)) })} />
              </div>
            )}>
            <div className="sp-skillgrid">
              {pass.skills.map((skill, si) => (
                <div key={si} className="sp-skillrow">
                  <span className="sp-skillnum" style={{ width: 72, fontSize: 12 }}>
                    {spec.labels ? spec.labels[si] : `${si + 1})`}
                  </span>
                  <input type="text" className="input" list={listId} style={{ flex: 1 }}
                    placeholder="Type to search skills…" value={skill.name}
                    onChange={(e) => {
                      const name = e.target.value;
                      const dd = ddByName.get(name.toLowerCase());
                      setSkill(pi, si, dd != null ? { name, dd: dd.toFixed(1) } : { name });
                    }} />
                  <input type="number" className="input" inputMode="decimal" min={0} step={0.1}
                    style={{ width: 76, textAlign: 'center', fontWeight: 700 }} placeholder="DD"
                    value={skill.dd} onChange={(e) => setSkill(pi, si, { dd: e.target.value })} />
                </div>
              ))}
            </div>
          </PanelSection>
        );
      })}

      <PanelSection title="Chair of Panel penalties" sub="e.g. level violation 2.0, missing card 0.2."
        right={<button className="btn ghost small" type="button" onClick={() => onChange(init(levelId, eventCode))}>Reset</button>}>
        <DecimalInput value={value.penalty} step={0.1} max={30}
          onChange={(penalty) => onChange({ ...value, penalty })} />
      </PanelSection>

      <div className="sp-section-sub">
        Skills not on the DD chart need Rules-Team approval — enter their approved DD manually.
        Repeats per the NAIGC COP are the judge's call; this panel totals what you enter.
      </div>
      <WarnBox warnings={outcome.warnings} />
      <BreakdownLine breakdown={outcome.breakdown} />
    </div>
  );
}
