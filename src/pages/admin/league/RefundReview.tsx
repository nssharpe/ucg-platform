import { useMemo, useState } from 'react';
import { useDB, syncFromSupabase } from '../../../lib/store';
import { useToast } from '../../../components/ui-hooks';
import { useFmtDate } from '../../../components/ui-hooks';
import { Badge, Modal } from '../../../components/ui';
import { fmtMoney } from '../../../lib/scoring';
import { decideAfterConflict } from '../../../lib/pricing';
import { processRefund } from '../../../lib/supabase';
import { useAdminInvoices } from '../../../lib/invoices-admin-slice';
import { useAdminPeople } from '../../../lib/people-admin-slice';
import type { InvoiceItem, RefundRequest } from '../../../lib/types';

const REASON_LABEL: Record<RefundRequest['reason'], string> = {
  injury: 'Injury', illness: 'Illness', bereavement: 'Bereavement', other: 'Other',
};

/** One reviewable decision — every `refund_requests` row sharing a
 *  `requestGroupId` (UAT Z-04: one request per REGISTRATION, covering every
 *  payment that funded it; an add-on request is a one-row group). */
interface RefundGroup {
  groupId: string;
  rows: RefundRequest[];
  kind: RefundRequest['kind'];
  requesterPersonId: string;
  clubId: string | null | undefined;
  eventId: string;
  reason: RefundRequest['reason'];
  reasonDetail?: string | null;
  createdAt: string;
  reviewedAt?: string | null;
  reviewedBy?: string | null;
  rejectionReason?: string | null;
  /** 'pending' if ANY row is still pending (including a partially-approved
   *  retry — those still need reviewer attention), else the shared outcome. */
  status: 'pending' | 'approved' | 'rejected';
  paymentIds: string[];
}

function groupRequests(requests: RefundRequest[]): RefundGroup[] {
  const byGroup = new Map<string, RefundRequest[]>();
  for (const r of requests) {
    const key = r.requestGroupId || r.id;
    const list = byGroup.get(key);
    if (list) list.push(r); else byGroup.set(key, [r]);
  }
  return Array.from(byGroup.entries()).map(([groupId, rows]) => {
    const first = rows[0];
    const status: RefundGroup['status'] = rows.some((r) => r.status === 'pending')
      ? 'pending'
      : rows.every((r) => r.status === 'approved') ? 'approved' : 'rejected';
    return {
      groupId, rows, kind: first.kind, requesterPersonId: first.requesterPersonId, clubId: first.clubId,
      eventId: first.eventId, reason: first.reason, reasonDetail: first.reasonDetail,
      createdAt: rows.map((r) => r.createdAt).sort()[0],
      reviewedAt: rows.map((r) => r.reviewedAt).filter(Boolean).sort().slice(-1)[0],
      reviewedBy: rows.find((r) => r.reviewedBy)?.reviewedBy,
      rejectionReason: rows.find((r) => r.rejectionReason)?.rejectionReason,
      status,
      paymentIds: Array.from(new Set(rows.map((r) => r.paymentId).filter((id): id is string => !!id))),
    };
  });
}

/** Refund review queue (event-mgmt v2 Phase 3, spec §H, T6; grouped rewrite
 *  UAT Z-04). Refund managers and admins approve or reject pending refund
 *  GROUPS; the actual Stripe call(s) + item/registration state change happen
 *  server-side (`process-refund` Edge Function) — this page only displays +
 *  confirms. */
