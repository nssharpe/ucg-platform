import { useMemo, useState } from 'react';
import { useDB, mutate } from '../lib/store';
import { useCapabilities } from '../lib/capabilities';
import { Badge, Combo, Field, Modal, Tabs } from '../components/ui';
import { useToast } from '../components/ui-hooks';
import { pushRegistration, pushCart } from '../lib/supabase';
import { fmtMoney } from '../lib/scoring';
import type { Club, Meet, Registration } from '../lib/types';

const today = () => new Date().toISOString().slice(0, 10);

/** "My Registrations" (MY UCG): all events this athlete is/was registered for,
 *  split into Upcoming / Past, searchable, expandable, with an option to change
 *  which affiliated club they're registered with for an upcoming competition. */
export function MyRegistrations() {
  const caps = useCapabilities();
  if (!caps.person) {
    return (
      <div className="card card-pad" style={{ maxWidth: 520 }}>
        <h2 className="display" style={{ fontSize: 22 }}>Sign in to view your registrations</h2>
      </div>
    );
  }
  return <MyRegistrationsInner personId={caps.person.id} />;
}

function MyRegistrationsInner({ personId }: { personId: string }) {
  const db = useDB();
  const toast = useToast();
  const [tab, setTab] = useState<'upcoming' | 'past'>('upcoming');
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editingMeetId, setEditingMeetId] = useState<string | null>(null);

  const lvlName = (id?: string) => db.levels.find((l) => l.id === id)?.name ?? '—';
  const nameOf = (id: string) => {
    const p = db.people.find((x) => x.id === id);
    return p ? `${p.firstName} ${p.lastName}` : 'partner';
  };

  // Group this athlete's (non-refunded) registrations by meet.
  const byMeet = useMemo(() => {
    const mine = db.registrations.filter((r) => r.athleteId === personId && !r.refunded);
    const groups = new Map<string, Registration[]>();
    for (const r of mine) {
      const arr = groups.get(r.meetId) ?? [];
      arr.push(r);
      groups.set(r.meetId, arr);
    }
    return [...groups.entries()]
      .map(([meetId, regs]) => ({ meet: db.meets.find((m) => m.id === meetId), regs }))
      .filter((g): g is { meet: NonNullable<typeof g.meet>; regs: Registration[] } => !!g.meet)
      .sort((a, b) => b.meet.startDate.localeCompare(a.meet.startDate));
  }, [db.registrations, db.meets, personId]);

  const t = today();
  const lq = q.trim().toLowerCase();
  const filtered = byMeet
    .filter((g) => (tab === 'upcoming' ? g.meet.endDate >= t : g.meet.endDate < t))
    .filter((g) => !lq || g.meet.name.toLowerCase().includes(lq) || g.meet.city.toLowerCase().includes(lq));

  // Clubs this athlete is affiliated with (main + alt) — for the club switch.
  const me = db.people.find((p) => p.id === personId);
  const affiliatedClubIds = me ? [me.mainClubId, ...(me.altClubIds ?? [])].filter((x): x is string => !!x) : [];
  const affiliatedClubs = db.clubs.filter((c) => affiliatedClubIds.includes(c.id));

  // A meet's change fee is live once its start date has passed.
  const changeFeeApplies = (meet: Meet) => !!(meet.changeFee && new Date() >= new Date(meet.changeFee.startsAt));

  // Label used for a meet's change fee in the athlete's cart — also how we detect
  // that a change fee for this meet is already pending checkout.
  const changeFeeLabel = (meetName: string) => `${meetName} change fee`;
  const changeFeePending = (meet: Meet) =>
    (db.carts[personId] ?? []).some((c) => c.kind === 'meet-entry' && c.label.startsWith(changeFeeLabel(meet.name)));

  const changeClub = (meet: Meet, newClubId: string) => {
    const applyFee = changeFeeApplies(meet) && !!meet.changeFee;
    const alreadyPending = changeFeePending(meet);
    mutate((d) => {
      for (const r of d.registrations) {
        if (r.meetId === meet.id && r.athleteId === personId && !r.refunded) {
          r.clubId = newClubId;
          pushRegistration(r, r.sessionId);
        }
      }
      if (applyFee && meet.changeFee && !alreadyPending) {
        const cart = d.carts[personId] ?? (d.carts[personId] = []);
        const clubName = d.clubs.find((c) => c.id === newClubId)?.shortName ?? 'new club';
        cart.push({
          id: `ci-change-${Date.now()}`,
          label: `${changeFeeLabel(meet.name)} — club switch to ${clubName}`,
          amount: meet.changeFee.amount, kind: 'meet-entry', refUserId: personId,
        });
        pushCart(personId, cart, false);
      }
    });
    toast(applyFee
      ? `Club updated. A ${fmtMoney(meet.changeFee!.amount)} change fee was added to your cart — pay it to finalize.`
      : 'Updated the club for this competition.');
    setEditingMeetId(null);
  };

  return (
    <div style={{ maxWidth: 820 }}>
      <h1 className="page-title display">My Registrations</h1>
      <p className="page-sub">Every event you’re registered for. Change which club you compete for on upcoming meets.</p>

      <Tabs
        tabs={[{ id: 'upcoming' as const, label: 'Upcoming' }, { id: 'past' as const, label: 'Past' }]}
        active={tab}
        onChange={(id) => { setTab(id); setExpanded(null); }}
      />

      <input
        type="search" className="input" placeholder="Search by meet or city…"
        value={q} onChange={(e) => setQ(e.target.value)}
        style={{ maxWidth: 300, margin: '12px 0' }}
      />

      {filtered.length === 0 ? (
        <p style={{ color: 'var(--ink-soft)' }}>No {tab} registrations.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {filtered.map(({ meet, regs }) => {
            const isOpen = expanded === meet.id;
            const club = db.clubs.find((c) => c.id === regs[0]?.clubId);
            const regClosed = meet.regCloses < t;
            return (
              <div key={meet.id} className="card card-pad">
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, cursor: 'pointer', flexWrap: 'wrap' }}
                  onClick={() => setExpanded(isOpen ? null : meet.id)}>
                  <strong style={{ fontSize: 15 }}>{meet.name}</strong>
                  <span style={{ color: 'var(--ink-soft)', fontSize: 13 }}>
                    {meet.startDate}{meet.endDate !== meet.startDate ? `–${meet.endDate}` : ''} · {meet.city}, {meet.state}
                  </span>
                  {club && <Badge tone="navy">{club.shortName || club.name}</Badge>}
                  <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 10, alignItems: 'center' }}>
                    {isOpen && tab === 'upcoming' && affiliatedClubs.length > 1 && (
                      <button
                        className="btn ghost small"
                        onClick={(e) => { e.stopPropagation(); setEditingMeetId(meet.id); }}
                      >
                        Edit
                      </button>
                    )}
                    <span style={{ color: 'var(--accent)', fontSize: 13 }}>{isOpen ? 'Hide' : 'Details'}</span>
                  </span>
                </div>

                {isOpen && (
                  <div style={{ marginTop: 12, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
                    <div style={{ fontSize: 13, color: 'var(--ink-soft)', marginBottom: 8 }}>
                      Status: {meet.status} · Registration closes {meet.regCloses}
                    </div>
                    <table className="tbl" style={{ marginBottom: 12 }}>
                      <tbody>
                        {regs.map((r) => {
                          const base = r.events.join(', ');
                          const evts = r.events.includes('SY') && r.partnerAthleteId
                            ? `${base} (synchro w/ ${nameOf(r.partnerAthleteId)})` : base;
                          return (
                            <tr key={r.id}>
                              <td>{r.discipline === 'TNT' ? 'T&T' : r.discipline}</td>
                              <td>{lvlName(r.levelId)}</td>
                              <td>{evts}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>

                    {tab === 'upcoming' && (
                      changeFeePending(meet) ? (
                        <div className="card card-pad" style={{ borderLeft: '4px solid var(--warn-500, #d97706)', padding: '8px 12px', fontSize: 13 }}>
                          ⏳ Changes are pending checkout — a {fmtMoney(meet.changeFee?.amount ?? 0)} change fee is in your{' '}
                          <a href="#/cart">cart</a>. Your registration updates fully once it’s paid.
                        </div>
                      ) : affiliatedClubs.length > 1 ? (
                        <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', margin: 0 }}>
                          Use <strong>Edit</strong> above to change which club you compete for{regClosed ? ' (registration is closed — changes may be limited)' : ''}.
                        </p>
                      ) : (
                        <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', margin: 0 }}>
                          To compete for a different club, add it as an affiliated club on your profile first.
                        </p>
                      )
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {editingMeetId && (() => {
        const meet = db.meets.find((m) => m.id === editingMeetId);
        if (!meet) return null;
        const currentClubId = db.registrations.find((r) => r.meetId === meet.id && r.athleteId === personId && !r.refunded)?.clubId ?? null;
        return (
          <EditRegistrationModal
            meet={meet}
            clubs={affiliatedClubs}
            currentClubId={currentClubId}
            changeFee={changeFeeApplies(meet) ? meet.changeFee ?? null : null}
            feeAlreadyPending={changeFeePending(meet)}
            onClose={() => setEditingMeetId(null)}
            onSave={(newClubId) => changeClub(meet, newClubId)}
          />
        );
      })()}
    </div>
  );
}

// ---- EditRegistrationModal --------------------------------------------------
// Lets an athlete change which affiliated club they compete for. When the meet's
// change fee is live, saving adds that fee to the athlete's cart.
function EditRegistrationModal({ meet, clubs, currentClubId, changeFee, feeAlreadyPending, onClose, onSave }: {
  meet: Meet; clubs: Club[]; currentClubId: string | null;
  changeFee: { amount: number; startsAt: string } | null; feeAlreadyPending: boolean;
  onClose: () => void; onSave: (newClubId: string) => void;
}) {
  const [clubId, setClubId] = useState<string | null>(currentClubId);
  const changed = clubId !== null && clubId !== currentClubId;
  const willCharge = changed && !!changeFee && !feeAlreadyPending;

  return (
    <Modal title={`Edit registration — ${meet.name}`} onClose={onClose}>
      <Field label="Club I’m competing for">
        <Combo
          options={clubs.map((c) => ({ value: c.id, label: c.name, sub: `${c.state} · ${c.region}` }))}
          value={clubId}
          onChange={setClubId}
        />
      </Field>
      {willCharge && (
        <div className="card card-pad" style={{ borderLeft: '4px solid var(--warn-500, #d97706)', padding: '8px 12px', fontSize: 13, marginTop: 10 }}>
          A <strong>{fmtMoney(changeFee!.amount)}</strong> change fee applies to this meet. Saving adds it to your cart;
          the change finalizes once you check out.
        </div>
      )}
      <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
        <button className="btn primary" disabled={!changed} onClick={() => onSave(clubId!)}>
          {willCharge ? 'Save & add change to cart' : 'Save change'}
        </button>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

export default MyRegistrations;
