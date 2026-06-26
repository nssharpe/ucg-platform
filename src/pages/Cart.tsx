import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useDB, mutate, syncFromSupabase } from '../lib/store';
import { useCapabilities } from '../lib/capabilities';
import { useToast } from '../components/ui-hooks';
import { fmtMoney } from '../lib/scoring';
import { pushInvoice, pushCart, pushRegistration, createCheckoutSession } from '../lib/supabase';
import { StripeCheckout } from '../components/StripeCheckout';
import type { CartItem, Invoice } from '../lib/types';

const sum = (items: CartItem[]) => items.reduce((s, i) => s + i.amount, 0);

/** Create the paid invoice for `items`, remove them from the person's cart, and
 *  return the new invoice (so callers can offer a receipt download / email it).
 *  Shared by the grouped cart and the memberships-only checkout. */
function completePurchase(personId: string, items: CartItem[]): Invoice | null {
  if (items.length === 0) return null;
  let created: Invoice | null = null;
  mutate((d) => {
    const inv: Invoice = {
      id: `inv-${Date.now()}`,
      number: `UCG-2026-${String(d.invoices.length + 1).padStart(4, '0')}`,
      clubId: null, athleteId: personId,
      createdAt: new Date().toISOString(), paidAt: new Date().toISOString(),
      items: items.map((i) => ({ ...i })),
    };
    d.invoices.push(inv);
    pushInvoice(inv);
    // 3f: flip the exact registrations this purchase covers to paid.
    const regIds = new Set(items.flatMap((i) => i.refRegIds ?? []));
    if (regIds.size > 0) {
      for (const reg of d.registrations) {
        if (regIds.has(reg.id)) {
          reg.paid = true;
          reg.updatedPending = false;
          pushRegistration(reg);
        }
      }
    }
    const ids = new Set(items.map((i) => i.id));
    d.carts[personId] = (d.carts[personId] ?? []).filter((i) => !ids.has(i.id));
    pushCart(personId, d.carts[personId], false);
    created = inv;
  });
  return created;
}

function CartCard({ title, items, returnTo, returnLabel, onPurchase }: {
  title: string; items: CartItem[]; returnTo: string; returnLabel: string; onPurchase: () => void;
}) {
  return (
    <div className="card card-pad">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <h3 className="card-title" style={{ margin: 0 }}>{title}</h3>
        <Link to={returnTo} style={{ marginLeft: 'auto', fontSize: 13 }}>{returnLabel} →</Link>
      </div>
      <ul style={{ margin: '10px 0', paddingLeft: 18, fontSize: 14 }}>
        {items.map((i) => (
          <li key={i.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
            <span>{i.label}</span><strong>{fmtMoney(i.amount)}</strong>
          </li>
        ))}
      </ul>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <strong>Subtotal: {fmtMoney(sum(items))}</strong>
        <button className="btn primary small" style={{ marginLeft: 'auto' }} onClick={onPurchase}>
          Purchase {title.toLowerCase()}
        </button>
      </div>
    </div>
  );
}

/** View Cart (topbar): the signed-in person's cart, grouped into a card per meet
 *  plus a Memberships card, each with a "return to registration" link and its own
 *  checkout — or purchase everything at once. */
export function Cart() {
  const caps = useCapabilities();
  if (!caps.person) {
    return (
      <div className="card card-pad" style={{ maxWidth: 520 }}>
        <h2 className="display" style={{ fontSize: 22 }}>Sign in to view your cart</h2>
      </div>
    );
  }
  return <CartInner personId={caps.person.id} name={`${caps.person.firstName} ${caps.person.lastName}`} />;
}

function CartInner({ personId, name }: { personId: string; name: string }) {
  const db = useDB();
  const toast = useToast();
  const cart = useMemo(() => db.carts[personId] ?? [], [db.carts, personId]);

  // Group: a card per meet (matched by name in the label), one "Memberships"
  // card, and an "Other" card for anything that doesn't match.
  const groups = useMemo(() => {
    const membership: CartItem[] = [];
    const byMeet = new Map<string, { meetName: string; slug: string | null; items: CartItem[] }>();
    const other: CartItem[] = [];
    for (const item of cart) {
      if (item.kind === 'membership') { membership.push(item); continue; }
      const meet = db.meets.find((m) => item.label.includes(m.name));
      if (meet) {
        const g = byMeet.get(meet.id) ?? { meetName: meet.name, slug: meet.slug, items: [] };
        g.items.push(item);
        byMeet.set(meet.id, g);
      } else {
        other.push(item);
      }
    }
    return { membership, meets: [...byMeet.values()], other };
  }, [cart, db.meets]);

  const purchase = (items: CartItem[], label: string) => {
    if (completePurchase(personId, items)) {
      toast(`Purchased ${label}. Receipt is in your Purchase History.`);
    }
  };

  if (cart.length === 0) {
    return (
      <div style={{ maxWidth: 720 }}>
        <h1 className="page-title display">Your Cart</h1>
        <p style={{ color: 'var(--ink-soft)' }}>Your cart is empty.</p>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 720 }}>
      <h1 className="page-title display">Your Cart</h1>
      <p className="page-sub">Billed to {name}. Purchase one section, or everything at once.</p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {groups.membership.length > 0 && (
          <CartCard title="Memberships" items={groups.membership} returnTo="/cart/memberships" returnLabel="Checkout Memberships"
            onPurchase={() => purchase(groups.membership, 'Memberships')} />
        )}
        {groups.meets.map((g) => (
          <CartCard key={g.meetName} title={g.meetName} items={g.items}
            returnTo={g.slug ? `/meets/${g.slug}` : '/meets'} returnLabel="Return to registration"
            onPurchase={() => purchase(g.items, g.meetName)} />
        ))}
        {groups.other.length > 0 && (
          <CartCard title="Other" items={groups.other} returnTo="/meets" returnLabel="Browse"
            onPurchase={() => purchase(groups.other, 'Other')} />
        )}
      </div>

      <div className="card card-pad" style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 12 }}>
        <strong style={{ fontSize: 16 }}>Total: {fmtMoney(sum(cart))}</strong>
        <button className="btn primary" style={{ marginLeft: 'auto' }} onClick={() => purchase(cart, 'everything in your cart')}>
          Purchase everything →
        </button>
      </div>
    </div>
  );
}