export function RefundReview() {
  const db = useDB();
  const toast = useToast();
  const fmtDate = useFmtDate();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{ group: RefundGroup; action: 'approve' | 'reject' } | null>(null);

  // invoices are Tier 2 boot-scoped to the caller's own + managed-club rows
  // (whats-next.md §7) — a refund_manager reviewing requests league-wide
  // needs every invoice's items to resolve what's being refunded, so this
  // fetches on demand instead (CONTRACT shape #4). The ACTUAL refund amount
  // is always computed server-side by process-refund regardless of what
  // renders here, but showing "Item not yet resolved" for every request
  // because this list was scoped-empty would still be a badly misleading
  // review queue, so gate item resolution on `invoicesStatus === 'ready'`.
  const { rows: invoices, status: invoicesStatus } = useAdminInvoices();
  // Phase 4 (data-layer-scale.md): db.people at boot no longer covers the
  // whole league — requesters/reviewers can be from any club, same
  // league-wide shape (#3) as the invoices fetch above.
  const { rows: adminPeopleRows } = useAdminPeople();

  const groups = useMemo(() => groupRequests(db.refundRequests ?? []), [db.refundRequests]);
  const pending = useMemo(
    () => groups.filter((g) => g.status === 'pending').slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [groups],
  );
  const reviewed = useMemo(
    () => groups.filter((g) => g.status !== 'pending').slice().sort((a, b) => (b.reviewedAt ?? '').localeCompare(a.reviewedAt ?? '')),
    [groups],
  );

  const personName = (id: string | null | undefined) => {
    const p = adminPeopleRows.find((x) => x.id === id);
    return p ? `${p.firstName} ${p.lastName}` : (id ?? '—');
  };
  const clubName = (id: string | null | undefined) => db.clubs.find((c) => c.id === id)?.name ?? '—';
  const eventName = (id: string) => db.events.find((e) => e.id === id)?.name ?? '—';
  const event = (id: string) => db.events.find((e) => e.id === id);

  /** Resolve every row's invoice_item by scanning every invoice's items.
   *  Not every request necessarily has one visible yet (e.g. a host-club $0
   *  entry never gets an invoice_item at all), and none resolve before the
   *  on-demand invoices fetch (above) is ready. */
  const itemFor = (r: RefundRequest): InvoiceItem | null => {
    if (!r.invoiceItemId || invoicesStatus !== 'ready') return null;
    for (const inv of invoices) {
      const item = inv.items.find((i) => i.id === r.invoiceItemId);
      if (item) return item;
    }
    return null;
  };

  /** Group-level estimate: sum every resolvable row's item amount, scaled to
   *  75% once (registrations only, past the event's edit deadline) — mirrors
   *  `allocateRegistrationRefund`'s per-payment scaling closely enough for
   *  display (it is NOT the authoritative amount; process-refund always
   *  recomputes server-side and may land lower if a coupon applied). */
  const expectedRefund = (g: RefundGroup): { cents: number; isPastDeadline: boolean; lines: { label: string; cents: number }[] } | null => {
    const resolved = g.rows.map((r) => ({ row: r, item: itemFor(r) })).filter((x): x is { row: RefundRequest; item: InvoiceItem } => !!x.item);
    if (resolved.length === 0) return null;
    const ev = event(g.eventId);
    const isPastDeadline = g.kind === 'registration' && !!ev?.lastDateToEdit && new Date().getTime() > Date.parse(ev.lastDateToEdit);
    const lines = resolved.map(({ item }) => {
      const baseCents = Math.round(item.amount * 100);
      const cents = isPastDeadline ? Math.round(baseCents * 0.75) : baseCents;
      return { label: item.label, cents };
    });
    return { cents: lines.reduce((s, l) => s + l.cents, 0), isPastDeadline, lines };
  };

  /** Rule 7: after a 409 "already reviewed", refetch and decide whether to
   *  move the request to history silently (both reviewers reached the SAME
   *  outcome) or keep the error toast (a genuine conflict). */
  const handleConflict = async (groupId: string, attempted: 'approve' | 'reject') => {
    await syncFromSupabase();
    const fresh = groupRequests(db.refundRequests ?? []).find((g) => g.groupId === groupId);
    const currentStatus = fresh?.status ?? 'pending';
    if (decideAfterConflict(currentStatus, attempted) === 'toast') {
      toast('This request has already been reviewed.', { variant: 'error', persist: true });
    }
  };

  const decide = async (g: RefundGroup, action: 'approve' | 'reject', rejectionReason?: string) => {
    setBusyId(g.groupId);
    const res = await processRefund(g.groupId, action, rejectionReason);
    setBusyId(null);
    setConfirming(null);
    if (res.ok) {
      if (action === 'approve') {
        const totalCents = (res.refunded ?? []).reduce((s, r) => s + r.cents, 0);
        const failedCount = res.failed?.length ?? 0;
        toast(
          `Refund approved — ${fmtMoney(totalCents / 100)} refunded`
          + (failedCount > 0 ? `. ${failedCount} payment(s) could not be processed and will need a retry.` : '.'),
          failedCount > 0 ? { variant: 'error', persist: true } : undefined,
        );
      } else {
        toast('Refund request rejected.');
      }
      void syncFromSupabase();
    } else if (res.status === 409) {
      await handleConflict(g.groupId, action);
      void syncFromSupabase();
    } else {
      toast(res.error ?? 'Could not process this decision.', { variant: 'error', persist: true });
    }
  };

  const GroupCard = ({ g, reviewedView }: { g: RefundGroup; reviewedView?: boolean }) => {
    const exp = expectedRefund(g);
    const noPayment = g.paymentIds.length === 0;
    return (
      <li className="card card-pad" style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, alignItems: 'baseline' }}>
          <div>
            <strong>{personName(g.requesterPersonId)}</strong>{' '}
            <span style={{ color: 'var(--ink-soft)' }}>
              — {g.kind === 'registration' ? 'Registration' : 'Add-on'}
              {g.paymentIds.length > 1 ? ` (${g.paymentIds.length} payments)` : ''}
            </span>
          </div>
          <span style={{ fontSize: 12.5, color: 'var(--ink-soft)' }}>
            {reviewedView ? (g.reviewedAt ? fmtDate(g.reviewedAt) : '—') : fmtDate(g.createdAt)}
          </span>
        </div>
        <div style={{ fontSize: 13.5, color: 'var(--ink-soft)', marginTop: 4 }}>
          {eventName(g.eventId)} {g.clubId ? `· ${clubName(g.clubId)}` : ''}
        </div>
        {exp && exp.lines.length > 0 && (
          <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 13 }}>
            {exp.lines.map((l, i) => <li key={i}>{l.label} — {fmtMoney(l.cents / 100)}</li>)}
          </ul>
        )}
        <div style={{ fontSize: 13.5, marginTop: 6 }}>
          <strong>Reason:</strong> {REASON_LABEL[g.reason]}
          {g.reasonDetail ? ` — ${g.reasonDetail}` : ''}
        </div>

        {!reviewedView && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10, alignItems: 'center' }}>
            {noPayment && <Badge tone="warn">No traceable payment — manual</Badge>}
            {exp && exp.isPastDeadline && <Badge tone="warn">75% — past edit deadline</Badge>}
            {exp && (
              <span style={{ fontSize: 13, color: 'var(--ink-soft)' }}>
                Estimated refund: up to {fmtMoney(exp.cents / 100)}. Service fees are non-refundable — the
                final amount is computed server-side and may be lower if a coupon was applied to the purchase.
              </span>
            )}
            {!exp && !noPayment && (
              <Badge tone="info">{invoicesStatus === 'loading' ? 'Loading item…' : 'Item not yet resolved'}</Badge>
            )}
          </div>
        )}

        {reviewedView ? (
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 10, alignItems: 'center' }}>
            <Badge tone={g.status === 'approved' ? 'ok' : 'err'}>{g.status === 'approved' ? 'Approved' : 'Rejected'}</Badge>
            {g.status === 'approved' && (
              <span style={{ fontSize: 13 }}>
                {fmtMoney(g.rows.reduce((s, r) => s + (r.refundAmountCents ?? 0), 0) / 100)} refunded
              </span>
            )}
            {g.status === 'rejected' && g.rejectionReason && (
              <span style={{ fontSize: 13 }}>Reason: {g.rejectionReason}</span>
            )}
            <span style={{ fontSize: 12.5, color: 'var(--ink-soft)' }}>Reviewed by {personName(g.reviewedBy)}</span>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
            <button className="btn small primary" disabled={busyId === g.groupId} onClick={() => setConfirming({ group: g, action: 'approve' })}>
              Approve
            </button>
            <button className="btn small danger" disabled={busyId === g.groupId} onClick={() => setConfirming({ group: g, action: 'reject' })}>
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
        Review and process member refund requests (spec §H). Approving refunds the original payment method(s) and either
        removes the registration (on time) or blanks its apparatus selections and keeps it listed (past the edit deadline).
      </p>

      <h3 className="card-title" style={{ marginBottom: 8 }}>Pending ({pending.length})</h3>
      {pending.length === 0 ? (
        <p style={{ fontSize: 13.5, color: 'var(--ink-soft)' }}>No pending refund requests.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 28px' }}>
          {pending.map((g) => <GroupCard key={g.groupId} g={g} />)}
        </ul>
      )}

      <h3 className="card-title" style={{ marginBottom: 8 }}>Reviewed history</h3>
      {reviewed.length === 0 ? (
        <p style={{ fontSize: 13.5, color: 'var(--ink-soft)' }}>Nothing reviewed yet.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {reviewed.slice(0, 200).map((g) => <GroupCard key={g.groupId} g={g} reviewedView />)}
        </ul>
      )}

      {confirming && confirming.action === 'reject' && (
        <RejectDialog
          group={confirming.group}
          busy={busyId === confirming.group.groupId}
          onCancel={() => setConfirming(null)}
          onConfirm={(rejectionReason) => decide(confirming.group, 'reject', rejectionReason)}
        />
      )}
      {confirming && confirming.action === 'approve' && (
        <ApproveDialog
          group={confirming.group}
          expected={expectedRefund(confirming.group)}
          eventName={eventName(confirming.group.eventId)}
          busy={busyId === confirming.group.groupId}
          onCancel={() => setConfirming(null)}
          onConfirm={() => decide(confirming.group, 'approve')}
        />
      )}
    </div>
  );
}

