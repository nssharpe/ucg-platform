import { useEffect, useRef, useState } from 'react';
import { fmtMoney } from '../lib/scoring';
import {
  createCheckoutSession, fetchPaymentStatus, previewCartTotal,
  type CheckoutCapacityError, type CheckoutSessionRequiredError, type CheckoutSurveyRequiredError,
} from '../lib/supabase';
import { checkoutMode } from '../lib/pricing';
import { StripeCheckout } from './StripeCheckout';
import type { CartItem } from '../lib/types';

const FREE_POLL_MS = 1500;
const FREE_MAX_TRIES = 20; // ~30s — the server already ran fulfillment synchronously
                            // before returning `free:true`, so this should resolve fast.

type Stage =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | {
      // UAT M-12-01: a write-free `mode: 'preview'` call came back $0
      // (`checkoutMode` — post-discount subtotal plus service fee, service
      // fee itself 0 on a $0 subtotal). The real endpoint fulfills a $0
      // order immediately and unconditionally once called, so this stage
      // exists specifically to stop and require an explicit click before
      // that happens — never auto-advance out of it.
      kind: 'confirm-free';
      amountSubtotal: number; discountAmount: number; couponCode?: string; submitting: boolean;
    }
  | {
      kind: 'checkout'; clientSecret: string; paymentId: string;
      amountSubtotal: number; discountAmount: number; serviceFee: number; couponCode?: string;
    }
  | {
      // Free-order path (emv2 P3): a coupon covered the entire cost. The server
      // already fulfilled the order server-side before responding — no Stripe
      // form is mounted. We still CONFIRM via the same self-read poll
      // StripeCheckout uses (never claim success without checking the row) and
      // let the parent's onPaid own the success UI, same as the paid path.
      kind: 'free'; paymentId: string;
      amountSubtotal: number; discountAmount: number; couponCode?: string;
    };

/** The three structured rejections either endpoint (preview or real) can
 *  return — capacity/session/survey checks run identically in preview mode
 *  (see `previewCartTotal`'s doc comment in `supabase.ts`), so both call
 *  sites below need the exact same branching. */
interface CheckoutRejection {
  error?: string;
  capacityError?: CheckoutCapacityError;
  sessionRequiredError?: CheckoutSessionRequiredError;
  surveyRequiredError?: CheckoutSurveyRequiredError;
}

/** Reusable Stripe Embedded Checkout for an arbitrary set of cart lines.
 *  First runs a write-free price preview (`create-checkout-session { mode:
 *  'preview' }`) to learn the real total WITHOUT triggering the server's
 *  free-order fulfillment; only once that preview is authoritatively
 *  non-zero does it create the real session (recomputes every amount
 *  server-side — the cart `amount`s are display-only) and mount the Stripe
 *  form. A $0 preview instead stops on an explicit "Confirm — no charge"
 *  step (UAT M-12-01) — the real endpoint would otherwise fulfill a $0
 *  order immediately and unconditionally the moment it's called, with no
 *  chance to confirm first. Shows a server-authoritative Subtotal / Coupon /
 *  Service fee / Total summary either way. The verified `stripe-webhook` (or,
 *  for a $0 order, `create-checkout-session`'s own free-order branch) does
 *  ALL fulfillment server-side; this component performs NO local mutation.
 *  It does NOT render a success state and does NOT sync — on a genuine
 *  `paid` it calls `onPaid()` and lets the parent own post-payment UI/sync.
 *  A promo code can be applied before paying — the CODE is sent to the
 *  server, never a discount amount, and re-runs the preview (the amounts
 *  shown are always what the server just computed). */
