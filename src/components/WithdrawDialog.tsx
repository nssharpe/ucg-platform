import { useState } from 'react';
import { Modal } from './ui';
import { useToast } from './ui-hooks';
import { withdrawRegistration } from '../lib/supabase';
import { invalidateMyRegistrations } from '../lib/registrations-slice';
import type { Event } from '../lib/types';

/** Confirm dialog for athlete self-serve WITHDRAWAL (product owners' spec
 *  2026-08-23, rule 7: "requires a confirm dialog … + the late-withdrawal
 *  explanation when applicable"). Immediate, no admin review step — the
 *  edge function applies the withdrawal the moment this confirms. Shown
 *  from MyRegistrations.tsx wherever the athlete's own row isn't eligible
 *  for the "Request a refund" flow (rules 2–3: every non-refund-eligible
 *  registration gets Withdraw instead). */
export function WithdrawDialog({
  event, regId, label, onClose, onWithdrawn,
}: {
  event: Event;
  regId: string;
  label: string;
  onClose: () => void;
  /** Called once the withdrawal succeeds — the caller should refresh so the
   *  row reflects the removed/scratched state. */
  onWithdrawn: () => void;
}) {
  const toast = useToast();
  const [submitting, setSubmitting] = useState(false);

  const now = new Date();
  const isPastDeadline = !!event.lastDateToEdit && now.getTime() > Date.parse(event.lastDateToEdit);

  const confirm = async () => {
    if (submitting) return;
    setSubmitting(true);
    const res = await withdrawRegistration({ regId });
    setSubmitting(false);
    if (res.ok) {
      toast(
        res.plan === 'scratch'
          ? "You've been withdrawn — since this is after the edit deadline, you remain listed with all apparatus scratched."
          : "You've been withdrawn and removed from the event.",
      );
      invalidateMyRegistrations();
      onWithdrawn();
      onClose();
    } else {
      toast(res.error ?? 'Could not withdraw — please try again.', { variant: 'error', persist: true });
    }
  };

  return (
    <Modal title={`Withdraw from ${event.name}?`} onClose={onClose}>
      <div
        className="card card-pad"
        style={{ borderLeft: '4px solid var(--coral-500)', marginBottom: 14, fontSize: 13, lineHeight: 1.5 }}
      >
        <strong>This can't be undone.</strong>
        {isPastDeadline ? (
          <>
            {' '}The edit deadline for {event.name} has passed, so you'll <strong>remain listed</strong> with
            every apparatus scratched — you won't compete, but you (or a friend who attends) can still pick
            up any event freebies tied to your registration.
          </>
        ) : (
          <> You'll be <strong>fully removed</strong> from {event.name} — {label}.</>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 18 }}>
        <button className="btn ghost" onClick={onClose} disabled={submitting}>Cancel</button>
        <button className="btn primary" onClick={confirm} disabled={submitting}>
          {submitting ? 'Withdrawing…' : 'Withdraw'}
        </button>
      </div>
    </Modal>
  );
}
