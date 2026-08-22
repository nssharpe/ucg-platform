import { useMemo, useState } from 'react';
import { Modal, Field } from './ui';
import { useToast } from './ui-hooks';
import { requestRefund } from '../lib/supabase';
import { syncFromSupabase, useDB } from '../lib/store';
import { addonConfig, addonPurchaseOpen } from '../lib/pricing';
import type { Event, InvoiceItem } from '../lib/types';

/** One item to request a refund for — either a paid registration (rule 1:
 *  ONE request per registration, covering every payment that funded it — the
 *  server enumerates the lines, this dialog just names WHICH registration)
 *  or a purchased add-on line. Shared between MyRegistrations.tsx
 *  (self-serve) and Club.tsx (club-manager, on behalf of an athlete) —
 *  event-mgmt v2 Phase 3, spec §H; grouped-per-registration rewrite UAT
 *  Z-04. When more than one item is passed (e.g. a club manager refunding
 *  every discipline an athlete registered for at once), the dialog collects
 *  ONE reason and fires one `requestRefund` call per item — each call is
 *  already its own complete, correctly-grouped request server-side. */
export interface RefundRequestItem {
  kind: 'registration' | 'addon';
  regId?: string;
  invoiceItemId?: string;
  label: string;
}

const REASON_OPTIONS: { value: 'injury' | 'illness' | 'bereavement' | 'other'; label: string }[] = [
  { value: 'injury', label: 'Injury' },
  { value: 'illness', label: 'Illness' },
  { value: 'bereavement', label: 'Bereavement' },
  { value: 'other', label: 'Other' },
];

const fmt = (n: number) => `$${n.toFixed(2)}`;

/** Every refundable line for a registration-kind item: entry + extra-
 *  discipline fee lines only (kind='meet-entry'), excluding change-fee lines
 *  outright (rule 2 — never refundable, even when a change fee is combined
 *  with an added discipline into one 'change'-tagged line, M-10-01). Scans
 *  every invoice this caller can see (`db.invoices`, Tier 2 boot-scoped to
 *  self + managed-club rows) since a registration may be paid across TWO
 *  invoices (rule 1). Client-side ESTIMATE only — the server always
 *  recomputes at approval time and this may read lower once a coupon is
 *  applied, same disclaimer RefundReview.tsx already carries. */
function registrationLines(allItems: InvoiceItem[], regId: string): InvoiceItem[] {
  return allItems.filter((it) => it.kind === 'meet-entry' && it.refLineType !== 'change' && (it.refRegIds ?? []).includes(regId));
}

interface ItemSummary {
  item: RefundRequestItem;
  lines: { label: string; amount: number }[];
  totalDollars: number;
  estimateDollars: number;
  isPastDeadline: boolean;
  /** false ⇒ excluded from submission (no refundable lines / addon past its
   *  own order deadline) — rendered separately with an explanatory note. */
  offerable: boolean;
  blockedNote?: string;
}

