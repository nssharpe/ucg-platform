import { useMemo, useState } from 'react';
import { useDB, mutate } from '../lib/store';
import { useCapabilities } from '../lib/capabilities';
import { Badge, Combo, Field, Modal, Tabs } from '../components/ui';
import { useToast } from '../components/ui-hooks';
import { pushRegistration, pushCart } from '../lib/supabase';
import { RegistrationEditor } from '../components/RegistrationEditor';
import { newRegistrationEntryTotal, registrationChangeFee } from '../lib/pricing';
import { fmtMoney } from '../lib/scoring';
import type { Athlete, Club, Level, Event, Registration, Season } from '../lib/types';

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
  const [editingEventId, setEditingEventId] = useState<string | null>(null);

  const lvlName = (id?: string) => db.levels.find((l) => l.id === id)?.name ?? '—';
  const nameOf = (id: string) => {
    const p = db.people.find((x) => x.id === id);
    return p ? `${p.firstName} ${p.lastName}` : 'partner';
  };

  // Group this athlete's (non-refunded) registrations by event.
  const byEvent = useMemo(() => {
    const mine = db.registrations.filter((r) => r.athleteId === personId && !r.refunded);
    const groups = new Map<string, Registration[]>();
    for (const r of mine) {
      const arr = groups.get(r.eventId) ?? [];
      arr.push(r);
      groups.set(r.eventId, arr);
    }
    return [...groups.entries()]
      .map(([eventId, regs]) => ({ event: db.events.find((m) => m.id === eventId), regs }))
      .filter((g): g is { event: NonNullable<typeof g.event>; regs: Registration[] } => !!g.event)
      .sort((a, b) => b.event.startDate.localeCompare(a.event.startDate));
  }, [db.registrations, db.events, personId]);

  const t = today();
  const lq = q.trim().toLowerCase();
  const filtered = byEvent
    .filter((g) => (tab === 'upcoming' ? g.event.endDate >= t : g.event.endDate < t))
    .filter((g) => !lq || g.event.name.toLowerCase().includes(lq) || g.event.city.toLowerCase().includes(lq));

  // Clubs this athlete is affiliated with (main + alt) — for the club switch.
  const me = db.people.find((p) => p.id === personId);
  const affiliatedClubIds = me ? [me.mainClubId, ...(me.altClubIds ?? [])].filter((x): x is string => !!x) : [];
  const affiliatedClubs = db.clubs.filter((c) => affiliatedClubIds.includes(c.id));

  // A event's change fee is live once its start date has passed.
  const changeFeeApplies = (event: Event) => !!(event.changeFee && new Date() >= new Date(event.changeFee.startsAt));

  // Label used for an event's change fee in the athlete's cart — also how we detect
  // that a change fee for this event is already pending checkout.
  const changeFeeLabel = (eventName: string) => `${eventName} change fee`;
  const changeFeePending = (event: Event) =>
    (db.carts[personId] ?? []).some((c) => c.kind === 'meet-entry' && c.label.startsWith(changeFeeLabel(event.name)));

  const season = db.seasons.find((s) => s.current)!;

  // Persist the member's own registration edits (6a). Modeled on Club.tsx
  // saveRegs + addToCart, but TARGETS THE MEMBER'S OWN CART (carts[personId],
  // non-club) and uses the club selected in the modal. A event's change fee is
  // routed to the member's personal cart, where the Stripe webhook (after the
  // CartCheckout payment) flips the exact linked regs to paid via refRegIds.
  //
  // *** CRITICAL self-removal divergence from Club.tsx ***: the member side
  // NEVER deletes a registration. Where Club.tsx deletes regs for disciplines
  // the editor deselected, here we RETAIN the reg and blank it (apparatus: [],
  // no apparatusLevels / partner) instead. Deletion only ever happens via a refund
  // (out of scope) — so a member can't make their entry vanish on their own.
  const saveRegs = (event: Event, selectedClubId: string, newRegs: Registration[]) => {
    const applyFee = changeFeeApplies(event);
    const alreadyPending = changeFeePending(event);
    mutate((d) => {
      const existingForAthlete = d.registrations.filter(
        (r) => r.eventId === event.id && r.athleteId === personId && !r.refunded,
      );
      const editingExisting = existingForAthlete.length > 0;
      const newDiscSet = new Set(newRegs.map((r) => r.discipline));

      // Retain (do NOT delete) deselected disciplines: blank them out instead.
      for (const old of existingForAthlete) {
        if (!newDiscSet.has(old.discipline)) {
          old.apparatus = [];
          delete old.apparatusLevels;
          delete old.partnerAthleteId;
          old.clubId = selectedClubId;
          // squad_id is host-managed (squads table); never write a non-squad id here.
          // Passing old.sessionId set squad_id to a session id → registrations_squad_id_fkey.
          pushRegistration(old);
        }
      }

      // Chargeable edit (fee live, editing an existing reg, non-host fee).
      const changeFee = applyFee && editingExisting
        ? registrationChangeFee(event, { competingClubId: selectedClubId })
        : 0;

      // Brand-new entry total for disciplines with no prior reg (host = $0).
      const priorDisciplineCount = existingForAthlete.filter((r) => r.apparatus.length > 0).length;
      const entryTotal = !editingExisting
        ? newRegistrationEntryTotal(event, {
            competingClubId: selectedClubId,
            priorDisciplineCount,
            newDisciplineCount: newRegs.length,
          })
        : 0;

      // Upsert each returned reg. A chargeable edit flips a previously-PAID reg
      // back to "Updated pending purchase"; otherwise preserve prior payment
      // state. Brand-new regs: host-club $0 ⇒ paid immediately, else pending.
      const priorById = new Map(existingForAthlete.map((r) => [r.id, r]));
      for (const reg of newRegs) {
        const prior = priorById.get(reg.id);
        if (prior) {
          if (changeFee > 0 && prior.paid) {
            reg.paid = false;
            reg.updatedPending = true;
          } else {
            reg.paid = prior.paid ?? false;
            reg.updatedPending = prior.updatedPending ?? false;
          }
        } else {
          // A newly added discipline is "Registered" only when nothing is owed
          // (host-club $0). If a fee line covers it (a change fee mid-edit, or a
          // brand-new entry total), it stays pending until that line is paid —
          // refRegIds flips it then.
          reg.paid = changeFee === 0 && entryTotal === 0;
          reg.updatedPending = false;
        }
        const idx = d.registrations.findIndex((r) => r.id === reg.id);
        if (idx >= 0) d.registrations[idx] = reg;
        else d.registrations.push(reg);
        pushRegistration(reg);
      }

      // Add the fee/entry line to the MEMBER'S OWN cart, linked to the affected
      // regs via refRegIds so paying flips exactly those to paid.
      if (changeFee > 0 && !alreadyPending) {
        const cart = d.carts[personId] ?? (d.carts[personId] = []);
        cart.push({
          id: `ci-change-${Date.now()}`,
          label: `${changeFeeLabel(event.name)}`,
          amount: changeFee,
          kind: 'meet-entry',
          refUserId: personId,
          refRegIds: newRegs.map((r) => r.id),
          refEventId: event.id,
          refLineType: 'change',
          // Full prior registration row(s) (before this function's edits above),
          // so deleting this cart item later can revert them (Task A).
          priorRegSnapshot: newRegs.map((r) => priorById.get(r.id)).filter((r): r is Registration => !!r),
        });
        pushCart(personId, cart, false);
      } else if (entryTotal > 0) {
        const cart = d.carts[personId] ?? (d.carts[personId] = []);
        cart.push({
          id: `ci-${Date.now()}`,
          label: `${event.name} entry — ${newRegs.map((r) => r.discipline).join('+')}`,
          amount: entryTotal,
          kind: 'meet-entry',
          refUserId: personId,
          refRegIds: newRegs.map((r) => r.id),
          refEventId: event.id,
          refLineType: 'entry',
        });
        pushCart(personId, cart, false);
      }
    });

    const fee = applyFee && existingForEvent(event).length > 0 && !alreadyPending
      ? registrationChangeFee(event, { competingClubId: selectedClubId })
      : 0;
    toast(fee > 0
      ? `Registration updated. A ${fmtMoney(fee)} change fee was added to your cart — pay it to finalize.`
      : 'Registration updated.');
    setEditingEventId(null);
  };

  const existingForEvent = (event: Event) =>
    db.registrations.filter((r) => r.eventId === event.id && r.athleteId === personId && !r.refunded);

  return (
    <div style={{ maxWidth: 820 }}>
      <h1 className="page-title display">My Registrations</h1>
      <p className="page-sub">Every event you’re registered for. Change which club you compete for on upcoming events.</p>

      <Tabs
        tabs={[{ id: 'upcoming' as const, label: 'Upcoming' }, { id: 'past' as const, label: 'Past' }]}
        active={tab}
        onChange={(id) => { setTab(id); setExpanded(null); }}
      />

      <input
        type="search" className="input" placeholder="Search by event or city…"
        value={q} onChange={(e) => setQ(e.target.value)}
        style={{ maxWidth: 300, margin: '12px 0' }}
      />

      {filtered.length === 0 ? (
        <p style={{ color: 'var(--ink-soft)' }}>No {tab} registrations.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {filtered.map(({ event, regs }) => {
            const isOpen = expanded === event.id;
            const club = db.clubs.find((c) => c.id === regs[0]?.clubId);
            const regClosed = event.regCloses < t;
            return (
              <div key={event.id} className="card card-pad">
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, cursor: 'pointer', flexWrap: 'wrap' }}
                  onClick={() => setExpanded(isOpen ? null : event.id)}>
                  <strong style={{ fontSize: 15 }}>{event.name}</strong>
                  <span style={{ color: 'var(--ink-soft)', fontSize: 13 }}>
                    {event.startDate}{event.endDate !== event.startDate ? `–${event.endDate}` : ''} · {event.city}, {event.state}
                  </span>
                  {club && <Badge tone="navy">{club.shortName || club.name}</Badge>}
                  <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 10, alignItems: 'center' }}>
                    {isOpen && tab === 'upcoming' && !regClosed && (
                      <button
                        className="btn ghost small"
                        onClick={(e) => { e.stopPropagation(); setEditingEventId(event.id); }}
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
                      Status: {event.status} · Registration closes {event.regCloses}
                    </div>
                    <table className="tbl" style={{ marginBottom: 12 }}>
                      <tbody>
                        {regs.map((r) => {
                          const base = r.apparatus.join(', ');
                          const evts = r.apparatus.includes('SY') && r.partnerAthleteId
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
                      changeFeePending(event) ? (
                        <div className="card card-pad" style={{ borderLeft: '4px solid var(--warn-500, #d97706)', padding: '8px 12px', fontSize: 13 }}>
                          ⏳ Changes are pending checkout — a {fmtMoney(event.changeFee?.amount ?? 0)} change fee is in your{' '}
                          <a href="#/cart">cart</a>. Your registration updates fully once it’s paid.
                        </div>
                      ) : regClosed ? (
                        <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', margin: 0 }}>
                          Registration is closed for this event — entries can no longer be edited.
                        </p>
                      ) : (
                        <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', margin: 0 }}>
                          Use <strong>Edit</strong> above to change your disciplines, levels, events{affiliatedClubs.length > 1 ? ', or which club you compete for' : ''}.
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

      {editingEventId && me && (() => {
        const event = db.events.find((m) => m.id === editingEventId);
        if (!event) return null;
        const existing = existingForEvent(event);
        const currentClubId = existing[0]?.clubId ?? me.mainClubId ?? affiliatedClubs[0]?.id ?? null;
        if (!currentClubId) return null;
        return (
          <EditRegistrationModal
            event={event}
            me={me}
            clubs={affiliatedClubs}
            currentClubId={currentClubId}
            existing={existing}
            allAthletes={db.people as Athlete[]}
            levels={db.levels}
            season={season}
            changeFeeApplies={changeFeeApplies(event)}
            onClose={() => setEditingEventId(null)}
            onSave={(selectedClubId, regs) => saveRegs(event, selectedClubId, regs)}
          />
        );
      })()}
    </div>
  );
}

// ---- EditRegistrationModal --------------------------------------------------
// Lets a member edit ALL details of their own upcoming registration by reusing
// the shared RegistrationEditor (6a/6b). A club selector is shown only when the
// member has >1 affiliated club; the selected club flows through to the editor
// (its clubId prop is stamped onto every saved reg). `originalClubId` lets a
// club-only switch register as an eligible/chargeable change.
function EditRegistrationModal({
  event, me, clubs, currentClubId, existing, allAthletes, levels, season, changeFeeApplies, onClose, onSave,
}: {
  event: Event; me: Athlete; clubs: Club[]; currentClubId: string;
  existing: Registration[]; allAthletes: Athlete[]; levels: Level[];
  season: Season; changeFeeApplies: boolean;
  onClose: () => void; onSave: (selectedClubId: string, regs: Registration[]) => void;
}) {
  const [clubId, setClubId] = useState<string>(currentClubId);

  return (
    <Modal title={`Edit registration — ${event.name}`} onClose={onClose}>
      {clubs.length > 1 && (
        <Field label="Club I’m competing for">
          <Combo
            options={clubs.map((c) => ({ value: c.id, label: c.name, sub: `${c.state} · ${c.region}` }))}
            value={clubId}
            onChange={(v) => setClubId(v ?? currentClubId)}
          />
        </Field>
      )}
      <RegistrationEditor
        event={event}
        athlete={me}
        clubId={clubId}
        originalClubId={currentClubId}
        existing={existing}
        allAthletes={allAthletes}
        levels={levels}
        season={season}
        changeFeeApplies={changeFeeApplies}
        onSave={(regs) => onSave(clubId, regs)}
        onCancel={onClose}
      />
    </Modal>
  );
}

export default MyRegistrations;
