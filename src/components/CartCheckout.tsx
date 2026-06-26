import { useEffect, useRef, useState } from 'react';
import { fmtMoney } from '../lib/scoring';
import { createCheckoutSession } from '../lib/supabase';
import { StripeCheckout } from './StripeCheckout';
import type { CartItem } from '../lib/types';

type Stage =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'checkout'; clientSecret: string; paymentId: string; amountSubtotal: number; serviceFee: number };

/** Reusable Stripe Embedded Checkout for an arbitrary set of cart lines.
 *  Creates the checkout session once on mount (`create-checkout-session`, which
 *  recomputes every amount server-side — the cart `amount`s are display-only),
 *  shows a server-authoritative Subtotal / Service fee / Total summary, and
 *  renders the embedded form. The verified `stripe-webhook` does ALL fulfillment
 *  server-side; this component performs NO local mutation. It does NOT render a
 *  success state and does NOT sync — on a genuine `paid` it calls `onPaid()` and
 *  lets the parent own post-payment UI/sync. */
export function CartCheckout({
  items,
  title,
  onPaid,
  onError,
}: {
  items: CartItem[];
  title: string;
  onPaid: () => void;
  onError?: (msg: string) => void;
}) {
  const [stage, setStage] = useState<Stage>({ kind: 'loading' });
  // Create the session once. In dev, StrictMode's mount→unmount→remount resets
  // this per-instance ref and can create one extra test-mode session that simply
  // expires; a production build fires exactly once.
  const startedRef = useRef(false);

  useEffect(() => {
    if (items.length === 0 || startedRef.current) return;
    startedRef.current = true;
    void createCheckoutSession({ cartItemIds: items.map((i) => i.id) })
      .then((r) => {
        if (r.ok && r.clientSecret && r.paymentId && r.amountSubtotal != null && r.serviceFee != null) {
          setStage({ kind: 'checkout', clientSecret: r.clientSecret, paymentId: r.paymentId, amountSubtotal: r.amountSubtotal, serviceFee: r.serviceFee });
        } else {
          const msg = r.error ?? 'Could not start checkout. Please try again.';
          setStage({ kind: 'error', message: msg });
          onError?.(msg);
        }
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : 'Could not start checkout. Please try again.';
        setStage({ kind: 'error', message: msg });
        onError?.(msg);
      });
  }, [items, onError]);

  const retry = () => {
    startedRef.current = false;
    setStage({ kind: 'loading' });
  };

  const handleError = (msg: string) => {
    setStage({ kind: 'error', message: msg });
    onError?.(msg);
  };

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

  // Authoritative dollar amounts (server returns CENTS) for the summary.
  const summary = {
    subtotal: stage.amountSubtotal / 100,
    serviceFee: stage.serviceFee / 100,
    total: (stage.amountSubtotal + stage.serviceFee) / 100,
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
        <div style={{ borderTop: '1px solid var(--line)', margin: '10px 0 0', paddingTop: 10, fontSize: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
            <span style={{ color: 'var(--ink-soft)' }}>Subtotal</span>
            <span>{fmtMoney(summary.subtotal)}</span>
          </div>
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