/** Reject confirmation — a free-text rejection reason is REQUIRED (rule 6):
 *  stored on every row in the group and included in the requester's email. */
function RejectDialog({
  group, busy, onCancel, onConfirm,
}: {
  group: RefundGroup;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (rejectionReason: string) => void;
}) {
  const [rejectionReason, setRejectionReason] = useState('');
  const canConfirm = rejectionReason.trim().length > 0;
  return (
    <Modal title="Reject refund" onClose={onCancel}>
      <p style={{ fontSize: 14 }}>
        Reject this refund request{group.paymentIds.length > 1 ? ` (${group.paymentIds.length} payments)` : ''}?
        The requester will be notified and no registration/item change is made.
      </p>
      <label style={{ display: 'block', fontSize: 13, fontWeight: 600, margin: '12px 0 4px' }}>
        Reason for rejecting (required)
      </label>
      <textarea
        className="input"
        rows={3}
        value={rejectionReason}
        onChange={(e) => setRejectionReason(e.target.value)}
        placeholder="Tell the requester why this was rejected…"
        aria-label="Reason for rejecting"
      />
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 18 }}>
        <button className="btn ghost" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="btn danger" onClick={() => onConfirm(rejectionReason.trim())} disabled={busy || !canConfirm}>
          {busy ? 'Working…' : 'Reject request'}
        </button>
      </div>
    </Modal>
  );
}

