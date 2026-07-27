import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useDB, syncFromSupabase } from '../lib/store';
import { useCapabilities } from '../lib/capabilities';
import { useToast, useFmtDate } from '../components/ui-hooks';
import { Badge, Modal } from '../components/ui';
import { fmtMoney } from '../lib/scoring';
import { removeCartItemWithSync, cleanupCrossClubCart, CART_REMOVAL_MESSAGE } from '../lib/cart-sync';
import { downloadCartInvoice, downloadReceipt, invoiceTotal } from '../lib/receipt';
import { CartCheckout } from '../components/CartCheckout';
import { CapacityConflictDialog } from '../components/CapacityConflictDialog';
import { hasCapacityConfig } from '../lib/capacity';
import { missingNationalsSurveyEvents, diffCartLinePrices, cartSectionCount, type SessionRequestGateReg } from '../lib/pricing';
import { previewCartTotal, type CheckoutCapacityError, type CartPreviewLine } from '../lib/supabase';
import { useMyRegistrations, useClubRegistrations } from '../lib/registrations-slice';
import type { CartItem, Club, DB, Invoice, Registration } from '../lib/types';

const sum = (items: CartItem[]) => items.reduce((s, i) => s + i.amount, 0);

/** S4 (money-story UX): the cart's own server-price preview
 *  (`create-checkout-session { mode: 'preview' }`), fetched once per
 *  scope (personal cart, or one managed club's cart) for its FULL item
 *  set. `'loading'` covers both "not fetched yet" and "refetching after
 *  the cart's contents changed" — the stored amounts stay on screen,
 *  labelled "Estimated", the whole time. */
type CartPreviewState =
  | { status: 'loading' }
  | { status: 'loaded'; lines: CartPreviewLine[]; total: number; serviceFee: number }
  | { status: 'failed' };

/** This item's server-priced dollar amount, or `null` if the preview hasn't
 *  landed (yet, or ever) — the caller falls back to the stored `item.amount`. */
function previewAmountFor(itemId: string, preview: CartPreviewState): number | null {
  if (preview.status !== 'loaded') return null;
  const line = preview.lines.find((l) => l.itemId === itemId);
  return line ? line.amountCents / 100 : null;
}

/** The amount to DISPLAY for one cart item: the server preview's price once
 *  loaded, else the stored (possibly-stale) `cart_items.amount` — "the UI
 *  never sums client amounts as authoritative" once a server price exists. */
function pricedAmount(item: CartItem, preview: CartPreviewState): number {
  return previewAmountFor(item.id, preview) ?? item.amount;
}

function pricedSum(items: CartItem[], preview: CartPreviewState): number {
  return items.reduce((s, i) => s + pricedAmount(i, preview), 0);
}

/** Group a cart's items the same way everywhere: a "Memberships" bucket, a
 *  bucket per event (matched by name appearing in the label, carrying the
 *  event's id for capacity-hold lookups), and an "Other" bucket for anything
 *  left over. Shared by the personal cart and every managed-club section so
 *  grouping logic isn't duplicated/drifted. */
function groupCartItems(cart: CartItem[], db: DB) {
  const membership: CartItem[] = [];
  const byEvent = new Map<string, { eventId: string; eventName: string; slug: string | null; items: CartItem[] }>();
  const other: CartItem[] = [];
  for (const item of cart) {
    if (item.kind === 'membership') { membership.push(item); continue; }
    const event = db.events.find((m) => item.label.includes(m.name));
    if (event) {
      const g = byEvent.get(event.id) ?? { eventId: event.id, eventName: event.name, slug: event.slug, items: [] };
      g.items.push(item);
      byEvent.set(event.id, g);
    } else {
      other.push(item);
    }
  }
  return { membership, events: [...byEvent.values()], other };
}

/** event-mgmt v2 Phase 5 A3 (spec §L.1/§E5.4): which nationals events among
 *  `items`' referenced (incoming) registrations still have an unanswered
 *  required session-planning survey — the client-side advisory mirror of the
 *  server's checkout gate (`missingNationalsSurveyEvents` in `pricing.ts`).
 *
 *  Phase 3 (data-layer-scale): `regs` is the CALLER's cross-event
 *  registration set — `useMyRegistrations()` for the personal cart,
 *  `useClubRegistrations(clubId).rows` for a managed-club section (CONTRACT
 *  shapes #2/#5) — since a cart line's refRegIds may point at ANY event.
 *  `db.registrations` can no longer serve this once Stage 4 lands. Not
 *  memoized (M6 in-place-mutation trap — mutate() never reassigns
 *  db.sessionRequests on an update, so a memo keyed on it would go stale, and
 *  `regs` itself is already a fresh array reference on every slice update).
 *  Cheap enough to recompute on every render. */
