import { useState } from 'react';
import { useDB, mutate } from '../../../lib/store';
import { useCapabilities } from '../../../lib/capabilities';
import { useToast, useFmtDate } from '../../../components/ui-hooks';
import { Badge, Field, Tabs } from '../../../components/ui';
import { fmtMoney } from '../../../lib/scoring';
import { pushAccountingCode, deleteAccountingCode, pushHostPayout, deleteHostPayout } from '../../../lib/supabase';
import type { AccountingCode, Event, HostPayout } from '../../../lib/types';
import {
  buildFinanceTxns, buildFinanceSummary, buildFinanceSummarySheet, buildFinanceTxnsSheet,
  txnInRange, defaultLeagueRange, defaultEventRange, hostPayoutOwedCents,
  KNOWN_ITEM_KEYS, itemKeyLabel,
  type FinanceTxn, type FinanceSummary,
} from '../../../lib/finance';
import { downloadWorkbook } from '../../../lib/xlsx-download';

const LEAGUE_SCOPE = 'league';
type Tab = 'summary' | 'transactions' | 'codes';

// --- small pure helpers (trivial UI formatting -- not aggregation logic, so
// kept here rather than in finance.ts; see the task-brief judgment-call note
// in the final report) ---------------------------------------------------

/** yyyy-mm-dd (UTC) from a full ISO instant, for <input type="date"> values. */
const toDateOnly = (iso: string): string => iso.slice(0, 10);

/** date-only string -> full-day UTC bounds; empty ⇒ open bound. */
const dayStart = (dateOnly: string): string | undefined => (dateOnly ? `${dateOnly}T00:00:00.000Z` : undefined);
const dayEnd = (dateOnly: string): string | undefined => (dateOnly ? `${dateOnly}T23:59:59.999Z` : undefined);

const todayDateOnly = (): string => new Date().toISOString().slice(0, 10);

const slugify = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'scope';

function computeDefaultRange(scope: string, events: Event[]): { from: string; to: string } {
  if (scope === LEAGUE_SCOPE) {
    const r = defaultLeagueRange(new Date().toISOString());
    return { from: toDateOnly(r.from), to: toDateOnly(r.to) };
  }
  const ev = events.find((e) => e.id === scope);
  if (!ev) return { from: '', to: '' };
  const r = defaultEventRange(ev);
  return { from: r.from ? toDateOnly(r.from) : '', to: r.to ? toDateOnly(r.to) : '' };
}

function matchesSearch(t: FinanceTxn, q: string, peopleById: Map<string, { name?: string; email?: string }>): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  const person = t.personId ? peopleById.get(t.personId) : undefined;
  return [person?.name, person?.email, t.description, t.invoiceNumber]
    .some((v) => (v ?? '').toLowerCase().includes(needle));
}

/** Finance dashboard (event-mgmt v2 Phase 6 T3, spec §M): league-wide or
 *  per-event revenue summary, a full transaction ledger, host payout
 *  tracking, and per-item accounting-code management, plus an .xlsx export.
 *  All aggregation is done by the pure engine in src/lib/finance.ts (T2) --
 *  this page only wires up scope/range/tab UI state and the accounting-code/
 *  host-payout writes. */