/** Approve confirmation. A registration refund may span multiple payments
 *  (rule 1) — each is claimed/refunded server-side independently, so the
 *  confirmation names the payment count when >1. */
function ApproveDialog({
  group, expected, eventName, busy, onCancel, onConfirm,
}: {
  group: RefundGroup;
  expected: { cents: number; isPastDeadline: boolean } | null;
  eventName: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal title="Approve refund" onClose={onCancel}>
      <p style={{ fontSize: 14 }}>
        Approve this refund for <strong>{eventName}</strong>
        {group.paymentIds.length > 1 ? ` (${group.paymentIds.length} separate payments)` : ''}?
      </p>
      {expected ? (
        <p style={{ fontSize: 14 }}>
          Up to <strong>{fmtMoney(expected.cents / 100)}</strong> will be refunded to the original payment method(s)
          {expected.isPastDeadline ? ' (75% — past the edit deadline; 25% is retained).' : ' (100% — on/before the edit deadline).'}
          {' '}Service fees are non-refundable. The exact amount is computed server-side and may be lower if a coupon was applied.
        </p>
      ) : group.paymentIds.length === 0 ? (
        <p style={{ fontSize: 14, color: 'var(--coral-700)' }}>
          This request has no traceable payment — approving will fail with a manual-processing message; use the Stripe Dashboard instead.
        </p>
      ) : null}
      <p style={{ fontSize: 13.5, color: 'var(--ink-soft)' }}>
        {group.kind === 'registration'
          ? (expected?.isPastDeadline
            ? 'The registration is kept but blanked (apparatus selections cleared) — the athlete can no longer compete, though their name may still appear in event materials.'
            : 'The registration is fully removed — this cannot be undone.')
          : 'The item is marked refunded and removed from the order total.'}
      </p>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 18 }}>
        <button className="btn ghost" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="btn primary" onClick={onConfirm} disabled={busy}>
          {busy ? 'Working…' : 'Approve refund'}
        </button>
      </div>
    </Modal>
  );
}