function surveyGateForItems(items: CartItem[], regs: Registration[], db: DB): { eventId: string; eventName: string }[] {
  if (items.length === 0) return [];
  const incomingRegs: SessionRequestGateReg[] = [];
  for (const item of items) {
    for (const regId of item.refRegIds ?? []) {
      const reg = regs.find((r) => r.id === regId);
      if (!reg) continue;
      incomingRegs.push({
        athleteId: reg.athleteId, clubId: reg.clubId, eventId: reg.eventId,
        discipline: reg.discipline, levelId: reg.levelId, refunded: reg.refunded,
      });
    }
  }
  if (incomingRegs.length === 0) return [];
  const existing = (db.sessionRequests ?? []).map((s) => ({
    eventId: s.eventId, clubId: s.clubId ?? null, personId: s.personId ?? null,
    discipline: s.discipline, levelId: s.levelId ?? null, answers: s.answers,
  }));
  return missingNationalsSurveyEvents(db.events, incomingRegs, db.people, existing);
}

/** Earliest live (not-yet-expired-in-the-past... this returns it regardless of
 *  expiry — the caller decides "live" vs "expired") `holdExpiresAt` among the
 *  registrations a group of cart lines reference, epoch ms, or `null` if none
 *  hold a spot at all (uncapped event, or nothing hold-stamped yet). `regs` —
 *  see `surveyGateForItems`'s doc comment (Phase 3). */
function earliestHoldMs(items: CartItem[], regs: Registration[]): number | null {
  let earliest: number | null = null;
  for (const item of items) {
    for (const regId of item.refRegIds ?? []) {
      const reg = regs.find((r) => r.id === regId);
      if (!reg?.holdExpiresAt) continue;
      const t = new Date(reg.holdExpiresAt).getTime();
      if (Number.isNaN(t)) continue;
      if (earliest === null || t < earliest) earliest = t;
    }
  }
  return earliest;
}