export function RefundRequestDialog({
  items, event, clubId, onClose, onSubmitted,
}: {
  items: RefundRequestItem[];
  event: Event;
  /** Pass when requesting on behalf of an athlete from a club-manager context. */
  clubId?: string;
  onClose: () => void;
  /** Called once every request has been submitted (success or partial failure) — the
   *  caller should refresh from Supabase so "Refund requested" badges show up. */
  onSubmitted: () => void;
}) {
  const toast = useToast();
  const db = useDB();
  const [reason, setReason] = useState<'injury' | 'illness' | 'bereavement' | 'other'>('injury');
  const [reasonDetail, setReasonDetail] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const allInvoiceItems = useMemo(() => db.invoices.flatMap((inv) => inv.items), [db.invoices]);

  const summaries: ItemSummary[] = useMemo(() => {
    const now = new Date();
    const isPastEditDeadline = !!event.lastDateToEdit && now.getTime() > Date.parse(event.lastDateToEdit);
    return items.map((item): ItemSummary => {
      if (item.kind === 'registration') {
        const lines = registrationLines(allInvoiceItems, item.regId ?? '');
        const totalDollars = lines.reduce((s, l) => s + l.amount, 0);
        const estimateDollars = isPastEditDeadline ? Math.round(totalDollars * 0.75 * 100) / 100 : totalDollars;
        return {
          item,
          lines: lines.map((l) => ({ label: l.label, amount: l.amount })),
          totalDollars,
          estimateDollars,
          isPastDeadline: isPastEditDeadline,
          offerable: lines.length > 0,
          blockedNote: lines.length > 0 ? undefined : 'No refundable paid lines were found for this registration.',
        };
      }
      const matched = allInvoiceItems.find((it) => it.id === item.invoiceItemId);
      const cfg = addonConfig(event, matched?.refLineType ?? null);
      const stillOpen = addonPurchaseOpen(cfg, event.regCloses, now);
      const amount = matched?.amount ?? 0;
      const deadlineIso = cfg?.lastPurchaseAt ?? event.regCloses;
      return {
        item,
        lines: matched ? [{ label: matched.label, amount }] : [],
        totalDollars: amount,
        estimateDollars: amount, // add-ons are always 100% while still offerable (rule 5)
        isPastDeadline: false,
        offerable: stillOpen,
        blockedNote: stillOpen ? undefined : `No refunds after the order deadline (${new Date(deadlineIso).toLocaleDateString('en-US')}).`,
      };
    });
  }, [items, allInvoiceItems, event]);

  const offerableSummaries = summaries.filter((s) => s.offerable);
  const blockedSummaries = summaries.filter((s) => !s.offerable);

  const detailRequired = reason === 'other';
  const canSubmit = offerableSummaries.length > 0 && (!detailRequired || reasonDetail.trim().length > 0);

  const submit = async () => {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    let okCount = 0;
    let firstError: string | undefined;
    for (const { item } of offerableSummaries) {
      const res = await requestRefund({
        kind: item.kind,
        regId: item.regId,
        invoiceItemId: item.invoiceItemId,
        reason,
        reasonDetail: reasonDetail.trim() || undefined,
        clubId,
      });
      if (res.ok) okCount += 1;
      else firstError = firstError ?? (res.error ?? 'Could not submit the refund request.');
    }
    setSubmitting(false);
    if (okCount > 0) {
      if (okCount === offerableSummaries.length) {
        toast('Refund requested — a league refund manager will review it.');
      } else {
        toast(`${okCount} of ${offerableSummaries.length} refund requests submitted. ${firstError ?? ''}`.trim(), { variant: 'error', persist: true });
      }
      // The write (refund_requests insert(s) + registrations.refund_requested
      // flip) happened server-side via the edge function — pull a fresh
      // snapshot rather than mutating local state, matching the pattern used
      // after other server-driven flows (Cart.tsx's onPaid).
      void syncFromSupabase().finally(onSubmitted);
    } else {
      toast(firstError ?? 'Could not submit the refund request.', { variant: 'error', persist: true });
    }
    onClose();
  };

  return (
    <Modal title="Request a refund" onClose={onClose}>
      <div
        className="card card-pad"
        style={{ borderLeft: '4px solid var(--coral-500)', marginBottom: 14, fontSize: 13, lineHeight: 1.5 }}
      >
        <strong>This cannot be undone once approved.</strong> If your request is approved,
        {offerableSummaries.length > 1 ? ' these registrations/items are' : ' this registration/item is'} fully removed
        — the athlete will no longer be registered (or the add-on will be refunded and removed from the order).
        A league refund manager reviews every request before anything changes. Service fees are non-refundable.
      </div>

      <p style={{ fontSize: 13, color: 'var(--ink-soft)', margin: '0 0 4px' }}>For {event.name}:</p>
      <ul style={{ margin: '0 0 14px', paddingLeft: 20, fontSize: 14 }}>
        {offerableSummaries.map((s) => (
          <li key={s.item.regId ?? s.item.invoiceItemId} style={{ marginBottom: 6 }}>
            <div>{s.item.label}</div>
            {s.lines.length > 0 && (
              <div style={{ fontSize: 12.5, color: 'var(--ink-soft)' }}>
                {s.lines.map((l) => `${l.label} — ${fmt(l.amount)}`).join(', ')}
                {' · '}Estimated refund: up to {fmt(s.estimateDollars)}
                {s.isPastDeadline ? ' (75% — past the edit deadline)' : ''}
              </div>
            )}
          </li>
        ))}
      </ul>

      {blockedSummaries.length > 0 && (
        <ul style={{ margin: '0 0 14px', paddingLeft: 20, fontSize: 13, color: 'var(--ink-soft)' }}>
          {blockedSummaries.map((s) => (
            <li key={s.item.regId ?? s.item.invoiceItemId}>
              <s>{s.item.label}</s> — {s.blockedNote}
            </li>
          ))}
        </ul>
      )}

      <Field label="Reason" required>
        <select
          className="input"
          value={reason}
          onChange={(e) => setReason(e.target.value as typeof reason)}
        >
          {REASON_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </Field>

      {detailRequired && (
        <Field label="Please explain" required>
          <textarea
            className="input"
            rows={3}
            value={reasonDetail}
            onChange={(e) => setReasonDetail(e.target.value)}
            placeholder="Tell us what happened…"
          />
        </Field>
      )}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 18 }}>
        <button className="btn ghost" onClick={onClose} disabled={submitting}>Cancel</button>
        <button className="btn primary" onClick={submit} disabled={!canSubmit || submitting}>
          {submitting ? 'Submitting…' : 'Submit refund request'}
        </button>
      </div>
    </Modal>
  );
}
