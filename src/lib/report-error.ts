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

// ---- Small in-memory ring buffer for the "Report a problem" widget ----
// Last RECENT_RING_SIZE plain-text entries (message + timestamp), fed by (a)
// every reportError() call and (b) direct console.error() calls anywhere in
// the app. Kept as pure push/slice logic so it's trivially unit-testable
// (tests/report-error.test.ts) without any DOM/runtime deps.
export interface RecentErrorEntry {
  message: string;
  at: string; // ISO timestamp
}

const RECENT_RING_SIZE = 10;
const RECENT_MESSAGE_MAX = 500;
const recentRing: RecentErrorEntry[] = [];

/** Push a capped-length entry onto a ring buffer, mutating it in place and
 *  keeping only the most recent `max` entries (oldest dropped first). */
export function pushCapped<T>(ring_: T[], entry: T, max: number): void {
  ring_.push(entry);
  if (ring_.length > max) ring_.shift();
}

function pushRecent(message: string): void {
  pushCapped(recentRing, { message: message.slice(0, RECENT_MESSAGE_MAX), at: new Date().toISOString() }, RECENT_RING_SIZE);
}

/** Snapshot of the last 10 recent error entries (message + timestamp), newest
 *  last — attached to in-app "Report a problem" submissions for context. */
export function getRecentErrors(): RecentErrorEntry[] {
  return recentRing.slice();
}

// Wrap console.error ONCE so direct calls anywhere (not just via reportError)
// land in the ring buffer too, while preserving original console behavior.
// Guarded by `capturingViaDefaultSink` so the defaultSink's own console.error
// call below doesn't double-count an error already pushed by reportError().
let capturingViaDefaultSink = false;
const originalConsoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  if (!capturingViaDefaultSink) {
    try {
      const message = args
        .map((a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })()))
        .join(' ');
      pushRecent(message);
    } catch {
      /* ring-buffer capture must never break console.error */
    }
  }
  originalConsoleError(...args);
};

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
    pushRecent(context ? `${context}: ${message}` : message);
    capturingViaDefaultSink = true;
    try {
      sink(reported, original);
    } finally {
      capturingViaDefaultSink = false;
    }
  } catch {
    /* reporting itself failed — swallow, nothing else we can safely do */
  }
}

/** Snapshot of recent errors (newest last) for an in-app bug report. */
export function recentErrors(): ReportedError[] {
  return ring.slice();
}
