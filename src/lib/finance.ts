// Pure finance derivation engine for the finance dashboards (event-mgmt v2
// Phase 6, spec §M). No React, no supabase client — only `./types` +
// `./host-export`'s SheetModel shape, so this is unit-testable in the node
// vitest env exactly like pricing.ts/capabilities-core.ts. T3 (UI) consumes
// these exports; this file owns none of the fetching/lookup wiring.
//
// JUDGMENT CALLS (recorded here per the task brief, since several semantics
// were left to this implementation):
// - `defaultLeagueRange`/date-range filtering are computed in UTC (not the
//   caller's machine-local timezone) for determinism — a client-local
//   "previous calendar month" would render differently depending on the
//   browser/CI timezone, which is unacceptable for a finance report whose
//   numbers must match regardless of where it's run. `defaultEventRange`
//   likewise adds its 7-day pad and snaps to end-of-day in UTC.
// - `hostPayoutOwedCents` (formula confirmed by Julia, 2026-07-17): what's
//   owed to a host club is the event-scoped GROSS collected — every dollar
//   paid for athlete registrations and add-ons, before service/admin fees —
//   with refunds NOT deducted. Rationale: in-app refunds exist only for
//   league-hosted events (which get no payout), and when an athlete asks a
//   host club for a refund the club handles it themselves — UCG still pays
//   the full amount collected even if the athlete was removed from the
//   event. Merchant (Stripe) fees are the league's own cost and service
//   fees its own income; neither touches the payout. Payouts already made
//   are surfaced separately by the caller (host_payouts), not subtracted.
// - Money in `FinanceSummarySheet`/`FinanceTxnsSheet` rows is rendered as
//   plain dollar numbers (cents / 100), not formatted strings — `SheetModel`
//   rows are `(string | number)[]` and host-export.ts's existing sheets never
//   render money at all, so there's no precedent to match; a raw number lets
//   Excel sum/format the column, which seems more useful than a fixed string.

import type {
  AccountingCode, Event, HostPayout, Invoice, InvoiceItem, Payment, RefundRequest,
} from './types';
import type { SheetModel } from './host-export';

export type { SheetModel };

// --- Item keys ---------------------------------------------------------

/** Canonical grouping key for one line/refund, derived from its `kind` +
 *  `refLineType` refinement. Unknown/absent refinements fall back to the
 *  most common variant ('entry' for meet-entry, plain 'addon' for addon). */
export function itemKeyFor(kind: InvoiceItem['kind'], refLineType?: string): string {
  if (kind === 'meet-entry') {
    return refLineType === 'change' ? 'meet-entry:change' : 'meet-entry:entry';
  }
  if (kind === 'addon') {
    if (refLineType === 'tshirt' || refLineType === 'leo' || refLineType === 'banner' || refLineType === 'banquet') {
      return `addon:${refLineType}`;
    }
    return 'addon';
  }
  return kind;
}

/** Every item key this app can produce, in the order dashboards/accounting-
 *  code management should list them. Unknown keys (shouldn't happen, but a
 *  future kind or a corrupt row) are appended after this list, not lost. */
export const KNOWN_ITEM_KEYS: string[] = [
  'membership',
  'meet-entry:entry',
  'meet-entry:change',
  'addon:tshirt',
  'addon:leo',
  'addon:banner',
  'addon:banquet',
  'addon',
  'banquet',
  'donation',
  'fee',
  'discount',
];

const ITEM_KEY_LABELS: Record<string, string> = {
  membership: 'Memberships',
  'meet-entry:entry': 'Event entries',
  'meet-entry:change': 'Change fees',
  'addon:tshirt': 'T-shirts',
  'addon:leo': 'Leos',
  'addon:banner': 'Club banners',
  'addon:banquet': 'Banquet tickets',
  addon: 'Add-ons',
  banquet: 'Banquet (legacy)',
  donation: 'Donations',
  fee: 'Fees',
  discount: 'Discounts',
  unknown: 'Other',
};

