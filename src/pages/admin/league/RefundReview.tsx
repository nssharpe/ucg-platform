import { useMemo, useState } from 'react';
import { useDB, syncFromSupabase } from '../../../lib/store';
import { useToast } from '../../../components/ui-hooks';
import { useFmtDate } from '../../../components/ui-hooks';
import { Badge, Modal } from '../../../components/ui';
import { fmtMoney } from '../../../lib/scoring';
import { refundAmountCents } from '../../../lib/pricing';
import { processRefund } from '../../../lib/supabase';
import { useAdminInvoices } from '../../../lib/invoices-admin-slice';
import type { RefundRequest } from '../../../lib/types';

const REASON_LABEL: Record<RefundRequest['reason'], string> = {
  injury: 'Injury', illness: 'Illness', bereavement: 'Bereavement', other: 'Other',
};

/** Refund review queue (event-mgmt v2 Phase 3, spec §H, T6). Refund managers
 *  and admins approve or reject pending `refund_requests` rows; the actual
 *  Stripe call + item/registration state change happens server-side
 *  (`process-refund` Edge Function) — this page only displays + confirms. */
export function RefundReview() {
  const db = useDB();
  const toast = useToast();
  const fmtDate = useFmtDate();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{ request: RefundRequest; action: 'approve' | 'reject' } | null>(null);

  // invoices are Tier 2 boot-scoped to the caller's own + managed-club rows
  // (whats-next.md §7) — a refund_manager reviewing requests league-wide
  // needs every invoice's items to resolve what's being refunded, so this
  // fetches on demand instead (CONTRACT shape #4). The ACTUAL refund amount
  // is always computed server-side by process-refund regardless of what
  // renders here, but showing "Item not yet resolved" for every request
  // because this list was scoped-empty would still be a badly misleading
  // review queue, so gate item resolution on `invoicesStatus === 'ready'`.
  const { rows: invoices, status: invoicesStatus } = useAdminInvoices();

  const requests = useMemo(() => db.refundRequests ?? [], [db.refundRequests]);
  const pending = useMemo(
    () => requests.filter((r) => r.status === 'pending').slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [requests],
  );
  const reviewed = useMemo(
    () => requests.filter((r) => r.status !== 'pending').slice().sort((a, b) => (b.reviewedAt ?? '').localeCompare(a.reviewedAt ?? '')),
    [requests],
  );

  const personName = (id: string | null | undefined) => {
    const p = db.people.find((x) => x.id === id);
    return p ? `${p.firstName} ${p.lastName}` : (id ?? '—');
  };
  const clubName = (id: string | null | undefined) => db.clubs.find((c) => c.id === id)?.name ?? '—';
  const eventName = (id: string) => db.events.find((e) => e.id === id)?.name ?? '—';
  const event = (id: string) => db.events.find((e) => e.id === id);

  /** Resolve the item this request references (both kinds stamp invoiceItemId
   *  — see request-refund's registration-kind fix) by scanning every invoice's
   *  items. Not every request necessarily has one visible yet (e.g. a
   *  host-club $0 entry never gets an invoice_item at all), and none resolve
   *  before the on-demand invoices fetch (above) is ready. */
  const itemFor = (r: RefundRequest) => {
    if (!r.invoiceItemId || invoicesStatus !== 'ready') return null;
    for (const inv of invoices) {
      const item = inv.items.find((i) => i.id === r.invoiceItemId);
      if (item) return item;
    }
    return null;
  };

  const expectedRefund = (r: RefundRequest) => {
    const item = itemFor(r);
    if (!item) return null;
    const ev = event(r.eventId);
    const baseCents = Math.round(item.amount * 100);
    const cents = refundAmountCents(baseCents, ev?.lastDateToEdit ?? null, new Date().toISOString());
    const isPastDeadline = cents < baseCents;
    return { cents, isPastDeadline };
  };

  const decide = async (r: RefundRequest, action: 'approve' | 'reject') => {
    setBusyId(r.id);
    const res = await processRefund(r.id, action);
    setBusyId(null);
    setConfirming(null);
    if (res.ok) {
      toast(action === 'approve'
        ? `Refund approved${typeof res.refundAmountCents === 'number' ? ` — ${fmtMoney(res.refundAmountCents / 100)} refunded` : ''}.`
        : 'Refund request rejected.');
      void syncFromSupabase();
    } else {
      toast(res.error ?? 'Could not process this decision.', { variant: 'error', persist: true });
    }
  };

  const Row = ({ r, reviewedView }: { r: RefundRequest; reviewedView?: boolean }) => {
    const item = itemFor(r);
    const exp = expectedRefund(r);
    const noPayment = !r.paymentId;
    return (
      <li className="card card-pad" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, alignItems: 'baseline' }}>
          <div>
            <strong>{personName(r.requesterPersonId)}</strong>{' '}
            <span style={{ color: 'var(--ink-soft)' }}>
              — {item?.label ?? (r.kind === 'registration' ? 'Registration entry' : 'Add-on')}
            </span>
          </div>
          <span style={{ fontSize: 12.5, color: 'var(--ink-soft)' }}>
            {reviewedView ? (r.reviewedAt ? fmtDate(r.reviewedAt) : '—') : fmtDate(r.createdAt)}
          </span>
        </div>
        <div style={{ fontSize: 13.5, color: 'var(--ink-soft)', marginTop: 4 }}>
          {eventName(r.eventId)} {r.clubId ? `· ${clubName(r.clubId)}` : ''}
        </div>
        <div style={{ fontSize: 13.5, marginTop: 6 }}>
          <strong>Reason:</strong> {REASON_LABEL[r.reason]}
          {r.reasonDetail ? ` — ${r.reasonDetail}` : ''}
        </div>

        {!reviewedView && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10, alignItems: 'center' }}>
            {noPayment && <Badge tone="warn">No traceable payment — manual</Badge>}
            {exp && exp.isPastDeadline && <Badge tone="warn">75% — past edit deadline</Badge>}
            {exp && (
              <span style={{ fontSize: 13, color: 'var(--ink-soft)' }}>
                Expected refund: up to {fmtMoney(exp.cents / 100)} — the final amount is computed
                server-side and may be lower if a coupon was applied to the purchase
              </span>
            )}
            {!exp && !noPayment && (
              <Badge tone="info">{invoicesStatus === 'loading' ? 'Loading item…' : 'Item not yet resolved'}</Badge>
            )}
          </div>
        )}

        {reviewedView ? (
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 10, alignItems: 'center' }}>
            <Badge tone={r.status === 'approved' ? 'ok' : 'err'}>{r.status === 'approved' ? 'Approved' : 'Rejected'}</Badge>
            {r.status === 'approved' && typeof r.refundAmountCents === 'number' && (
              <span style={{ fontSize: 13 }}>{fmtMoney(r.refundAmountCents / 100)} refunded</span>
            )}
            <span style={{ fontSize: 12.5, color: 'var(--ink-soft)' }}>Reviewed by {personName(r.reviewedBy)}</span>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="btn small primary" disabled={busyId === r.id} onClick={() => setConfirming({ request: r, action: 'approve' })}>
              Approve
            </button>
            <button className="btn small danger" disabled={busyId === r.id} onClick={() => setConfirming({ request: r, action: 'reject' })}>
              Reject
            </button>
          </div>
        )}
      </li>
    );
  };

  return (
    <div style={{ maxWidth: 820 }}>
      <h1 className="page-title display">Refund requests</h1>
      <p className="page-sub">
        Review and process member refund requests (spec §H). Approving refunds the original payment method and either
        removes the registration (on time) or blanks its apparatus selections and keeps it listed (past the edit deadline).
      </p>

      <h3 className="card-title" style={{ marginBottom: 8 }}>Pending ({pending.length})</h3>
      {pending.length === 0 ? (
        <p style={{ fontSize: 13.5, color: 'var(--ink-soft)' }}>No pending refund requests.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 28px' }}>
          {pending.map((r) => <Row key={r.id} r={r} />)}
        </ul>
      )}

      <h3 className="card-title" style={{ marginBottom: 8 }}>Reviewed history</h3>
      {reviewed.length === 0 ? (
        <p style={{ fontSize: 13.5, color: 'var(--ink-soft)' }}>Nothing reviewed yet.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {reviewed.slice(0, 200).map((r) => <Row key={r.id} r={r} reviewedView />)}
        </ul>
      )}

      {confirming && (
        <ConfirmDialog
          request={confirming.request}
          action={confirming.action}
          expected={expectedRefund(confirming.request)}
          eventName={eventName(confirming.request.eventId)}
          busy={busyId === confirming.request.id}
          onCancel={() => setConfirming(null)}
          onConfirm={() => decide(confirming.request, confirming.action)}
        />
      )}
    </div>
  );
}

