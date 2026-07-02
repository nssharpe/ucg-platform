import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useDB, syncFromSupabase } from '../lib/store';
import { useCapabilities } from '../lib/capabilities';
import { useToast, useFmtDate } from '../components/ui-hooks';
import { Badge, Modal } from '../components/ui';
import { fmtMoney } from '../lib/scoring';
import { removeCartItemWithSync, cleanupCrossClubCart } from '../lib/cart-sync';
import { downloadCartInvoice, downloadReceipt, invoiceTotal } from '../lib/receipt';
import { CartCheckout } from '../components/CartCheckout';
import type { CartItem, Club, DB, Invoice } from '../lib/types';

const sum = (items: CartItem[]) => items.reduce((s, i) => s + i.amount, 0);

/** Group a cart's items the same way everywhere: a "Memberships" bucket, a
 *  bucket per event (matched by name appearing in the label), and an "Other"
 *  bucket for anything left over. Shared by the personal cart and every
 *  managed-club section so grouping logic isn't duplicated/drifted. */
function groupCartItems(cart: CartItem[], db: DB) {
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
}

function CartCard({ title, items, returnTo, returnLabel, onCheckout, onRemove, onPrintInvoice }: {
  title: string; items: CartItem[]; returnTo: string; returnLabel: string; onCheckout: () => void;
  onRemove: (item: CartItem) => void; onPrintInvoice: () => void;
}) {
  return (
    <div className="card card-pad">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <strong style={{ marginRight: 'auto' }}>Subtotal: {fmtMoney(sum(items))}</strong>
        <button className="btn ghost small" onClick={onPrintInvoice} disabled={items.length === 0}>
          Print Invoice
        </button>
        <button className="btn primary small" onClick={onCheckout} disabled={items.length === 0}>
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
  const [checkout, setCheckout] = useState<{ items: CartItem[]; title: string } | null>(null);

  const groups = useMemo(() => groupCartItems(cart, db), [cart, db]);

  // Syncs the underlying registration(s) via removeCartItemWithSync
  // (unified-cart-b2 Task A): a brand-new unpaid entry line is deleted
  // entirely; a "change" fee line with a captured snapshot reverts the
  // registration(s) to their pre-change values; a legacy "change" line with no
  // snapshot just removes the cart line (toasted honestly — nothing to revert
  // to); anything else (membership/addon/other) is unaffected, same as before.
  const removeItem = (item: CartItem) => {
    const { action } = removeCartItemWithSync(ownerKey, isClub, item);
    const message = {
      'delete-registration': 'Removed from cart and canceled the registration.',
      'revert-registration': 'Removed from cart — registration reverted to its prior state.',
      'no-snapshot-remove-only': 'Removed from cart. This registration was changed before we could track a revert — please check it.',
      'remove-only': 'Removed from cart.',
    }[action];
    onRemoved(message, action === 'no-snapshot-remove-only');
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

  if (cart.length === 0) {
    return <p style={{ color: 'var(--ink-soft)' }}>Cart is empty.</p>;
  }

  const checkoutAllButton = (
    <button className="btn primary" onClick={() => setCheckout({ items: cart, title: 'Everything' })}>
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
      {/* Checkout-All at the TOP, duplicated at the bottom below the cards. */}
      <div className="card card-pad" style={{ marginBottom: 14, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 16, marginRight: 'auto' }}>Total: {fmtMoney(sum(cart))}</strong>
        {printAllButton}
        {checkoutAllButton}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {groups.membership.length > 0 && (
          <CartCard title="Memberships" items={groups.membership} returnTo={membershipsReturnTo} returnLabel="Checkout Memberships"
            onCheckout={() => setCheckout({ items: groups.membership, title: 'Memberships' })}
            onRemove={removeItem}
            onPrintInvoice={() => downloadCartInvoice(groups.membership, name, 'Memberships')} />
        )}
        {groups.events.map((g) => (
          <CartCard key={g.eventName} title={g.eventName} items={g.items}
            returnTo={registrationsReturnTo(g.slug)} returnLabel="Return to registration"
            onCheckout={() => setCheckout({ items: g.items, title: g.eventName })}
            onRemove={removeItem}
            onPrintInvoice={() => downloadCartInvoice(g.items, name, g.eventName)} />
        ))}
        {groups.other.length > 0 && (
          <CartCard title="Other" items={groups.other} returnTo={otherReturnTo} returnLabel="Browse"
            onCheckout={() => setCheckout({ items: groups.other, title: 'Other' })}
            onRemove={removeItem}
            onPrintInvoice={() => downloadCartInvoice(groups.other, name, 'Other')} />
        )}
      </div>

      <div className="card card-pad" style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <strong style={{ fontSize: 16, marginRight: 'auto' }}>Total: {fmtMoney(sum(cart))}</strong>
        {printAllButton}
        {checkoutAllButton}
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

  const allInvoices = useMemo(() =>
    db.invoices
      .filter((i) => i.clubId === clubId)
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
                {inv.paidAt ? <Badge tone="ok">Paid</Badge> : <Badge tone="warn">Unpaid</Badge>}
                <strong style={{ marginLeft: 'auto' }}>{fmtMoney(invoiceTotal(inv))}</strong>
              </div>
              <p style={{ margin: '8px 0 10px', fontSize: 14, color: 'var(--ink-soft)' }}>
                {inv.items.filter((i) => i.kind !== 'discount').map((i) => i.label).join('; ')}
              </p>
              <button className="btn small ghost" onClick={() => setDetail(inv)}>Click for details →</button>
            </div>
          ))}
        </div>
      )}

      {detail && (
        <Modal title={`Receipt ${detail.number}`} onClose={() => setDetail(null)}>
          <div style={{ fontSize: 13.5, color: 'var(--ink-soft)', marginBottom: 12 }}>
            {fmtDate(detail.createdAt.slice(0, 10))} · {detail.paidAt ? 'Paid' : 'Unpaid'} · Billed to {forName}
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
  useEffect(() => {
    cleanupCrossClubCart(db, club.id, toast);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, club.id]);

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