/** Human label for an item key, for dashboard headers + accounting-code
 *  management UI. Falls back to the raw key for anything unrecognized. */
export function itemKeyLabel(key: string): string {
  return ITEM_KEY_LABELS[key] ?? key;
}

// --- Transactions --------------------------------------------------------

export type FinanceTxn = {
  id: string; // payment id or `refund:<requestId>`
  type: 'payment' | 'refund';
  date: string; // payment: fulfilledAt ?? createdAt; refund: reviewedAt
  personId?: string;
  clubId?: string; // invoice.clubId for payments (individual ⇒ undefined); refund.clubId
  eventIds: string[]; // distinct refEventIds across the lines ([] for membership-only)
  invoiceId?: string;
  invoiceNumber?: string;
  stripeSessionId?: string;
  stripePaymentIntentId?: string;
  description: string;
  lines: { itemKey: string; label: string; amountCents: number; refEventId?: string }[];
  subtotalCents: number; // Σ lines (negative for refunds)
  serviceFeeCents: number; // refunds: 0
  stripeFeeCents: number; // refunds: 0 (Stripe does not return a per-refund fee)
  totalCents: number; // subtotal + serviceFee
};

/** Builds one FinanceTxn per fulfilled payment (status 'paid'/'refunded';
 *  'pending'/'failed' never moved money, so they're excluded) plus one per
 *  APPROVED refund request. Line source precedence for a payment:
 *  `linesSnapshot` (paidCents, i.e. the post-coupon actual charge) → the
 *  linked invoice's items (dollars → cents) → a single synthetic 'unknown'
 *  line as a last resort so a payment is never silently dropped. Sorted date
 *  descending. */
export function buildFinanceTxns(input: {
  payments: Payment[];
  invoices: Invoice[];
  refundRequests: RefundRequest[];
  events: Event[];
}): FinanceTxn[] {
  const invoicesById = new Map(input.invoices.map((inv) => [inv.id, inv]));
  const paymentsById = new Map(input.payments.map((p) => [p.id, p]));
  const txns: FinanceTxn[] = [];

  for (const p of input.payments) {
    if (p.status !== 'paid' && p.status !== 'refunded') continue;
    const invoice = p.invoiceId ? invoicesById.get(p.invoiceId) : undefined;

    let lines: FinanceTxn['lines'];
    if (p.linesSnapshot && p.linesSnapshot.length > 0) {
      lines = p.linesSnapshot.map((l) => ({
        itemKey: itemKeyFor(l.kind, l.refLineType),
        label: l.label,
        amountCents: l.paidCents ?? l.amountCents,
        refEventId: l.refEventId,
      }));
    } else if (invoice && invoice.items.length > 0) {
      lines = invoice.items.map((it) => ({
        itemKey: itemKeyFor(it.kind, it.refLineType),
        label: it.label,
        amountCents: Math.round(it.amount * 100),
        refEventId: it.refEventId,
      }));
    } else {
      lines = [{ itemKey: 'unknown', label: 'Payment', amountCents: p.amountSubtotal ?? 0 }];
    }

    const eventIds = Array.from(
      new Set(lines.map((l) => l.refEventId).filter((x): x is string => !!x)),
    );
    const subtotalCents = lines.reduce((s, l) => s + l.amountCents, 0);
    const serviceFeeCents = p.serviceFee ?? 0;
    const stripeFeeCents = p.stripeFee ?? 0;

    txns.push({
      id: p.id,
      type: 'payment',
      date: p.fulfilledAt ?? p.createdAt,
      personId: p.personId ?? undefined,
      clubId: invoice?.clubId ?? undefined,
      eventIds,
      invoiceId: p.invoiceId ?? undefined,
      invoiceNumber: invoice?.number,
      stripeSessionId: p.stripeSessionId ?? undefined,
      stripePaymentIntentId: p.stripePaymentIntentId ?? undefined,
      description: lines.map((l) => l.label).join(', ') || 'Payment',
      lines,
      subtotalCents,
      serviceFeeCents,
      stripeFeeCents,
      totalCents: subtotalCents + serviceFeeCents,
    });
  }

  for (const rr of input.refundRequests) {
    if (rr.status !== 'approved') continue;
    if (rr.refundAmountCents == null) continue;
    const amount = rr.refundAmountCents;

    let itemKey: string;
    let label: string;
    if (rr.kind === 'registration') {
      itemKey = 'meet-entry:entry';
      label = 'Registration refund';
    } else {
      let foundItem: InvoiceItem | undefined;
      for (const inv of input.invoices) {
        const it = inv.items.find((i) => i.id === rr.invoiceItemId);
        if (it) { foundItem = it; break; }
      }
      if (foundItem) {
        itemKey = itemKeyFor(foundItem.kind, foundItem.refLineType);
        label = `${foundItem.label} refund`;
      } else {
        itemKey = 'addon';
        label = 'Add-on refund';
      }
    }

    const payment = rr.paymentId ? paymentsById.get(rr.paymentId) : undefined;
    const invoiceForRefund = payment?.invoiceId ? invoicesById.get(payment.invoiceId) : undefined;

    txns.push({
      id: `refund:${rr.id}`,
      type: 'refund',
      date: rr.reviewedAt ?? rr.createdAt,
      personId: rr.requesterPersonId,
      clubId: rr.clubId ?? undefined,
      eventIds: rr.eventId ? [rr.eventId] : [],
      invoiceId: invoiceForRefund?.id,
      invoiceNumber: invoiceForRefund?.number,
      stripeSessionId: payment?.stripeSessionId ?? undefined,
      stripePaymentIntentId: payment?.stripePaymentIntentId ?? undefined,
      description: label,
      lines: [{ itemKey, label, amountCents: -amount, refEventId: rr.eventId }],
      subtotalCents: -amount,
      serviceFeeCents: 0,
      stripeFeeCents: 0,
      totalCents: -amount,
    });
  }

  txns.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  return txns;
}

