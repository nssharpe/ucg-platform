import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { mutate, useDB } from '../lib/store';
import { pushMeet } from '../lib/supabase';
import { useCapabilities } from '../lib/capabilities';
import { scaffoldNationalsConfig } from '../lib/nationals-adapter';
import { Combo, Field, Modal, useToast } from './ui';
import { DISCIPLINES, STATE_REGIONS } from '../lib/types';
import type { Discipline, Level, Meet, MeetSession, MeetStatus } from '../lib/types';

const TIMEZONES = [
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix',
  'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu',
];

const slugify = (name: string) => name.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function uniqueSlug(name: string, taken: string[]): string {
  const base = slugify(name) || 'meet';
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

const addDays = (iso: string, days: number) => {
  const d = new Date(iso + 'T12:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};

// Session row being edited; numbered "Session N — {label}" on save (seed convention).
interface SessionDraft {
  key: number;
  discipline: Discipline;
  label: string;
  date: string;
  time: string;
  levelIds: string[];
  phase: 'prelim' | 'final';
}

const discLabel = (d: Discipline) => (d === 'TNT' ? 'T&T' : d);

function sessionLabel(d: Discipline, group: Level[], totalLevels: number): string {
  if (group.length === totalLevels) return d === 'TNT' ? 'T&T All Flights' : `${discLabel(d)} All Levels`;
  const names = group.map((l) => l.name);
  return `${discLabel(d)} ${names.length <= 2 ? names.join(' & ') : names.join(' / ')}`;
}

// Default templates mirror the seed: WAG splits lower levels (AM) from upper (PM); MAG/TNT run combined.
function defaultSessions(allLevels: Level[], d: Discipline, date: string, nextKey: () => number): SessionDraft[] {
  const ls = allLevels.filter((l) => l.discipline === d).sort((a, b) => a.order - b.order);
  const groups = d === 'WAG' && ls.length > 2 ? [ls.slice(0, 2), ls.slice(2)] : [ls];
  return groups.map((g, i) => ({
    key: nextKey(), discipline: d, label: sessionLabel(d, g, ls.length),
    date, time: i === 0 ? '09:00' : '14:00', levelIds: g.map((l) => l.id), phase: 'prelim' as const,
  }));
}

export function MeetWizard({ onClose }: { onClose: () => void }) {
  const db = useDB();
  const caps = useCapabilities();
  const toast = useToast();
  const navigate = useNavigate();
  const keyRef = useRef(1);
  const nextKey = () => keyRef.current++;

  // Nationals (admin only): adds prelim/finals phases + qualification config.
  const [kind, setKind] = useState<'standard' | 'nationals'>('standard');
  const [finalsLevelIds, setFinalsLevelIds] = useState<string[]>([]);

  // Basics
  const [name, setName] = useState('');
  const [hostClubId, setHostClubId] = useState<string | null>(null);
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [timezone, setTimezone] = useState('America/New_York');
  // Dates
  const defaultStart = addDays(new Date().toISOString().slice(0, 10), 60);
  const [startDate, setStartDate] = useState(defaultStart);
  const [endDate, setEndDate] = useState(defaultStart);
  const [regOpens, setRegOpens] = useState(`${new Date().toISOString().slice(0, 10)}T12:00`);
  const [regCloses, setRegCloses] = useState(`${addDays(defaultStart, -14)}T23:59`);
  const regClosesDirty = useRef(false);
  // Fees
  const [entryFee, setEntryFee] = useState('60');
  const [secondFee, setSecondFee] = useState('30');
  const [hasBanquet, setHasBanquet] = useState(false);
  const [banquetName, setBanquetName] = useState('Banquet');
  const [banquetPrice, setBanquetPrice] = useState('45');
  // Disciplines & sessions
  const [disciplines, setDisciplines] = useState<Discipline[]>([]);
  const [sessions, setSessions] = useState<SessionDraft[]>([]);
  // Status
  const [status, setStatus] = useState<MeetStatus>('reg-open');
  const [error, setError] = useState('');

  const slug = useMemo(() => uniqueSlug(name, db.meets.map((m) => m.slug)), [name, db.meets]);

  const allCompetingLevelIds = useMemo(() => [...new Set(sessions.flatMap((s) => s.levelIds))], [sessions]);
  // Finals apply to artistic (WAG/MAG) levels; TNT awards from prelims only.
  const finalsEligibleLevels = useMemo(
    () => db.levels
      .filter((l) => (l.discipline === 'WAG' || l.discipline === 'MAG') && allCompetingLevelIds.includes(l.id))
      .sort((a, b) => a.discipline.localeCompare(b.discipline) || a.order - b.order),
    [db.levels, allCompetingLevelIds],
  );

  const changeStart = (v: string) => {
    if (!v) return;
    // Sessions & end date that tracked the old start date follow it; user edits are kept.
    setSessions((rows) => rows.map((r) => (r.date === startDate ? { ...r, date: v } : r)));
    if (endDate === startDate || endDate < v) setEndDate(v);
    if (!regClosesDirty.current) setRegCloses(`${addDays(v, -14)}T23:59`);
    setStartDate(v);
  };

  const toggleDiscipline = (d: Discipline) => {
    if (disciplines.includes(d)) {
      setDisciplines(disciplines.filter((x) => x !== d));
      setSessions(sessions.filter((s) => s.discipline !== d));
    } else {
      setDisciplines([...disciplines, d]);
      setSessions([...sessions, ...defaultSessions(db.levels, d, startDate, nextKey)]);
    }
  };

  const updateSession = (key: number, patch: Partial<SessionDraft>) =>
    setSessions(sessions.map((s) => (s.key === key ? { ...s, ...patch } : s)));

  const submit = () => {
    if (!name.trim()) return setError('Meet name is required.');
    if (!hostClubId) return setError('Pick a host club.');
    if (!city.trim() || !state) return setError('City and state are required.');
    if (!startDate || !endDate || endDate < startDate) return setError('End date must be on or after the start date.');
    if (!regOpens || !regCloses || regCloses.slice(0, 10) > startDate) return setError('Registration must close on or before the meet start date.');
    if (regOpens >= regCloses) return setError('Registration must open before it closes.');
    if (disciplines.length === 0) return setError('Select at least one discipline.');
    if (sessions.length === 0) return setError('Add at least one session.');
    const bad = sessions.find((s) => !s.label.trim() || !s.date || !s.time || s.levelIds.length === 0);
    if (bad) return setError('Every session needs a name, date, time, and at least one level.');
    const fee = Number(entryFee), fee2 = Number(secondFee), bPrice = Number(banquetPrice);
    if (!Number.isFinite(fee) || fee < 0 || !Number.isFinite(fee2) || fee2 < 0) return setError('Fees must be valid dollar amounts.');
    if (hasBanquet && (!banquetName.trim() || !Number.isFinite(bPrice) || bPrice < 0)) return setError('Banquet needs a name and a valid price.');

    const nationals = kind === 'nationals';
    if (nationals && !sessions.some((s) => s.phase === 'prelim')) return setError('A Nationals meet needs at least one prelim session.');

    const meetId = `meet-${Date.now()}`;
    const meetSessions: MeetSession[] = sessions.map((s, i) => ({
      id: `${meetId}-s${i + 1}`,
      name: `Session ${i + 1} — ${s.label.trim()}`,
      discipline: s.discipline, date: s.date, time: s.time, levelIds: s.levelIds,
      squads: [], // matches seed: holding = unplaced regs, no explicit holding squad
      ...(nationals ? { phase: s.phase } : {}),
    }));
    const orderedDisciplines = DISCIPLINES.filter((d) => disciplines.includes(d));
    const meet: Meet = {
      id: meetId, slug, name: name.trim(), hostClubId,
      city: city.trim(), state, timezone,
      startDate, endDate, status, regOpens, regCloses,
      entryFee: fee, secondDisciplineFee: fee2,
      disciplines: orderedDisciplines,
      sessions: meetSessions,
      ...(hasBanquet ? { banquet: { name: banquetName.trim(), price: bPrice } } : {}),
      ...(nationals
        ? {
            kind: 'nationals' as const,
            nationalsConfig: scaffoldNationalsConfig(db.levels, orderedDisciplines, finalsLevelIds.filter((id) => allCompetingLevelIds.includes(id))),
          }
        : {}),
    };
    mutate((d) => { d.meets.push(meet); pushMeet(meet); });
    toast(`${meet.name} sanctioned — #/meets/${slug}`);
    onClose();
    navigate(`/meets/${slug}`);
  };

  const sectionTitle = (t: string) => (
    <h3 className="card-title" style={{ margin: '14px 0 8px', paddingTop: 10, borderTop: '1px solid var(--line)' }}>{t}</h3>
  );

  return (
    <Modal title="Sanction a new meet" onClose={onClose}>
      {caps.isAdmin && (
        <div className="card card-pad" style={{ marginBottom: 12, background: 'var(--ice)', borderColor: 'var(--line)' }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14, fontWeight: 600 }}>
            <input type="checkbox" checked={kind === 'nationals'} onChange={(e) => setKind(e.target.checked ? 'nationals' : 'standard')} />
            Nationals meet
          </label>
          <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', margin: '6px 0 0' }}>
            Unlocks prelim/finals sessions and automatic finals qualification &amp; awards. UCG-admin only.
          </p>
        </div>
      )}
      <h3 className="card-title" style={{ marginBottom: 8 }}>Basics</h3>
      <Field label="Meet name" hint={name.trim() ? `URL: ucg.org/#/meets/${slug}` : 'The URL slug is derived automatically.'}>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Southeast Open 2027" autoFocus />
      </Field>
      <Field label="Host club">
        <Combo
          options={db.clubs.map((c) => ({ value: c.id, label: c.name, sub: `${c.state} · ${c.region}` }))}
          value={hostClubId} onChange={setHostClubId} placeholder="Type to search clubs…"
        />
      </Field>
      <div className="grid cols-3">
        <Field label="City"><input className="input" value={city} onChange={(e) => setCity(e.target.value)} /></Field>
        <Field label="State">
          <select className="input" value={state} onChange={(e) => setState(e.target.value)}>
            <option value="" disabled>Select…</option>
            {Object.keys(STATE_REGIONS).map((s) => <option key={s}>{s}</option>)}
          </select>
        </Field>
        <Field label="Timezone">
          <select className="input" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
            {TIMEZONES.map((t) => <option key={t}>{t}</option>)}
          </select>
        </Field>
      </div>

      {sectionTitle('Dates')}
      <div className="grid cols-3">
        <Field label="Start date"><input className="input" type="date" value={startDate} onChange={(e) => changeStart(e.target.value)} /></Field>
        <Field label="End date"><input className="input" type="date" min={startDate} value={endDate} onChange={(e) => setEndDate(e.target.value)} /></Field>
      </div>
      <div className="grid cols-3">
        <Field label="Registration opens"><input className="input" type="datetime-local" value={regOpens} onChange={(e) => setRegOpens(e.target.value)} /></Field>
        <Field label="Registration closes" hint="Must be on or before the start date.">
          <input className="input" type="datetime-local" value={regCloses} onChange={(e) => { regClosesDirty.current = true; setRegCloses(e.target.value); }} />
        </Field>
      </div>

      {sectionTitle('Fees')}
      <div className="grid cols-3">
        <Field label="Entry fee ($)"><input className="input" type="number" min={0} step={5} value={entryFee} onChange={(e) => setEntryFee(e.target.value)} /></Field>
        <Field label="2nd discipline ($)"><input className="input" type="number" min={0} step={5} value={secondFee} onChange={(e) => setSecondFee(e.target.value)} /></Field>
      </div>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14, marginBottom: hasBanquet ? 8 : 0 }}>
        <input type="checkbox" checked={hasBanquet} onChange={(e) => setHasBanquet(e.target.checked)} /> Offer a banquet add-on
      </label>
      {hasBanquet && (
        <div className="grid cols-3">
          <Field label="Banquet name"><input className="input" value={banquetName} onChange={(e) => setBanquetName(e.target.value)} /></Field>
          <Field label="Banquet price ($)"><input className="input" type="number" min={0} step={5} value={banquetPrice} onChange={(e) => setBanquetPrice(e.target.value)} /></Field>
        </div>
      )}

      {sectionTitle('Disciplines & sessions')}
      <div style={{ display: 'flex', gap: 16, marginBottom: 10 }}>
        {DISCIPLINES.map((d) => (
          <label key={d} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 14, fontWeight: 600 }}>
            <input type="checkbox" checked={disciplines.includes(d)} onChange={() => toggleDiscipline(d)} /> {discLabel(d)}
          </label>
        ))}
      </div>
      {sessions.length === 0 && <p style={{ fontSize: 13, color: 'var(--ink-soft)', margin: '4px 0' }}>Pick a discipline to load its default session templates — then add, remove, or edit sessions.</p>}
      {sessions.map((s, i) => {
        const discLevels = db.levels.filter((l) => l.discipline === s.discipline).sort((a, b) => a.order - b.order);
        return (
          <div key={s.key} className="card card-pad" style={{ marginBottom: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
              <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--ink-soft)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Session {i + 1} · {discLabel(s.discipline)}</span>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {kind === 'nationals' && (
                  <select className="input" style={{ width: 'auto', padding: '2px 8px', fontSize: 12.5 }} value={s.phase} onChange={(e) => updateSession(s.key, { phase: e.target.value as 'prelim' | 'final' })}>
                    <option value="prelim">Prelims</option>
                    <option value="final">Finals</option>
                  </select>
                )}
                <button className="btn small ghost" onClick={() => setSessions(sessions.filter((x) => x.key !== s.key))}>Remove</button>
              </div>
            </div>
            <Field label="Name" hint={`Saved as “Session ${i + 1} — ${s.label.trim() || '…'}”`}>
              <input className="input" value={s.label} onChange={(e) => updateSession(s.key, { label: e.target.value })} />
            </Field>
            <div className="grid cols-3">
              <Field label="Date"><input className="input" type="date" min={startDate} max={endDate} value={s.date} onChange={(e) => updateSession(s.key, { date: e.target.value })} /></Field>
              <Field label="Time"><input className="input" type="time" value={s.time} onChange={(e) => updateSession(s.key, { time: e.target.value })} /></Field>
            </div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {discLevels.map((l) => (
                <label key={l.id} style={{ display: 'flex', gap: 5, alignItems: 'center', fontSize: 13.5 }}>
                  <input
                    type="checkbox"
                    checked={s.levelIds.includes(l.id)}
                    onChange={(e) => updateSession(s.key, {
                      levelIds: e.target.checked
                        ? discLevels.map((x) => x.id).filter((id) => s.levelIds.includes(id) || id === l.id) // keep level order
                        : s.levelIds.filter((id) => id !== l.id),
                    })}
                  /> {l.name}
                </label>
              ))}
            </div>
          </div>
        );
      })}
      {disciplines.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 4 }}>
          {disciplines.map((d) => (
            <button key={d} className="btn small ghost" onClick={() => setSessions([...sessions, { key: nextKey(), discipline: d, label: `${discLabel(d)} `, date: startDate, time: '09:00', levelIds: [], phase: 'prelim' }])}>
              + Add {discLabel(d)} session
            </button>
          ))}
        </div>
      )}

      {kind === 'nationals' && (
        <>
          {sectionTitle('Finals & qualification')}
          <p style={{ fontSize: 13, color: 'var(--ink-soft)', margin: '0 0 8px' }}>
            Pick the levels that hold finals (awards come from finals results); every other level awards
            straight from prelims. Set the qualification cutoffs (&ldquo;blue numbers&rdquo;) on the meet
            page after creating it.
          </p>
          {finalsEligibleLevels.length === 0 && <p style={{ fontSize: 13, color: 'var(--ink-soft)' }}>Add WAG/MAG sessions with levels first.</p>}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {finalsEligibleLevels.map((l) => (
              <label key={l.id} style={{ display: 'flex', gap: 5, alignItems: 'center', fontSize: 13.5 }}>
                <input
                  type="checkbox"
                  checked={finalsLevelIds.includes(l.id)}
                  onChange={(e) => setFinalsLevelIds(e.target.checked ? [...finalsLevelIds, l.id] : finalsLevelIds.filter((id) => id !== l.id))}
                /> {discLabel(l.discipline)} {l.name}
              </label>
            ))}
          </div>
        </>
      )}

      {sectionTitle('Status')}
      <div style={{ display: 'flex', gap: 16, marginBottom: 6 }}>
        {(['reg-open', 'draft'] as const).map((s) => (
          <label key={s} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 14 }}>
            <input type="radio" name="meet-status" checked={status === s} onChange={() => setStatus(s)} />
            {s === 'reg-open' ? 'Open registration now' : 'Save as draft'}
          </label>
        ))}
      </div>

      {error && <p style={{ color: 'var(--coral-600)', fontSize: 13.5, fontWeight: 600, margin: '8px 0 0' }}>{error}</p>}
      <div style={{ display: 'flex', justifyContent: 'end', gap: 8, marginTop: 16 }}>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={submit}>Sanction meet</button>
      </div>
    </Modal>
  );
}
