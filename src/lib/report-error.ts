// Central error-reporting indirection. Today it just logs + keeps a small
// in-memory ring buffer (so a future "report a problem" widget can attach
// recent errors). When we wire Sentry (§3 of production-readiness.md), call
// `setErrorReporter(sentrySink)` once at boot and every error boundary +
// write-queue failure flows through it automatically — no call-site changes.

export interface ReportedError {
  /** The thing that was thrown. Stringified defensively for the buffer. */
  message: string;
  stack?: string;
  /** Where it came from: a route path, 'write-queue', 'react-render', etc. */
  context?: string;
  /** Extra structured detail (componentStack, table name, op kind, …). */
  detail?: Record<string, unknown>;
  at: string; // ISO timestamp
}

type Sink = (err: ReportedError, original: unknown) => void;

const RING_SIZE = 25;
const ring: ReportedError[] = [];

const defaultSink: Sink = (err) => {
  console.error(`[report-error] ${err.context ?? 'app'}:`, err.message, err.detail ?? '');
};

let sink: Sink = defaultSink;

/** Swap the destination (e.g. Sentry) at boot. The default logs to console. */
export function setErrorReporter(next: Sink) {
  sink = next;
}

/** Report an error from anywhere. Never throws — reporting must not crash the app. */
export function reportError(
  original: unknown,
  context?: string,
  detail?: Record<string, unknown>,
): void {
  try {
    const e = original as { message?: unknown; stack?: unknown } | undefined;
    const message =
      e && typeof e.message === 'string' ? e.message
      : typeof original === 'string' ? original
      : (() => { try { return JSON.stringify(original); } catch { return String(original); } })();
    const reported: ReportedError = {
      message,
      stack: e && typeof e.stack === 'string' ? e.stack : undefined,
      context,
      detail,
      at: new Date().toISOString(),
    };
    ring.push(reported);
    if (ring.length > RING_SIZE) ring.shift();
    sink(reported, original);
  } catch {
    /* reporting itself failed — swallow, nothing else we can safely do */
  }
}

/** Snapshot of recent errors (newest last) for an in-app bug report. */
export function recentErrors(): ReportedError[] {
  return ring.slice();
}