// --- Date filtering + defaults --------------------------------------------

/** Inclusive range check by millisecond instant; a missing bound is open. */
export function txnInRange(t: FinanceTxn, fromIso?: string, toIso?: string): boolean {
  const ts = new Date(t.date).getTime();
  if (fromIso && ts < new Date(fromIso).getTime()) return false;
  if (toIso && ts > new Date(toIso).getTime()) return false;
  return true;
}

function dateOnlyInRange(dateIso: string, fromIso?: string, toIso?: string): boolean {
  const ts = new Date(dateIso).getTime();
  if (fromIso && ts < new Date(fromIso).getTime()) return false;
  if (toIso && ts > new Date(toIso).getTime()) return false;
  return true;
}

/** Previous CALENDAR month (1st 00:00:00.000 → last day 23:59:59.999),
 *  computed in UTC from `todayIso` (see the header note on why UTC, not
 *  machine-local time). */
export function defaultLeagueRange(todayIso: string): { from: string; to: string } {
  const today = new Date(todayIso);
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth(); // current month, 0-indexed
  const from = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0, 0));
  const to = new Date(Date.UTC(y, m, 0, 23, 59, 59, 999)); // day 0 of month m = last day of month m-1
  return { from: from.toISOString(), to: to.toISOString() };
}

/** `regOpens` → `(endDate ?? startDate)` + 7 days, end-of-day (UTC). Tolerant
 *  of missing fields: an unparseable/missing end date yields an open `to`;
 *  a missing `regOpens` yields an open `from`. */
export function defaultEventRange(
  event: Pick<Event, 'regOpens' | 'startDate' | 'endDate'>,
): { from?: string; to?: string } {
  const from = event.regOpens || undefined;
  const endBase = event.endDate || event.startDate;
  if (!endBase) return { from };
  const endDate = new Date(endBase);
  if (Number.isNaN(endDate.getTime())) return { from };
  const to = new Date(endDate.getTime() + 7 * 24 * 60 * 60 * 1000);
  to.setUTCHours(23, 59, 59, 999);
  return { from, to: to.toISOString() };
}

// --- Summary ---------------------------------------------------------------

