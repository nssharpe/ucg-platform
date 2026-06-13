import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useDB, mutate } from '../lib/store';
import { useCapabilities } from '../lib/capabilities';
import { Combo, Field, Modal, useToast, Badge } from '../components/ui';
import { SHIRT_SIZES, DIETARY_OPTIONS, STATE_REGIONS, DISCIPLINES } from '../lib/types';
import type { Athlete, ClubRequest, Gender, Region } from '../lib/types';
import { pushClubRequest, pushMembership, pushPerson } from '../lib/supabase';

export function Profile({ adminView = false }: { adminView?: boolean }) {
  const db = useDB();
  const params = useParams();
  const toast = useToast();
  const caps = useCapabilities();
  const personId = adminView ? params.personId! : caps.personId;
  const person = db.people.find((p) => p.id === personId);
  const [draft, setDraft] = useState<Athlete | null>(null);
  const [clubReqOpen, setClubReqOpen] = useState(false);
  if (!person) return <p>Person not found.</p>;
  const pid: string = person.id; // narrowed (personId may be null before this guard)
  const p = draft ?? person;
  const set = (patch: Partial<Athlete>) => setDraft({ ...p, ...patch });
  const clubOptions = db.clubs.map((c) => ({ value: c.id, label: c.name, sub: `${c.state} · ${c.region}` }));
  const states = Object.keys(STATE_REGIONS);

  const save = () => {
    mutate((d) => {
      const i = d.people.findIndex((x) => x.id === pid);
      d.people[i] = { ...p };
      pushPerson(d.people[i]);
    });
    setDraft(null);
    toast('Profile saved.');
  };

  return (
    <div style={{ maxWidth: 760 }}>
      <h1 className="page-title display">{adminView ? `${p.firstName} ${p.lastName}` : 'My profile'}</h1>
      <p className="page-sub">
        {adminView
          ? <>Unique member URL: <code>#/admin/members/{p.id}</code> · {p.kind} · {p.email}</>
          : 'Your competition levels, contact info, and meet-day details. Autofills each season — confirm before competing.'}
      </p>

      {adminView && (
        <div className="card card-pad" style={{ marginBottom: 16, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <AdminMembershipControls personId={pid} />
        </div>
      )}

      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <h3 className="card-title">Identity</h3>
        <div className="grid cols-2">
          <Field label="First name"><input type="text" value={p.firstName} onChange={(e) => set({ firstName: e.target.value })} /></Field>
          <Field label="Last name"><input type="text" value={p.lastName} onChange={(e) => set({ lastName: e.target.value })} /></Field>
          <Field label="Date of birth" hint="Athletes must be 15+, coaches 18+."><input type="date" value={p.dob} onChange={(e) => set({ dob: e.target.value })} /></Field>
          <Field label="Gender">
            <select className="input" value={p.gender} onChange={(e) => set({ gender: e.target.value as Gender })}>
              {['Male', 'Female', 'Non-binary', 'Genderfluid', 'Agender', 'Other'].map((g) => <option key={g}>{g}</option>)}
            </select>
          </Field>
          {p.gender !== 'Male' && p.gender !== 'Female' && (
            <>
              {DISCIPLINES.map((d) => (
                <Field key={d} label={`${d} placement category`} tip="Determines which division you place in for this discipline">
                  <select className="input" value={p.placement?.[d] ?? 'women+'} onChange={(e) => set({ placement: { ...p.placement, [d]: e.target.value as 'men+' | 'women+' } })}>
                    <option value="women+">women+</option>
                    <option value="men+">men+</option>
                  </select>
                </Field>
              ))}
            </>
          )}
          <Field label="Undergrad graduation year" hint="Enter 1900 if you do not have a past or future undergraduate graduation year.">
            <input type="number" value={p.gradYear} onChange={(e) => set({ gradYear: +e.target.value })} />
          </Field>
          <Field label="Student status" hint="Full-time student for ≥1 semester this season (Jul–Jun)? Grad students may pick either.">
            <select className="input" value={p.studentStatus} onChange={(e) => set({ studentStatus: e.target.value as 'Student' | 'Non-Student' })}>
              <option>Student</option><option>Non-Student</option>
            </select>
          </Field>
          <Field label="T-shirt size">
            <select className="input" value={p.shirt} onChange={(e) => set({ shirt: e.target.value })}>
              {SHIRT_SIZES.map((s) => <option key={s}>{s}</option>)}
            </select>
          </Field>
          <Field label="Training state">
            <Combo options={states.map((s) => ({ value: s, label: s, sub: STATE_REGIONS[s] }))} value={p.state} onChange={(v) => set({ state: v })} />
          </Field>
          <Field label="Phone"><input type="tel" value={p.phone} onChange={(e) => set({ phone: e.target.value })} /></Field>
        </div>
      </div>

      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <h3 className="card-title">Competition</h3>
        <div className="grid cols-2">
          <Field label="Main club" hint="The only club that can pay your membership fee.">
            <Combo options={clubOptions} value={p.mainClubId} onChange={(v) => set({ mainClubId: v })} />
          </Field>
          <Field label="Region" hint="Derived from training state.">
            <input type="text" disabled value={STATE_REGIONS[p.state] ?? 'Other'} />
          </Field>
          <Field label="Other clubs" hint="Clubs you also belong to — choose which one you compete for per meet at registration.">
            <Combo
              options={clubOptions.filter((c) => c.value !== p.mainClubId && !p.altClubIds.includes(c.value))}
              value={null}
              onChange={(v) => set({ altClubIds: [...p.altClubIds, v] })}
              placeholder="Add another club…"
            />
            {p.altClubIds.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                {p.altClubIds.map((cid) => (
                  <span key={cid} className="badge info" style={{ gap: 8 }}>
                    {db.clubs.find((c) => c.id === cid)?.shortName ?? cid}
                    <button type="button" title="Remove club"
                      onClick={() => set({ altClubIds: p.altClubIds.filter((x) => x !== cid) })}
                      style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0 }}>✕</button>
                  </span>
                ))}
              </div>
            )}
            {!adminView && (
              <button type="button" className="btn ghost small" style={{ marginTop: 8 }} onClick={() => setClubReqOpen(true)}>
                Don't see your club? Request a new one
              </button>
            )}
          </Field>
          {DISCIPLINES.map((d) => (
            <Field key={d} label={`${d} level`}>
              <select className="input" value={p.levels[d] ?? ''} onChange={(e) => set({ levels: { ...p.levels, [d]: e.target.value || undefined } })}>
                <option value="">Not competing {d}</option>
                {db.levels.filter((l) => l.discipline === d).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </Field>
          ))}
        </div>
      </div>

      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <h3 className="card-title">Meet-day</h3>
        <div className="grid cols-2">
          <Field label="Emergency contact"><input type="text" value={p.emergency.contact} onChange={(e) => set({ emergency: { ...p.emergency, contact: e.target.value } })} /></Field>
          <Field label="Relation"><input type="text" value={p.emergency.relation} onChange={(e) => set({ emergency: { ...p.emergency, relation: e.target.value } })} /></Field>
          <Field label="Emergency phone"><input type="tel" value={p.emergency.phone} onChange={(e) => set({ emergency: { ...p.emergency, phone: e.target.value } })} /></Field>
        </div>
        <Field label="Dietary restrictions">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 18px' }}>
            {DIETARY_OPTIONS.map((opt) => (
              <label className="checkrow" key={opt}>
                <input
                  type="checkbox"
                  checked={p.dietary.includes(opt)}
                  onChange={(e) => set({ dietary: e.target.checked ? [...p.dietary, opt] : p.dietary.filter((x) => x !== opt) })}
                />
                {opt}
              </label>
            ))}
          </div>
        </Field>
        <Field label="Dietary notes"><textarea rows={2} value={p.dietaryNotes} onChange={(e) => set({ dietaryNotes: e.target.value })} /></Field>
      </div>

      {p.achievements.length > 0 && (
        <div className="card card-pad" style={{ marginBottom: 16 }}>
          <h3 className="card-title">Achievements</h3>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {p.achievements.map((a) => <Badge key={a} tone="info">🏅 {a}</Badge>)}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, position: 'sticky', bottom: 16 }}>
        <button className="btn primary" disabled={!draft} onClick={save}>Save changes</button>
        {draft && <button className="btn ghost" onClick={() => setDraft(null)}>Discard</button>}
        {draft && <span style={{ alignSelf: 'center', fontSize: 13, color: 'var(--coral-600)', fontWeight: 600 }}>Unsaved changes</span>}
      </div>

      {clubReqOpen && <ClubRequestForm requesterPersonId={pid} onClose={() => setClubReqOpen(false)} />}
    </div>
  );
}

