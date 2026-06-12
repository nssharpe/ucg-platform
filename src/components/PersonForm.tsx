import { useState } from 'react';
import { useDB, mutate } from '../lib/store';
import { Combo, Field, Modal, useToast } from './ui';
import { DIETARY_OPTIONS, DISCIPLINES, SHIRT_SIZES, STATE_REGIONS } from '../lib/types';
import type { Athlete, Gender, Placement } from '../lib/types';
import { nextId } from './ClubForm';
import { pushPerson } from '../lib/supabase';

const GENDERS: Gender[] = ['Male', 'Female', 'Non-binary', 'Genderfluid', 'Agender', 'Other'];

const blank = (): Omit<Athlete, 'id'> => ({
  kind: 'athlete', firstName: '', lastName: '', email: '', dob: '', gender: 'Female',
  gradYear: 1900, studentStatus: 'Student', shirt: 'Adult M', country: 'United States',
  state: '', phone: '', mainClubId: null, altClubIds: [], levels: {},
  emergency: { contact: '', relation: '', phone: '' },
  dietary: [], dietaryNotes: '', memberships: [], achievements: [],
});

/** Create (person undefined) or edit an athlete/coach in a modal. */
export function PersonForm({ person, onClose }: { person?: Athlete; onClose: () => void }) {
  const db = useDB();
  const toast = useToast();
  const [draft, setDraft] = useState<Omit<Athlete, 'id'>>(person ? { ...person } : blank());
  const set = (patch: Partial<Athlete>) => setDraft({ ...draft, ...patch });
  const states = Object.keys(STATE_REGIONS);
  const clubOptions = [
    { value: '', label: 'Independent (no club)' },
    ...db.clubs.map((c) => ({ value: c.id, label: c.name, sub: `${c.state} · ${c.region}` })),
  ];
  const noGradYear = draft.gradYear === 1900;
  const valid = draft.firstName.trim() && draft.lastName.trim() && draft.email.trim() && draft.dob && draft.state;

  const save = () => {
    if (!valid) { toast('Name, email, date of birth, and state are required.'); return; }
    const data = { ...draft, firstName: draft.firstName.trim(), lastName: draft.lastName.trim(), email: draft.email.trim() };
    mutate((d) => {
      if (person) {
        const i = d.people.findIndex((x) => x.id === person.id);
        d.people[i] = { ...d.people[i], ...data };
        pushPerson(d.people[i]);
      } else {
        const created = { id: nextId(d.people, 'p-'), ...data };
        d.people.push(created);
        pushPerson(created);
      }
    });
    toast(person ? 'Person updated.' : `${data.kind === 'coach' ? 'Coach' : 'Athlete'} created — open their profile to manage memberships.`);
    onClose();
  };

  return (
    <Modal title={person ? `Edit ${person.firstName} ${person.lastName}` : 'New person'} onClose={onClose}>
      <div className="grid cols-2">
        <Field label="Type">
          <select className="input" value={draft.kind} onChange={(e) => set({ kind: e.target.value as Athlete['kind'] })}>
            <option value="athlete">Athlete</option>
            <option value="coach">Coach</option>
          </select>
        </Field>
        <Field label="Email"><input type="email" value={draft.email} onChange={(e) => set({ email: e.target.value })} /></Field>
        <Field label="First name"><input type="text" value={draft.firstName} onChange={(e) => set({ firstName: e.target.value })} /></Field>
        <Field label="Last name"><input type="text" value={draft.lastName} onChange={(e) => set({ lastName: e.target.value })} /></Field>
        <Field label="Date of birth" hint="Athletes must be 15+, coaches 18+."><input type="date" value={draft.dob} onChange={(e) => set({ dob: e.target.value })} /></Field>
        <Field label="Gender">
          <select className="input" value={draft.gender} onChange={(e) => set({ gender: e.target.value as Gender })}>
            {GENDERS.map((g) => <option key={g}>{g}</option>)}
          </select>
        </Field>
        {draft.gender !== 'Male' && draft.gender !== 'Female' && DISCIPLINES.map((d) => (
          <Field key={d} label={`${d} placement category`} tip="Determines which division they place in for this discipline">
            <select className="input" value={draft.placement?.[d] ?? ''} onChange={(e) => {
              const v = e.target.value as Placement | '';
              set({ placement: { ...draft.placement, [d]: v || undefined } });
            }}>
              <option value="">Not set</option>
              <option value="women+">women+</option>
              <option value="men+">men+</option>
            </select>
          </Field>
        ))}
        <Field label="Undergrad graduation year">
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <input type="number" disabled={noGradYear} value={noGradYear ? '' : draft.gradYear} placeholder="n/a"
              onChange={(e) => set({ gradYear: +e.target.value || 1900 })} />
            <label className="checkrow" style={{ whiteSpace: 'nowrap', margin: 0 }}>
              {/* 1900 is the sentinel for "no undergrad grad year" */}
              <input type="checkbox" checked={noGradYear} onChange={(e) => set({ gradYear: e.target.checked ? 1900 : new Date().getFullYear() })} />
              N/A
            </label>
          </div>
        </Field>
        <Field label="Student status" hint="Full-time student for ≥1 semester this season.">
          <select className="input" value={draft.studentStatus} onChange={(e) => set({ studentStatus: e.target.value as Athlete['studentStatus'] })}>
            <option>Student</option><option>Non-Student</option>
          </select>
        </Field>
        <Field label="T-shirt size">
          <select className="input" value={draft.shirt} onChange={(e) => set({ shirt: e.target.value })}>
            {SHIRT_SIZES.map((s) => <option key={s}>{s}</option>)}
          </select>
        </Field>
        <Field label="Country"><input type="text" value={draft.country} onChange={(e) => set({ country: e.target.value })} /></Field>
        <Field label="Training state">
          <Combo options={states.map((s) => ({ value: s, label: s, sub: STATE_REGIONS[s] }))} value={draft.state || null} onChange={(v) => set({ state: v })} />
        </Field>
        <Field label="Phone"><input type="tel" value={draft.phone} onChange={(e) => set({ phone: e.target.value })} /></Field>
      </div>

      <h3 className="card-title" style={{ marginTop: 8 }}>Competition</h3>
      <div className="grid cols-2">
        <Field label="Main club" hint="The only club that can pay their membership fee.">
          <Combo options={clubOptions} value={draft.mainClubId ?? ''} onChange={(v) => set({ mainClubId: v || null })} />
        </Field>
        <Field label="Region" hint="Derived from training state.">
          <input type="text" disabled value={draft.state ? STATE_REGIONS[draft.state] ?? 'Other' : '—'} />
        </Field>
        {DISCIPLINES.map((d) => (
          <Field key={d} label={`${d} level`}>
            <select className="input" value={draft.levels[d] ?? ''} onChange={(e) => set({ levels: { ...draft.levels, [d]: e.target.value || undefined } })}>
              <option value="">Not competing {d}</option>
              {db.levels.filter((l) => l.discipline === d).sort((a, b) => a.order - b.order).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </Field>
        ))}
      </div>

      <h3 className="card-title" style={{ marginTop: 8 }}>Meet-day</h3>
      <div className="grid cols-2">
        <Field label="Emergency contact"><input type="text" value={draft.emergency.contact} onChange={(e) => set({ emergency: { ...draft.emergency, contact: e.target.value } })} /></Field>
        <Field label="Relation"><input type="text" value={draft.emergency.relation} onChange={(e) => set({ emergency: { ...draft.emergency, relation: e.target.value } })} /></Field>
        <Field label="Emergency phone"><input type="tel" value={draft.emergency.phone} onChange={(e) => set({ emergency: { ...draft.emergency, phone: e.target.value } })} /></Field>
      </div>
      <Field label="Dietary restrictions">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 18px' }}>
          {DIETARY_OPTIONS.map((opt) => (
            <label className="checkrow" key={opt}>
              <input type="checkbox" checked={draft.dietary.includes(opt)}
                onChange={(e) => set({ dietary: e.target.checked ? [...draft.dietary, opt] : draft.dietary.filter((x) => x !== opt) })} />
              {opt}
            </label>
          ))}
        </div>
      </Field>
      <Field label="Dietary notes"><textarea rows={2} value={draft.dietaryNotes} onChange={(e) => set({ dietaryNotes: e.target.value })} /></Field>

      <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
        <button className="btn primary" disabled={!valid} onClick={save}>{person ? 'Save changes' : 'Create person'}</button>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}