export type FinanceSummaryLine = {
  itemKey: string;
  label: string;
  code?: string;
  grossCents: number;
  refundsCents: number;
  netCents: number;
  txnCount: number;
};

export type FinanceSummary = {
  lines: FinanceSummaryLine[]; // one per itemKey present, KNOWN_ITEM_KEYS order then unknowns
  grossCents: number;
  refundsCents: number;
  netCents: number;
  feesCollectedCents: number; // Σ serviceFee of included payment txns
  feesPaidCents: number; // Σ stripeFee of included payment txns
  feeProfitCents: number; // collected − paid
  hostPayoutsCents: number;
};

/** Filters `txns` by date range and (optionally) one event, then aggregates
 *  per item key. Event-scoping keeps only lines whose OWN `refEventId`
 *  matches (so a mixed cart's membership line never leaks into an event's
 *  dashboard) and prorates each payment's service/Stripe fee by that event's
 *  share of the payment's total line value — attributing a mixed payment's
 *  whole fee to one event would double-count it across the other event(s)/
 *  membership sharing the same cart. */
export function buildFinanceSummary(
  txns: FinanceTxn[],
  opts: { eventId?: string; from?: string; to?: string; accountingCodes?: AccountingCode[]; hostPayouts?: HostPayout[] },
): FinanceSummary {
  const filtered = txns.filter((t) => txnInRange(t, opts.from, opts.to));
  const scoped = opts.eventId ? filtered.filter((t) => t.eventIds.includes(opts.eventId!)) : filtered;

  const byKey = new Map<string, FinanceSummaryLine>();
  const ensure = (key: string): FinanceSummaryLine => {
    let l = byKey.get(key);
    if (!l) {
      l = { itemKey: key, label: itemKeyLabel(key), grossCents: 0, refundsCents: 0, netCents: 0, txnCount: 0 };
      byKey.set(key, l);
    }
    return l;
  };

  let feesCollectedCents = 0;
  let feesPaidCents = 0;

  for (const t of scoped) {
    const relevantLines = opts.eventId ? t.lines.filter((l) => l.refEventId === opts.eventId) : t.lines;
    if (relevantLines.length === 0) continue;

    for (const l of relevantLines) {
      const line = ensure(l.itemKey);
      if (t.type === 'payment') line.grossCents += l.amountCents;
      else line.refundsCents += Math.abs(l.amountCents);
      line.txnCount += 1;
    }

    if (t.type === 'payment') {
      if (opts.eventId) {
        const relevantTotal = relevantLines.reduce((s, l) => s + l.amountCents, 0);
        const allTotal = t.lines.reduce((s, l) => s + l.amountCents, 0);
        if (allTotal > 0) {
          const share = relevantTotal / allTotal;
          feesCollectedCents += Math.round(t.serviceFeeCents * share);
          feesPaidCents += Math.round(t.stripeFeeCents * share);
        }
      } else {
        feesCollectedCents += t.serviceFeeCents;
        feesPaidCents += t.stripeFeeCents;
      }
    }
  }

  for (const l of byKey.values()) l.netCents = l.grossCents - l.refundsCents;

  const orderedKeys = [
    ...KNOWN_ITEM_KEYS.filter((k) => byKey.has(k)),
    ...[...byKey.keys()].filter((k) => !KNOWN_ITEM_KEYS.includes(k)),
  ];
  const lines = orderedKeys.map((k) => {
    const line = byKey.get(k)!;
    const code = opts.accountingCodes?.find((c) => c.itemKey === k)?.code;
    return { ...line, code };
  });

  const grossCents = lines.reduce((s, l) => s + l.grossCents, 0);
  const refundsCents = lines.reduce((s, l) => s + l.refundsCents, 0);
  const netCents = grossCents - refundsCents;

  const hostPayoutsCents = (opts.hostPayouts ?? [])
    .filter((p) => !opts.eventId || p.eventId === opts.eventId)
    .filter((p) => dateOnlyInRange(p.paidOn, opts.from, opts.to))
    .reduce((s, p) => s + p.amountCents, 0);

  return {
    lines, grossCents, refundsCents, netCents,
    feesCollectedCents, feesPaidCents, feeProfitCents: feesCollectedCents - feesPaidCents,
    hostPayoutsCents,
  };
}