export function CartCheckout({
  items,
  title,
  onPaid,
  onError,
  onCapacityConflict,
  onSessionRequired,
  onSurveyRequired,
}: {
  items: CartItem[];
  title: string;
  onPaid: () => void;
  onError?: (msg: string) => void;
  /** event-mgmt v2 P4 T6: a 409 capacity-exceeded rejection. When provided,
   *  this is called INSTEAD of showing the generic error stage — the caller
   *  (Cart.tsx) owns the resolution dialog and should dismiss this checkout
   *  view back to the cart. */
  onCapacityConflict?: (err: CheckoutCapacityError) => void;
  /** A 400 session-required rejection (by-session event, missing session pick). */
  onSessionRequired?: (err: CheckoutSessionRequiredError) => void;
  /** event-mgmt v2 Phase 5 A3: a 400 session-survey-required rejection — the
   *  server-authoritative fallback for the client's own advisory check
   *  (`missingNationalsSurveyEvents`, checked by the caller before this
   *  component even mounts a session). When provided, called INSTEAD of
   *  showing the generic error stage, same pattern as the two above. */
  onSurveyRequired?: (err: CheckoutSurveyRequiredError) => void;
}) {
  const [stage, setStage] = useState<Stage>({ kind: 'loading' });
  const [couponInput, setCouponInput] = useState('');
  const [couponBusy, setCouponBusy] = useState(false);
  // Create the session once on mount. In dev, StrictMode's mount→unmount→remount
  // resets this per-instance ref and can create one extra test-mode session that
  // simply expires; a production build fires exactly once.
  const startedRef = useRef(false);

  const handleRejection = (r: CheckoutRejection) => {
    if (r.capacityError && onCapacityConflict) { onCapacityConflict(r.capacityError); return; }
    if (r.sessionRequiredError && onSessionRequired) { onSessionRequired(r.sessionRequiredError); return; }
    if (r.surveyRequiredError && onSurveyRequired) { onSurveyRequired(r.surveyRequiredError); return; }
    const msg = r.error ?? 'Could not start checkout. Please try again.';
    setStage({ kind: 'error', message: msg });
    onError?.(msg);
  };

  // Creates the REAL session (mode default): the write that actually charges
  // a card, or — for a $0 cart — fulfills the order immediately. Only ever
  // called (a) from startPreview below once a non-zero preview total is
  // confirmed authoritative, or (b) from the "Confirm — no charge" button.
  // Deliberately does NOT touch `stage` before resolving in case (b): the
  // confirm-free card stays on screen with its button disabled
  // (stage.submitting) rather than flashing to the generic loading card.
  const startRealSession = (couponCode?: string) => {
    void createCheckoutSession({ cartItemIds: items.map((i) => i.id), couponCode })
      .then((r) => {
        if (r.ok && r.free && r.paymentId && r.amountSubtotal != null) {
          setStage({
            kind: 'free', paymentId: r.paymentId,
            amountSubtotal: r.amountSubtotal, discountAmount: r.discountAmount ?? 0, couponCode,
          });
        } else if (r.ok && r.clientSecret && r.paymentId && r.amountSubtotal != null && r.serviceFee != null) {
          setStage({
            kind: 'checkout', clientSecret: r.clientSecret, paymentId: r.paymentId,
            amountSubtotal: r.amountSubtotal, discountAmount: r.discountAmount ?? 0,
            serviceFee: r.serviceFee, couponCode,
          });
        } else {
          handleRejection(r);
        }
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : 'Could not start checkout. Please try again.';
        setStage({ kind: 'error', message: msg });
        onError?.(msg);
      })
      .finally(() => setCouponBusy(false));
  };

  // Write-free preview: decides free-confirm vs. Stripe WITHOUT ever risking
  // the real endpoint's immediate, unconditional $0 fulfillment. Re-run on
  // mount and on every coupon apply — a coupon can move a cart between the
  // two branches either direction.
  const startPreview = (couponCode?: string) => {
    setStage({ kind: 'loading' });
    void previewCartTotal({ cartItemIds: items.map((i) => i.id), couponCode })
      .then((r) => {
        if (r.ok && r.lines && r.amountSubtotal != null && r.total != null) {
          if (checkoutMode(r.total) === 'free-confirm') {
            setStage({
              kind: 'confirm-free', amountSubtotal: r.amountSubtotal,
              discountAmount: r.discountAmount ?? 0, couponCode, submitting: false,
            });
            setCouponBusy(false);
          } else {
            startRealSession(couponCode);
          }
        } else {
          handleRejection(r);
          setCouponBusy(false);
        }
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : 'Could not start checkout. Please try again.';
        setStage({ kind: 'error', message: msg });
        onError?.(msg);
        setCouponBusy(false);
      });
  };

  useEffect(() => {
    if (items.length === 0 || startedRef.current) return;
    startedRef.current = true;
    startPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  // H8 fix (2026-07-02): this used to just reset startedRef + stage and rely
  // on the mount effect above to re-fire startSession() — but that effect is
  // keyed on `[items]`, and every caller passes a stable, state-held `items`
  // reference (Cart.tsx `checkout.items` / `db.carts[...]`), so the effect's
  // dependency never actually changes and it never re-ran. Any transient
  // create-checkout-session failure stranded the user on "Try again" forever.
  // Call startPreview() directly instead of hoping the effect re-fires;
  // startedRef is still set so the mount effect (if it DOES ever re-run,
  // e.g. items legitimately changes) doesn't race a second session creation.
  const retry = () => {
    startedRef.current = true;
    startPreview();
  };

  const applyCoupon = () => {
    const code = couponInput.trim();
    if (!code) return;
    setCouponBusy(true);
    startPreview(code);
  };

  const confirmFree = () => {
    if (stage.kind !== 'confirm-free' || stage.submitting) return;
    setStage({ ...stage, submitting: true });
    startRealSession(stage.couponCode);
  };

  const handleError = (msg: string) => {
    setStage({ kind: 'error', message: msg });
    onError?.(msg);
  };

  // Free-order confirmation poll (emv2 P3): the server already ran
  // fulfillment synchronously before returning `free:true`, so the row
  // should already read `paid` — but we still poll the self-read `payments`
  // row rather than calling onPaid() on the mere presence of `free:true`.
  // Mirrors StripeCheckout's "never falsely claim success" rule.
  const freePaymentId = stage.kind === 'free' ? stage.paymentId : null;
  useEffect(() => {
    if (!freePaymentId) return;
    let tries = 0;
    let cancelled = false;
    const id = setInterval(() => {
      tries += 1;
      void fetchPaymentStatus(freePaymentId).then((res) => {
        if (cancelled) return;
        if (res?.status === 'paid') {
          clearInterval(id);
          onPaid();
        } else if (res?.status === 'failed') {
          clearInterval(id);
          handleError('This order could not be completed. Please try again.');
        } else if (tries >= FREE_MAX_TRIES) {
          clearInterval(id);
          handleError('Still confirming — check your Purchase History in a few minutes to confirm this order went through.');
        }
      });
    }, FREE_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [freePaymentId]);

  if (stage.kind === 'error') {
    return (
      <div className="card card-pad" style={{ maxWidth: 520 }}>
        <h3 className="card-title" style={{ marginTop: 0, color: 'var(--ink)' }}>Couldn’t start checkout</h3>
        <p style={{ color: 'var(--ink-soft)' }}>{stage.message}</p>
        <button className="btn primary small" onClick={retry}>Try again</button>
      </div>
    );
  }

  if (stage.kind === 'loading') {
    return (
      <div className="card card-pad">
        <p style={{ color: 'var(--ink-soft)', margin: 0 }}>Preparing your secure checkout…</p>
      </div>
    );
  }

  if (stage.kind === 'confirm-free') {
    const confirmSummary = { subtotal: stage.amountSubtotal / 100, discount: stage.discountAmount / 100 };
    return (
      <div className="card card-pad" style={{ maxWidth: 520 }}>
        <h3 className="card-title" style={{ marginTop: 0, color: 'var(--ink)' }}>{title}</h3>
        <div style={{ borderTop: '1px solid var(--line)', margin: '10px 0 0', paddingTop: 10, fontSize: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
            <span style={{ color: 'var(--ink-soft)' }}>Subtotal</span>
            <span>{fmtMoney(confirmSummary.subtotal)}</span>
          </div>
          {stage.couponCode && (
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginTop: 4, color: 'var(--teal-900)' }}>
              <span>Coupon {stage.couponCode}</span>
              <span>−{fmtMoney(confirmSummary.discount)}</span>
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginTop: 4 }}>
            <span style={{ color: 'var(--ink-soft)' }}>Service fee (card processing)</span>
            <span>{fmtMoney(0)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginTop: 8 }}>
            <strong style={{ fontSize: 16 }}>Total due</strong>
            <strong style={{ fontSize: 16 }}>{fmtMoney(0)}</strong>
          </div>
        </div>
        <p style={{ color: 'var(--ink-soft)', margin: '12px 0 0' }}>
          Your coupon covers the full cost — no payment needed. Confirm below to complete this order.
        </p>
        <button className="btn primary" style={{ marginTop: 12 }} onClick={confirmFree} disabled={stage.submitting}>
          {stage.submitting ? 'Confirming…' : 'Confirm — no charge'}
        </button>
      </div>
    );
  }

  if (stage.kind === 'free') {
    const freeSummary = { subtotal: stage.amountSubtotal / 100, discount: stage.discountAmount / 100 };
    return (
      <div className="card card-pad" style={{ maxWidth: 520 }}>
        <h3 className="card-title" style={{ marginTop: 0, color: 'var(--ink)' }}>Confirming your order…</h3>
        <div style={{ borderTop: '1px solid var(--line)', margin: '10px 0 0', paddingTop: 10, fontSize: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
            <span style={{ color: 'var(--ink-soft)' }}>Subtotal</span>
            <span>{fmtMoney(freeSummary.subtotal)}</span>
          </div>
          {stage.couponCode && (
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginTop: 4, color: 'var(--teal-900)' }}>
              <span>Coupon {stage.couponCode}</span>
              <span>−{fmtMoney(freeSummary.discount)}</span>
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginTop: 8 }}>
            <strong style={{ fontSize: 16 }}>Total due</strong>
            <strong style={{ fontSize: 16 }}>{fmtMoney(0)}</strong>
          </div>
        </div>
        <p style={{ color: 'var(--ink-soft)', margin: '12px 0 0' }}>
          Your coupon covers the full cost — no payment needed. We&rsquo;re finalizing your order now; this usually takes a few seconds.
        </p>
      </div>
    );
  }

  // Authoritative dollar amounts (server returns CENTS) for the summary.
  // amountSubtotal is PRE-discount; the discount is shown as its own line so
  // Subtotal - Coupon + Service fee = Total, with no double-counting.
  const summary = {
    subtotal: stage.amountSubtotal / 100,
    discount: stage.discountAmount / 100,
    serviceFee: stage.serviceFee / 100,
    total: (stage.amountSubtotal - stage.discountAmount + stage.serviceFee) / 100,
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="card card-pad">
        <h3 className="card-title" style={{ marginTop: 0 }}>{title}</h3>
        <ul style={{ margin: '10px 0', paddingLeft: 18, fontSize: 14 }}>
          {items.map((i) => (
            <li key={i.id}><span>{i.label}</span></li>
          ))}
        </ul>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginTop: 6 }}>
          <div style={{ flex: 1 }}>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 700, marginBottom: 4, color: 'var(--navy-700)' }}>
              Promo code
            </label>
            <input
              className="input"
              placeholder="e.g. EARLYBIRD"
              value={couponInput}
              onChange={(e) => setCouponInput(e.target.value)}
              disabled={couponBusy}
            />
          </div>
          <button className="btn ghost small" onClick={applyCoupon} disabled={couponBusy || !couponInput.trim()}>
            {couponBusy ? 'Applying…' : 'Apply'}
          </button>
        </div>
        {stage.couponCode && (
          summary.discount > 0
            ? <p style={{ color: 'var(--teal-900)', fontSize: 13, margin: '6px 0 0' }}>Code {stage.couponCode} applied.</p>
            : <p style={{ color: 'var(--coral-text)', fontSize: 13, margin: '6px 0 0' }}>Code {stage.couponCode} didn’t apply — it may be invalid, expired, or not valid for these items.</p>
        )}
        <div style={{ borderTop: '1px solid var(--line)', margin: '10px 0 0', paddingTop: 10, fontSize: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
            <span style={{ color: 'var(--ink-soft)' }}>Subtotal</span>
            <span>{fmtMoney(summary.subtotal)}</span>
          </div>
          {summary.discount > 0 && (
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginTop: 4, color: 'var(--teal-900)' }}>
              <span>Coupon {stage.couponCode}</span>
              <span>−{fmtMoney(summary.discount)}</span>
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginTop: 4 }}>
            <span style={{ color: 'var(--ink-soft)' }}>Service fee (card processing)</span>
            <span>{fmtMoney(summary.serviceFee)}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginTop: 8 }}>
            <strong style={{ fontSize: 16 }}>Total due</strong>
            <strong style={{ fontSize: 16 }}>{fmtMoney(summary.total)}</strong>
          </div>
        </div>
      </div>
      <StripeCheckout
        clientSecret={stage.clientSecret}
        paymentId={stage.paymentId}
        onPaid={onPaid}
        onError={handleError}
      />
    </div>
  );
}

export default CartCheckout;