function ConfirmDialog({
  request, action, expected, eventName, busy, onCancel, onConfirm,
}: {
  request: RefundRequest;
  action: 'approve' | 'reject';
  expected: { cents: number; isPastDeadline: boolean } | null;
  eventName: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal title={action === 'approve' ? 'Approve refund' : 'Reject refund'} onClose={onCancel}>
      {action === 'approve' ? (
        <>
          <p style={{ fontSize: 14 }}>
            Approve this refund for <strong>{eventName}</strong>?
          </p>
          {expected ? (
            <p style={{ fontSize: 14 }}>
              Up to <strong>{fmtMoney(expected.cents / 100)}</strong> will be refunded to the original payment method
              {expected.isPastDeadline ? ' (75% — past the edit deadline; 25% is retained).' : ' (100% — on/before the edit deadline).'}
              {' '}The exact amount is computed server-side and may be lower if a coupon was applied to the purchase.
            </p>
          ) : !request.paymentId ? (
            <p style={{ fontSize: 14, color: 'var(--coral-700)' }}>
              This item has no traceable payment — approving will fail with a manual-processing message; use the Stripe Dashboard instead.
            </p>
          ) : null}
          <p style={{ fontSize: 13.5, color: 'var(--ink-soft)' }}>
            {request.kind === 'registration'
              ? (expected?.isPastDeadline
                ? 'The registration is kept but blanked (apparatus selections cleared) — the athlete can no longer compete, though their name may still appear in event materials.'
                : 'The registration is fully removed — this cannot be undone.')
              : 'The item is marked refunded and removed from the order total.'}
          </p>
        </>
      ) : (
        <p style={{ fontSize: 14 }}>
          Reject this refund request? The requester will be notified and no registration/item change is made.
        </p>
      )}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 18 }}>
        <button className="btn ghost" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className={action === 'approve' ? 'btn primary' : 'btn danger'} onClick={onConfirm} disabled={busy}>
          {busy ? 'Working…' : action === 'approve' ? 'Approve refund' : 'Reject request'}
        </button>
      </div>
    </Modal>
  );
}
