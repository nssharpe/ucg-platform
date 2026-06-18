import { useState } from 'react';
import { useDB, mutate } from '../lib/store';
import { Combo, Field, Modal, useToast } from './ui';
import { STATE_REGIONS } from '../lib/types';
import type { Club } from '../lib/types';
import { pushClub } from '../lib/supabase';

/** Next seed-style id: max numeric suffix + 1 (e.g. club-9 after club-8). */
export function nextId(items: { id: string }[], prefix: string): string {
  const max = items.reduce((m, x) => {
    const n = x.id.startsWith(prefix) ? +x.id.slice(prefix.length) : NaN;
    return Number.isFinite(n) ? Math.max(m, n) : m;
  }, 0);
  return `${prefix}${max + 1}`;
}

const BLANK: Omit<Club, 'id'> = {
  name: '', shortName: '', state: '', region: 'Other',
  managerIds: [], email: '', allowClubPay: true, access: 'open',
};

/** Create (club undefined) or edit a club in a modal. */
export function ClubForm({ club, onClose }: { club?: Club; onClose: () => void }) {
  const db = useDB();
  const toast = useToast();
  const [draft, setDraft] = useState<Omit<Club, 'id'>>(club ? { ...club } : BLANK);
  const set = (patch: Partial<Club>) => setDraft({ ...draft, ...patch });
  const region = STATE_REGIONS[draft.state] ?? 'Other';
  const states = Object.keys(STATE_REGIONS);
  const valid = draft.name.trim() && draft.shortName.trim() && draft.state;

  const save = () => {
    if (!valid) { toast('Name, short name, and state are required.'); return; }
    const data = { ...draft, name: draft.name.trim(), shortName: draft.shortName.trim(), region };
    mutate((d) => {
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
        <Field label="Payments">
          <label className="checkrow">
            <input type="checkbox" checked={draft.allowClubPay} onChange={(e) => set({ allowClubPay: e.target.checked })} />
            Athletes may push membership fees to the club cart
          </label>
        </Field>
      </div>
      <Field label="Club managers" hint="Managers can edit the roster, register for meets, and pay the club cart.">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 18px', maxHeight: 160, overflowY: 'auto' }}>
          {/* Keep the list manageable: coaches, this club's roster, and anyone already selected */}
          {db.people
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
