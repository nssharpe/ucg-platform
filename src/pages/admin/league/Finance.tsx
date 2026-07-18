import { useMemo, useState } from 'react';
import { isStuckPending } from '../../../lib/reconciliation';
import { useDB, mutate, syncFromSupabase } from '../../../lib/store';
import { useCapabilities } from '../../../lib/capabilities';
import { useToast, useFmtDate } from '../../../components/ui-hooks';
import { Badge, Field, Modal, Tabs } from '../../../components/ui';
import { fmtMoney } from '../../../lib/scoring';
import {
  pushAccountingCode, deleteAccountingCode, pushHostPayout, deleteHostPayout,
  reconcileScan, reconcileRefulfill, reconcileMarkRefunded,
  type ReconDriftRow,
} from '../../../lib/supabase';
import type { AccountingCode, Event, HostPayout, Payment } from '../../../lib/types';
import {
  buildFinanceTxns, buildFinanceSummary, buildFinanceSummarySheet, buildFinanceTxnsSheet,
  txnInRange, defaultLeagueRange, defaultEventRange, hostPayoutOwedCents,
  KNOWN_ITEM_KEYS, itemKeyLabel,
  type FinanceTxn, type FinanceSummary,
} from '../../../lib/finance';
import { downloadWorkbook } from '../../../lib/xlsx-download';

