import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useDB, syncFromSupabase } from '../lib/store';
import { useCapabilities } from '../lib/capabilities';
import { useToast } from '../components/ui-hooks';
import { fmtMoney } from '../lib/scoring';
import { removeCartItemWithSync } from '../lib/cart-sync';
import { CartCheckout } from '../components/CartCheckout';
import type { CartItem } from '../lib/types';

const sum = (items: CartItem[]) => items.reduce((s, i) => s + i.amount, 0);

function CartCard({ title, items, returnTo, returnLabel, onCheckout, onRemove }: {
  title: string; items: CartItem[]; returnTo: string; returnLabel: string; onCheckout: () => void;
  onRemove: (item: CartItem) => void;
}) {
  return (
    <div className="card card-pad">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <h3 className="card-title" style={{ margin: 0 }}>{title}</h3>
        <Link to={returnTo} style={{ marginLeft: 'auto', fontSize: 13 }}>{returnLabel} →</Link>
      </div>
      <ul style={{ margin: '10px 0', paddingLeft: 18, fontSize: 14 }}>
        {items.map((i) => (
          <li key={i.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
            <span>{i.label}</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <strong>{fmtMoney(i.amount)}</strong>
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <strong>Subtotal: {fmtMoney(sum(items))}</strong>
        <button className="btn primary small" style={{ marginLeft: 'auto' }} onClick={onCheckout} disabled={items.length === 0}>
          Check out {title}
        </button>
      </div>
    </div>
  );
}

/** View Cart (topbar): the signed-in person's cart, grouped into a card per event
 *  plus a Memberships card, each with a "return to registration" link and its own
 *  checkout — or check out everything at once. Every group pays via Stripe
 *  Embedded Checkout (`CartCheckout`); the verified webhook does all fulfillment
 *  (invoice, registrations, cart clearing, receipt) server-side. */
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
  // NOT memoized: `mutate()` mutates the shared db object in place rather than
  // replacing it, so `db.carts` never gets a new reference for useMemo to key
  // off — a memo here would silently go stale after any local cart mutation
  // (e.g. removeItem below). useDB()'s own subscription already re-renders
  // this component on every store change, so reading fresh here is correct
  // and cheap (a plain property lookup, not a real computation).
  const cart = db.carts[personId] ?? [];
  const [checkout, setCheckout] = useState<{ items: CartItem[]; title: string } | null>(null);

  // Group: a card per event (matched by name in the label), one "Memberships"
  // card, and an "Other" card for anything that doesn't match.
  const groups = useMemo(() => {
    const membership: CartItem[] = [];
    const byEvent = new Map<string, { eventName: string; slug: string | null; items: CartItem[] }>();
    const other: CartItem[] = [];
    for (const item of cart) {
      if (item.kind === 'membership') { membership.push(item); continue; }
      const event = db.events.find((m) => item.label.includes(m.name));
      if (event) {
        const g = byEvent.get(event.id) ?? { eventName: event.name, slug: event.slug, items: [] };
        g.items.push(item);
        byEvent.set(event.id, g);
      } else {
        other.push(item);
      }
    }
    return { membership, events: [...byEvent.values()], other };
  }, [cart, db.events]);

  // Removes a single line from the person's OWN cart (e.g. a stale/orphaned
  // item that fails checkout, or something they just changed their mind
  // about). Syncs the underlying registration(s) via removeCartItemWithSync
  // (unified-cart-b2 Task A): a brand-new unpaid entry line is deleted
  // entirely; a "change" fee line with a captured snapshot reverts the
  // registration(s) to their pre-change values; a legacy "change" line with no
  // snapshot just removes the cart line (toasted honestly — nothing to revert
  // to); anything else (membership/addon/other) is unaffected, same as before.
  const removeItem = (item: CartItem) => {
    const { action } = removeCartItemWithSync(personId, false, item);
    const message = {
      'delete-registration': 'Removed from cart and canceled the registration.',
      'revert-registration': 'Removed from cart — registration reverted to its prior state.',
      'no-snapshot-remove-only': 'Removed from cart. This registration was changed before we could track a revert — please check it.',
      'remove-only': 'Removed from cart.',
    }[action];
    toast(message, action === 'no-snapshot-remove-only' ? { variant: 'error' } : undefined);
  };

  const onPaid = () => {
    // The invoice, registrations, and cart lines are all written by the webhook —
    // pull the fresh snapshot so the UI reflects them. Do NOT mutate locally.
    void syncFromSupabase().finally(() => {
      setCheckout(null);
      toast('Payment complete. Receipt emailed and saved to your Purchase History.');
    });
  };

  if (cart.length === 0) {
    return (
      <div style={{ maxWidth: 720 }}>
        <h1 className="page-title display">Your Cart</h1>
        <p style={{ color: 'var(--ink-soft)' }}>Your cart is empty.</p>
      </div>
    );
  }

  if (checkout) {
    return (
      <div style={{ maxWidth: 620 }}>
        <h1 className="page-title display">Checkout — {checkout.title}</h1>
        <p className="page-sub">Billed to {name}.</p>
        <div style={{ marginBottom: 14 }}>
          <button className="btn ghost small" onClick={() => setCheckout(null)}>← Back to cart</button>
        </div>
        <CartCheckout
          items={checkout.items}
          title={checkout.title}
          onPaid={onPaid}
          onError={(msg) => toast(msg, { variant: 'error' })}
        />
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 720 }}>
      <h1 className="page-title display">Your Cart</h1>
      <p className="page-sub">Billed to {name}. Check out one section, or everything at once.</p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {groups.membership.length > 0 && (
          <CartCard title="Memberships" items={groups.membership} returnTo="/cart/memberships" returnLabel="Checkout Memberships"
            onCheckout={() => setCheckout({ items: groups.membership, title: 'Memberships' })} onRemove={removeItem} />
        )}
        {groups.events.map((g) => (
          <CartCard key={g.eventName} title={g.eventName} items={g.items}
            returnTo={g.slug ? `/events/${g.slug}` : '/events'} returnLabel="Return to registration"
            onCheckout={() => setCheckout({ items: g.items, title: g.eventName })} onRemove={removeItem} />
        ))}
        {groups.other.length > 0 && (
          <CartCard title="Other" items={groups.other} returnTo="/events" returnLabel="Browse"
            onCheckout={() => setCheckout({ items: groups.other, title: 'Other' })} onRemove={removeItem} />
        )}
      </div>

      <div className="card card-pad" style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 12 }}>
        <strong style={{ fontSize: 16 }}>Total: {fmtMoney(sum(cart))}</strong>
        <button className="btn primary" style={{ marginLeft: 'auto' }} onClick={() => setCheckout({ items: cart, title: 'Everything' })}>
          Check out everything →
        </button>
      </div>
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
  const cart = useMemo(() => db.carts[personId] ?? [], [db.carts, personId]);
  const items = useMemo(() => cart.filter((i) => i.kind === 'membership'), [cart]);
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
