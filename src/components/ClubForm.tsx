import { useState } from 'react';
import { mutate } from '../lib/store';
import { Combo, Field, Modal } from './ui';
import { useToast } from './ui-hooks';
import { CLUB_ACCESS_LABELS, STATE_REGIONS } from '../lib/types';
import type { Club, ClubAccess } from '../lib/types';
import { pushClub } from '../lib/supabase';
import { nextId } from '../lib/ids';
import { useAdminPeople } from '../lib/people-admin-slice';

const BLANK: Omit<Club, 'id'> = {
  name: '', shortName: '', state: '', region: 'Other',
  managerIds: [], email: '', allowClubPay: true, access: 'open', isLeagueHost: false,
};

const ACCESS_ENTRIES = Object.entries(CLUB_ACCESS_LABELS) as [ClubAccess, string][];

/** Create (club undefined) or edit a club in a modal. */
export function ClubForm({ club, onClose }: { club?: Club; onClose: () => void }) {
  const toast = useToast();
  // Phase 4 (data-layer-scale.md): db.people at boot no longer covers the
  // whole league — the manager picker below deliberately includes "any
  // coach in the whole system" (not just this club's roster), which was
  // already a league-wide need even before this change, so this always
  // fetches league-wide regardless of whether the caller is an admin or a
  // real club manager editing their own club.
  const { rows: adminPeopleRows } = useAdminPeople();
  const [draft, setDraft] = useState<Omit<Club, 'id'>>(club ? { ...club } : BLANK);
  const set = (patch: Partial<Club>) => setDraft({ ...draft, ...patch });
  const region = STATE_REGIONS[draft.state] ?? 'Other';
  const states = Object.keys(STATE_REGIONS);
  const valid = draft.name.trim() && draft.shortName.trim() && draft.state;

  const save = () => {
    if (!valid) { toast('Name, short name, and state are required.'); return; }
    const data = { ...draft, name: draft.name.trim(), shortName: draft.shortName.trim(), region };
    const applied = mutate((d) => {
      if (club) {
        const i = d.clubs.findIndex((c) => c.id === club.id);
        d.clubs[i] = { ...d.clubs[i], ...data };
        pushClub(d.clubs[i]);
      } else {
        const created = { id: nextId(d.clubs, 'club-'), ...data };
        d.clubs.push(created);
        pushClub(created);
      }
    });
    if (!applied) return; // offline read-only gate — no false success toast
    toast(club ? 'Club updated.' : 'Club created.');
    onClose();
  };

  return (
    <Modal title={club ? `Edit ${club.shortName}` : 'New club'} onClose={onClose}>
      <div className="grid cols-2">
        <Field label="Club name"><input type="text" value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="University of … Gymnastics Club" /></Field>
        <Field label="Short name"><input type="text" value={draft.shortName} onChange={(e) => set({ shortName: e.target.value })} placeholder="e.g. Minnesota" /></Field>
        <Field label="State">
          <Combo options={states.map((s) => ({ value: s, label: s, sub: STATE_REGIONS[s] }))} value={draft.state || null} onChange={(v) => set({ state: v })} />
        </Field>
        <Field label="Region" hint="Derived from state."><input type="text" disabled value={draft.state ? region : '—'} /></Field>
        <Field label="Club email"><input type="email" value={draft.email} onChange={(e) => set({ email: e.target.value })} placeholder="club@clubs.ucg.org" /></Field>
        <Field label="Membership eligibility" hint="Who may register with or compete for this club.">
          <select className="input" value={draft.access} onChange={(e) => set({ access: e.target.value as ClubAccess })}>
            {ACCESS_ENTRIES.map(([val, label]) => <option key={val} value={val}>{label}</option>)}
          </select>
        </Field>
        <Field label="Payments">
          <label className="checkrow">
            <input type="checkbox" checked={draft.allowClubPay} onChange={(e) => set({ allowClubPay: e.target.checked })} />
            Athletes may push membership fees to the club cart
          </label>
        </Field>
        <Field label="Refunds" hint="Refunds are only offered for events hosted by this club.">
          <label className="checkrow">
            <input type="checkbox" checked={!!draft.isLeagueHost} onChange={(e) => set({ isLeagueHost: e.target.checked })} />
            Is league host club (UCG - Main)
          </label>
        </Field>
      </div>
      <Field label="Club managers" hint="Managers can edit the roster, register for events, and pay the club cart.">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 18px', maxHeight: 160, overflowY: 'auto' }}>
          {/* Keep the list manageable: coaches, this club's roster, and anyone already selected */}
          {adminPeopleRows
            .filter((p) => draft.managerIds.includes(p.id) || p.kind === 'coach' || (club && p.mainClubId === club.id))
            .sort((a, b) => a.lastName.localeCompare(b.lastName))
            .map((p) => (
              <label className="checkrow" key={p.id}>
                <input
                  type="checkbox"
                  checked={draft.managerIds.includes(p.id)}
                  onChange={(e) => set({ managerIds: e.target.checked ? [...draft.managerIds, p.id] : draft.managerIds.filter((x) => x !== p.id) })}
                />
                {p.firstName} {p.lastName} {p.kind === 'coach' ? '(coach)' : ''}
              </label>
            ))}
        </div>
      </Field>
      <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
        <button className="btn primary" disabled={!valid} onClick={save}>{club ? 'Save changes' : 'Create club'}</button>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}
