import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useDB, mutate } from '../lib/store';
import { useCapabilities } from '../lib/capabilities';
import { useToast } from '../components/ui-hooks';
import { fmtMoney } from '../lib/scoring';
import { pushInvoice, pushCart, sendReceipt } from '../lib/supabase';
import { downloadReceipt } from '../lib/receipt';
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
 *  items in the signed-in person's cart, their total, and a single Pay action.
 *  On completion it creates the invoice (shared `completePurchase`), clears the
 *  membership items, emails the account owner a confirmation + HTML receipt (via
 *  the service-role `send-receipt` fn — works for a non-admin member), and
 *  offers a PDF receipt download. */
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

  const checkout = () => {
    const inv = completePurchase(personId, items);
    if (!inv) return;
    // Offer the PDF receipt immediately (client-side, reuses receipt.ts).
    downloadReceipt(inv, name);
    // Email the account owner their confirmation + inline HTML receipt.
    // Best-effort: a mail failure must not break a completed checkout, but the
    // toast reflects reality — only claim "emailed" when the send succeeds.
    void sendReceipt({
      items: inv.items.map((i) => ({ label: i.label, amount: i.amount, kind: i.kind })),
      total: inv.items.reduce((s, i) => s + i.amount, 0),
      invoiceNumber: inv.number,
      couponCode: inv.couponCode,
    })
      .then((r) => {
        if (r.ok && r.sent) toast('Memberships purchased. Confirmation emailed and receipt downloaded.');
        else toast('Memberships purchased. Receipt downloaded and saved to your Purchase History.');
      })
      .catch(() => toast('Memberships purchased. Receipt downloaded and saved to your Purchase History.'));
  };

  return (
    <div style={{ maxWidth: 620 }}>
      <h1 className="page-title display">Checkout — Memberships</h1>
      <p className="page-sub">Billed to {name}.</p>
      <div style={{ marginBottom: 14 }}>
        <Link className="btn ghost small" to="/cart">← Back to cart</Link>
      </div>

      {items.length === 0 ? (
        <div className="card card-pad">
          <p style={{ color: 'var(--ink-soft)' }}>No memberships in your cart.</p>
        </div>
      ) : (
        <div className="card card-pad">
          <h3 className="card-title" style={{ marginTop: 0 }}>Memberships</h3>
          <ul style={{ margin: '10px 0', paddingLeft: 18, fontSize: 14 }}>
            {items.map((i) => (
              <li key={i.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                <span>{i.label}</span><strong>{fmtMoney(i.amount)}</strong>
              </li>
            ))}
          </ul>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
            <strong style={{ fontSize: 16 }}>Total: {fmtMoney(sum(items))}</strong>
            <button className="btn primary" style={{ marginLeft: 'auto' }} onClick={checkout}>
              Pay {fmtMoney(sum(items))} →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default Cart;
