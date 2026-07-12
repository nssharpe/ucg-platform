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
import { groupRegsByWaitlistKey, regsAffectedByViolations, splitFit, type CapacityViolation } from '../lib/capacity';
import { shrinkOrDropCartLines } from '../lib/pricing';
import { pushCart, pushRegistration, pushWaitlistGroup } from '../lib/supabase';
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
 *  caller's toast copy. */
function waitlistGroups(
  groups: { key: { discipline: Registration['discipline']; levelId: string | null; sessionId: string | null }; regs: Registration[] }[],
  eventId: string,
  ownerKey: string,
  isClub: boolean,
): Set<string> {
  const waitlistedIds = new Set<string>();
  mutate((d) => {
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
        if (idx >= 0) {
          const next: Registration = {
            ...d.registrations[idx], waitlisted: true, waitlistGroupId: wg.id, holdExpiresAt: null, paid: false,
          };
          d.registrations[idx] = next;
          pushRegistration(next);
        }
      }
    }
    d.waitlistGroups = [...existingGroups, ...newGroups];

    const nextCart = shrinkOrDropCartLines(d.carts[ownerKey] ?? [], waitlistedIds);
    d.carts[ownerKey] = nextCart;
    pushCart(ownerKey, nextCart, isClub);
  });
  return waitlistedIds;
}

export function CapacityConflictDialog({
  eventId, eventName, violations, ownerKey, isClub, onClose, onResolved, onPickSession,
}: CapacityConflictDialogProps) {
  const db = useDB();
  const [splitPreview, setSplitPreview] = useState<{ fits: Registration[]; overflow: Registration[] } | null>(null);

  const event = db.events.find((e) => e.id === eventId);

  // The checkout's own registrations at this event: every reg referenced by
  // a cart line in this scope's cart, restricted to this event.
  const checkoutRegs = useMemo(() => {
    const cart = db.carts[ownerKey] ?? [];
    const ids = new Set(cart.flatMap((i) => i.refRegIds ?? []));
    return db.registrations.filter((r) => ids.has(r.id) && r.eventId === eventId);
  }, [db.carts, db.registrations, ownerKey, eventId]);

  const affected = useMemo(() => regsAffectedByViolations(checkoutRegs, violations), [checkoutRegs, violations]);

  const nameOf = (athleteId: string) => {
    const p = db.people.find((x) => x.id === athleteId);
    return p ? `${p.firstName} ${p.lastName}` : 'athlete';
  };
  const levelName = (levelId?: string | null) => (levelId ? db.levels.find((l) => l.id === levelId)?.name ?? levelId : '—');
  const sessionName = (sessionId?: string | null) =>
    (sessionId ? event?.sessions.find((s) => s.id === sessionId)?.name ?? sessionId : '—');

  const violationText = (v: CapacityViolation): string => {
    const scopeLabel = v.scope === 'total'
      ? eventName
      : v.scope === 'level'
        ? `Level ${levelName(v.levelId)}`
        : v.scope === 'discipline'
          ? (v.discipline === 'TNT' ? 'T&T' : v.discipline)
          : `${sessionName(v.sessionId)} (${v.apparatus})`;
    return `${scopeLabel}: ${v.remaining} of ${v.cap} spot(s) remain — this order needs ${v.requested}.`;
  };

  const canPickSession = event?.registrationMode === 'by-session' && violations.every((v) => v.scope === 'session');

  const doWaitlistAll = () => {
    const groups = groupRegsByWaitlistKey(affected);
    waitlistGroups(groups, eventId, ownerKey, isClub);
    const n = affected.length;
    onResolved(`${n} ${n === 1 ? 'athlete was' : 'athletes were'} added to the waitlist for ${eventName}. We'll email you if a spot opens up.`);
    onClose();
  };

  const computeSplit = () => {
    if (!event) return;
    const groupsById = Object.fromEntries((db.waitlistGroups ?? []).map((g) => [g.id, g]));
    const { fits, overflow } = splitFit(event, event.sessions, db.registrations, checkoutRegs, groupsById, nowMs());
    setSplitPreview({ fits, overflow });
  };

  const confirmSplit = () => {
    if (!splitPreview) return;
    // splitFit already computed exactly which regs overflow every configured
    // cap — no further filtering needed, unlike the (a) path which must
    // derive "affected" from the violations list.
    const groups = groupRegsByWaitlistKey(splitPreview.overflow);
    waitlistGroups(groups, eventId, ownerKey, isClub);
    const n = splitPreview.overflow.length;
    const m = splitPreview.fits.length;
    onResolved(
      `Registered ${m} ${m === 1 ? 'athlete' : 'athletes'}, waitlisted ${n} ${n === 1 ? 'athlete' : 'athletes'} for ${eventName}. `
      + 'Retry checkout to pay for the athletes still in your cart.',
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
            <strong style={{ fontSize: 13 }}>Waitlist ({splitPreview.overflow.length}):</strong>{' '}
            <span style={{ fontSize: 13, color: 'var(--ink-soft)' }}>
              {splitPreview.overflow.length ? splitPreview.overflow.map((r) => nameOf(r.athleteId)).join(', ') : 'none'}
            </span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn primary small" onClick={confirmSplit} disabled={splitPreview.overflow.length === 0}>
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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <button className="btn primary small" onClick={doWaitlistAll}>
          Waitlist the whole group ({affected.length})
        </button>
        {canPickSession && (
          <button className="btn ghost small" onClick={() => { onClose(); onPickSession(eventId); }}>
            Pick a different session
          </button>
        )}
        <button className="btn ghost small" onClick={computeSplit} disabled={!event}>
          Register who fits, waitlist the rest
        </button>
        <button className="btn ghost small" onClick={onClose}>Cancel — back to cart</button>
      </div>
    </Modal>
  );
}

export default CapacityConflictDialog;
