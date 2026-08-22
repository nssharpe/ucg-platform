import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDB, mutate } from '../lib/store';
import { useCapabilities } from '../lib/capabilities';
import { Badge, Combo, Field, Modal, Tabs } from '../components/ui';
import { useToast, useFmtDate } from '../components/ui-hooks';
import { tzAbbrev } from '../lib/timezone';
import { pushRegistration, pushCampSurvey, pushCart, syncSynchroPartnerLevelRemote, cancelWaitlistGroup, deleteRegistration, fetchCampSurveys } from '../lib/supabase';
import { RegistrationEditor } from '../components/RegistrationEditor';
import { useMyRegistrations, useEventRegistrations, applyLocalRegistrationUpsert, applyLocalRegistrationRemove, mergeUpsertedRegs } from '../lib/registrations-slice';
import {
  newRegistrationEntryTotal, registrationChangeFee, changeIsEligible, regsForChangeLine, syncSynchroPartnerLevel, lateFeeApplies, lateFeeAnchor,
  campSurveyQuestionsOf, campSurveyAnswersValid, campSurveyToStored, campSurveyAnswerLabel, requiredSessionRequests,
} from '../lib/pricing';
import type { RegChangeState } from '../lib/pricing';
import { holdStamp, waitlistPosition } from '../lib/capacity';
import { fmtMoney } from '../lib/scoring';
import type { Athlete, Club, Level, Event, Registration, Season, WaitlistGroup } from '../lib/types';
import { canStillEditRegistration, eventIsRefundEligible } from '../lib/events-core';
import { RefundRequestDialog, type RefundRequestItem } from '../components/RefundRequestDialog';
import { SessionRequestSurveyCard } from '../components/SessionRequestSurvey';
import { NationalsDashboard } from '../components/NationalsDashboard';
import { EventCheckinCard } from '../components/EventCheckinCard';
import { currentSeason } from '../lib/season-lifecycle';
import { regGroupPaymentStatusInfo } from '../lib/registration-status';

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
  const fmtDate = useFmtDate();
  const navigate = useNavigate();
  const [tab, setTab] = useState<'upcoming' | 'past'>('upcoming');
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editingEventId, setEditingEventId] = useState<string | null>(null);
  const [refundTarget, setRefundTarget] = useState<{ event: Event; item: RefundRequestItem } | null>(null);

  // Phase 3 (data-layer-scale): "mine" (Tier 2, synchronous — CONTRACT §2) is
  // the primary source throughout this page, since every registration here
  // belongs to the signed-in caller (personId) — no loading state to gate on,
  // matching the page's pre-refactor zero-flicker UX. priorDisciplineCount/
  // existingForAthlete callers MUST use this, not a by-event slice, per the
  // COMPLETENESS rule. Synchro-partner sync needs a DIFFERENT athlete's
  // registration though, so it separately uses the by-event slice
  // (editingEventRegs) keyed on whichever event is currently being edited.
  const myRegs = useMyRegistrations();
  const { rows: editingEventRegs, status: editingEventRegsStatus } = useEventRegistrations(editingEventId);

  const lvlName = (id?: string) => db.levels.find((l) => l.id === id)?.name ?? '—';
  const nameOf = (id: string) => {
    const p = db.people.find((x) => x.id === id);
    return p ? `${p.firstName} ${p.lastName}` : 'partner';
  };

  // H2 item 1: `event.regCloses` is a naive local wall-clock string
  // ("2026-06-24T23:59", no zone suffix) in the EVENT's own timezone, not
  // UTC — reused from the exact same two existing helpers Events.tsx already
  // composes for its "Opens X · closes Y (tz)" line: `fmtDate` for the date
  // portion (never converts; formats the digits as given) and `tzAbbrev` to
  // LABEL which zone those digits are in (never to convert them). The time
  // portion uses the same ad hoc `toLocaleTimeString` pattern already used
  // elsewhere in this codebase (e.g. ErrorLog.tsx) for a short clock time —
  // safe here for the same no-conversion reason as fmtDate: `new
  // Date(regCloses)` parses a zone-less string as local time, and formatting
  // without a `timeZone` option reproduces the same digits regardless of the
  // browser's zone.
  const fmtRegCloses = (event: Event) => {
    if (!event.regCloses) return '—';
    const datePart = fmtDate(event.regCloses.slice(0, 10));
    const timePart = event.regCloses.length > 10
      ? new Date(event.regCloses).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
      : '';
    return `${datePart}${timePart ? `, ${timePart}` : ''} (${tzAbbrev(event.timezone)})`;
  };

  // Group this athlete's (non-refunded) registrations by event. NOT memoized
  // (M6 fix, 2026-07-02): mutate() (store.ts) mutates db.registrations in
  // place for an update rather than reassigning the array, so a useMemo keyed
  // on db.registrations would never see an update-only edit. Phase 3: myRegs
  // (the "mine" slice cache) is a fresh array reference on every update, so
  // it doesn't carry that trap either way — recomputing this plain
  // filter/group per render is still correct and cheap (same precedent as
  // Cart.tsx's un-memoized `cart`).
  const byEvent = (() => {
    // Include refunded-but-kept regs (`keepListed`, event-mgmt v2 Phase 3 spec
    // §H) so a post-edit-deadline refund still shows here — with apparatus
    // locked and a "Refunded" badge — instead of silently vanishing (a
    // pre-deadline refund deletes the row outright, so it naturally drops out).
    const mine = myRegs.filter((r) => r.athleteId === personId && (!r.refunded || r.keepListed));
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
  //
  // UAT M-10 x Z-04 (2026-08-22 rework): a discipline ADDED alongside a
  // chargeable edit no longer folds into this change line — it gets its OWN
  // separate entry line (`entryFeePendingItem` below), because change-fee
  // lines (`refLineType:'change'`) are NEVER refundable (Z-04's
  // requirements-owner rule) and a combined line would have made the added
  // discipline's entry-fee portion permanently non-refundable too. This line
  // is a PURE change fee again — same label/lookup as before M-10-01.
  const changeFeeLabel = (eventName: string) => `${eventName} change fee`;
  const changeFeePendingItem = (event: Event) =>
    (db.carts[personId] ?? []).find((c) => c.kind === 'meet-entry' && c.label.startsWith(changeFeeLabel(event.name)));
  const changeFeePending = (event: Event) => !!changeFeePendingItem(event);

  // Already-pending ENTRY line (for a discipline added mid-edit) to extend in
  // place instead of stacking a second one, mirroring the change-line M7/H5
  // idiom above. Matched structurally (kind/refLineType/refUserId/refEventId)
  // — new code with no pre-existing label-matching behavior to preserve, and
  // the label varies by which disciplines are included so can't serve as a
  // stable match key.
  const entryFeePendingItem = (event: Event) =>
    (db.carts[personId] ?? []).find((c) => c.kind === 'meet-entry' && c.refLineType === 'entry' && c.refUserId === personId && c.refEventId === event.id);

  const season = currentSeason(db)!;

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
        const base = idx >= 0 ? d.registrations[idx] : reg;
        const next = { ...base, waitlisted: false, waitlistGroupId: null };
        if (idx >= 0) d.registrations[idx] = next;
        pushRegistration(next);
        applyLocalRegistrationUpsert(next);
      } else {
        d.registrations = d.registrations.filter((r) => r.id !== reg.id);
        deleteRegistration(reg.id);
        applyLocalRegistrationRemove(reg);
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
    const groupRegs = myRegs.filter((r) => r.waitlistGroupId === group.id && r.waitlisted && r.athleteId === personId);
    if (groupRegs.length === 0) return;
    const applied = mutate((d) => {
      const priorRegs = myRegs.filter(
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
        const base = idx >= 0 ? d.registrations[idx] : reg;
        const next: Registration = {
          ...base,
          waitlisted: false, // waitlistGroupId kept — audit trail + sweep pass-1 signal
          paid: entryTotal === 0, // host-club $0 (shouldn't normally be waitlisted; stay consistent)
          updatedPending: false,
          holdExpiresAt: entryTotal > 0 ? holdStamp(event, event.sessions, Date.now()) : undefined,
        };
        if (idx >= 0) d.registrations[idx] = next;
        pushRegistration(next);
        applyLocalRegistrationUpsert(next);
      }
      if (entryTotal > 0) {
        const cart = d.carts[personId] ?? (d.carts[personId] = []);
        const lateSuffix = lineAnchor !== null && lateFeeApplies(event, lineAnchor) ? ' (incl. late fee)' : '';
        // Camps ask nothing discipline-related — omit the parenthetical
        // (PM feedback 2026-07-23).
        const discParen = event.eventType === 'camp' ? '' : ` (${groupRegs.map((r) => r.discipline).join('+')})`;
        cart.push({
          id: `ci-self-${Date.now()}-${personId}`,
          label: `${event.name} entry — ${me?.firstName ?? ''} ${me?.lastName ?? ''}${discParen}${lateSuffix}`,
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
    // Captured BEFORE the mutate below so they reflect the pre-edit cart state.
    const alreadyPendingItem = changeFeePendingItem(event);
    const alreadyPendingEntryItem = entryFeePendingItem(event);
    const alreadyPending = !!alreadyPendingItem;
    let chargedFee = 0;
    let addedEntryFee = 0;
    // Phase 3: read from the pre-write "mine" snapshot — this is the FIRST
    // read of registration state in this call, so it can't have gone stale
    // relative to d.registrations (perpetually empty in Supabase-configured
    // mode once Stage 4 lands). priorDisciplineCount below MUST come from
    // "mine" per the COMPLETENESS rule, not a by-event slice.
    const existingForAthlete = myRegs.filter(
      (r) => r.eventId === event.id && r.athleteId === personId && !r.refunded,
    );
    const applied = mutate((d) => {
      const editingExisting = existingForAthlete.length > 0;
      const newDiscSet = new Set(newRegs.map((r) => r.discipline));

      // Snapshot the PRE-edit state for the eligibility check below — needed
      // even now that the retain-and-blank loop no longer mutates these row
      // objects in place (Phase 3: it produces NEW objects instead, since
      // existingForAthlete's rows may be the "mine" slice cache's own row
      // objects, which must never be mutated directly — only replaced via
      // applyLocalRegistrationUpsert). Kept as its own snapshot for clarity
      // and because `before` needs plain-value copies regardless.
      const beforeClubId = existingForAthlete[0]?.clubId ?? selectedClubId;
      const beforeDisciplines = existingForAthlete.map((r) => ({
        discipline: r.discipline,
        levelId: r.levelId,
        apparatus: [...r.apparatus],
        ...(r.apparatusLevels ? { apparatusLevels: r.apparatusLevels } : {}),
      }));

      // Retain (do NOT delete) deselected disciplines: blank them out instead
      // — building a NEW object per row (Phase 3: never mutate a slice-cache
      // row's fields directly; produce a new object and go through
      // applyLocalRegistrationUpsert, same as every other write in this
      // refactor).
      const blankedRegs: Registration[] = [];
      for (const old of existingForAthlete) {
        if (!newDiscSet.has(old.discipline)) {
          const blanked: Registration = { ...old, apparatus: [] };
          delete blanked.apparatusLevels;
          delete blanked.partnerAthleteId;
          blanked.clubId = selectedClubId;
          // squad_id is host-managed (squads table); never write a non-squad id here.
          // Passing old.sessionId set squad_id to a session id → registrations_squad_id_fkey.
          const idx = d.registrations.findIndex((r) => r.id === old.id);
          if (idx >= 0) d.registrations[idx] = blanked;
          pushRegistration(blanked);
          applyLocalRegistrationUpsert(blanked);
          blankedRegs.push(blanked);
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

      // Upsert lookup, hoisted above the split below (regsForChangeLine needs
      // it to read each reg's PRIOR paid/updated_pending state).
      const priorById = new Map(existingForAthlete.map((r) => [r.id, r]));

      // UAT M-10 x Z-04 (2026-08-22): when EDITING an existing registration,
      // a discipline added alongside the edit (no prior row) owes its own
      // extra-discipline entry fee ON TOP of any change fee — but as a
      // SEPARATE entry line now, never folded into the change line
      // (`entryTotal` above stays 0 while editingExisting; it only prices
      // the brand-new-registration path). `changedRegs`
      // (`regsForChangeLine`, pricing.ts — regs that were already
      // paid/updated_pending) is what the change line's `refRegIds` covers
      // instead of ALL of `newRegs` — change-fee lines are NEVER refundable,
      // so keeping an added discipline's entry-fee portion out of that line
      // preserves its own refund eligibility and accounting code. A prior
      // row that exists but was NEVER paid (e.g. a still-unpaid discipline
      // added in an earlier, not-yet-checked-out edit) must land in
      // `newOnlyRegs`, not `changedRegs` — see `regsForChangeLine`'s doc
      // comment for why (it would silently reconstruct a mixed line
      // server-side and double-charge it).
      //
      // `chargeAddedEntry` deliberately stays gated on `changeFee > 0` only
      // (not `!applyFee`): the pre-existing "change-fee window CLOSED,
      // discipline added mid-edit" gap (member side never separately charges
      // an entry fee there, unlike Club.tsx's H7 fix) is untouched — out of
      // this ticket's scope, and closing it is a separate decision.
      const newOnlyRegs = editingExisting ? newRegs.filter((r) => !priorById.has(r.id)) : [];
      const changedRegs = editingExisting ? regsForChangeLine(newRegs, priorById) : [];
      const addedEntryTotal = newOnlyRegs.length > 0
        ? newRegistrationEntryTotal(event, {
            competingClubId: selectedClubId,
            priorDisciplineCount,
            newDisciplineCount: newOnlyRegs.length,
            late: lateAnchor ? { earliestCreatedAtISO: lateAnchor } : undefined,
          })
        : 0;
      const chargeAddedEntry = addedEntryTotal > 0 && changeFee > 0;

      // Which regs get a cart-add capacity hold stamped (event-mgmt v2 P4):
      // both the change-fee and entry-fee branches further below reference
      // ALL of `newRegs`, so a hold is due on all of them whenever either fee
      // is actually being charged — never on a free edit.
      const cartLinked = changeFee > 0 || entryTotal > 0 || addedEntryTotal > 0;

      // Upsert each returned reg. A chargeable edit flips a previously-PAID reg
      // back to "Updated pending purchase"; otherwise preserve prior payment
      // state. Brand-new regs: host-club $0 ⇒ paid immediately, else pending.
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
          // (host-club $0). If a fee line covers it (a change fee mid-edit, a
          // brand-new entry total, or an added-discipline entry line), it
          // stays pending until that line is paid — refRegIds flips it then.
          reg.paid = changeFee === 0 && entryTotal === 0 && addedEntryTotal === 0;
          reg.updatedPending = false;
        }
        if (cartLinked) {
          reg.holdExpiresAt = holdStamp(event, event.sessions, Date.now());
        }
        const idx = d.registrations.findIndex((r) => r.id === reg.id);
        if (idx >= 0) d.registrations[idx] = reg;
        else d.registrations.push(reg);
        pushRegistration(reg);
        applyLocalRegistrationUpsert(reg);
      }

      // Synchro same-level auto-sync (B4.4): whoever actively saves a partner
      // selection sets the SY level for BOTH — not a validation, an active
      // sync. Update the local snapshot optimistically; the actual remote
      // write goes through sync_synchro_partner_level (an RPC, NOT a plain
      // upsert) because the caller typically lacks RLS write access to the
      // PARTNER's own registration row (a different athlete, often a
      // different club) — the RPC re-derives + authorizes it server-side
      // from the caller's OWN just-saved registration.
      //
      // Phase 3: the partner is a DIFFERENT athlete, so this needs the
      // by-event slice (editingEventRegs — event.id === editingEventId here,
      // since this only runs from the edit modal), not "mine". Merged with
      // this call's own writes (newRegs + blankedRegs) via mergeUpsertedRegs
      // so a partner pairing involving a row this SAME save just touched is
      // still found.
      const eventRegsForSync = mergeUpsertedRegs(editingEventRegs, [...newRegs, ...blankedRegs]).filter((r) => r.eventId === event.id && !r.refunded);
      for (const reg of newRegs) {
        const partnerUpdate = syncSynchroPartnerLevel(eventRegsForSync, reg);
        const mySyLevel = reg.apparatusLevels?.SY;
        if (partnerUpdate && mySyLevel) {
          const idx = d.registrations.findIndex((r) => r.id === partnerUpdate.id);
          if (idx >= 0) d.registrations[idx] = partnerUpdate;
          syncSynchroPartnerLevelRemote(reg.id, mySyLevel);
          applyLocalRegistrationUpsert(partnerUpdate);
        }
      }

      // Add the fee/entry line(s) to the MEMBER'S OWN cart, linked to the
      // affected regs via refRegIds so paying flips exactly those to paid.
      // M7/H5: if a change line for this event is ALREADY pending, EXTEND it
      // in place (append newly-covered reg ids + snapshot entries for regs
      // not already covered) instead of silently dropping the fee (the old
      // behavior) or stacking a second line — stacking is what let removal
      // delete/resurrect against a stale snapshot. NEVER overwrite an
      // existing snapshot entry: it must stay the ORIGINAL pre-change state
      // from the FIRST edit.
      //
      // UAT M-10 x Z-04 (2026-08-22): this used to fold an added
      // discipline's entry-total INTO the change line as one combined
      // amount (M-10-01). That was reworked: change-fee lines
      // (`refLineType:'change'`) are NEVER refundable (Z-04's
      // requirements-owner rule), so a combined line made the added
      // discipline's entry-fee portion permanently non-refundable too. Now
      // the two are ALWAYS separate lines — a pure change-fee line
      // (`changedRegs`) and, independently, a pure entry line for whatever
      // was added (`newOnlyRegs`), each with its own refund eligibility.
      // (The server's three-way isChange/mixed split in
      // create-checkout-session stays as defense-in-depth for a forged or
      // legacy cart that still mixes a line — the client itself never
      // produces one anymore.)
      if (changeFee > 0 && changedRegs.length > 0) {
        chargedFee = changeFee;
        const cart = d.carts[personId] ?? (d.carts[personId] = []);
        if (alreadyPendingItem) {
          const line = cart.find((c) => c.id === alreadyPendingItem.id);
          if (line) {
            const covered = new Set(line.refRegIds ?? []);
            line.refRegIds = [...covered, ...changedRegs.map((r) => r.id).filter((id) => !covered.has(id))];
            const snapshotCovered = new Set((line.priorRegSnapshot ?? []).map((r) => r.id));
            const newSnapshotEntries = changedRegs.map((r) => priorById.get(r.id)).filter((r): r is Registration => !!r);
            line.priorRegSnapshot = [
              ...(line.priorRegSnapshot ?? []),
              ...newSnapshotEntries.filter((r) => !snapshotCovered.has(r.id)),
            ];
          }
        } else {
          cart.push({
            id: `ci-change-${Date.now()}`,
            label: changeFeeLabel(event.name),
            amount: changeFee,
            kind: 'meet-entry',
            refUserId: personId,
            refRegIds: changedRegs.map((r) => r.id),
            refEventId: event.id,
            refLineType: 'change',
            // Full prior registration row(s) (before this function's edits above),
            // so deleting this cart item later can revert them (Task A).
            priorRegSnapshot: changedRegs.map((r) => priorById.get(r.id)).filter((r): r is Registration => !!r),
          });
        }
        pushCart(personId, cart, false);
      }

      if (chargeAddedEntry) {
        // A discipline was ADDED alongside this chargeable edit: it always
        // owes its own entry/second-discipline fee, on a line of its OWN,
        // never the change line above. `alreadyPendingEntryItem` extends an
        // already-pending entry line in place (mirroring the change line's
        // M7/H5 idiom) instead of stacking a second one.
        addedEntryFee = addedEntryTotal;
        const cart = d.carts[personId] ?? (d.carts[personId] = []);
        const lateSuffix = lateAnchor !== null && lateFeeApplies(event, lateAnchor) ? ' (incl. late fee)' : '';
        // Camps ask nothing discipline-related — omit the parenthetical
        // (PM feedback 2026-07-23).
        const discSuffix = event.eventType === 'camp' ? '' : ` — ${newOnlyRegs.map((r) => r.discipline).join('+')}`;
        if (alreadyPendingEntryItem) {
          const line = cart.find((c) => c.id === alreadyPendingEntryItem.id);
          if (line) {
            const covered = new Set(line.refRegIds ?? []);
            line.refRegIds = [...covered, ...newOnlyRegs.map((r) => r.id).filter((id) => !covered.has(id))];
            line.amount = (line.amount ?? 0) + addedEntryTotal;
          }
        } else {
          cart.push({
            id: `ci-${Date.now()}`,
            label: `${event.name} entry${discSuffix}${lateSuffix}`,
            amount: addedEntryTotal,
            kind: 'meet-entry',
            refUserId: personId,
            refRegIds: newOnlyRegs.map((r) => r.id),
            refEventId: event.id,
            refLineType: 'entry',
          });
        }
        pushCart(personId, cart, false);
      }

      if (entryTotal > 0) {
        // Brand-new registration (unaffected by this rework — `entryTotal`
        // is only ever nonzero when `!editingExisting`, mutually exclusive
        // with the two branches above).
        const cart = d.carts[personId] ?? (d.carts[personId] = []);
        const lateSuffix = lateAnchor !== null && lateFeeApplies(event, lateAnchor) ? ' (incl. late fee)' : '';
        // Camps ask nothing discipline-related — omit the parenthetical
        // (PM feedback 2026-07-23).
        const discSuffix = event.eventType === 'camp' ? '' : ` — ${newRegs.map((r) => r.discipline).join('+')}`;
        cart.push({
          id: `ci-${Date.now()}`,
          label: `${event.name} entry${discSuffix}${lateSuffix}`,
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

    // UAT M-10 x Z-04: the two are separate lines now, but the toast still
    // reports the combined total for a mixed save ("combined total is fine
    // to display" per the rework) — only the CART LINES (and their
    // refund/accounting treatment) need to stay split.
    toast(
      chargedFee > 0 && addedEntryFee > 0
        ? `Registration updated. ${fmtMoney(chargedFee + addedEntryFee)} added to your cart (change fee + entry fee) — pay it to finalize.`
        : chargedFee > 0
          ? alreadyPending
            ? 'Registration updated. Your pending change fee now covers this edit too — pay it to finalize.'
            : `Registration updated. A ${fmtMoney(chargedFee)} change fee was added to your cart — pay it to finalize.`
          : addedEntryFee > 0
            ? `Registration updated. ${fmtMoney(addedEntryFee)} entry fee was added to your cart — pay it to finalize.`
            : 'Registration updated.',
      // UAT M-01-02: this edit routes through the athlete's own personal cart
      // (`d.carts[personId]` above).
      { action: { label: 'View cart', to: '/cart' } },
    );
    setEditingEventId(null);
  };

  // Feeds RegistrationEditor's `existing` prop — must include keepListed
  // refunded rows too, or the editor can't show its locked/refunded state.
  const existingForEvent = (event: Event) =>
    myRegs.filter((r) => r.eventId === event.id && r.athleteId === personId && (!r.refunded || r.keepListed));

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
            // deadline" for the self-service flow (an admin still bypasses via
            // caps.isEventHost).
            const canStillEdit = canStillEditRegistration(event, caps.isEventHost(event.id));
            // Payment status (S6) reflects the still-active rows — a
            // refunded-but-kept row (spec §H) no longer owes anything and
            // shouldn't drag an otherwise-paid card into a misleading state.
            // Falls back to the full group if every row happens to be
            // refunded-but-kept. Derived strictly from paid/updatedPending
            // (registration-status.ts) — never a refRegIds heuristic.
            const activeRegs = regs.filter((r) => !r.refunded);
            const paymentStatus = regGroupPaymentStatusInfo(activeRegs.length > 0 ? activeRegs : regs);
            return (
              <div key={event.id} className="card card-pad">
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, cursor: 'pointer', flexWrap: 'wrap' }}
                  onClick={() => setExpanded(isOpen ? null : event.id)}>
                  <strong style={{ fontSize: 15 }}>{event.name}</strong>
                  <span style={{ color: 'var(--ink-soft)', fontSize: 13 }}>
                    {event.startDate}{event.endDate !== event.startDate ? `–${event.endDate}` : ''} · {event.city}, {event.state}
                  </span>
                  {club && <Badge tone="navy">{club.shortName || club.name}</Badge>}
                  <Badge tone={paymentStatus.tone}>{paymentStatus.label}</Badge>
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
                    <button
                      type="button"
                      className="linklike-button"
                      aria-expanded={isOpen}
                      style={{ color: 'var(--teal-900)', fontSize: 13 }}
                      onClick={(e) => { e.stopPropagation(); setExpanded(isOpen ? null : event.id); }}
                    >
                      {isOpen ? 'Hide' : 'Details'}
                    </button>
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
                      {paymentStatus.label} · Registration closes {fmtRegCloses(event)}
                    </div>
                    {/* Wrapped in its own horizontal scroller (same technique as
                        Clubs.tsx's H4.7 fix / Events.tsx's `.events-table-wrap`):
                        at 375px a "Refund requested" badge + button in the last
                        column pushes this table wider than the viewport. */}
                    <div style={{ overflowX: 'auto', marginBottom: 12 }}>
                    <table className="tbl">
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
                    </div>

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
                          Use <strong>Edit</strong> above to change your disciplines, levels, and apparatus{affiliatedClubs.length > 1 ? ', or which club you compete for' : ''}.
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
        // COMPLETENESS: allEventRegs feeds capacity checks, which are
        // event-wide across every club — must be the full by-event slice
        // (editingEventRegs, gated on 'ready' here) rather than db.registrations.
        if (editingEventRegsStatus === 'loading') {
          return <Modal title={`Edit registration — ${event.name}`} onClose={() => setEditingEventId(null)}><p>Loading…</p></Modal>;
        }
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
            allEventRegs={editingEventRegs.filter((r) => !r.refunded)}
            waitlistGroups={db.waitlistGroups?.filter((g) => g.eventId === event.id) ?? []}
          />
        );
      })()}

      {refundTarget && (
        <RefundRequestDialog
          items={[refundTarget.item]}
          event={refundTarget.event}
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

  // Camp registrant survey (event-mgmt v2 §G; editable questions 2026-07-23):
  // editable any time up to the event's edit deadline (this whole modal is
  // only reachable then — MyRegistrationsInner's "Edit" button is hidden
  // past it). Survey edits are FREE — saved directly here, entirely separate
  // from RegistrationEditor's discipline/change-fee flow below.
  const isCamp = event.eventType === 'camp';
  const surveyConfig = useMemo(() => campSurveyQuestionsOf(event.campConfig), [event.campConfig]);
  const surveyRequired = isCamp && surveyConfig.enabled;
  const surveyQuestions = surveyConfig.questions;
  const [surveyAnswers, setSurveyAnswers] = useState<Record<string, string | string[]>>(
    () => existing[0]?.campSurvey ?? {},
  );
  // camp_survey is no longer part of the broad loadAll read (privacy fix,
  // docs/research/2026-07-17-supabomb-scan-results.md) — existing[0] above
  // never carries a prior answer any more, so fetch it on demand via the
  // scoped RPC (self-scoped: this athlete's own registration) to seed the
  // edit form. No-op when there's nothing to prefill.
  useEffect(() => {
    if (!surveyRequired || existing.length === 0) return;
    let cancelled = false;
    fetchCampSurveys(event.id).then((surveys) => {
      if (cancelled) return;
      const prior = surveys[existing[0].id];
      if (prior) setSurveyAnswers(prior);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const setSurveyAnswer = (id: string, value: string | string[]) => setSurveyAnswers((a) => ({ ...a, [id]: value }));
  const toggleSurveyMultiOption = (id: string, option: string) => setSurveyAnswers((a) => {
    const cur = Array.isArray(a[id]) ? a[id] as string[] : [];
    return { ...a, [id]: cur.includes(option) ? cur.filter((x) => x !== option) : [...cur, option] };
  });

  const saveSurvey = () => {
    if (!campSurveyAnswersValid(surveyAnswers, surveyQuestions)) {
      toast('Answer every required survey question before saving.', { variant: 'error' });
      return;
    }
    const stored = campSurveyToStored(surveyAnswers);
    const applied = mutate((d) => {
      for (const r of existing) {
        const idx = d.registrations.findIndex((x) => x.id === r.id);
        const updated: Registration = { ...(idx >= 0 ? d.registrations[idx] : r), campSurvey: stored };
        if (idx >= 0) d.registrations[idx] = updated; else d.registrations.push(updated);
        pushRegistration(updated);
        applyLocalRegistrationUpsert(updated);
        // camp_survey travels through its own targeted-update write (see
        // pushCampSurvey's doc comment) — never via the row upsert above.
        pushCampSurvey(updated.id, stored);
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
          <h4 style={{ margin: '0 0 4px' }}>Registrant survey</h4>
          <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', margin: '0 0 12px' }}>
            Free to update any time before the edit deadline — never a change fee.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {surveyQuestions.map((q) => {
              const value = surveyAnswers[q.id];
              if (q.type === 'text') {
                return (
                  <Field key={q.id} label={q.required ? q.label : `${q.label} (optional)`} required={q.required}>
                    <input
                      className="input"
                      value={typeof value === 'string' ? value : ''}
                      onChange={(e) => setSurveyAnswer(q.id, e.target.value)}
                    />
                  </Field>
                );
              }
              if (q.type === 'single') {
                return (
                  <Field key={q.id} label={q.required ? q.label : `${q.label} (optional)`} required={q.required}>
                    <select
                      className="input"
                      value={typeof value === 'string' ? value : ''}
                      onChange={(e) => setSurveyAnswer(q.id, e.target.value)}
                    >
                      <option value="" disabled>— select —</option>
                      {(q.options ?? []).map((opt) => (
                        <option key={opt} value={opt}>{campSurveyAnswerLabel(q.id, opt)}</option>
                      ))}
                    </select>
                  </Field>
                );
              }
              const selected = Array.isArray(value) ? value : [];
              return (
                <Field key={q.id} label={q.required ? q.label : `${q.label} (optional)`} required={q.required}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {(q.options ?? []).map((opt) => (
                      <label key={opt} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 14 }}>
                        <input
                          type="checkbox"
                          checked={selected.includes(opt)}
                          onChange={() => toggleSurveyMultiOption(q.id, opt)}
                        />
                        {campSurveyAnswerLabel(q.id, opt)}
                      </label>
                    ))}
                  </div>
                </Field>
              );
            })}
          </div>
          <button className="btn ghost" style={{ marginTop: 8 }} onClick={saveSurvey} disabled={!campSurveyAnswersValid(surveyAnswers, surveyQuestions)}>
            Save survey answers
          </button>
        </div>
      )}
    </Modal>
  );
}

export default MyRegistrations;