// --- Host payout owed ------------------------------------------------------

/** Amount owed to the host club: the event's GROSS collected (registrations
 *  + add-ons, before service/admin fees), refunds NOT deducted — see the
 *  header note (formula per Julia, 2026-07-17). `summaryForEvent` MUST
 *  already be scoped to one event (i.e. built with `eventId` set) — this
 *  function does no further scoping itself. */
export function hostPayoutOwedCents(
  summaryForEvent: FinanceSummary,
): { owedCents: number; parts: { label: string; cents: number }[] } {
  const parts = summaryForEvent.lines.map((l) => ({ label: l.label, cents: l.grossCents }));
  parts.push({ label: 'Total', cents: summaryForEvent.grossCents });
  return { owedCents: summaryForEvent.grossCents, parts };
}

// --- Excel sheet models ------------------------------------------------------

const dollars = (cents: number): number => Math.round(cents) / 100;

/** One-sheet summary export: per-item gross/refunds/net + accounting code,
 *  followed by totals and the fee/payout figures. `opts.title` becomes the
 *  sheet name (Excel sheet names are caller-visible, so keep it short —
 *  e.g. "June 2026" or the event name). */
export function buildFinanceSummarySheet(summary: FinanceSummary, opts: { title: string }): SheetModel {
  const columns = ['Item', 'Code', 'Gross', 'Refunds', 'Net', 'Txns'];
  const rows: (string | number)[][] = summary.lines.map((l) => [
    l.label, l.code ?? '', dollars(l.grossCents), dollars(l.refundsCents), dollars(l.netCents), l.txnCount,
  ]);
  rows.push(['', '', '', '', '', '']);
  rows.push(['Total', '', dollars(summary.grossCents), dollars(summary.refundsCents), dollars(summary.netCents), '']);
  rows.push(['Service fees collected', '', dollars(summary.feesCollectedCents), '', '', '']);
  rows.push(['Service fees paid (Stripe)', '', dollars(summary.feesPaidCents), '', '', '']);
  rows.push(['Fee profit', '', dollars(summary.feeProfitCents), '', '', '']);
  rows.push(['Host payouts recorded', '', dollars(summary.hostPayoutsCents), '', '', '']);
  return { name: opts.title, columns, rows };
}

/** One-row-per-transaction export. Person/club/event NAME resolution is a
 *  caller-supplied lookup — this module stays free of `DB`/store imports
 *  (types-only), matching how host-export.ts keeps its sheet builders pure. */
export function buildFinanceTxnsSheet(
  txns: FinanceTxn[],
  lookups: {
    peopleById: Map<string, { name?: string; email?: string }>;
    clubNameById: Map<string, string>;
    eventNameById: Map<string, string>;
  },
): SheetModel {
  const columns = [
    'Date', 'Type', 'Name', 'Email', 'Club', 'Event(s)', 'Invoice #', 'Description',
    'Subtotal', 'Service fee', 'Stripe fee', 'Total', 'Stripe session', 'Stripe PI',
  ];
  const rows: (string | number)[][] = txns.map((t) => {
    const person = t.personId ? lookups.peopleById.get(t.personId) : undefined;
    const club = t.clubId ? lookups.clubNameById.get(t.clubId) : undefined;
    const events = t.eventIds.map((id) => lookups.eventNameById.get(id) ?? id).join(', ');
    return [
      t.date, t.type, person?.name ?? '', person?.email ?? '', club ?? '', events,
      t.invoiceNumber ?? '', t.description,
      dollars(t.subtotalCents), dollars(t.serviceFeeCents), dollars(t.stripeFeeCents), dollars(t.totalCents),
      t.stripeSessionId ?? '', t.stripePaymentIntentId ?? '',
    ];
  });
  return { name: 'Transactions', columns, rows };
}