export function Finance() {
  const db = useDB();
  const caps = useCapabilities();
  const toast = useToast();
  const fmtDate = useFmtDate();

  const events = db.events;
  const sortedEvents = [...events].sort((a, b) => b.startDate.localeCompare(a.startDate));

  const [scope, setScope] = useState<string>(LEAGUE_SCOPE);
  const [range, setRange] = useState(() => computeDefaultRange(LEAGUE_SCOPE, events));
  const [tab, setTab] = useState<Tab>('summary');
  const [itemKeyFilter, setItemKeyFilter] = useState<string | null>(null);
  const [txnSearch, setTxnSearch] = useState('');
  const [exporting, setExporting] = useState(false);

  const handleScopeChange = (newScope: string) => {
    setScope(newScope);
    setRange(computeDefaultRange(newScope, events));
    setItemKeyFilter(null);
  };

  const eventId = scope === LEAGUE_SCOPE ? undefined : scope;
  const fromIso = dayStart(range.from);
  const toIso = dayEnd(range.to);

  const payments = db.payments ?? [];
  const refundRequests = db.refundRequests ?? [];
  const accountingCodes = db.accountingCodes ?? [];
  const hostPayouts = db.hostPayouts ?? [];

  const txns = buildFinanceTxns({ payments, invoices: db.invoices, refundRequests, events: db.events });
  const summary = buildFinanceSummary(txns, { eventId, from: fromIso, to: toIso, accountingCodes, hostPayouts });

  const peopleById = new Map(db.people.map((p) => [p.id, { name: `${p.firstName} ${p.lastName}`, email: p.email }]));
  const clubNameById = new Map(db.clubs.map((c) => [c.id, c.name]));
  const eventNameById = new Map(db.events.map((e) => [e.id, e.name]));

  // Scope+range filtered (used by both the Transactions tab base set and the
  // export) -- itemKeyFilter/search are UI-only refinements on top.
  const rangeScopedTxns = txns
    .filter((t) => txnInRange(t, fromIso, toIso))
    .filter((t) => !eventId || t.eventIds.includes(eventId));
  const visibleTxns = rangeScopedTxns
    .filter((t) => !itemKeyFilter || t.lines.some((l) => l.itemKey === itemKeyFilter))
    .filter((t) => matchesSearch(t, txnSearch, peopleById));

  const goToTxnsForItemKey = (itemKey: string) => {
    setItemKeyFilter(itemKey);
    setTab('transactions');
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      const scopeEvent = eventId ? events.find((e) => e.id === eventId) : undefined;
      const title = (scopeEvent?.name ?? 'League summary').slice(0, 31);
      const summarySheet = buildFinanceSummarySheet(summary, { title });
      const txnsSheet = buildFinanceTxnsSheet(rangeScopedTxns, { peopleById, clubNameById, eventNameById });
      const scopeSlug = scopeEvent ? slugify(scopeEvent.name) : 'league';
      const filename = `ucg-finance-${scopeSlug}-${range.from || 'open'}-${range.to || 'open'}.xlsx`;
      await downloadWorkbook([summarySheet, txnsSheet], filename);
    } catch (err) {
      toast(`Couldn't build the export: ${err instanceof Error ? err.message : String(err)}`, { variant: 'error' });
    } finally {
      setExporting(false);
    }
  };

  const saveAccountingCode = (itemKey: string, value: string) => {
    const trimmed = value.trim();
    const existing = accountingCodes.find((c) => c.itemKey === itemKey);
    if (!trimmed) {
      if (existing) {
        mutate((d) => { d.accountingCodes = (d.accountingCodes ?? []).filter((c) => c.itemKey !== itemKey); });
        deleteAccountingCode(existing.id);
      }
      return;
    }
    if (existing && existing.code === trimmed) return;
    const code: AccountingCode = { id: existing?.id ?? crypto.randomUUID(), itemKey, code: trimmed, updatedAt: new Date().toISOString() };
    mutate((d) => {
      const list = (d.accountingCodes ??= []);
      const idx = list.findIndex((c) => c.itemKey === itemKey);
      if (idx >= 0) list[idx] = code; else list.push(code);
    });
    pushAccountingCode(code);
    toast(`Saved code for ${itemKeyLabel(itemKey)}.`);
  };

  const addHostPayout = (draft: { amount: string; method: HostPayout['method']; reference: string; paidOn: string; notes: string }) => {
    if (!eventId) return;
    const amountCents = Math.round(parseFloat(draft.amount) * 100);
    if (!draft.amount || Number.isNaN(amountCents) || amountCents <= 0) {
      toast('Enter a payout amount greater than $0.', { variant: 'error' });
      return;
    }
    if (!draft.paidOn) {
      toast('Enter the date the payout was made.', { variant: 'error' });
      return;
    }
    const payout: HostPayout = {
      id: crypto.randomUUID(),
      eventId,
      amountCents,
      method: draft.method,
      reference: draft.reference.trim() || undefined,
      paidOn: draft.paidOn,
      notes: draft.notes.trim() || undefined,
      createdBy: caps.personId ?? undefined,
      createdAt: new Date().toISOString(),
    };
    mutate((d) => { (d.hostPayouts ??= []).push(payout); });
    pushHostPayout(payout);
    toast('Payout recorded.');
  };

  const removeHostPayout = (id: string) => {
    if (!window.confirm('Delete this recorded payout? This cannot be undone.')) return;
    mutate((d) => { d.hostPayouts = (d.hostPayouts ?? []).filter((p) => p.id !== id); });
    deleteHostPayout(id);
    toast('Payout deleted.');
  };

  return (
    <div>
      <h1 className="page-title display">Finance</h1>
      <p className="page-sub">
        League-wide or per-event revenue summary, transaction ledger, host payout tracking, and accounting-code
        mapping (spec §M). Money is recomputed from payments/invoices/refunds -- not stored totals.
      </p>

      <div className="card card-pad" style={{ marginBottom: 18 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }}>
          <div style={{ minWidth: 240, flex: '1 1 240px' }}>
            <Field label="Scope">
              <select className="input" value={scope} onChange={(e) => handleScopeChange(e.target.value)}>
                <option value={LEAGUE_SCOPE}>League-wide (all events)</option>
                {sortedEvents.map((e) => (
                  <option key={e.id} value={e.id}>{e.name} — {fmtDate(e.startDate)}</option>
                ))}
              </select>
            </Field>
          </div>
          <div style={{ minWidth: 150 }}>
            <Field label="From">
              <input className="input" type="date" value={range.from} onChange={(ev) => setRange((r) => ({ ...r, from: ev.target.value }))} />
            </Field>
          </div>
          <div style={{ minWidth: 150 }}>
            <Field label="To">
              <input className="input" type="date" value={range.to} onChange={(ev) => setRange((r) => ({ ...r, to: ev.target.value }))} />
            </Field>
          </div>
          <button className="btn primary" disabled={exporting} onClick={handleExport} style={{ marginBottom: 2 }}>
            {exporting ? 'Building…' : 'Export (.xlsx)'}
          </button>
        </div>
      </div>

      <Tabs
        tabs={[
          { id: 'summary', label: 'Summary' },
          { id: 'transactions', label: 'Transactions' },
          { id: 'codes', label: 'Accounting codes' },
        ]}
        active={tab}
        onChange={setTab}
      />

      <div style={{ marginTop: 16 }}>
        {tab === 'summary' && (
          <SummaryTab
            summary={summary}
            isEventScope={!!eventId}
            event={eventId ? events.find((e) => e.id === eventId) : undefined}
            hostPayouts={eventId ? hostPayouts.filter((p) => p.eventId === eventId) : []}
            onItemKeyClick={goToTxnsForItemKey}
            onAddPayout={addHostPayout}
            onRemovePayout={removeHostPayout}
            fmtDate={fmtDate}
          />
        )}
        {tab === 'transactions' && (
          <TransactionsTab
            txns={visibleTxns}
            itemKeyFilter={itemKeyFilter}
            onClearFilter={() => setItemKeyFilter(null)}
            search={txnSearch}
            onSearchChange={setTxnSearch}
            peopleById={peopleById}
            clubNameById={clubNameById}
            eventNameById={eventNameById}
            fmtDate={fmtDate}
          />
        )}
        {tab === 'codes' && (
          <AccountingCodesTab accountingCodes={accountingCodes} onSave={saveAccountingCode} />
        )}
      </div>
    </div>
  );
}