/** Memberships-only checkout: a focused page showing ONLY the membership line
 *  items in the signed-in person's cart, a service-fee line, the grand total, and
 *  a single Pay action. Paying creates a Stripe Embedded Checkout session
 *  (`create-checkout-session`, which recomputes every amount server-side) and
 *  renders the embedded form. The verified `stripe-webhook` fulfills server-side
 *  (activates memberships, writes the invoice, clears the cart lines, emails the
 *  receipt); the FE polls the payments row until `paid`, then re-syncs and shows
 *  a success state. No local mutation of memberships/cart on the pay path. */
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

type Stage =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'checkout'; clientSecret: string; paymentId: string; amountSubtotal: number; serviceFee: number }
  | { kind: 'paid' };

function MembershipsCheckoutInner({ personId, name }: { personId: string; name: string }) {
  const db = useDB();
  const toast = useToast();
  const cart = useMemo(() => db.carts[personId] ?? [], [db.carts, personId]);
  const items = useMemo(() => cart.filter((i) => i.kind === 'membership'), [cart]);
  const [stage, setStage] = useState<Stage>({ kind: 'loading' });
  // Create the checkout session once on mount. The cart `amount`s are
  // display-only — we drive the summary from the session's SERVER-recomputed
  // amounts so the total shown always equals what Stripe collects. (In dev,
  // StrictMode's mount→unmount→remount resets this per-instance ref and can
  // create one extra test-mode session that simply expires; a production build
  // does not double-invoke, so it fires exactly once.)
  const startedRef = useRef(false);

  useEffect(() => {
    if (items.length === 0 || startedRef.current) return;
    startedRef.current = true;
    void createCheckoutSession({ cartItemIds: items.map((i) => i.id) })
      .then((r) => {
        if (r.ok && r.clientSecret && r.paymentId && r.amountSubtotal != null && r.serviceFee != null) {
          setStage({ kind: 'checkout', clientSecret: r.clientSecret, paymentId: r.paymentId, amountSubtotal: r.amountSubtotal, serviceFee: r.serviceFee });
        } else {
          setStage({ kind: 'error', message: r.error ?? 'Could not start checkout. Please try again.' });
        }
      })
      .catch((e) => {
        setStage({ kind: 'error', message: e instanceof Error ? e.message : 'Could not start checkout. Please try again.' });
      });
  }, [items]);

  const onPaid = () => {
    // Memberships, invoice, and cart lines are all written by the webhook — pull
    // the fresh snapshot so the UI reflects them. Do NOT mutate locally.
    void syncFromSupabase().finally(() => {
      setStage({ kind: 'paid' });
      toast('Membership activated. Receipt emailed and saved to your Purchase History.');
    });
  };

  const onError = (msg: string) => {
    toast(msg, { variant: 'error' });
    setStage({ kind: 'error', message: msg });
  };

  const retry = () => {
    startedRef.current = false;
    setStage({ kind: 'loading' });
  };

  // Authoritative dollar amounts (server returns CENTS) for the summary.
  const summary = stage.kind === 'checkout'
    ? { subtotal: stage.amountSubtotal / 100, serviceFee: stage.serviceFee / 100, total: (stage.amountSubtotal + stage.serviceFee) / 100 }
    : null;

  return (
    <div style={{ maxWidth: 620 }}>
      <h1 className="page-title display">Checkout — Memberships</h1>
      <p className="page-sub">Billed to {name}.</p>
      {stage.kind !== 'paid' && (
        <div style={{ marginBottom: 14 }}>
          <Link className="btn ghost small" to="/cart">← Back to cart</Link>
        </div>
      )}

      {stage.kind === 'paid' ? (
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
      ) : stage.kind === 'error' ? (
        <div className="card card-pad" style={{ maxWidth: 520 }}>
          <h3 className="card-title" style={{ marginTop: 0, color: 'var(--ink)' }}>Couldn’t start checkout</h3>
          <p style={{ color: 'var(--ink-soft)' }}>{stage.message}</p>
          <button className="btn primary small" onClick={retry}>Try again</button>
        </div>
      ) : stage.kind === 'loading' ? (
        <div className="card card-pad">
          <p style={{ color: 'var(--ink-soft)', margin: 0 }}>Preparing your secure checkout…</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="card card-pad">
            <h3 className="card-title" style={{ marginTop: 0 }}>Memberships</h3>
            <ul style={{ margin: '10px 0', paddingLeft: 18, fontSize: 14 }}>
              {items.map((i) => (
                <li key={i.id}><span>{i.label}</span></li>
              ))}
            </ul>
            {summary && (
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
            )}
          </div>
          <StripeCheckout
            clientSecret={stage.clientSecret}
            paymentId={stage.paymentId}
            onPaid={onPaid}
            onError={onError}
          />
        </div>
      )}
    </div>
  );
}

export default Cart;
