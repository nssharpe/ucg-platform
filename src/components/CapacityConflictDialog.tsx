// Capacity-conflict dialog (event-mgmt v2 P4 T6): shown when
// `create-checkout-session` rejects a checkout with a 409
// `capacity-exceeded` body. Never silently drops the conflict — the payer
// picks exactly one of three explicit resolutions:
//   (a) waitlist the whole affected group(s),
//   (b) go pick a different session (by-session events, session-only
//       violations only),
//   (c) a deliberate split — register whoever fits, waitlist the overflow.
// All writes here mirror the same idiom as cart-sync.ts: local `mutate()` +
// the matching `push*` remote call, never a bare local-only mutation.
import { useMemo, useState } from 'react';
import { useDB, mutate } from '../lib/store';
import { Modal } from './ui';
import { groupRegsByWaitlistKey, isWaitlistable, regsAffectedByViolations, splitFit, type CapacityViolation } from '../lib/capacity';
import { shrinkOrDropCartLines } from '../lib/pricing';
import { pushCart, pushRegistration, pushWaitlistGroup } from '../lib/supabase';
import { useEventRegistrations, applyLocalRegistrationUpsert } from '../lib/registrations-slice';
import { usePeopleNames, nameLookup } from '../lib/people-slice';
import type { Registration, WaitlistGroup } from '../lib/types';

// Tucked behind a plain helper (not a bare `Date.now()` inline in a hook/
// handler body) so react-hooks/purity's impure-call check doesn't fire —
// same idiom as RegistrationEditor.tsx's `nowMs`.
const nowMs = (): number => Date.now();

const genGroupId = (): string =>
  `wg-${Date.now()}-${typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10)}`;

export interface CapacityConflictDialogProps {
  eventId: string;
  eventName: string;
  violations: CapacityViolation[];
  /** The cart scope this checkout was for: a personId (self cart) or a clubId
   *  (club cart) — same "ownerKey" idiom as `removeCartItemWithSync`. */
  ownerKey: string;
  isClub: boolean;
  onClose: () => void;
  /** Called once a resolution has been applied, with the exact-what-happened
   *  toast message (never a generic "done"). */
  onResolved: (message: string) => void;
  /** (b) Pick a different session: the caller owns navigation (deep-linking
   *  to the registration editor is page-specific). */
  onPickSession: (eventId: string) => void;
}

/** Waitlists every reg in `groups` (one WaitlistGroup row per cohort) and
 *  shrinks/drops the cart lines that referenced them. Shared by (a) and the
 *  overflow half of (c). Returns the set of waitlisted reg ids for the
 *  caller's toast copy, or null when the offline read-only gate refused the
 *  mutation (nothing was waitlisted; callers must not toast success). */
function waitlistGroups(
  groups: { key: { discipline: Registration['discipline']; levelId: string | null; sessionId: string | null }; regs: Registration[] }[],
  eventId: string,
  ownerKey: string,
  isClub: boolean,
): Set<string> | null {
  const waitlistedIds = new Set<string>();
  const applied = mutate((d) => {
    const existingGroups = d.waitlistGroups ?? [];
    const newGroups: WaitlistGroup[] = [];
    for (const g of groups) {
      const wg: WaitlistGroup = {
        id: genGroupId(),
        eventId,
        clubId: isClub ? ownerKey : null,
        personId: isClub ? null : ownerKey,
        discipline: g.key.discipline,
        levelId: g.key.levelId,
        sessionId: g.key.sessionId,
        status: 'waiting',
        queuedAt: new Date().toISOString(),
      };
      newGroups.push(wg);
      pushWaitlistGroup(wg);
      for (const reg of g.regs) {
        waitlistedIds.add(reg.id);
        const idx = d.registrations.findIndex((r) => r.id === reg.id);
        // NO `paid: false` here: callers only ever pass `isWaitlistable`
        // regs (paid !== true already), and blindly clearing `paid` on
        // anything else is exactly the paid-spot-release bug class the
        // predicate exists to prevent — keep the write shape honest.
        const base = idx >= 0 ? d.registrations[idx] : reg;
        const next: Registration = {
          ...base, waitlisted: true, waitlistGroupId: wg.id, holdExpiresAt: null,
        };
        if (idx >= 0) d.registrations[idx] = next;
        pushRegistration(next);
        applyLocalRegistrationUpsert(next);
      }
    }
    d.waitlistGroups = [...existingGroups, ...newGroups];

    const nextCart = shrinkOrDropCartLines(d.carts[ownerKey] ?? [], waitlistedIds);
    d.carts[ownerKey] = nextCart;
    pushCart(ownerKey, nextCart, isClub);
  });
  return applied ? waitlistedIds : null;
}