const LEAGUE_SCOPE = 'league';
type Tab = 'summary' | 'transactions' | 'codes' | 'recon';

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
        // offline read-only gate: skip the remote delete if local was refused
        if (!mutate((d) => { d.accountingCodes = (d.accountingCodes ?? []).filter((c) => c.itemKey !== itemKey); })) return;
        deleteAccountingCode(existing.id);
      }
      return;
    }
    if (existing && existing.code === trimmed) return;
    const code: AccountingCode = { id: existing?.id ?? crypto.randomUUID(), itemKey, code: trimmed, updatedAt: new Date().toISOString() };
    const applied = mutate((d) => {
      const list = (d.accountingCodes ??= []);
      const idx = list.findIndex((c) => c.itemKey === itemKey);
      if (idx >= 0) list[idx] = code; else list.push(code);
    });
    if (!applied) return; // offline read-only gate — don't push or claim success
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
    if (!mutate((d) => { (d.hostPayouts ??= []).push(payout); })) return; // offline read-only gate
    pushHostPayout(payout);
    toast('Payout recorded.');
  };

  const removeHostPayout = (id: string) => {
    if (!window.confirm('Delete this recorded payout? This cannot be undone.')) return;
    if (!mutate((d) => { d.hostPayouts = (d.hostPayouts ?? []).filter((p) => p.id !== id); })) return; // offline read-only gate
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
          { id: 'recon', label: 'Reconciliation' },
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
        {tab === 'recon' && (
          <ReconciliationTab payments={payments} peopleById={peopleById} clubNameById={clubNameById} fmtDate={fmtDate} />
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
        Owed is the total collected for this event (registrations and add-ons, before service/admin
        fees). Refunds are not deducted — refund requests to a host club are handled by the club
        itself, and the full amount collected is still paid out.
      </p>
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 10 }}>
        <div>Owed: <strong>{fmtMoney(owed.owedCents / 100)}</strong></div>
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

// ---- Reconciliation tab (F4) ------------------------------------------------
// Panel A (stuck-pending) reads straight off the already-loaded `db.payments`
// store — admin/finance_admin already have blanket RLS read access to
// `payments` (payments_self_read's is_admin() branch + the finance_admin
// parity policy added in 20260716120000), so no server round trip is needed
// just to LIST them; the reconcile-payments edge function is only invoked for
// the actual re-fulfillment action. Panel B (Stripe drift) has no local
// equivalent — it requires live Stripe lookups server-side — so it's scan-
// on-click only via the edge function's 'scan' op, never auto-run on mount.

const DRIFT_VERDICT_LABEL: Record<ReconDriftRow['verdict'], string> = {
  'consistent': 'Consistent',
  'dashboard-refund-drift-partial': 'Dashboard refund (partial) — not reflected',
  'dashboard-refund-drift-full': 'Dashboard refund (full) — not reflected',
  'record-ahead-of-stripe': 'Our records show MORE refunded than Stripe — needs manual review',
};

function ReconciliationTab({
  payments, peopleById, clubNameById, fmtDate,
}: {
  payments: Payment[];
  peopleById: Map<string, { name?: string; email?: string }>;
  clubNameById: Map<string, string>;
  fmtDate: (iso: string) => string;
}) {
  const toast = useToast();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [driftRows, setDriftRows] = useState<ReconDriftRow[]>([]);
  const [scanMeta, setScanMeta] = useState<{ scannedDays: number; scannedCount: number; truncated: boolean } | null>(null);
  const [confirmMark, setConfirmMark] = useState<ReconDriftRow | null>(null);

  // Lazy-initialized once (not read live during render) so this stays a pure
  // render per the react-hooks/purity rule — an admin re-opening the tab gets
  // a fresh mount anyway, and the 1h cutoff doesn't need second-level accuracy.
  const [nowMs] = useState(() => Date.now());
  const stuckPending = useMemo(
    () => payments.filter((p) => isStuckPending(p.status, p.createdAt, nowMs)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [payments, nowMs],
  );

  const clubIdFor = (p: Payment): string | undefined => p.linesSnapshot?.find((l) => l.clubId)?.clubId;

  const payerLabel = (p: Payment): string => {
    const clubId = clubIdFor(p);
    if (clubId) return clubNameById.get(clubId) ?? clubId;
    const person = p.personId ? peopleById.get(p.personId) : undefined;
    return person?.name ?? p.personId ?? '—';
  };

  const totalCents = (p: Payment): number => (p.amountSubtotal ?? 0) + (p.serviceFee ?? 0);

  const runRefulfill = async (paymentId: string) => {
    setBusyId(paymentId);
    const res = await reconcileRefulfill(paymentId);
    setBusyId(null);
    if (!res.ok) {
      toast(res.error ?? 'Could not re-run fulfillment.', { variant: 'error', persist: true });
      return;
    }
    if (res.fulfilled) {
      toast('Payment fulfilled.');
      void syncFromSupabase();
    } else {
      const message = res.verdict === 'stripe-expired'
        ? 'Stripe shows this checkout session as expired — nothing to fulfill.'
        : res.verdict === 'amount-mismatch'
          ? 'What Stripe collected does not match this payment’s recorded amount — not fulfilled. This needs manual review (see error_logs).'
          : `Stripe does not show this session as paid (status: ${res.stripePaymentStatus ?? 'unknown'}) — not fulfilled.`;
      toast(message, { variant: 'error', persist: true });
    }
  };

  const runScan = async () => {
    setScanning(true);
    const res = await reconcileScan();
    setScanning(false);
    setScanned(true);
    if (!res.ok) {
      toast(res.error ?? 'Could not scan for refund drift.', { variant: 'error', persist: true });
      return;
    }
    setDriftRows(res.driftRows ?? []);
    setScanMeta({
      scannedDays: res.scannedDays ?? 90,
      scannedCount: res.scannedCount ?? 0,
      truncated: !!res.truncated,
    });
  };

  const confirmMarkRefunded = async (note: string) => {
    if (!confirmMark) return;
    setBusyId(confirmMark.id);
    const res = await reconcileMarkRefunded(confirmMark.id, note);
    setBusyId(null);
    setConfirmMark(null);
    if (!res.ok) {
      toast(res.error ?? 'Could not record the reconciliation note.', { variant: 'error', persist: true });
      return;
    }
    toast(res.statusChanged ? 'Marked refunded — status updated.' : 'Reconciliation note recorded.');
    setDriftRows((rows) => rows.filter((r) => r.id !== confirmMark.id));
    void syncFromSupabase();
  };

  return (
    <div>
      <div className="card card-pad" style={{ marginBottom: 18 }}>
        <h3 className="card-title" style={{ marginBottom: 4 }}>Stuck pending ({stuckPending.length})</h3>
        <p style={{ fontSize: 13, color: 'var(--ink-soft)', marginTop: 0, marginBottom: 12 }}>
          Payments still <code>pending</code> more than an hour after creation — the Stripe webhook may have been
          missed or failed. Re-running fulfillment re-checks the Stripe session first and only completes the order
          if Stripe confirms it was actually paid.
        </p>
        {stuckPending.length === 0 ? (
          <p style={{ fontSize: 13.5, color: 'var(--ink-soft)' }}>No stuck-pending payments.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Created</th><th>Payer / club</th><th className="num">Amount</th><th>Session</th><th />
                </tr>
              </thead>
              <tbody>
                {stuckPending.map((p) => (
                  <tr key={p.id}>
                    <td>{fmtDate(p.createdAt)}</td>
                    <td>{payerLabel(p)}</td>
                    <td className="num">{fmtMoney(totalCents(p) / 100)}</td>
                    <td style={{ fontSize: 12.5, color: 'var(--ink-soft)' }}>
                      {p.stripeSessionId ? p.stripeSessionId : <Badge tone="info">Free order</Badge>}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn small primary"
                        disabled={busyId === p.id}
                        onClick={() => void runRefulfill(p.id)}
                      >
                        {busyId === p.id ? 'Working…' : 'Re-run fulfillment'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card card-pad">
        <h3 className="card-title" style={{ marginBottom: 4 }}>Stripe refund drift</h3>
        <p style={{ fontSize: 13, color: 'var(--ink-soft)', marginTop: 0, marginBottom: 12 }}>
          Finds paid orders (last 90 days) where Stripe shows a refund our records don't account for — typically a
          refund issued directly in the Stripe Dashboard, which never reflects into our system. Runs live Stripe
          lookups, so this is on-demand only.
        </p>
        <button type="button" className="btn primary" disabled={scanning} onClick={() => void runScan()} style={{ marginBottom: 14 }}>
          {scanning ? 'Scanning…' : 'Scan for refund drift'}
        </button>

        {scanMeta && (
          <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', marginTop: 0 }}>
            Checked {scanMeta.scannedCount} paid payment{scanMeta.scannedCount === 1 ? '' : 's'} from the last {scanMeta.scannedDays} days.
            {scanMeta.truncated ? ' More rows exist than could be checked in one scan — run again to cover the rest.' : ''}
          </p>
        )}

        {scanned && driftRows.length === 0 && (
          <p style={{ fontSize: 13.5, color: 'var(--ink-soft)' }}>No drift found.</p>
        )}

        {driftRows.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Date</th><th>Payer</th><th>Verdict</th>
                  <th className="num">Our records</th><th className="num">Stripe shows</th><th />
                </tr>
              </thead>
              <tbody>
                {driftRows.map((r) => {
                  const person = r.personId ? peopleById.get(r.personId) : undefined;
                  const actionable = r.verdict === 'dashboard-refund-drift-full' || r.verdict === 'dashboard-refund-drift-partial';
                  return (
                    <tr key={r.id}>
                      <td>{fmtDate(r.createdAt)}</td>
                      <td>{person?.name ?? r.personId ?? '—'}</td>
                      <td>
                        <Badge tone={r.verdict === 'record-ahead-of-stripe' ? 'warn' : 'err'}>
                          {DRIFT_VERDICT_LABEL[r.verdict]}
                        </Badge>
                      </td>
                      <td className="num">{fmtMoney(r.ourApprovedRefundedCents / 100)}</td>
                      <td className="num">{fmtMoney(r.stripeRefundedCents / 100)}</td>
                      <td>
                        {actionable && (
                          <button
                            type="button"
                            className="btn small primary"
                            disabled={busyId === r.id}
                            onClick={() => setConfirmMark(r)}
                          >
                            Mark refunded
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {confirmMark && (
        <MarkRefundedDialog
          row={confirmMark}
          busy={busyId === confirmMark.id}
          onCancel={() => setConfirmMark(null)}
          onConfirm={confirmMarkRefunded}
        />
      )}
    </div>
  );
}

function MarkRefundedDialog({
  row, busy, onCancel, onConfirm,
}: {
  row: ReconDriftRow;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (note: string) => void;
}) {
  const [note, setNote] = useState('');
  return (
    <Modal title="Mark refunded" onClose={onCancel}>
      <p style={{ fontSize: 14 }}>
        Stripe shows <strong>{fmtMoney(row.stripeRefundedCents / 100)}</strong> refunded on this payment (our records
        show {fmtMoney(row.ourApprovedRefundedCents / 100)}).
      </p>
      <p style={{ fontSize: 13.5, color: 'var(--coral-700)', fontWeight: 600 }}>
        This only aligns bookkeeping — it does NOT reverse the athlete's registration, membership, or invoice.
        Dashboard refunds bypass the in-app reversal flow entirely; if the registration/membership also needs to be
        undone, do that separately.
      </p>
      <Field label="Note (optional)">
        <textarea
          className="input"
          rows={3}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="e.g. confirmed with Stripe Dashboard, event cancelled…"
        />
      </Field>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 18 }}>
        <button className="btn ghost" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="btn primary" onClick={() => onConfirm(note)} disabled={busy}>
          {busy ? 'Working…' : 'Mark refunded'}
        </button>
      </div>
    </Modal>
  );
}