// ---- Summary tab ----------------------------------------------------------

function SummaryTab({
  summary, isEventScope, event, hostPayouts, onItemKeyClick, onAddPayout, onRemovePayout, fmtDate,
}: {
  summary: FinanceSummary;
  isEventScope: boolean;
  event: Event | undefined;
  hostPayouts: HostPayout[];
  onItemKeyClick: (itemKey: string) => void;
  onAddPayout: (draft: { amount: string; method: HostPayout['method']; reference: string; paidOn: string; notes: string }) => void;
  onRemovePayout: (id: string) => void;
  fmtDate: (iso: string) => string;
}) {
  return (
    <div>
      <div className="card card-pad" style={{ overflowX: 'auto', marginBottom: 18 }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Item</th>
              <th>Accounting code</th>
              <th className="num">Gross</th>
              <th className="num">Refunds</th>
              <th className="num">Net</th>
              <th className="num">Count</th>
            </tr>
          </thead>
          <tbody>
            {summary.lines.length === 0 && (
              <tr><td colSpan={6} style={{ color: 'var(--ink-soft)' }}>No transactions in this range.</td></tr>
            )}
            {summary.lines.map((l) => (
              <tr key={l.itemKey}>
                <td>
                  <button
                    type="button"
                    className="btn-link"
                    style={{ background: 'none', border: 'none', padding: 0, color: 'var(--teal-900)', cursor: 'pointer', textDecoration: 'underline', font: 'inherit' }}
                    onClick={() => onItemKeyClick(l.itemKey)}
                    title="View these transactions"
                  >
                    {l.label}
                  </button>
                </td>
                <td style={{ color: l.code ? undefined : 'var(--ink-soft)' }}>{l.code ?? '—'}</td>
                <td className="num">{fmtMoney(l.grossCents / 100)}</td>
                <td className="num">{l.refundsCents > 0 ? `−${fmtMoney(l.refundsCents / 100)}` : fmtMoney(0)}</td>
                <td className="num">{fmtMoney(l.netCents / 100)}</td>
                <td className="num">{l.txnCount}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr style={{ fontWeight: 700, borderTop: '2px solid var(--line)' }}>
              <td colSpan={2}>Total</td>
              <td className="num">{fmtMoney(summary.grossCents / 100)}</td>
              <td className="num">{summary.refundsCents > 0 ? `−${fmtMoney(summary.refundsCents / 100)}` : fmtMoney(0)}</td>
              <td className="num">{fmtMoney(summary.netCents / 100)}</td>
              <td className="num">{summary.lines.reduce((s, l) => s + l.txnCount, 0)}</td>
            </tr>
          </tfoot>
        </table>
        <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13.5 }}>
          <div>Merchant fees collected (service fee): <strong>{fmtMoney(summary.feesCollectedCents / 100)}</strong></div>
          <div>Merchant fees paid (Stripe): <strong>{fmtMoney(summary.feesPaidCents / 100)}</strong></div>
          <div>Fee profit: <strong>{fmtMoney(summary.feeProfitCents / 100)}</strong></div>
          {!isEventScope && (
            <div>Paid to hosts: <strong>{fmtMoney(summary.hostPayoutsCents / 100)}</strong></div>
          )}
        </div>
      </div>

      {isEventScope && event && (
        <HostPayoutCard
          event={event}
          summary={summary}
          hostPayouts={hostPayouts}
          onAddPayout={onAddPayout}
          onRemovePayout={onRemovePayout}
          fmtDate={fmtDate}
        />
      )}
    </div>
  );
}

function HostPayoutCard({
  event, summary, hostPayouts, onAddPayout, onRemovePayout, fmtDate,
}: {
  event: Event;
  summary: FinanceSummary;
  hostPayouts: HostPayout[];
  onAddPayout: (draft: { amount: string; method: HostPayout['method']; reference: string; paidOn: string; notes: string }) => void;
  onRemovePayout: (id: string) => void;
  fmtDate: (iso: string) => string;
}) {
  const [draft, setDraft] = useState({ amount: '', method: 'check' as HostPayout['method'], reference: '', paidOn: todayDateOnly(), notes: '' });
  const owed = hostPayoutOwedCents(summary);
  const recordedCents = hostPayouts.reduce((s, p) => s + p.amountCents, 0);
  const remainingCents = owed.owedCents - recordedCents;
  const sortedPayouts = [...hostPayouts].sort((a, b) => b.paidOn.localeCompare(a.paidOn));

  const submit = () => {
    onAddPayout(draft);
    setDraft({ amount: '', method: 'check', reference: '', paidOn: todayDateOnly(), notes: '' });
  };

  return (
    <div className="card card-pad">
      <h3 className="card-title">Host payout — {event.name}</h3>
      <p style={{ fontSize: 13, color: 'var(--ink-soft)', marginTop: 0 }}>
        Owed amount is provisional: it's this event's net revenue (gross minus approved refunds), with no
        deduction for merchant fees or payouts already made. Confirm the final figure before sending money.
      </p>
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 10 }}>
        <div>Owed (provisional): <strong>{fmtMoney(owed.owedCents / 100)}</strong></div>
        <div>Recorded payouts: <strong>{fmtMoney(recordedCents / 100)}</strong></div>
        <div>
          Remaining:{' '}
          <strong style={remainingCents < 0 ? { color: 'var(--coral-700)' } : undefined}>
            {fmtMoney(remainingCents / 100)}
          </strong>
        </div>
      </div>
      <details style={{ marginBottom: 16 }}>
        <summary style={{ fontSize: 12.5, color: 'var(--teal-900)', cursor: 'pointer' }}>Show calculation</summary>
        <ul style={{ margin: '6px 0 0 16px', fontSize: 12.5, color: 'var(--ink-soft)' }}>
          {owed.parts.map((p) => (
            <li key={p.label}>{p.label}: {fmtMoney(p.cents / 100)}</li>
          ))}
        </ul>
      </details>

      <h4 style={{ margin: '0 0 8px', fontSize: 14 }}>Recorded payouts ({sortedPayouts.length})</h4>
      {sortedPayouts.length === 0 ? (
        <p style={{ fontSize: 13.5, color: 'var(--ink-soft)' }}>No payouts recorded for this event yet.</p>
      ) : (
        <div style={{ overflowX: 'auto', marginBottom: 16 }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Date</th><th>Method</th><th>Reference</th><th className="num">Amount</th><th>Notes</th><th />
              </tr>
            </thead>
            <tbody>
              {sortedPayouts.map((p) => (
                <tr key={p.id}>
                  <td>{fmtDate(p.paidOn)}</td>
                  <td style={{ textTransform: 'capitalize' }}>{p.method}</td>
                  <td>{p.reference ?? '—'}</td>
                  <td className="num">{fmtMoney(p.amountCents / 100)}</td>
                  <td>{p.notes ?? '—'}</td>
                  <td>
                    <button
                      type="button"
                      className="btn small ghost"
                      title="Delete this payout"
                      onClick={() => onRemovePayout(p.id)}
                    >✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h4 style={{ margin: '0 0 8px', fontSize: 14 }}>Add payout</h4>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'end' }}>
        <div style={{ minWidth: 120 }}>
          <Field label="Amount ($)">
            <input className="input" type="number" min="0" step="0.01" value={draft.amount}
              onChange={(e) => setDraft((d) => ({ ...d, amount: e.target.value }))} />
          </Field>
        </div>
        <div style={{ minWidth: 130 }}>
          <Field label="Method">
            <select className="input" value={draft.method}
              onChange={(e) => setDraft((d) => ({ ...d, method: e.target.value as HostPayout['method'] }))}>
              <option value="check">Check</option>
              <option value="paypal">PayPal</option>
              <option value="ach">ACH</option>
            </select>
          </Field>
        </div>
        <div style={{ minWidth: 160 }}>
          <Field label="Reference">
            <input className="input" type="text" value={draft.reference}
              onChange={(e) => setDraft((d) => ({ ...d, reference: e.target.value }))} placeholder="Check #, txn id…" />
          </Field>
        </div>
        <div style={{ minWidth: 150 }}>
          <Field label="Paid on">
            <input className="input" type="date" value={draft.paidOn}
              onChange={(e) => setDraft((d) => ({ ...d, paidOn: e.target.value }))} />
          </Field>
        </div>
        <div style={{ minWidth: 180, flex: '1 1 180px' }}>
          <Field label="Notes">
            <input className="input" type="text" value={draft.notes}
              onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))} />
          </Field>
        </div>
        <button className="btn primary" style={{ marginBottom: 2 }} onClick={submit}>Add payout</button>
      </div>
    </div>
  );
}

// ---- Transactions tab ------------------------------------------------------

function TransactionsTab({
  txns, itemKeyFilter, onClearFilter, search, onSearchChange, peopleById, clubNameById, eventNameById, fmtDate,
}: {
  txns: FinanceTxn[];
  itemKeyFilter: string | null;
  onClearFilter: () => void;
  search: string;
  onSearchChange: (v: string) => void;
  peopleById: Map<string, { name?: string; email?: string }>;
  clubNameById: Map<string, string>;
  eventNameById: Map<string, string>;
  fmtDate: (iso: string) => string;
}) {
  return (
    <div className="card card-pad">
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end', marginBottom: 14 }}>
        <div style={{ minWidth: 220 }}>
          <Field label="Search">
            <input className="input" type="text" value={search} onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Name, email, description, invoice #…" />
          </Field>
        </div>
        {itemKeyFilter && (
          <Badge tone="info">
            Filtered: {itemKeyLabel(itemKeyFilter)}{' '}
            <button
              type="button"
              onClick={onClearFilter}
              style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0, marginLeft: 4, font: 'inherit' }}
            >✕</button>
          </Badge>
        )}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Date</th><th>Type</th><th>Name</th><th>Email</th><th>Club</th><th>Event(s)</th>
              <th>Invoice #</th><th>Description</th>
              <th className="num">Subtotal</th><th className="num">Service fee</th><th className="num">Stripe fee</th><th className="num">Total</th>
            </tr>
          </thead>
          <tbody>
            {txns.length === 0 && (
              <tr><td colSpan={12} style={{ color: 'var(--ink-soft)' }}>No transactions match.</td></tr>
            )}
            {txns.map((t) => {
              const person = t.personId ? peopleById.get(t.personId) : undefined;
              const club = t.clubId ? clubNameById.get(t.clubId) : undefined;
              const events = t.eventIds.map((id) => eventNameById.get(id) ?? id).join(', ');
              const isRefund = t.type === 'refund';
              return (
                <tr key={t.id}>
                  <td>{fmtDate(t.date)}</td>
                  <td><Badge tone={isRefund ? 'err' : 'ok'}>{isRefund ? 'Refund' : 'Payment'}</Badge></td>
                  <td>{person?.name ?? '—'}</td>
                  <td>{person?.email ?? '—'}</td>
                  <td>{club ?? 'Individual'}</td>
                  <td>{events || '—'}</td>
                  <td>{t.invoiceNumber ?? '—'}</td>
                  <td title={t.description} style={{ maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t.description}
                  </td>
                  <td className="num" style={isRefund ? { color: 'var(--coral-700)' } : undefined}>
                    {isRefund ? `−${fmtMoney(Math.abs(t.subtotalCents) / 100)}` : fmtMoney(t.subtotalCents / 100)}
                  </td>
                  <td className="num">{fmtMoney(t.serviceFeeCents / 100)}</td>
                  <td className="num">{fmtMoney(t.stripeFeeCents / 100)}</td>
                  <td className="num" style={isRefund ? { color: 'var(--coral-700)' } : undefined}>
                    {isRefund ? `−${fmtMoney(Math.abs(t.totalCents) / 100)}` : fmtMoney(t.totalCents / 100)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---- Accounting codes tab --------------------------------------------------

function AccountingCodesTab({
  accountingCodes, onSave,
}: {
  accountingCodes: AccountingCode[];
  onSave: (itemKey: string, value: string) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const codeFor = (itemKey: string) => accountingCodes.find((c) => c.itemKey === itemKey)?.code ?? '';

  const commit = (itemKey: string) => {
    const value = drafts[itemKey] ?? codeFor(itemKey);
    onSave(itemKey, value);
    setDrafts((d) => { const next = { ...d }; delete next[itemKey]; return next; });
  };

  return (
    <div className="card card-pad">
      <p style={{ fontSize: 13, color: 'var(--ink-soft)', marginTop: 0 }}>
        Codes appear on the Summary tab and in exports.
      </p>
      <div style={{ overflowX: 'auto' }}>
        <table className="tbl">
          <thead>
            <tr><th>Item</th><th>Key</th><th>Accounting code</th></tr>
          </thead>
          <tbody>
            {KNOWN_ITEM_KEYS.map((key) => (
              <tr key={key}>
                <td>{itemKeyLabel(key)}</td>
                <td style={{ fontSize: 12, color: 'var(--ink-soft)' }}>{key}</td>
                <td>
                  <input
                    className="input"
                    style={{ maxWidth: 200 }}
                    value={drafts[key] ?? codeFor(key)}
                    onChange={(e) => setDrafts((d) => ({ ...d, [key]: e.target.value }))}
                    onBlur={() => commit(key)}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur(); } }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