/** Member-facing "request a new club" form. Admins review the queue in AdminClubs.
 *  Email to newclubinquiries@naigc.org is deferred (see CLAUDE.md). */
function ClubRequestForm({ requesterPersonId, onClose }: { requesterPersonId: string; onClose: () => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [shortName, setShortName] = useState('');
  const [state, setState] = useState('');
  const [note, setNote] = useState('');
  const states = Object.keys(STATE_REGIONS);

  const submit = () => {
    if (!name.trim()) return;
    const req: ClubRequest = {
      id: crypto.randomUUID(),
      requesterPersonId,
      proposedName: name.trim(),
      shortName: shortName.trim(),
      state,
      region: (STATE_REGIONS[state] ?? '') as Region | '',
      note: note.trim(),
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    mutate((d) => { d.clubRequests.push(req); pushClubRequest(req); });
    toast('Request submitted — a UCG admin will review it.');
    onClose();
  };

  return (
    <Modal title="Request a new club" onClose={onClose}>
      <Field label="Club name"><input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Rocky Mountain Gymnastics Club" autoFocus /></Field>
      <Field label="Short name" hint="Abbreviation shown on results."><input type="text" value={shortName} onChange={(e) => setShortName(e.target.value)} placeholder="RMGC" /></Field>
      <Field label="State">
        <select className="input" value={state} onChange={(e) => setState(e.target.value)}>
          <option value="">Select a state…</option>
          {states.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </Field>
      <Field label="Anything else?" hint="Region is set automatically from the state."><textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
        <button className="btn primary" disabled={!name.trim()} onClick={submit}>Submit request</button>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

function AdminMembershipControls({ personId }: { personId: string }) {
  const db = useDB();
  const toast = useToast();
  const person = db.people.find((x) => x.id === personId)!;
  return (
    <>
      {db.seasons.map((s) => {
        const m = person.memberships.find((x) => x.seasonId === s.id);
        return (
          <div key={s.id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <strong style={{ fontSize: 13 }}>{s.name}:</strong>
            {m?.status === 'active' ? <Badge tone="ok">Active{m.activatedByAdmin ? ' (admin)' : ''}</Badge>
              : m?.status === 'pending-club-payment' ? <Badge tone="warn">Pending club</Badge>
              : <Badge tone="err">None</Badge>}
            {m?.waiverSignedAt && <span data-tip={`Signed by ${m.waiverSignedBy} · ${m.waiverSignedAt.slice(0, 10)}`} style={{ fontSize: 12, cursor: 'help' }}>📝</span>}
            <button
              className="btn small ghost"
              onClick={() => {
                mutate((d) => {
                  const p = d.people.find((x) => x.id === personId)!;
                  let em = p.memberships.find((x) => x.seasonId === s.id);
                  if (em?.status === 'active') {
                    em.status = 'none';
                  } else if (em) {
                    em.status = 'active'; em.activatedByAdmin = true;
                  } else {
                    em = { seasonId: s.id, status: 'active', waiverSignedAt: null, waiverSignedBy: null, paidVia: 'comp', activatedByAdmin: true };
                    p.memberships.push(em);
                  }
                  pushMembership(p.id, em);
                });
                toast(`Membership ${m?.status === 'active' ? 'deactivated' : 'activated'} for ${s.name}.`);
              }}
            >
              {m?.status === 'active' ? 'Deactivate' : 'Activate'}
            </button>
          </div>
        );
      })}
      <button className="btn small" onClick={() => toast(`Waiver signing link emailed to ${person.email}. You'll be notified when signed.`)}>✉ Email waiver</button>
    </>
  );
}
