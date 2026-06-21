import { useSyncExternalStore } from 'react';
import { subscribeWriteQueue, getWriteQueueState, retryFailedWrites } from '../lib/write-queue';

/**
 * Surfaces failed write-through saves. The write queue retries transient
 * failures silently; this banner only appears once a write has exhausted its
 * automatic retries (or while offline), so the user knows a change didn't stick
 * and can retry it manually. Mounted once at the app root.
 */
export function WriteStatus() {
  const state = useSyncExternalStore(subscribeWriteQueue, getWriteQueueState, getWriteQueueState);
  if (state.failed === 0) return null;

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
        <div className="writestatus-actions">
          <button className="btn" onClick={() => retryFailedWrites()} disabled={!state.online}>
            Retry now
          </button>
        </div>
      </div>
    </div>
  );
}
