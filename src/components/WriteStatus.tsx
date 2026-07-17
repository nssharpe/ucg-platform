import { useSyncExternalStore } from 'react';
import { subscribeWriteQueue, getWriteQueueState, retryFailedWrites, discardFailedWrites } from '../lib/write-queue';
import { isSupabaseConfigured } from '../lib/supabase';

/**
 * Surfaces failed write-through saves. The write queue retries transient
 * failures silently; this banner only appears once a write has exhausted its
 * automatic retries (or while offline), so the user knows a change didn't stick
 * and can retry it manually. Mounted once at the app root.
 */
export function WriteStatus() {
  const state = useSyncExternalStore(subscribeWriteQueue, getWriteQueueState, getWriteQueueState);
  // Supabase-backed + offline: store.ts's mutate() is refusing NEW local edits
  // (read-only-while-offline), independent of whether anything is failed/queued.
  const offlineReadOnly = isSupabaseConfigured && !state.online;

  if (state.failed === 0 && !offlineReadOnly) return null;

  if (state.failed === 0) {
    return (
      <div className="writestatus" role="status" aria-live="polite">
        <div className="writestatus-icon" aria-hidden>📴</div>
        <div className="writestatus-body">
          <div className="writestatus-title">You're offline — viewing only</div>
          <div className="writestatus-detail">Changes are disabled until you reconnect.</div>
        </div>
      </div>
    );
  }

  const n = state.failed;
  const labels = state.failedLabels.slice(0, 3).join(', ');
  return (
    <div className="writestatus" role="alert" aria-live="assertive">
      <div className="writestatus-icon" aria-hidden>⚠️</div>
      <div className="writestatus-body">
        <div className="writestatus-title">
          {n} change{n > 1 ? 's' : ''} didn’t save
        </div>
        <div className="writestatus-detail">
          {state.online
            ? `We couldn’t reach the server${labels ? ` (${labels})` : ''}. Your changes are queued — retry to save them.`
            : 'You appear to be offline. Changes are queued and will retry automatically when you reconnect.'}
        </div>
        {state.failedErrors.length > 0 && (
          <div className="writestatus-detail" style={{ marginTop: 4, color: 'var(--coral-600)', wordBreak: 'break-word' }}>
            {state.failedErrors.join(' · ')}
          </div>
        )}
        <div className="writestatus-actions">
          <button className="btn" onClick={() => retryFailedWrites()} disabled={!state.online}>
            Retry now
          </button>
          <button className="btn ghost" onClick={() => discardFailedWrites()}>
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}
