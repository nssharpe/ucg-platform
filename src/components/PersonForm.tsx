import { useState } from 'react';
import { useDB, mutate } from '../lib/store';
import { Combo, Field, Modal } from './ui';
import { useToast } from './ui-hooks';
import { DIETARY_OPTIONS, DISCIPLINES, SHIRT_SIZES, STATE_REGIONS } from '../lib/types';
import type { Athlete, Gender, Placement } from '../lib/types';
import { nextId } from '../lib/ids';
import { pushPerson } from '../lib/supabase';

const GENDERS: Gender[] = ['Male', 'Female', 'Non-binary', 'Genderfluid', 'Agender', 'Other'];

// ---------------------------------------------------------------------------
// Helpers (duplicated from Profile to avoid cross-page coupling)
// ---------------------------------------------------------------------------

function formatPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 10);
  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function phoneValid(raw: string): boolean {
  return raw.replace(/\D/g, '').length === 10;
}

// ---------------------------------------------------------------------------

const blank = (): Omit<Athlete, 'id'> => ({
  kind: 'athlete', roles: { athlete: true, coach: false },
  firstName: '', lastName: '', email: '', dob: '', gender: 'Female',
  // 0 = not yet chosen (forces a year or an explicit N/A); 1900 = N/A sentinel.
  gradYear: 0, studentStatus: '', shirt: '', country: 'United States',
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
  // Club must be an explicit choice: either pick a club, or tick "Independent
  // Athlete" (which maps to mainClubId = null behind the scenes). No default.
  const [independent, setIndependent] = useState<boolean>(person ? person.mainClubId === null : false);
  const clubOptions = db.clubs.map((c) => ({ value: c.id, label: c.name, sub: `${c.state} · ${c.region}` }));
  const altClubOptions = db.clubs.map((c) => ({ value: c.id, label: c.name, sub: `${c.state} · ${c.region}` }));
  const noGradYear = draft.gradYear === 1900;
  const unsetGradYear = draft.gradYear === 0;
  const clubChosen = independent || !!draft.mainClubId;
  const isCoach = draft.kind === 'coach';
  // Coach-only accounts hide (and skip validation for) student status + grad year;
  // they also see "Coaching state" instead of "Training state" (feedback 1e).
  const coachOnly = isCoach;
  const outsideUs = !!draft.outsideUs;
  const stateLabel = coachOnly ? 'Coaching state' : 'Training state';
  // Student status + grad year are required only for athletes. Coaches skip both gates.
  const studentStatusMissing = !isCoach && !draft.studentStatus;
  const gradYearMissing = !isCoach && unsetGradYear;
  const shirtMissing = !draft.shirt;
  // Training/Coaching state is required only when NOT training outside the US.
  const stateMissing = !outsideUs && !draft.state;
  const valid = draft.firstName.trim() && draft.lastName.trim() && draft.email.trim()
    && draft.dob && !stateMissing && !gradYearMissing && !studentStatusMissing && !shirtMissing && clubChosen;

  const mainPhoneInvalid = draft.phone && !phoneValid(draft.phone);
  const emergPhoneInvalid = draft.emergency.phone && !phoneValid(draft.emergency.phone);

  const save = () => {
    if (gradYearMissing) { toast('Enter a graduation year or check N/A.'); return; }
    if (studentStatusMissing) { toast('Select a student status.'); return; }
    if (shirtMissing) { toast('Select a t-shirt size.'); return; }
    if (!clubChosen) { toast('Pick a club, or check "Independent Athlete".'); return; }
    if (!valid) { toast(`Name, email, date of birth, and ${stateLabel.toLowerCase()} are required.`); return; }
    const data = { ...draft, firstName: draft.firstName.trim(), lastName: draft.lastName.trim(), email: draft.email.trim() };
    const applied = mutate((d) => {
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
    if (!applied) return; // offline read-only gate — no false success toast
    toast(person ? 'Person updated.' : `${data.kind === 'coach' ? 'Coach' : 'Athlete'} created — open their profile to manage memberships.`);
    onClose();
  };

  return (
    <Modal title={person ? `Edit ${person.firstName} ${person.lastName}` : 'New person'} onClose={onClose}>
      <p style={{ fontSize: 13, color: 'var(--ink-soft)', margin: '0 0 12px' }}>
        Fields marked <span style={{ color: 'var(--coral-text)' }}>*</span> are required.
      </p>
      <div className="grid cols-2">
        <Field label="Type" required>
          <select className="input" value={draft.kind} onChange={(e) => set({ kind: e.target.value as Athlete['kind'] })}>
            <option value="athlete">Athlete</option>
            <option value="coach">Coach</option>
          </select>
        </Field>
        <Field label="Email" required><input type="email" value={draft.email} onChange={(e) => set({ email: e.target.value })} /></Field>
        <Field label="First name" required><input type="text" value={draft.firstName} onChange={(e) => set({ firstName: e.target.value })} /></Field>
        <Field label="Last name" required><input type="text" value={draft.lastName} onChange={(e) => set({ lastName: e.target.value })} /></Field>
        <Field label="Date of birth" required hint="Athletes must be 15+, coaches 18+."><input type="date" value={draft.dob} onChange={(e) => set({ dob: e.target.value })} /></Field>
        <Field label="Gender">
          <select className="input" value={draft.gender} onChange={(e) => set({ gender: e.target.value as Gender })}>
            {GENDERS.map((g) => <option key={g}>{g}</option>)}
          </select>
        </Field>
        {!isCoach && draft.gender !== 'Male' && draft.gender !== 'Female' && DISCIPLINES.map((d) => (
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
        {!coachOnly && (
          <Field label="Undergrad graduation year" required>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <input type="number" disabled={noGradYear} value={noGradYear || unsetGradYear ? '' : draft.gradYear} placeholder="YYYY"
                onChange={(e) => set({ gradYear: +e.target.value || 0 })} />
              <label className="checkrow" style={{ whiteSpace: 'nowrap', margin: 0 }}>
                {/* 1900 = "no undergrad grad year"; 0 = not yet chosen (unchecking
                    N/A clears back to unset so a year must be entered). */}
                <input type="checkbox" checked={noGradYear} onChange={(e) => set({ gradYear: e.target.checked ? 1900 : 0 })} />
                N/A
              </label>
            </div>
            {gradYearMissing && <div style={{ fontSize: 12, color: 'var(--coral-text)', marginTop: 4 }}>Enter a year or check N/A.</div>}
          </Field>
        )}
        {!coachOnly && (
          <Field label="Student status" required hint="Full-time student for ≥1 semester this season.">
            <select className="input" value={draft.studentStatus || ''}
              style={studentStatusMissing ? { outline: '2px solid var(--coral-600)', borderRadius: 4 } : undefined}
              onChange={(e) => set({ studentStatus: e.target.value as Athlete['studentStatus'] })}>
              <option value="" disabled>Select a student status…</option>
              <option value="Student">Student</option><option value="Non-Student">Non-Student</option>
            </select>
            {studentStatusMissing && <div style={{ fontSize: 12, color: 'var(--coral-text)', marginTop: 4 }}>Select a student status.</div>}
          </Field>
        )}
        <Field label="T-shirt size" required>
          <select className="input" value={draft.shirt || ''}
            style={shirtMissing ? { outline: '2px solid var(--coral-600)', borderRadius: 4 } : undefined}
            onChange={(e) => set({ shirt: e.target.value })}>
            <option value="" disabled>Select a t-shirt size…</option>
            {SHIRT_SIZES.map((s) => <option key={s}>{s}</option>)}
          </select>
          {shirtMissing && <div style={{ fontSize: 12, color: 'var(--coral-text)', marginTop: 4 }}>Select a t-shirt size.</div>}
        </Field>
        <Field label="Country"><input type="text" value={draft.country} onChange={(e) => set({ country: e.target.value })} /></Field>
        <Field label={stateLabel} required={!outsideUs}>
          {outsideUs ? (
            <input type="text" disabled value="Outside US" />
          ) : (
            <Combo options={states.map((s) => ({ value: s, label: s, sub: STATE_REGIONS[s] }))} value={draft.state || null} onChange={(v) => set({ state: v })} />
          )}
          <label className="checkrow" style={{ margin: '8px 0 0' }}>
            <input type="checkbox" checked={outsideUs}
              onChange={(e) => set(e.target.checked ? { outsideUs: true, state: '' } : { outsideUs: false })} />
            {coachOnly ? 'Coaching outside the US' : 'Training outside the US'}
          </label>
        </Field>
        <Field label="Phone">
          <input
            type="tel"
            value={draft.phone}
            onChange={(e) => set({ phone: formatPhone(e.target.value) })}
            placeholder="(555) 123-4567"
          />
          {mainPhoneInvalid && <div style={{ fontSize: 12, color: 'var(--coral-text)', marginTop: 4 }}>Must be a 10-digit US phone number.</div>}
        </Field>
      </div>

      <h3 className="card-title" style={{ marginTop: 8 }}>Competition</h3>
      <div className="grid cols-2">
        <Field label="Main club" required hint="The only club that can pay their membership fee.">
          {independent ? (
            <input type="text" disabled value="Independent Athlete" />
          ) : (
            <Combo options={clubOptions} value={draft.mainClubId ?? ''} placeholder="Select a club…"
              onChange={(v) => set({ mainClubId: v || null })} />
          )}
          <label className="checkrow" style={{ margin: '8px 0 0' }}>
            <input type="checkbox" checked={independent}
              onChange={(e) => { setIndependent(e.target.checked); if (e.target.checked) set({ mainClubId: null }); }} />
            No club — I am an Independent Athlete
          </label>
        </Field>
        <Field label="Region" hint={outsideUs ? 'Set because they train outside the US.' : `Derived from ${stateLabel.toLowerCase()}.`}>
          <input type="text" disabled value={outsideUs ? 'Outside US' : draft.state ? STATE_REGIONS[draft.state] ?? 'Other' : '—'} />
        </Field>
        <Field label="Other clubs" hint="Clubs they also belong to.">
          <Combo
            options={altClubOptions.filter((c) => c.value !== (draft.mainClubId ?? '') && !draft.altClubIds.includes(c.value))}
            value={null}
            onChange={(v) => set({ altClubIds: [...draft.altClubIds, v] })}
            placeholder="Add another club…"
          />
          {draft.altClubIds.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
              {draft.altClubIds.map((cid) => (
                <span key={cid} className="badge info" style={{ gap: 8 }}>
                  {db.clubs.find((c) => c.id === cid)?.name ?? cid}
                  <button type="button" title="Remove club"
                    onClick={() => set({ altClubIds: draft.altClubIds.filter((x) => x !== cid) })}
                    style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0 }}>✕</button>
                </span>
              ))}
            </div>
          )}
        </Field>
      </div>
      {!isCoach && (
        <div style={{ marginTop: 8 }}>
          <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink-soft)', marginBottom: 6, marginTop: 0 }}>Competition levels</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {DISCIPLINES.map((d) => (
              <Field key={d} label={`${d} level`}>
                <select className="input" value={draft.levels[d] ?? ''} onChange={(e) => set({ levels: { ...draft.levels, [d]: e.target.value || undefined } })}>
                  <option value="">Not competing {d}</option>
                  {db.levels.filter((l) => l.discipline === d).sort((a, b) => a.order - b.order).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </Field>
            ))}
          </div>
        </div>
      )}

      <h3 className="card-title" style={{ marginTop: 8 }}>Event-day</h3>
      <div className="grid cols-2">
        <Field label="Emergency contact"><input type="text" value={draft.emergency.contact} onChange={(e) => set({ emergency: { ...draft.emergency, contact: e.target.value } })} /></Field>
        <Field label="Relation"><input type="text" value={draft.emergency.relation} onChange={(e) => set({ emergency: { ...draft.emergency, relation: e.target.value } })} /></Field>
        <Field label="Emergency phone">
          <input
            type="tel"
            value={draft.emergency.phone}
            onChange={(e) => set({ emergency: { ...draft.emergency, phone: formatPhone(e.target.value) } })}
            placeholder="(555) 123-4567"
          />
          {emergPhoneInvalid && <div style={{ fontSize: 12, color: 'var(--coral-text)', marginTop: 4 }}>Must be a 10-digit US phone number.</div>}
        </Field>
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