export function CapacityConflictDialog({
  eventId, eventName, violations, ownerKey, isClub, onClose, onResolved, onPickSession,
}: CapacityConflictDialogProps) {
  const db = useDB();
  const [splitPreview, setSplitPreview] = useState<{ fits: Registration[]; overflow: Registration[] } | null>(null);

  // Phase 3 (data-layer-scale) / COMPLETENESS: caps are event-wide across
  // EVERY club, so this MUST be the full by-event slice, never a
  // club-narrowed subset — a partial read here undercounts usage and would
  // admit an over-capacity registration. Also backs checkoutRegs below
  // (a subset of the same event-wide set).
  const { rows: eventRegs, status: regsStatus } = useEventRegistrations(eventId);

  const event = db.events.find((e) => e.id === eventId);

  // The checkout's own registrations at this event: every reg referenced by
  // a cart line in this scope's cart, restricted to this event.
  const checkoutRegs = useMemo(() => {
    const cart = db.carts[ownerKey] ?? [];
    const ids = new Set(cart.flatMap((i) => i.refRegIds ?? []));
    return eventRegs.filter((r) => ids.has(r.id) && r.eventId === eventId);
  }, [db.carts, eventRegs, ownerKey, eventId]);

  const affected = useMemo(() => regsAffectedByViolations(checkoutRegs, violations), [checkoutRegs, violations]);

  // Money-invariant partition (fable review of T6): only never-paid regs may
  // be flipped to waitlist placeholders. A paid reg mid-change
  // (`updatedPending:true`) still holds its purchased spot — waitlisting it
  // would release that spot, and "Leave waitlist" would then hard-delete a
  // paid-history reg (deletion of paid regs is a refund action ONLY). Those
  // regs are NEVER acted on here; the guidance below tells the payer the
  // real alternative (✕ the change line to revert to the prior paid state).
  const waitlistableAffected = useMemo(() => affected.filter(isWaitlistable), [affected]);
  const blockedAffected = useMemo(() => affected.filter((r) => !isWaitlistable(r)), [affected]);

  // Phase 4 (data-layer-scale.md): db.people at boot doesn't necessarily
  // cover every affected athlete — thin name-only lookup, bounded to this
  // checkout's own cart registrations (checkoutRegs). Called unconditionally
  // (Rules of Hooks) before the loading early return below.
  const { rows: conflictCompetitorRefs, status: conflictPeopleStatus } = usePeopleNames(checkoutRegs.map((r) => r.athleteId));
  const conflictNameById = nameLookup(conflictCompetitorRefs);

  // MUST gate before any resolution action is offered — every button below
  // (waitlist/split) computes off eventRegs, and a partial read here would
  // undercount capacity usage (COMPLETENESS rule). All hooks above are
  // called unconditionally regardless of this branch (Rules of Hooks).
  if (regsStatus === 'loading' || conflictPeopleStatus === 'loading') {
    return (
      <Modal title={`Can't check out — ${eventName} is at capacity`} onClose={onClose}>
        <p style={{ fontSize: 13.5, color: 'var(--ink-soft)' }}>Loading…</p>
      </Modal>
    );
  }

  const nameOf = (athleteId: string) => conflictNameById.get(athleteId) ?? 'athlete';
  const levelName = (levelId?: string | null) => (levelId ? db.levels.find((l) => l.id === levelId)?.name ?? levelId : '—');
  const sessionName = (sessionId?: string | null) =>
    (sessionId ? event?.sessions.find((s) => s.id === sessionId)?.name ?? sessionId : '—');

  const violationText = (v: CapacityViolation): string => {
    const scopeLabel = v.scope === 'level'
      ? `${v.discipline === 'TNT' ? 'T&T' : v.discipline} — Level ${levelName(v.levelId)}`
      : v.scope === 'discipline'
        ? (v.discipline === 'TNT' ? 'T&T' : v.discipline)
        : `${sessionName(v.sessionId)} (${v.apparatus})`;
    return `${scopeLabel}: ${v.remaining} of ${v.cap} spot(s) remain — this order needs ${v.requested}.`;
  };

  const canPickSession = event?.registrationMode === 'by-session' && violations.every((v) => v.scope === 'session');

  const blockedNote = blockedAffected.length > 0
    ? ` (${blockedAffected.map((r) => nameOf(r.athleteId)).join(', ')} kept their updated registration${blockedAffected.length === 1 ? '' : 's'} — remove the change from your cart to revert instead.)`
    : '';

  const doWaitlistAll = () => {
    if (waitlistableAffected.length === 0) return;
    const groups = groupRegsByWaitlistKey(waitlistableAffected);
    if (!waitlistGroups(groups, eventId, ownerKey, isClub)) return; // offline read-only gate
    const n = waitlistableAffected.length;
    onResolved(`${n} ${n === 1 ? 'athlete was' : 'athletes were'} added to the waitlist for ${eventName}. We'll email you if a spot opens up.${blockedNote}`);
    onClose();
  };

  const computeSplit = () => {
    if (!event) return;
    const groupsById = Object.fromEntries((db.waitlistGroups ?? []).map((g) => [g.id, g]));
    const { fits, overflow } = splitFit(event, event.sessions, eventRegs, checkoutRegs, groupsById, nowMs());
    setSplitPreview({ fits, overflow });
  };

  // Split preview partition: splitFit computes overflow purely on capacity —
  // it may include non-waitlistable regs (a paid reg mid-change), which must
  // stay in the cart untouched, never flipped. Only the waitlistable subset
  // of the overflow is acted on.
  const splitWaitlistable = splitPreview ? splitPreview.overflow.filter(isWaitlistable) : [];
  const splitBlocked = splitPreview ? splitPreview.overflow.filter((r) => !isWaitlistable(r)) : [];

  const confirmSplit = () => {
    if (!splitPreview || splitWaitlistable.length === 0) return;
    const groups = groupRegsByWaitlistKey(splitWaitlistable);
    if (!waitlistGroups(groups, eventId, ownerKey, isClub)) return; // offline read-only gate
    const n = splitWaitlistable.length;
    const m = splitPreview.fits.length;
    const keptNote = splitBlocked.length > 0
      ? ` ${splitBlocked.map((r) => nameOf(r.athleteId)).join(', ')} kept their updated registration${splitBlocked.length === 1 ? '' : 's'} (still in your cart) — remove the change line to revert instead.`
      : '';
    onResolved(
      `Registered ${m} ${m === 1 ? 'athlete' : 'athletes'}, waitlisted ${n} ${n === 1 ? 'athlete' : 'athletes'} for ${eventName}. `
      + 'Retry checkout to pay for the athletes still in your cart.'
      + keptNote,
    );
    onClose();
  };

  if (splitPreview) {
    return (
      <Modal title={`Split registration — ${eventName}`} onClose={onClose}>
        <p style={{ color: 'var(--ink-soft)', fontSize: 14 }}>
          Register the {splitPreview.fits.length} who fit under the cap now, and waitlist the rest.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 14 }}>
          <div>
            <strong style={{ fontSize: 13 }}>Register ({splitPreview.fits.length}):</strong>{' '}
            <span style={{ fontSize: 13, color: 'var(--ink-soft)' }}>
              {splitPreview.fits.length ? splitPreview.fits.map((r) => nameOf(r.athleteId)).join(', ') : 'none'}
            </span>
          </div>
          <div>
            <strong style={{ fontSize: 13 }}>Waitlist ({splitWaitlistable.length}):</strong>{' '}
            <span style={{ fontSize: 13, color: 'var(--ink-soft)' }}>
              {splitWaitlistable.length ? splitWaitlistable.map((r) => nameOf(r.athleteId)).join(', ') : 'none'}
            </span>
          </div>
          {splitBlocked.length > 0 && (
            <div style={{ fontSize: 13, color: 'var(--coral-text)' }}>
              {splitBlocked.map((r) => nameOf(r.athleteId)).join(', ')}
              {splitBlocked.length === 1 ? "'s updated registration can't" : "' updated registrations can't"} be
              waitlisted — they already hold a purchased spot. To undo the change, remove the change line
              from your cart (✕) and their previous registration is restored.
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn primary small" onClick={confirmSplit} disabled={splitWaitlistable.length === 0}>
            Confirm split
          </button>
          <button className="btn ghost small" onClick={() => setSplitPreview(null)}>← Back</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={`Can't check out — ${eventName} is at capacity`} onClose={onClose}>
      <ul style={{ margin: '0 0 14px', paddingLeft: 18, fontSize: 14, color: 'var(--ink-soft)' }}>
        {violations.map((v, i) => <li key={i}>{violationText(v)}</li>)}
      </ul>
      <p style={{ fontSize: 13.5, marginBottom: 14 }}>
        Choose how to proceed — nothing has changed yet.
      </p>
      {blockedAffected.length > 0 && (
        <p style={{ fontSize: 13, color: 'var(--coral-text)', marginBottom: 14 }}>
          {blockedAffected.map((r) => nameOf(r.athleteId)).join(', ')}
          {blockedAffected.length === 1 ? "'s updated registration can't" : "' updated registrations can't"} be
          waitlisted — they already hold a purchased spot for this event. To undo the change, remove the
          change line from your cart (✕) and their previous registration is restored.
        </p>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <button className="btn primary small" onClick={doWaitlistAll} disabled={waitlistableAffected.length === 0}>
          Waitlist the whole group ({waitlistableAffected.length})
        </button>
        {canPickSession && (
          <button className="btn ghost small" onClick={() => { onClose(); onPickSession(eventId); }}>
            Pick a different session
          </button>
        )}
        <button className="btn ghost small" onClick={computeSplit} disabled={!event || waitlistableAffected.length === 0}>
          Register who fits, waitlist the rest
        </button>
        <button className="btn ghost small" onClick={onClose}>Cancel — back to cart</button>
      </div>
    </Modal>
  );
}

export default CapacityConflictDialog;
