// UAT round-1 (Z-01-02 + M-19-01 + M-20-01): pure helpers backing the
// separated My Purchase History (/me/purchases, personal-only) vs Club
// Purchase History (/club/:id/purchases, every one of that club's invoices,
// including ones the viewer themselves paid) pages.
import type { CartItem, Invoice, Payment } from './types';
import { fmtMoney } from './scoring';
import { invoiceTotal } from './receipt';

/** A personal (non-club) invoice belonging to `personId` — either they're the
 *  billed individual (`athleteId`) or one of the invoice's line items is FOR
 *  them (a rarer shape, e.g. a guardian's personal cart paying for a minor).
 *  `inv.clubId` is non-null for every club-cart invoice (`fulfillPayment`
 *  always writes `athlete_id: clubId ? null : personId` — the two are
 *  mutually exclusive), so excluding those is what keeps a club invoice the
 *  viewer happened to pay out of "MY purchases" — it belongs on that club's
 *  Purchase History page instead, same money, different scope. */
export function isPersonalInvoice(inv: Invoice, personId: string): boolean {
  if (inv.clubId) return false;
  return inv.athleteId === personId || inv.items.some((i) => i.refUserId === personId);
}

/** Minimal person shape `payerLabel` needs — deliberately a subset (not the
 *  full `Athlete`) so tests can pass plain literals. */
export type PayerPerson = { id: string; firstName: string; lastName: string; email?: string };

/** "Paid by <name or email>" for a receipt/invoice row. Deviates from the
 *  brief's literal `payerLabel(inv, people)` signature by also taking
 *  `payments`: an invoice alone cannot say who PAID a club invoice —
 *  `invoices.athlete_id` is always null there (see `isPersonalInvoice`'s
 *  comment), and the payer is the person on the ONE `payments` row that
 *  fulfilled into it (`payment.invoice_id === inv.id`; `create-checkout-
 *  session`/`fulfillPayment` mint one dedicated invoice per payment — see
 *  `_shared/fulfill.ts`'s `invoiceId = payment.invoice_id ?? 'inv-'+payment.id`).
 *  For a personal invoice, `inv.athleteId` already names the payer directly
 *  and is used as a fallback when no matching payment row is loaded (e.g. a
 *  legacy pre-Stripe-foundations row, or an admin-comp'd membership invoice,
 *  which is written by `Membership.tsx`'s comp path with no `payments` row
 *  at all).
 *
 *  KNOWN RLS LIMIT (flagged, not fixed): `payments` is self-read-or-admin
 *  only (`payments_self_read`, `20260625231808`) — a non-admin club manager
 *  can only ever see the personId on payments THEY THEMSELVES made. For a
 *  club invoice paid by a DIFFERENT manager of the same club, the matching
 *  payment row simply never loads into this viewer's `db.payments`, so this
 *  falls through to 'A club manager' rather than a guessed name. Widening
 *  that would need a new RLS policy (`manages_club(payments.person_id's
 *  club?)`) — money-adjacent, reviewer-tier territory, out of scope here. */
export function payerLabel(inv: Invoice, payments: Payment[], people: PayerPerson[]): string {
  const payment = payments.find((p) => p.invoiceId === inv.id);
  const personId = payment?.personId ?? inv.athleteId ?? null;
  if (!personId) return inv.clubId ? 'A club manager' : 'Unknown';
  const person = people.find((p) => p.id === personId);
  if (!person) return inv.clubId ? 'A club manager' : 'Unknown';
  const name = `${person.firstName} ${person.lastName}`.trim();
  return name || person.email || (inv.clubId ? 'A club manager' : 'Unknown');
}

/** Total cart lines across every club the viewer manages — the topbar "Club
 *  Cart(s)" badge count, kept independent of the personal cart badge. */
export function clubCartBadgeCount(carts: Record<string, CartItem[]>, managedClubIds: string[]): number {
  return managedClubIds.reduce((sum, id) => sum + (carts[id]?.length ?? 0), 0);
}

/** Club Purchase History's search box: matches the receipt number, the payer
 *  name/email, the formatted total, or any line label — mirrors the personal
 *  ReceiptsSection search in Cart.tsx, extended with the payer (payer search
 *  is the whole reason Club Purchase History needs its OWN filter helper
 *  rather than reusing that one verbatim). */
export function matchesClubPurchaseSearch(inv: Invoice, query: string, payerName: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (inv.number.toLowerCase().includes(q)) return true;
  if (payerName.toLowerCase().includes(q)) return true;
  if (fmtMoney(invoiceTotal(inv)).includes(q)) return true;
  return inv.items.some((it) => it.label.toLowerCase().includes(q));
}
