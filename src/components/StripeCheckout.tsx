import { useEffect, useRef, useState } from 'react';
import { loadStripe } from '@stripe/stripe-js';
import { EmbeddedCheckoutProvider, EmbeddedCheckout } from '@stripe/react-stripe-js';
import { fetchPaymentStatus } from '../lib/supabase';

// Create the Stripe instance ONCE at module scope (never inside render — a new
// promise per render re-initializes Stripe.js and breaks the embedded form).
const stripePromise = loadStripe(import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY ?? '');

const POLL_MS = 2000;
const MAX_TRIES = 30; // ~60s safety cap before we stop claiming anything.

type Phase = 'form' | 'confirming' | 'failed' | 'timeout';

/** Stripe Embedded Checkout for an already-created session. `onComplete` fires
 *  in-page (no redirect) when the card is accepted; we then poll the payments
 *  row (written `pending` by create-checkout-session, flipped `paid` by the
 *  verified webhook after server-side fulfillment) until it resolves. We NEVER
 *  show success here — the parent's `onPaid` owns the success UI, and we only
 *  call it once the row is genuinely `paid`. */
export function StripeCheckout({
  clientSecret,
  paymentId,
  onPaid,
  onError,
}: {
  clientSecret: string;
  paymentId: string;
  onPaid: () => void;
  onError?: (msg: string) => void;
}) {
  const [phase, setPhase] = useState<Phase>('form');
  // Keep callbacks current without retriggering the polling effect.
  const onPaidRef = useRef(onPaid);
  const onErrorRef = useRef(onError);
  useEffect(() => { onPaidRef.current = onPaid; onErrorRef.current = onError; });

  // Poll only while confirming. setInterval in an effect, cleared on unmount or
  // when we leave the confirming phase.
  useEffect(() => {
    if (phase !== 'confirming') return;
    let tries = 0;
    let cancelled = false;
    const id = setInterval(() => {
      tries += 1;
      void fetchPaymentStatus(paymentId).then((res) => {
        if (cancelled) return;
        if (res?.status === 'paid') {
          clearInterval(id);
          setPhase('form'); // reset internal state; parent swaps us out via onPaid
          onPaidRef.current();
        } else if (res?.status === 'failed') {
          clearInterval(id);
          setPhase('failed');
          onErrorRef.current?.('Payment failed. Please try again.');
        } else if (tries >= MAX_TRIES) {
          clearInterval(id);
          setPhase('timeout');
        }
      });
    }, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [phase, paymentId]);

  if (phase === 'confirming') {
    return (
      <div className="card card-pad" style={{ maxWidth: 520 }}>
        <h3 className="card-title" style={{ marginTop: 0, color: 'var(--ink)' }}>
          Confirming your payment…
        </h3>
        <p style={{ color: 'var(--ink-soft)', margin: 0 }}>
          Your card was accepted. We&rsquo;re finalizing your membership — this
          usually takes a few seconds. Please don&rsquo;t close this page.
        </p>
      </div>
    );
  }

  if (phase === 'failed') {
    return (
      <div className="card card-pad" style={{ maxWidth: 520 }}>
        <h3 className="card-title" style={{ marginTop: 0, color: 'var(--ink)' }}>
          Payment failed
        </h3>
        <p style={{ color: 'var(--ink-soft)', margin: 0 }}>
          Your payment could not be completed. Please go back and try again.
        </p>
      </div>
    );
  }

  if (phase === 'timeout') {
    return (
      <div className="card card-pad" style={{ maxWidth: 520 }}>
        <h3 className="card-title" style={{ marginTop: 0, color: 'var(--ink)' }}>
          Still confirming…
        </h3>
        <p style={{ color: 'var(--ink-soft)', margin: 0 }}>
          Your card was accepted but confirmation is taking longer than usual.
          No need to pay again — check your Purchase History in a few minutes to
          confirm your membership is active.
        </p>
      </div>
    );
  }

  return (
    // UAT G-05 (owner screenshot, 2026-08-27): the embedded Stripe iframe
    // used to sit flush against the card's bottom edge — `.card-pad`'s 20px
    // reads fine above/beside the form but Stripe's own iframe content
    // renders all the way to ITS edge, so the visual gap below the form
    // needs an explicit bottom padding to actually match the 20px top/side
    // `.card-pad` token; a bare `.card-pad` alone wasn't giving the inlay
    // breathing room in practice.
    <div className="card card-pad" style={{ paddingBottom: 20 }}>
      <EmbeddedCheckoutProvider
        stripe={stripePromise}
        options={{ clientSecret, onComplete: () => setPhase('confirming') }}
      >
        <EmbeddedCheckout />
      </EmbeddedCheckoutProvider>
    </div>
  );
}

export default StripeCheckout;