function fmtCountdown(msLeft: number): string {
  const totalSec = Math.max(0, Math.ceil(msLeft / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Ticketing-site-style cart hold countdown (event-mgmt v2 P4 T6): shown on a
 *  capacity-configured event's cart card when at least one referenced
 *  registration carries a live soft hold. Ticks every second; once the
 *  earliest hold expires it swaps to a plain-language warning instead of
 *  disappearing — items are NEVER auto-removed, they're just re-checked for
 *  real at checkout. Module-scope component (never nested in a render body —
 *  ESLint's react-refresh rule). */
function HoldCountdown({ expiresAtMs }: { expiresAtMs: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const msLeft = expiresAtMs - now;
  if (msLeft <= 0) {
    return (
      <p style={{ margin: '0 0 10px', fontSize: 13, color: 'var(--coral-600)' }}>
        Hold expired — spots are no longer guaranteed; they're re-checked at checkout.
      </p>
    );
  }
  return (
    <p style={{ margin: '0 0 10px', fontSize: 13, color: 'var(--navy-700)' }}>
      Spots held — cart expires in {fmtCountdown(msLeft)}
    </p>
  );
}

function CartCard({ title, items, preview, returnTo, returnLabel, onCheckout, onRemove, onPrintInvoice, holdExpiresAtMs, surveyGate, surveyReturnTo }: {
  title: string; items: CartItem[]; preview: CartPreviewState; returnTo: string; returnLabel: string; onCheckout: () => void;
  onRemove: (item: CartItem) => void; onPrintInvoice: () => void;
  /** event-mgmt v2 P4 T6: earliest live cart-add hold among this card's
   *  registrations, epoch ms — only set for capacity-configured events. */
  holdExpiresAtMs?: number | null;
  /** event-mgmt v2 Phase 5 A3: nationals events among this card's incoming
   *  regs with an unanswered required session-planning survey. Non-empty ⇒
   *  the "Check out" button is disabled and a warning is shown instead of
   *  sending a request the server will just reject. */
  surveyGate?: { eventId: string; eventName: string }[];
  /** Where to send the user to answer the survey (club registrations page
   *  for a club cart, My Registrations for a self cart). */
  surveyReturnTo?: string;
}) {
  const surveyBlocked = !!surveyGate && surveyGate.length > 0;
  const estimated = preview.status !== 'loaded';
  return (
    <div className="card card-pad">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <h3 className="card-title" style={{ margin: 0 }}>{title}</h3>
        <Link to={returnTo} style={{ marginLeft: 'auto', fontSize: 13 }}>{returnLabel} →</Link>
      </div>
      {holdExpiresAtMs != null && <HoldCountdown expiresAtMs={holdExpiresAtMs} />}
      {surveyBlocked && (
        <p style={{ margin: '0 0 10px', fontSize: 13, color: 'var(--coral-600)' }}>
          Answer the nationals session-planning survey for {surveyGate!.map((g) => g.eventName).join(', ')}{' '}
          before checking out{surveyReturnTo ? <> — <Link to={surveyReturnTo}>answer it here</Link></> : null}.
        </p>
      )}
      <ul style={{ margin: '10px 0', paddingLeft: 18, fontSize: 14 }}>
        {items.map((i) => (
          <li key={i.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
            <span>{i.label}</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <strong>{fmtMoney(pricedAmount(i, preview))}</strong>
              <button
                type="button"
                className="btn ghost small"
                title="Remove from cart"
                aria-label={`Remove ${i.label} from cart`}
                onClick={() => onRemove(i)}
                style={{ padding: '2px 8px', lineHeight: 1 }}
              >
                ✕
              </button>
            </span>
          </li>
        ))}
      </ul>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <strong style={{ marginRight: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span>Subtotal: {fmtMoney(pricedSum(items, preview))}</span>
          {estimated && <Badge tone="info">Estimated</Badge>}
        </strong>
        <button className="btn ghost small" onClick={onPrintInvoice} disabled={items.length === 0}>
          Print Invoice
        </button>
        <button className="btn primary small" onClick={onCheckout} disabled={items.length === 0 || surveyBlocked}>
          Check out {title}
        </button>
      </div>
    </div>
  );
}

/** One scope's worth of cart sections (personal OR one managed club): the
 *  Memberships / per-event / Other cards, a duplicated "check out everything"
 *  button at both the top and bottom, and Print Invoice on every card. Shared
 *  by the personal cart and every managed-club section so the two surfaces
 *  can't drift apart. */
function CartScope({
  cart, ownerKey, isClub, name, registrationsReturnTo, otherReturnTo, membershipsReturnTo, onRemoved,
}: {
  cart: CartItem[];
  ownerKey: string;
  isClub: boolean;
  name: string;
  /** Where a meet-entry card's "Return to registration" link points, given
   *  that event's slug (personal cart: `/events/:slug` if known, else the
   *  index; club sections: always that club's registrations page). */
  registrationsReturnTo: (slug: string | null) => string;
  /** Where the "Other" card's return link points. */
  otherReturnTo: string;
  /** Where the Memberships card's return link points. */
  membershipsReturnTo: string;
  onRemoved: (message: string, isError: boolean) => void;
}) {
  const db = useDB();
  const toast = useToast();
  const navigate = useNavigate();
  const [checkout, setCheckout] = useState<{ items: CartItem[]; title: string } | null>(null);
  const [capacityConflict, setCapacityConflict] = useState<CheckoutCapacityError | null>(null);
  const [preview, setPreview] = useState<CartPreviewState>({ status: 'loading' });

  // Phase 3 (data-layer-scale): this scope's cross-event registration set —
  // shape #2 ("mine", synchronous) for the personal cart, shape #5 (by-club,
  // cross-event) for a managed-club section. Both hooks are always called
  // (Rules of Hooks — CartScope is shared by both cases via `isClub`); the
  // unused one is a harmless no-op subscription (useClubRegistrations(null)
  // is explicitly null-tolerant, mirroring useEventRegistrations).
  const myRegs = useMyRegistrations();
  const clubRegsResult = useClubRegistrations(isClub ? ownerKey : null);
  const regs = isClub ? clubRegsResult.rows : myRegs;
  // "mine" is Tier 2/synchronous — never loading. A club scope can be.
  const regsReady = isClub ? clubRegsResult.status === 'ready' : true;

  const groups = useMemo(() => groupCartItems(cart, db), [cart, db]);
  // H5: only show the "checkout everything" bar when it aggregates 2+
  // sections — with a single CartCard, that card's own subtotal +
  // checkout button IS the checkout-everything action, so a second,
  // identical bar (let alone one duplicated top AND bottom) is pure
  // redundancy, not a second choice.
  const showEverythingBar = cartSectionCount(groups) >= 2;

  // S4 (money-story UX): fetch a server price preview for this scope's ENTIRE
  // cart (`create-checkout-session { mode: 'preview' }`) whenever its
  // contents change, so the cart can replace the stale, client-written
  // `cart_items.amount` with the same price the server would actually
  // charge. Keyed on a stable, order-independent id list rather than the
  // `cart` array reference (mutate() mutates db.carts in place — the M6 trap
  // — so a reference-keyed effect could miss a real change or refire on a
  // no-op resync). Never blocks or empties the cart: a failed/loading
  // preview just means the stored amounts stay on screen (see
  // `pricedAmount`/`CartPreviewState`). Deliberately does NOT reset state to
  // `'loading'` synchronously at the top of the effect (an ESLint-flagged
  // cascading-render trap, CLAUDE.md "no synchronous setState in a useEffect
  // body") — a stale-but-loaded preview just stays on screen, unlabelled,
  // until the refetch resolves, which reads better than flickering back to
  // "Estimated" on every cart edit anyway.
  const cartIdsKey = cart.map((i) => i.id).slice().sort().join(',');
  useEffect(() => {
    if (cart.length === 0) return;
    let cancelled = false;
    void previewCartTotal({ cartItemIds: cart.map((i) => i.id) })
      .then((r) => {
        if (cancelled) return;
        if (r.ok && r.lines && r.total != null && r.serviceFee != null) {
          setPreview({ status: 'loaded', lines: r.lines, total: r.total, serviceFee: r.serviceFee });
        } else {
          setPreview({ status: 'failed' });
        }
      })
      .catch(() => { if (!cancelled) setPreview({ status: 'failed' }); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cartIdsKey]);

  // "We updated these prices to today's rates" (spec §1): which lines'
  // server price differs from what's currently displayed, once the preview
  // has actually landed (never computed against a failed/loading preview —
  // there's nothing authoritative to diff against yet).
  const diffLines = preview.status === 'loaded'
    ? diffCartLinePrices(cart.map((i) => ({ id: i.id, label: i.label, amount: i.amount })), preview.lines)
    : [];
  // The server's total (subtotal − discount + service fee, in dollars) once
  // loaded — this is what "Check out everything" would actually charge, so
  // it's what the cart's own "Total" bars show. Falls back to the stored,
  // fee-less client sum (labelled "Estimated") until then.
  const scopeTotal = preview.status === 'loaded' ? preview.total / 100 : sum(cart);
  const totalEstimated = preview.status !== 'loaded';

  // event-mgmt v2 Phase 5 A3: where this scope answers a nationals
  // session-planning survey — the club's registrations page for a club cart,
  // My Registrations for a self cart (mirrors `goPickSession` below).
  const surveyReturnTo = isClub ? `/club/${ownerKey}/registrations` : '/me/registrations';

  // A 400 session-survey-required rejection is the server-authoritative
  // fallback for the advisory gate below (e.g. a survey answered/unanswered
  // by someone else between the client check and the request landing).
  const goAnswerSurvey = (eventName: string) => {
    toast(`Answer the nationals session-planning survey for ${eventName} before checking out.`, { variant: 'error' });
    navigate(surveyReturnTo);
  };

  // (b) "Pick a different session" / the 400 session-required path both land
  // here: no clean deep-link into the registration editor exists from the
  // /cart page (that state lives in Club.tsx/MyRegistrations.tsx), so this
  // is the documented minimal hook — toast + navigate to the reg page, same
  // as the brief allows.
  const goPickSession = (eventId: string) => {
    const event = db.events.find((e) => e.id === eventId);
    toast(`Pick a session for each entry at ${event?.name ?? 'this event'}, then re-add it to your cart.`, { variant: 'error' });
    navigate(isClub ? `/club/${ownerKey}/registrations` : '/me/registrations');
  };

  // Syncs the underlying registration(s)/membership via removeCartItemWithSync
  // (unified-cart-b2 Task A; extended for H5/H6 2026-07-02): a brand-new unpaid
  // entry line is deleted entirely; a "change" fee line with a captured
  // snapshot reverts the registration(s) to their pre-change values; a legacy
  // "change" line with no snapshot just removes the cart line (toasted
  // honestly — nothing to revert to); a member-pushed membership line clears
  // that member's club-payment hold; anything else (addon/other) is
  // unaffected, same as before. H5: if a registration this line referenced is
  // STILL referenced by another cart line, it's left alone (not
  // deleted/reverted) — `keptRegIds` names those so the toast is honest about
  // what actually happened.
  //
  // M9 (smallest useful step): before removing, check for a `pending`
  // payments row (self-read RLS — db.payments only ever holds the caller's
  // OWN rows) whose cart_item_ids include this item. A pending row means a
  // Stripe Embedded Checkout session may be open in another tab/window right
  // now for this exact line; removing it here wouldn't cancel that session,
  // so if it later completes the webhook would fulfill against a cart line
  // that's already gone. Full session-expiry/cancellation is out of scope
  // (Phase-3 territory per the plan) — this only adds an explicit confirm.
  const removeItem = (item: CartItem) => {
    // Phase 3 completeness guard: removeCartItemWithSync's never-resurrect
    // check needs the COMPLETE registration set for this scope — a partial
    // (still-loading) `regs` could make a legitimate revert silently no-op
    // instead of restoring the registration's prior state.
    if (!regsReady) {
      toast('Still loading — try again in a moment.', { variant: 'error' });
      return;
    }
    const inFlight = (db.payments ?? []).some(
      (p) => p.status === 'pending' && p.cartItemIds.includes(item.id),
    );
    if (inFlight && !window.confirm(
      'A checkout for this item may be in progress (in this tab or another). ' +
      'Removing it now could cause a payment to complete for an item that’s no longer in your cart. Remove anyway?',
    )) {
      return;
    }
    const { action, keptRegIds } = removeCartItemWithSync(ownerKey, isClub, item, regs);
    // Offline read-only gate: nothing was removed; mutate() already toasted.
    if (action === 'blocked-offline') return;
    const message = CART_REMOVAL_MESSAGE[action];
    const keptNote = keptRegIds.length > 0
      ? ` (${keptRegIds.length === 1 ? 'One registration was' : `${keptRegIds.length} registrations were`} kept — another cart line still covers ${keptRegIds.length === 1 ? 'it' : 'them'}.)`
      : '';
    onRemoved(message + keptNote, action === 'no-snapshot-remove-only');
  };

  const onPaid = () => {
    // The invoice, registrations, and cart lines are all written by the webhook —
    // pull the fresh snapshot so the UI reflects them. Do NOT mutate locally.
    void syncFromSupabase().finally(() => {
      setCheckout(null);
      toast('Payment complete. Receipt emailed and saved to your Purchase History.');
    });
  };

  if (checkout) {
    return (
      <div style={{ maxWidth: 620 }}>
        {/* H5: the page-level subtitle (CartInner / ManagedClubSection) already
            states "Billed to {name}." above this — don't repeat it here. */}
        <div style={{ marginBottom: 14 }}>
          <button className="btn ghost small" onClick={() => setCheckout(null)}>← Back to cart</button>
        </div>
        <CartCheckout
          items={checkout.items}
          title={checkout.title}
          onPaid={onPaid}
          onError={(msg) => toast(msg, { variant: 'error' })}
          onCapacityConflict={(err) => { setCheckout(null); setCapacityConflict(err); }}
          onSessionRequired={(err) => { setCheckout(null); goPickSession(err.eventId); }}
          onSurveyRequired={(err) => { setCheckout(null); goAnswerSurvey(err.eventName); }}
        />
      </div>
    );
  }

  // Rendered as an overlay ON TOP of whatever's below (Modal is its own
  // fixed-position veil) rather than replacing the cart body — same
  // ReceiptsSection-detail-modal idiom used elsewhere in this file — so
  // dismissing it (or resolving it) lands back on a live cart, not a blank
  // page.
  const conflictDialog = capacityConflict && (
    <CapacityConflictDialog
      eventId={capacityConflict.eventId}
      eventName={capacityConflict.eventName}
      violations={capacityConflict.violations}
      ownerKey={ownerKey}
      isClub={isClub}
      onClose={() => setCapacityConflict(null)}
      onResolved={(msg) => toast(msg)}
      onPickSession={goPickSession}
    />
  );

  if (cart.length === 0) {
    return <>{conflictDialog}<p style={{ color: 'var(--ink-soft)' }}>Cart is empty.</p></>;
  }

  // event-mgmt v2 Phase 5 A3: gate every checkout entry point (everything +
  // each bucket below) on unanswered required nationals surveys among that
  // bucket's OWN incoming regs — matches the server's per-line scoping
  // exactly (a bucket that doesn't reference a nationals event's regs is
  // never blocked by another bucket's missing survey).
  const everythingSurveyGate = surveyGateForItems(cart, regs, db);
  const everythingSurveyBlocked = everythingSurveyGate.length > 0;

  const checkoutAllButton = (
    <button
      className="btn primary"
      onClick={() => setCheckout({ items: cart, title: 'Everything' })}
      disabled={everythingSurveyBlocked}
      title={everythingSurveyBlocked
        ? `Answer the nationals session-planning survey for ${everythingSurveyGate.map((g) => g.eventName).join(', ')} first.`
        : undefined}
    >
      Check out everything →
    </button>
  );
  const printAllButton = (
    <button className="btn ghost" onClick={() => downloadCartInvoice(cart, name, 'Everything')}>
      Print Invoice
    </button>
  );

  return (
    <div>
      {conflictDialog}
      {/* S4: the price-agreement notice/fallback sits ABOVE the totals bar —
          "above the totals" per spec §1 — so it's the first thing explaining
          why a number moved, before the number itself. */}
      {diffLines.length > 0 && (
        <div className="card card-pad" style={{ marginBottom: 14, background: 'var(--ice-100)', border: '1px solid var(--ice-300)' }}>
          <strong style={{ display: 'block', marginBottom: 6, color: 'var(--navy-800)', fontSize: 14 }}>
            We updated these prices to today&rsquo;s rates
          </strong>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13.5, color: 'var(--navy-700)' }}>
            {diffLines.map((d) => (
              <li key={d.itemId}>{d.label}: {fmtMoney(d.oldDollars)} → {fmtMoney(d.newDollars)}</li>
            ))}
          </ul>
        </div>
      )}
      {preview.status === 'failed' && (
        <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--ink-soft)' }}>
          Showing estimated prices — final total is confirmed at checkout.
        </p>
      )}
      {/* H5: "checkout everything" only means something distinct from a single
          section's own checkout button once there are 2+ sections — and when
          it does render, it renders ONCE, at the top (no bottom duplicate). */}
      {showEverythingBar && (
        <>
          <div className="card card-pad" style={{ marginBottom: 14, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 16, marginRight: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>Total: {fmtMoney(scopeTotal)}</span>
              {totalEstimated && <Badge tone="info">Estimated</Badge>}
            </strong>
            {printAllButton}
            {checkoutAllButton}
          </div>
          {everythingSurveyBlocked && (
            <p style={{ margin: '-6px 0 14px', fontSize: 13, color: 'var(--coral-600)' }}>
              "Check out everything" is blocked: answer the nationals session-planning survey for{' '}
              {everythingSurveyGate.map((g) => g.eventName).join(', ')} — <Link to={surveyReturnTo}>answer it here</Link>.
              Individual sections not affected by that event can still be checked out separately.
            </p>
          )}
        </>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {groups.membership.length > 0 && (
          <CartCard title="Memberships" items={groups.membership} preview={preview} returnTo={membershipsReturnTo} returnLabel="Check out Memberships"
            onCheckout={() => setCheckout({ items: groups.membership, title: 'Memberships' })}
            onRemove={removeItem}
            onPrintInvoice={() => downloadCartInvoice(groups.membership, name, 'Memberships')}
            surveyGate={surveyGateForItems(groups.membership, regs, db)}
            surveyReturnTo={surveyReturnTo} />
        )}
        {groups.events.map((g) => {
          const event = db.events.find((e) => e.id === g.eventId);
          const configured = !!event && hasCapacityConfig(event, event.sessions);
          const holdMs = configured ? earliestHoldMs(g.items, regs) : null;
          return (
            <CartCard key={g.eventId} title={g.eventName} items={g.items} preview={preview}
              returnTo={registrationsReturnTo(g.slug)} returnLabel="Return to registration"
              onCheckout={() => setCheckout({ items: g.items, title: g.eventName })}
              onRemove={removeItem}
              onPrintInvoice={() => downloadCartInvoice(g.items, name, g.eventName)}
              holdExpiresAtMs={holdMs}
              surveyGate={surveyGateForItems(g.items, regs, db)}
              surveyReturnTo={surveyReturnTo} />
          );
        })}
        {groups.other.length > 0 && (
          <CartCard title="Other" items={groups.other} preview={preview} returnTo={otherReturnTo} returnLabel="Browse"
            onCheckout={() => setCheckout({ items: groups.other, title: 'Other' })}
            onRemove={removeItem}
            onPrintInvoice={() => downloadCartInvoice(groups.other, name, 'Other')}
            surveyGate={surveyGateForItems(groups.other, regs, db)}
            surveyReturnTo={surveyReturnTo} />
        )}
      </div>
    </div>
  );
}

/** Receipts/invoices history for one billing scope (a club, or `null` for the
 *  signed-in person's own individual invoices) — search + date filter +
 *  detail modal + PDF download. Adapted from Club.tsx's retired `ClubCart`. */
function ReceiptsSection({ clubId, forName }: { clubId: string | null; forName: string }) {
  const db = useDB();
  const fmtDate = useFmtDate();
  const [detail, setDetail] = useState<Invoice | null>(null);
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  // S4 (money-story UX §2): same "receipts only" treatment as PurchaseHistory
  // — an unpaid invoice is not a supported member/manager-facing state.
  const allInvoices = useMemo(() =>
    db.invoices
      .filter((i) => i.clubId === clubId && i.paidAt != null)
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [db.invoices, clubId],
  );
  const invoices = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allInvoices.filter((inv) => {
      if (from && inv.createdAt.slice(0, 10) < from) return false;
      if (to && inv.createdAt.slice(0, 10) > to) return false;
      if (!q) return true;
      if (inv.number.toLowerCase().includes(q)) return true;
      const totalStr = fmtMoney(invoiceTotal(inv));
      if (totalStr.includes(q)) return true;
      return inv.items.some((it) => it.label.toLowerCase().includes(q));
    });
  }, [allInvoices, search, from, to]);

  return (
    <div style={{ marginTop: 4 }}>
      <h3 className="card-title" style={{ marginBottom: 10 }}>Receipts</h3>
      {allInvoices.length > 0 && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 12, flexWrap: 'wrap', alignItems: 'end' }}>
          <div style={{ flex: '1 1 180px', minWidth: 140 }}>
            <label style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.04em', color: 'var(--navy-700)', display: 'block', marginBottom: 5 }}>Search</label>
            <input className="input" type="text" value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Name, item, amount…" />
          </div>
          <div style={{ minWidth: 120 }}>
            <label style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.04em', color: 'var(--navy-700)', display: 'block', marginBottom: 5 }}>From</label>
            <input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div style={{ minWidth: 120 }}>
            <label style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.04em', color: 'var(--navy-700)', display: 'block', marginBottom: 5 }}>To</label>
            <input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          {(search || from || to) && (
            <button className="btn small ghost" style={{ marginBottom: 2 }}
              onClick={() => { setSearch(''); setFrom(''); setTo(''); }}>Clear</button>
          )}
        </div>
      )}
      {allInvoices.length === 0 ? <p style={{ color: 'var(--ink-soft)' }}>No receipts yet.</p>
      : invoices.length === 0 ? <p style={{ color: 'var(--ink-soft)' }}>No receipts match your filters.</p>
      : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {invoices.map((inv) => (
            <div key={inv.id} className="card card-pad">
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                <strong>{inv.number}</strong>
                <span style={{ color: 'var(--ink-soft)', fontSize: 13 }}>{fmtDate(inv.createdAt.slice(0, 10))}</span>
                <Badge tone="ok">Paid</Badge>
                <strong style={{ marginLeft: 'auto' }}>{fmtMoney(invoiceTotal(inv))}</strong>
              </div>
              <p style={{ margin: '8px 0 10px', fontSize: 14, color: 'var(--ink-soft)' }}>
                {inv.items.filter((i) => i.kind !== 'discount').map((i) => i.label).join('; ')}
              </p>
              <button className="btn small ghost" onClick={() => setDetail(inv)}>View details →</button>
            </div>
          ))}
        </div>
      )}

      {detail && (
        <Modal title={`Receipt ${detail.number}`} onClose={() => setDetail(null)}>
          <div style={{ fontSize: 13.5, color: 'var(--ink-soft)', marginBottom: 12 }}>
            {fmtDate(detail.createdAt.slice(0, 10))} · Paid · Billed to {forName}
          </div>
          {(() => {
            const lineItems = detail.items.filter((i) => i.kind !== 'discount');
            const subtotal = lineItems.reduce((s, i) => s + (i.refunded ? 0 : i.amount), 0);
            const discount = -detail.items.filter((i) => i.kind === 'discount').reduce((s, i) => s + (i.refunded ? 0 : i.amount), 0);
            const total = subtotal - discount;
            return (
              <table className="tbl" style={{ marginBottom: 12 }}>
                <tbody>
                  {lineItems.map((i) => (
                    <tr key={i.id}>
                      <td>{i.label}{i.refunded ? ' (refunded)' : ''}</td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{fmtMoney(i.refunded ? 0 : i.amount)}</td>
                    </tr>
                  ))}
                  {discount > 0 && (
                    <>
                      <tr style={{ borderTop: '1px solid var(--line)' }}>
                        <td style={{ color: 'var(--ink-soft)' }}>Subtotal</td>
                        <td style={{ textAlign: 'right', color: 'var(--ink-soft)' }}>{fmtMoney(subtotal)}</td>
                      </tr>
                      <tr>
                        <td style={{ color: 'var(--ink-soft)' }}>Promo code{detail.couponCode ? ` (${detail.couponCode})` : ''}</td>
                        <td style={{ textAlign: 'right', color: 'var(--ink-soft)' }}>−{fmtMoney(discount)}</td>
                      </tr>
                    </>
                  )}
                  <tr style={{ borderTop: '2px solid var(--navy-800)', fontWeight: 700 }}>
                    <td>Total{discount > 0 ? ' paid' : ''}</td>
                    <td style={{ textAlign: 'right' }}>{fmtMoney(total)}</td>
                  </tr>
                </tbody>
              </table>
            );
          })()}
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn primary" onClick={() => downloadReceipt(detail, forName)}>Download receipt (PDF)</button>
            <button className="btn ghost" onClick={() => setDetail(null)}>Close</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** One managed club's cart section: heading with the club's name, its own
 *  CartScope (grouping/checkout/print/edit-link/delete), and its own Receipts
 *  section filtered to that club's invoices. */
function ManagedClubSection({ club }: { club: Club }) {
  const db = useDB();
  const toast = useToast();
  const cart = db.carts[club.id] ?? [];

  // Cross-club cart cleanup (3d): run whenever this section renders so a
  // manager visiting /cart also gets the moot-pending-line cleanup that used
  // to only fire on the old dedicated ClubCart page / the registrations view.
  // M6 audit note (same as Club.tsx's EventRegGrid copy of this effect): `db`
  // is a stable reference across in-place mutate() calls, so this only
  // re-fires on mount/`club.id` change or a full resync — judged safe for the
  // same reason (idempotent, no-op when clean, and the staleness it targets
  // is a cross-manager/cross-tab condition that surfaces via resync anyway).
  //
  // Phase 3: needs this club's cross-event registrations (CONTRACT shape #5)
  // — a club cart can hold pending lines for multiple events. Gated on
  // 'ready' (mirrors Club.tsx's EventRegGrid copy of this effect).
  const clubRegsAllEvents = useClubRegistrations(club.id);
  useEffect(() => {
    if (clubRegsAllEvents.status !== 'ready') return;
    cleanupCrossClubCart(db, clubRegsAllEvents.rows, club.id, toast);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, club.id, clubRegsAllEvents.status]);

  return (
    <section style={{ marginTop: 32 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
        <h2 className="page-title display" style={{ fontSize: 22, margin: 0 }}>{club.shortName || club.name} cart</h2>
        <Link to={`/club/${club.id}/roster`} style={{ fontSize: 13 }}>← Back to club page</Link>
      </div>
      <p className="page-sub" style={{ marginTop: 2 }}>
        Memberships pushed to the club, event entries, and add-ons. Billed to {club.shortName || club.name}.
      </p>

      <CartScope
        cart={cart}
        ownerKey={club.id}
        isClub
        name={club.shortName || club.name}
        registrationsReturnTo={() => `/club/${club.id}/registrations`}
        otherReturnTo={`/club/${club.id}/registrations`}
        membershipsReturnTo={`/club/${club.id}/registrations`}
        onRemoved={(message, isError) => toast(message, isError ? { variant: 'error' } : undefined)}
      />

      <div style={{ marginTop: 20 }}>
        <ReceiptsSection clubId={club.id} forName={club.shortName || club.name} />
      </div>
    </section>
  );
}

/** View Cart (topbar): the signed-in person's cart, grouped into a card per event
 *  plus a Memberships card, each with a "return to registration" link and its own
 *  checkout — or check out everything at once — PLUS, for every club this person
 *  manages, a separate section below showing that club's cart the same way, with
 *  its own receipts history. Every group pays via Stripe Embedded Checkout
 *  (`CartCheckout`); the verified webhook does all fulfillment (invoice,
 *  registrations, cart clearing, receipt) server-side. Cross-entity "checkout
 *  everything" spanning personal + multiple clubs in one Stripe session is out of
 *  scope — the billing model assumes one payer per session, so each scope keeps
 *  its own checkout-all button. */
export function Cart() {
  const caps = useCapabilities();
  const db = useDB();
  if (!caps.person) {
    return (
      <div className="card card-pad" style={{ maxWidth: 520 }}>
        <h2 className="display" style={{ fontSize: 22 }}>Sign in to view your cart</h2>
      </div>
    );
  }
  const managedClubs = caps.managedClubIds
    .map((id) => db.clubs.find((c) => c.id === id))
    .filter((c): c is Club => !!c);
  return (
    <CartInner
      personId={caps.person.id}
      name={`${caps.person.firstName} ${caps.person.lastName}`}
      managedClubs={managedClubs}
    />
  );
}

function CartInner({ personId, name, managedClubs }: { personId: string; name: string; managedClubs: Club[] }) {
  const db = useDB();
  const toast = useToast();
  // NOT memoized: `mutate()` mutates the shared db object in place rather than
  // replacing it, so `db.carts` never gets a new reference for useMemo to key
  // off — a memo here would silently go stale after any local cart mutation
  // (e.g. removeItem below). useDB()'s own subscription already re-renders
  // this component on every store change, so reading fresh here is correct
  // and cheap (a plain property lookup, not a real computation).
  const cart = db.carts[personId] ?? [];

  return (
    <div style={{ maxWidth: 820 }}>
      <h1 className="page-title display">Your Cart</h1>
      <p className="page-sub">Billed to {name}. Check out one section, or everything at once.</p>

      <CartScope
        cart={cart}
        ownerKey={personId}
        isClub={false}
        name={name}
        registrationsReturnTo={(slug) => (slug ? `/events/${slug}` : '/events')}
        otherReturnTo="/events"
        membershipsReturnTo="/cart/memberships"
        onRemoved={(message, isError) => toast(message, isError ? { variant: 'error' } : undefined)}
      />

      {managedClubs.map((club) => (
        <ManagedClubSection key={club.id} club={club} />
      ))}
    </div>
  );
}

/** Memberships-only checkout: a focused page showing ONLY the membership line
 *  items in the signed-in person's cart and the Stripe Embedded Checkout form.
 *  Paying creates a Stripe session (`create-checkout-session`, which recomputes
 *  every amount server-side) via `CartCheckout`; the verified `stripe-webhook`
 *  fulfills server-side (activates memberships, writes the invoice, clears the
 *  cart lines, emails the receipt). This page owns the success state; the
 *  reusable `CartCheckout` owns the form. No local mutation on the pay path. */
export function MembershipsCheckout() {
  const caps = useCapabilities();
  if (!caps.person) {
    return (
      <div className="card card-pad" style={{ maxWidth: 520 }}>
        <h2 className="display" style={{ fontSize: 22 }}>Sign in to check out</h2>
      </div>
    );
  }
  return <MembershipsCheckoutInner personId={caps.person.id} name={`${caps.person.firstName} ${caps.person.lastName}`} />;
}

function MembershipsCheckoutInner({ personId, name }: { personId: string; name: string }) {
  const db = useDB();
  const toast = useToast();
  // Not memoized on `db.carts` — see the stale-memo note on CartInner's `cart` above;
  // same reasoning applies (a plain lookup + filter here is cheap either way).
  const items = (db.carts[personId] ?? []).filter((i) => i.kind === 'membership');
  const [paid, setPaid] = useState(false);

  const onPaid = () => {
    // Memberships, invoice, and cart lines are all written by the webhook — pull
    // the fresh snapshot so the UI reflects them. Do NOT mutate locally.
    void syncFromSupabase().finally(() => {
      setPaid(true);
      toast('Membership activated. Receipt emailed and saved to your Purchase History.');
    });
  };

  const onError = (msg: string) => {
    toast(msg, { variant: 'error' });
  };

  return (
    <div style={{ maxWidth: 620 }}>
      <h1 className="page-title display">Checkout — Memberships</h1>
      <p className="page-sub">Billed to {name}.</p>
      {!paid && (
        <div style={{ marginBottom: 14 }}>
          <Link className="btn ghost small" to="/cart">← Back to cart</Link>
        </div>
      )}

      {paid ? (
        <div className="card card-pad" style={{ maxWidth: 520 }}>
          <h3 className="card-title" style={{ marginTop: 0, color: 'var(--ink)' }}>
            Payment complete
          </h3>
          <p style={{ color: 'var(--ink-soft)' }}>
            Your membership is activated. A receipt has been emailed to you and saved
            to your Purchase History.
          </p>
          <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
            <Link className="btn primary small" to="/membership">View membership</Link>
            <Link className="btn ghost small" to="/profile">Purchase history</Link>
          </div>
        </div>
      ) : items.length === 0 ? (
        <div className="card card-pad">
          <p style={{ color: 'var(--ink-soft)' }}>No memberships in your cart.</p>
        </div>
      ) : (
        <CartCheckout items={items} title="Memberships" onPaid={onPaid} onError={onError} />
      )}
    </div>
  );
}

export default Cart;
