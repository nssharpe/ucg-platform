import { useState } from 'react';
import { Modal, Field } from './ui';
import { useToast } from './ui-hooks';
import { requestRefund } from '../lib/supabase';
import { syncFromSupabase } from '../lib/store';

/** One item to request a refund for — either a paid registration entry or a
 *  purchased add-on line. Shared between MyRegistrations.tsx (self-serve) and
 *  Club.tsx (club-manager, on behalf of an athlete) — event-mgmt v2 Phase 3,
 *  spec §H. When more than one item is passed (e.g. a club manager refunding
 *  every discipline an athlete registered for at once), the dialog collects
 *  ONE reason and fires one `requestRefund` call per item. */
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

export function RefundRequestDialog({
  items, eventName, clubId, onClose, onSubmitted,
}: {
  items: RefundRequestItem[];
  eventName: string;
  /** Pass when requesting on behalf of an athlete from a club-manager context. */
  clubId?: string;
  onClose: () => void;
  /** Called once every request has been submitted (success or partial failure) — the
   *  caller should refresh from Supabase so "Refund requested" badges show up. */
  onSubmitted: () => void;
}) {
  const toast = useToast();
  const [reason, setReason] = useState<'injury' | 'illness' | 'bereavement' | 'other'>('injury');
  const [reasonDetail, setReasonDetail] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const detailRequired = reason === 'other';
  const canSubmit = items.length > 0 && (!detailRequired || reasonDetail.trim().length > 0);

  const submit = async () => {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    let okCount = 0;
    let firstError: string | undefined;
    for (const item of items) {
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
      if (okCount === items.length) {
        toast('Refund requested — a league refund manager will review it.');
      } else {
        toast(`${okCount} of ${items.length} refund requests submitted. ${firstError ?? ''}`.trim(), { variant: 'error', persist: true });
      }
      // The write (refund_requests insert + registrations.refund_requested
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
        {items.length > 1 ? ' these registrations/items are' : ' this registration/item is'} fully removed
        — the athlete will no longer be registered (or the add-on will be refunded and removed from the order).
        A league refund manager reviews every request before anything changes.
      </div>

      <p style={{ fontSize: 13, color: 'var(--ink-soft)', margin: '0 0 4px' }}>For {eventName}:</p>
      <ul style={{ margin: '0 0 14px', paddingLeft: 20, fontSize: 14 }}>
        {items.map((it) => <li key={it.regId ?? it.invoiceItemId}>{it.label}</li>)}
      </ul>

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
