import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDB, mutate } from '../lib/store';
import { useCapabilities } from '../lib/capabilities';
import { Badge, Combo, Field, Modal, Tabs } from '../components/ui';
import { useToast } from '../components/ui-hooks';
import { pushRegistration, pushCart, syncSynchroPartnerLevelRemote, cancelWaitlistGroup, deleteRegistration } from '../lib/supabase';
import { RegistrationEditor } from '../components/RegistrationEditor';
import {
  newRegistrationEntryTotal, registrationChangeFee, changeIsEligible, syncSynchroPartnerLevel, lateFeeApplies, lateFeeAnchor,
  initialCampSurveyDraft, campSurveyValid, campSurveyToStored, CABIN_GENDER_OPTIONS, requiredSessionRequests,
} from '../lib/pricing';
import type { RegChangeState, CampSurveyDraft } from '../lib/pricing';
import { holdStamp, waitlistPosition } from '../lib/capacity';
import { fmtMoney } from '../lib/scoring';
import type { Athlete, Club, Level, Event, Registration, Season, WaitlistGroup } from '../lib/types';
import { canStillEditRegistration, eventIsRefundEligible } from '../lib/events-core';
import { RefundRequestDialog, type RefundRequestItem } from '../components/RefundRequestDialog';
import { SessionRequestSurveyCard } from '../components/SessionRequestSurvey';
import { NationalsDashboard } from '../components/NationalsDashboard';
import { EventCheckinCard } from '../components/EventCheckinCard';

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
  const caps = useCapabilities();
  const toast = useToast();
  const navigate = useNavigate();
  const [tab, setTab] = useState<'upcoming' | 'past'>('upcoming');
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editingEventId, setEditingEventId] = useState<string | null>(null);
  const [refundTarget, setRefundTarget] = useState<{ event: Event; item: RefundRequestItem } | null>(null);

  const lvlName = (id?: string) => db.levels.find((l) => l.id === id)?.name ?? '—';
  const nameOf = (id: string) => {
    const p = db.people.find((x) => x.id === id);
    return p ? `${p.firstName} ${p.lastName}` : 'partner';
  };

  // Group this athlete's (non-refunded) registrations by event. NOT memoized
  // (M6 fix, 2026-07-02): `mutate()` (store.ts) mutates `db.registrations` in
  // place for an update (`d.registrations[idx] = reg`) rather than reassigning
  // the array, so a `useMemo` keyed on `db.registrations` never sees an
  // update-only edit — exactly this page's own `saveRegs` above, meaning the
  // grid showed stale data right after its own save (M6). `useDB()`'s
  // subscription already re-renders on every store change, so recomputing
  // this plain filter/group per render is correct and cheap (same precedent
  // as Cart.tsx's un-memoized `cart`).
  const byEvent = (() => {
    // Include refunded-but-kept regs (`keepListed`, event-mgmt v2 Phase 3 spec
    // §H) so a post-edit-deadline refund still shows here — with apparatus
    // locked and a "Refunded" badge — instead of silently vanishing (a
    // pre-deadline refund deletes the row outright, so it naturally drops out).
    const mine = db.registrations.filter((r) => r.athleteId === personId && (!r.refunded || r.keepListed));
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
  })();

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
  // that a change fee for this event is already pending checkout (M7: returns the
  // item itself so saveRegs can extend it in place instead of just checking).
  const changeFeeLabel = (eventName: string) => `${eventName} change fee`;
  const changeFeePendingItem = (event: Event) =>
    (db.carts[personId] ?? []).find((c) => c.kind === 'meet-entry' && c.label.startsWith(changeFeeLabel(event.name)));
  const changeFeePending = (event: Event) => !!changeFeePendingItem(event);

  const season = db.seasons.find((s) => s.current)!;

  // Leave waitlist (event-mgmt v2 P4 T6, self-serve): cancels the reg's
  // waitlist group (status → 'cancelled' — the only client-writable
  // transition; there is no client DELETE policy on waitlist_groups) and
  // hard-deletes the waitlisted reg itself. This is the one case where the
  // member side DOES delete a registration (unlike the retain-and-blank rule
  // in saveRegs above) — a waitlisted reg was never paid, so it's just a
  // placeholder, same as a brand-new unpaid entry line's ✕ removal —
  // EXCEPT a reg with paid history (see the guard below).
  const leaveWaitlist = (reg: Registration) => {
    if (!window.confirm('Leave the waitlist for this event?')) return;
    // Belt-and-braces money guard (fable review of T6): NEVER hard-delete a
    // reg with paid history (`updatedPending:true` — the paid→change-pending
    // state). The capacity dialog's `isWaitlistable` gate should make this
    // unreachable, but if any other/historical path waitlisted such a reg,
    // deleting it would destroy a purchased registration — that's a refund
    // action only. Cancel the group but keep the reg.
    const keepPaidHistory = reg.updatedPending === true;
    const applied = mutate((d) => {
      if (reg.waitlistGroupId) {
        const idx = (d.waitlistGroups ?? []).findIndex((g) => g.id === reg.waitlistGroupId);
        if (idx >= 0 && d.waitlistGroups) {
          d.waitlistGroups[idx] = { ...d.waitlistGroups[idx], status: 'cancelled' as const };
          cancelWaitlistGroup(reg.waitlistGroupId);
        }
      }
      if (keepPaidHistory) {
        const idx = d.registrations.findIndex((r) => r.id === reg.id);
        if (idx >= 0) {
          const next = { ...d.registrations[idx], waitlisted: false, waitlistGroupId: null };
          d.registrations[idx] = next;
          pushRegistration(next);
        }
      } else {
        d.registrations = d.registrations.filter((r) => r.id !== reg.id);
        deleteRegistration(reg.id);
      }
    });
    if (!applied) return; // offline read-only gate — no false success toast
    if (keepPaidHistory) {
      toast(
        'Left the waitlist, but your registration was kept (it was an update to a paid registration, not '
        + 'a new one). To undo the update, remove its change line from the cart; to cancel the registration '
        + 'entirely, request a refund.',
        { variant: 'error' },
      );
    } else {
      toast('Removed from the waitlist.');
    }
  };

  // Complete checkout for a promoted ('notified') waitlist group (event-mgmt
  // v2 P4 T7, self-serve): flips this group's regs off the waitlist
  // placeholder state (waitlisted:false; waitlistGroupId KEPT for audit —
  // scheduled-dispatch's pass 1 marks the group 'promoted' once no reg is
  // still waitlisted), stamps a fresh 30-min cart hold, and queues the normal
  // ENTRY-fee line in the member's OWN cart — the same label/refRegIds shape
  // SelfRegModal's entry line uses. Never a change fee: claiming a promoted
  // spot is the original entry purchase, not an edit, so it deliberately
  // never passes through changeIsEligible.
  const completeWaitlistCheckout = (event: Event, group: WaitlistGroup) => {
    const groupRegs = db.registrations.filter((r) => r.waitlistGroupId === group.id && r.waitlisted && r.athleteId === personId);
    if (groupRegs.length === 0) return;
    const applied = mutate((d) => {
      const priorRegs = d.registrations.filter(
        (r) => r.eventId === event.id && r.athleteId === personId
          && !r.refunded && !groupRegs.some((g) => g.id === r.id) && !r.waitlisted,
      );
      const competingClubId = groupRegs[0].clubId;
      const lineAnchor = lateFeeAnchor(groupRegs, priorRegs, new Date().toISOString());
      const entryTotal = newRegistrationEntryTotal(event, {
        competingClubId,
        priorDisciplineCount: priorRegs.length,
        newDisciplineCount: groupRegs.length,
        late: lineAnchor ? { earliestCreatedAtISO: lineAnchor } : undefined,
      });
      for (const reg of groupRegs) {
        const idx = d.registrations.findIndex((r) => r.id === reg.id);
        if (idx < 0) continue;
        const next: Registration = {
          ...d.registrations[idx],
          waitlisted: false, // waitlistGroupId kept — audit trail + sweep pass-1 signal
          paid: entryTotal === 0, // host-club $0 (shouldn't normally be waitlisted; stay consistent)
          updatedPending: false,
          holdExpiresAt: entryTotal > 0 ? holdStamp(event, event.sessions, Date.now()) : undefined,
        };
        d.registrations[idx] = next;
        pushRegistration(next);
      }
      if (entryTotal > 0) {
        const cart = d.carts[personId] ?? (d.carts[personId] = []);
        const lateSuffix = lineAnchor !== null && lateFeeApplies(event, lineAnchor) ? ' (incl. late fee)' : '';
        cart.push({
          id: `ci-self-${Date.now()}-${personId}`,
          label: `${event.name} entry — ${me?.firstName ?? ''} ${me?.lastName ?? ''} (${groupRegs.map((r) => r.discipline).join('+')})${lateSuffix}`,
          amount: entryTotal,
          kind: 'meet-entry',
          refUserId: personId,
          refRegIds: groupRegs.map((r) => r.id),
          refEventId: event.id,
          refLineType: 'entry',
        });
        pushCart(personId, cart, false);
      }
    });
    if (!applied) return; // offline read-only gate — no false success toast
    toast('Entry added to your cart — complete checkout before the hold expires.');
    navigate('/cart');
  };

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
    // Captured BEFORE the mutate below so it reflects the pre-edit cart state.
    const alreadyPendingItem = changeFeePendingItem(event);
    const alreadyPending = !!alreadyPendingItem;
    let chargedFee = 0;
    const applied = mutate((d) => {
      const existingForAthlete = d.registrations.filter(
        (r) => r.eventId === event.id && r.athleteId === personId && !r.refunded,
      );
      const editingExisting = existingForAthlete.length > 0;
      const newDiscSet = new Set(newRegs.map((r) => r.discipline));

      // Snapshot the PRE-edit state for the eligibility check below, before the
      // retain-and-blank loop mutates these same row objects in place (it sets
      // old.clubId = selectedClubId on deselected rows) — computing `before`
      // from `existingForAthlete` AFTER that loop would silently see the NEW
      // club on a deselected discipline and mask a chargeable club switch.
      const beforeClubId = existingForAthlete[0]?.clubId ?? selectedClubId;
      const beforeDisciplines = existingForAthlete.map((r) => ({
        discipline: r.discipline,
        levelId: r.levelId,
        apparatus: [...r.apparatus],
        ...(r.apparatusLevels ? { apparatusLevels: r.apparatusLevels } : {}),
      }));

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

      // Chargeable edit (fee live, editing an existing reg, non-host fee, AND
      // the change is actually eligible per `changeIsEligible`: adding a
      // discipline, changing a level, or switching clubs. A pure apparatus
      // tweak or discipline-removal-only edit is NOT eligible and stays free
      // (B8) — `before.clubId` uses the registrations' OWN pre-edit club so a
      // club-only switch is recognized as eligible.
      const before: RegChangeState = { clubId: beforeClubId, athleteId: personId, disciplines: beforeDisciplines };
      const after: RegChangeState = { clubId: selectedClubId, athleteId: personId, disciplines: newRegs };
      const eligible = editingExisting && changeIsEligible(before, after);
      const changeFee = applyFee && eligible
        ? registrationChangeFee(event, { competingClubId: selectedClubId })
        : 0;
      chargedFee = changeFee;

      // Brand-new entry total for disciplines with no prior reg (host = $0).
      const priorDisciplineCount = existingForAthlete.filter((r) => r.apparatus.length > 0).length;
      // Late-registration fee attachment (emv2 P0 Task 3, corrected): the
      // surcharge attaches ONLY to the line containing the athlete's
      // earliest-created reg for this event — `lateFeeAnchor` returns that
      // line's anchor or null (⇒ no surcharge on this line). This branch only
      // runs when `!editingExisting` (existingForAthlete is empty), so the
      // anchor here is effectively "now" — computed generally for consistency
      // with the other call sites.
      const lateAnchor = lateFeeAnchor(newRegs, existingForAthlete, new Date().toISOString());
      const entryTotal = !editingExisting
        ? newRegistrationEntryTotal(event, {
            competingClubId: selectedClubId,
            priorDisciplineCount,
            newDisciplineCount: newRegs.length,
            late: lateAnchor ? { earliestCreatedAtISO: lateAnchor } : undefined,
          })
        : 0;

      // Which regs get a cart-add capacity hold stamped (event-mgmt v2 P4):
      // both the change-fee and entry-fee branches further below reference
      // ALL of `newRegs`, so a hold is due on all of them whenever either fee
      // is actually being charged — never on a free edit.
      const cartLinked = changeFee > 0 || entryTotal > 0;

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
        if (cartLinked) {
          reg.holdExpiresAt = holdStamp(event, event.sessions, Date.now());
        }
        const idx = d.registrations.findIndex((r) => r.id === reg.id);
        if (idx >= 0) d.registrations[idx] = reg;
        else d.registrations.push(reg);
        pushRegistration(reg);
      }

      // Synchro same-level auto-sync (B4.4): whoever actively saves a partner
      // selection sets the SY level for BOTH — not a validation, an active
      // sync. Update the local snapshot optimistically; the actual remote
      // write goes through sync_synchro_partner_level (an RPC, NOT a plain
      // upsert) because the caller typically lacks RLS write access to the
      // PARTNER's own registration row (a different athlete, often a
      // different club) — the RPC re-derives + authorizes it server-side
      // from the caller's OWN just-saved registration.
      const eventRegsForSync = d.registrations.filter((r) => r.eventId === event.id && !r.refunded);
      for (const reg of newRegs) {
        const partnerUpdate = syncSynchroPartnerLevel(eventRegsForSync, reg);
        const mySyLevel = reg.apparatusLevels?.SY;
        if (partnerUpdate && mySyLevel) {
          const idx = d.registrations.findIndex((r) => r.id === partnerUpdate.id);
          if (idx >= 0) d.registrations[idx] = partnerUpdate;
          syncSynchroPartnerLevelRemote(reg.id, mySyLevel);
        }
      }

      // Add the fee/entry line to the MEMBER'S OWN cart, linked to the affected
      // regs via refRegIds so paying flips exactly those to paid. M7/H5: if a
      // change line for this event is ALREADY pending, EXTEND it in place
      // (append newly-covered reg ids + snapshot entries for regs not already
      // covered) instead of silently dropping the fee (the old behavior) or
      // stacking a second line — stacking is what let removal delete/resurrect
      // against a stale snapshot. NEVER overwrite an existing snapshot entry:
      // it must stay the ORIGINAL pre-change state from the FIRST edit.
      if (changeFee > 0 && alreadyPendingItem) {
        const cart = d.carts[personId] ?? (d.carts[personId] = []);
        const line = cart.find((c) => c.id === alreadyPendingItem.id);
        if (line) {
          const covered = new Set(line.refRegIds ?? []);
          line.refRegIds = [...covered, ...newRegs.map((r) => r.id).filter((id) => !covered.has(id))];
          const snapshotCovered = new Set((line.priorRegSnapshot ?? []).map((r) => r.id));
          const newSnapshotEntries = newRegs.map((r) => priorById.get(r.id)).filter((r): r is Registration => !!r);
          line.priorRegSnapshot = [
            ...(line.priorRegSnapshot ?? []),
            ...newSnapshotEntries.filter((r) => !snapshotCovered.has(r.id)),
          ];
          pushCart(personId, cart, false);
        }
      } else if (changeFee > 0) {
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
        const lateSuffix = lateAnchor !== null && lateFeeApplies(event, lateAnchor) ? ' (incl. late fee)' : '';
        cart.push({
          id: `ci-${Date.now()}`,
          label: `${event.name} entry — ${newRegs.map((r) => r.discipline).join('+')}${lateSuffix}`,
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
    if (!applied) return; // offline read-only gate — no false success toast

    toast(chargedFee > 0
      ? alreadyPending
        ? 'Registration updated. Your pending change fee now covers this edit too — pay it to finalize.'
        : `Registration updated. A ${fmtMoney(chargedFee)} change fee was added to your cart — pay it to finalize.`
      : 'Registration updated.');
    setEditingEventId(null);
  };

  // Feeds RegistrationEditor's `existing` prop — must include keepListed
  // refunded rows too, or the editor can't show its locked/refunded state.
  const existingForEvent = (event: Event) =>
    db.registrations.filter((r) => r.eventId === event.id && r.athleteId === personId && (!r.refunded || r.keepListed));

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
            // B4.2: client-side UX mirror of the registrations_edit_lockout DB
            // trigger — a member editing their OWN registration is never the
            // event's host club, so this is effectively "locked out past the
            // deadline" for the self-service flow (an admin impersonating
            // still bypasses via caps.isEventHost).
            const canStillEdit = canStillEditRegistration(event, caps.isEventHost(event.id));
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
                    {isOpen && tab === 'upcoming' && !regClosed && canStillEdit && (
                      <button
                        className="btn ghost small"
                        onClick={(e) => { e.stopPropagation(); setEditingEventId(event.id); }}
                      >
                        Edit
                      </button>
                    )}
                    {isOpen && tab === 'upcoming' && !regClosed && !canStillEdit && (
                      <span style={{ fontSize: 12, color: 'var(--ink-soft)' }}>Edit deadline passed</span>
                    )}
                    <span style={{ color: 'var(--teal-900)', fontSize: 13 }}>{isOpen ? 'Hide' : 'Details'}</span>
                  </span>
                </div>

                {/* Promoted waitlist group (event-mgmt v2 P4 T7): spots are
                    being held — prominent, rendered even when collapsed. */}
                {(db.waitlistGroups ?? [])
                  .filter((g) => g.eventId === event.id && g.personId === personId && g.status === 'notified')
                  .filter((g) => regs.some((r) => r.waitlistGroupId === g.id && r.waitlisted))
                  .map((g) => (
                    <div key={g.id} style={{ marginTop: 10, padding: '10px 12px', borderLeft: '4px solid var(--coral-500)', background: 'var(--ice-100)', borderRadius: 6, color: 'var(--ink)' }}>
                      <div style={{ fontSize: 14, marginBottom: 8 }}>
                        <strong>A waitlist spot opened up!</strong> Spots are being held
                        {g.holdExpiresAt && <> until <strong>{new Date(g.holdExpiresAt).toLocaleString()}</strong></>} —
                        complete checkout before then or you'll return to the end of the queue.
                      </div>
                      <button className="btn primary small" onClick={(e) => { e.stopPropagation(); completeWaitlistCheckout(event, g); }}>
                        Complete checkout →
                      </button>
                    </div>
                  ))}

                {isOpen && (() => {
                  const refundEligible = eventIsRefundEligible(event, db.clubs);
                  return (
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
                          const canRequestRefund = refundEligible && r.paid === true && !r.refunded && !r.refundRequested;
                          return (
                            <tr key={r.id}>
                              <td>{r.discipline === 'TNT' ? 'T&T' : r.discipline}</td>
                              <td>{lvlName(r.levelId)}</td>
                              <td>{evts}</td>
                              <td style={{ textAlign: 'right' }}>
                                {r.refunded ? (
                                  <Badge tone="info">Refunded</Badge>
                                ) : r.refundRequested ? (
                                  <Badge tone="warn">Refund requested</Badge>
                                ) : r.waitlisted ? (
                                  <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                                    <Badge tone="info">Waitlisted</Badge>
                                    {(() => {
                                      const pos = r.waitlistGroupId ? waitlistPosition(r.waitlistGroupId, db.waitlistGroups ?? []) : undefined;
                                      return pos !== undefined
                                        ? <span style={{ fontSize: 12, color: 'var(--ink-soft)' }}>#{pos} in line</span>
                                        : null;
                                    })()}
                                    <button
                                      className="btn ghost small"
                                      style={{ color: 'var(--coral-500)' }}
                                      onClick={() => leaveWaitlist(r)}
                                    >
                                      Leave waitlist
                                    </button>
                                  </span>
                                ) : canRequestRefund ? (
                                  <button
                                    className="btn ghost small"
                                    style={{ color: 'var(--coral-500)' }}
                                    onClick={() => setRefundTarget({
                                      event,
                                      item: { kind: 'registration', regId: r.id, label: `${r.discipline === 'TNT' ? 'T&T' : r.discipline} — ${lvlName(r.levelId)}` },
                                    })}
                                  >
                                    Request refund
                                  </button>
                                ) : null}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>

                    {/* Nationals session-planning survey (event-mgmt v2 Phase
                        5, A2) — independent-athlete variant: only when this
                        athlete has no main club. One key per registered
                        discipline. Read db.sessionRequests directly each
                        render (M6 in-place-mutation trap). Editable until the
                        event's edit deadline; read-only after (canStillEdit,
                        same gate the Edit button above uses). */}
                    {event.kind === 'nationals' && me?.mainClubId === null && (
                      <SessionRequestSurveyCard
                        eventId={event.id}
                        sessions={event.sessions}
                        keys={requiredSessionRequests(event, regs.filter((r) => !r.refunded), 'person')}
                        existing={(db.sessionRequests ?? []).filter((r) => r.eventId === event.id && r.personId === personId)}
                        owner={{ personId }}
                        editable={canStillEdit}
                        showSeparateGyms={false}
                        notesHint="e.g. who you'd like to be grouped with"
                        labelFor={(key) => (key.discipline === 'TNT' ? 'T&T' : key.discipline)}
                      />
                    )}

                    {/* Nationals summary dashboard (event-mgmt v2 Phase 5 D1,
                        spec §L.3) — independent-athlete variant: only when
                        this athlete has no main club, mirroring the survey
                        card's gate above. */}
                    {event.kind === 'nationals' && me?.mainClubId === null && (
                      <NationalsDashboard eventId={event.id} scope={{ personId }} />
                    )}

                    {/* Nationals check-in (event-mgmt v2 Phase 5 E1, spec
                        §L.4) — independent-athlete variant, same gate as the
                        summary dashboard above. */}
                    {event.kind === 'nationals' && me?.mainClubId === null && (
                      <EventCheckinCard eventId={event.id} scope={{ personId }} />
                    )}

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
                  );
                })()}
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
            allEventRegs={db.registrations.filter((r) => r.eventId === event.id && !r.refunded)}
            waitlistGroups={db.waitlistGroups?.filter((g) => g.eventId === event.id) ?? []}
          />
        );
      })()}

      {refundTarget && (
        <RefundRequestDialog
          items={[refundTarget.item]}
          eventName={refundTarget.event.name}
          onClose={() => setRefundTarget(null)}
          onSubmitted={() => { /* store refresh happens inside the dialog via syncFromSupabase() */ }}
        />
      )}
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
  allEventRegs, waitlistGroups,
}: {
  event: Event; me: Athlete; clubs: Club[]; currentClubId: string;
  existing: Registration[]; allAthletes: Athlete[]; levels: Level[];
  season: Season; changeFeeApplies: boolean;
  onClose: () => void; onSave: (selectedClubId: string, regs: Registration[]) => void;
  allEventRegs: Registration[]; waitlistGroups: WaitlistGroup[];
}) {
  const [clubId, setClubId] = useState<string>(currentClubId);
  const toast = useToast();
  const caps = useCapabilities();

  // Camp overnight-accommodations survey (event-mgmt v2 §G): editable any
  // time up to the event's edit deadline (this whole modal is only reachable
  // then — MyRegistrationsInner's "Edit" button is hidden past it). Survey
  // edits are FREE — saved directly here, entirely separate from
  // RegistrationEditor's discipline/change-fee flow below.
  const isCamp = event.eventType === 'camp';
  const surveyRequired = isCamp && !!event.campConfig?.overnightSurvey;
  const [surveyDraft, setSurveyDraft] = useState<CampSurveyDraft>(
    () => initialCampSurveyDraft(existing[0]?.campSurvey),
  );

  const saveSurvey = () => {
    if (!campSurveyValid(surveyDraft)) {
      toast('Answer bedtime, noise level, and cabin gender preference before saving (roommate request is optional).', { variant: 'error' });
      return;
    }
    const stored = campSurveyToStored(surveyDraft);
    const applied = mutate((d) => {
      for (const r of existing) {
        const idx = d.registrations.findIndex((x) => x.id === r.id);
        const updated: Registration = { ...(idx >= 0 ? d.registrations[idx] : r), campSurvey: stored };
        if (idx >= 0) d.registrations[idx] = updated; else d.registrations.push(updated);
        pushRegistration(updated);
      }
    });
    if (!applied) return; // offline read-only gate — no false success toast
    toast('Overnight-accommodations answers saved.');
    onClose();
  };

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
        isAdmin={caps.isAdmin}
        allEventRegs={allEventRegs}
        waitlistGroups={waitlistGroups}
      />

      {surveyRequired && (
        <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--line)' }}>
          <h4 style={{ margin: '0 0 4px' }}>Overnight accommodations</h4>
          <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', margin: '0 0 12px' }}>
            Free to update any time before the edit deadline — never a change fee.
          </p>
          <div className="grid cols-2" style={{ gap: 12 }}>
            <Field label="Bedtime">
              <select
                className="input"
                value={surveyDraft.bedtime}
                onChange={(e) => setSurveyDraft((d) => ({ ...d, bedtime: e.target.value as CampSurveyDraft['bedtime'] }))}
              >
                <option value="" disabled>— select —</option>
                <option value="before-10">Before 10pm</option>
                <option value="10-to-midnight">10pm–midnight</option>
                <option value="after-midnight">After midnight</option>
              </select>
            </Field>
            <Field label="Noise level preference">
              <select
                className="input"
                value={surveyDraft.noiseLevel}
                onChange={(e) => setSurveyDraft((d) => ({ ...d, noiseLevel: e.target.value as CampSurveyDraft['noiseLevel'] }))}
              >
                <option value="" disabled>— select —</option>
                <option value="quiet">Quiet</option>
                <option value="moderate">Moderate</option>
                <option value="lively">Lively</option>
              </select>
            </Field>
            <Field label="Cabin gender preference">
              <select
                className="input"
                value={surveyDraft.cabinGenderPref}
                onChange={(e) => setSurveyDraft((d) => ({ ...d, cabinGenderPref: e.target.value }))}
              >
                <option value="" disabled>— select —</option>
                {CABIN_GENDER_OPTIONS.map((g) => <option key={g} value={g}>{g}</option>)}
              </select>
            </Field>
          </div>
          <Field label="Roommate request (optional)" hint="Who would you like to room with?">
            <input
              className="input"
              value={surveyDraft.roommateRequest}
              onChange={(e) => setSurveyDraft((d) => ({ ...d, roommateRequest: e.target.value }))}
              placeholder="e.g. Jamie Lee"
            />
          </Field>
          <button className="btn ghost" style={{ marginTop: 8 }} onClick={saveSurvey} disabled={!campSurveyValid(surveyDraft)}>
            Save survey answers
          </button>
        </div>
      )}
    </Modal>
  );
}

export default MyRegistrations;
