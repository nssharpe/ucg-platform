// Outbound write queue — makes the write-through layer failure-aware.
//
// Background: src/lib/supabase.ts mirrors every local mutation to Supabase via
// `push*` helpers that were fire-and-forget (console.error on failure, UI shows
// success regardless). A failed save was therefore invisible AND lost on the
// next reload. This queue fixes both: every remote write is enqueued, retried
// with backoff, persisted to localStorage so it survives a reload, and — when
// it can't be saved — surfaced to the user (see components/WriteStatus.tsx)
// with a manual retry.
//
// The class is dependency-injected (executor / storage / scheduler / online
// check) so the retry logic is unit-tested in a plain node environment
// (tests/write-queue.test.ts) without Supabase or a DOM.
import { reportError } from './report-error';

/** A serializable description of one remote write. Kept data-only so it can be
 *  persisted to localStorage and replayed after a reload. */
export type WriteOp =
  | { kind: 'upsert'; table: string; rows: Record<string, unknown>[]; onConflict?: string }
  | { kind: 'delete'; table: string; match: Record<string, unknown> }
  | { kind: 'replace'; table: string; match: Record<string, unknown>; rows: Record<string, unknown>[] }
  // A targeted column UPDATE (not a full-row upsert) — needed when RLS grants
  // UPDATE on only specific columns of an existing row (e.g. waitlist_groups'
  // client-cancel path, which may touch ONLY `status`); an upsert's ON
  // CONFLICT DO UPDATE would fail there since Postgres builds the full INSERT
  // tuple (including NOT NULL columns absent from `patch`) before the conflict
  // is even resolved.
  | { kind: 'update'; table: string; match: Record<string, unknown>; patch: Record<string, unknown> }
  // A security-definer RPC that performs its own delete+insert atomically,
  // server-side, with an authorization check made ONCE up front — for
  // replace-style writes where a plain client-side delete-then-insert under
  // RLS is a self-referential trap (the actor's own permission to write can
  // depend on the very rows the delete just removed). `table` is a display
  // label only (matches the affected table for the write-status UI/logs).
  | { kind: 'rpc'; table: string; fn: string; args: Record<string, unknown> };

/** Result shape mirrors a Supabase/PostgREST call: `{ error }`, null on success. */
export type ExecResult = { error: unknown };
export type Executor = (op: WriteOp) => Promise<ExecResult>;

/** A persisted queue entry (exported so storage adapters / tests can type it). */
export interface WriteQueueEntry {
  id: string;
  op: WriteOp;
  /** Human label for the UI / logs (the table name). */
  label: string;
  attempts: number;
  status: 'pending' | 'failed';
  lastError?: string;
}

/** Immutable snapshot handed to React via useSyncExternalStore. */
export interface WriteQueueState {
  pending: number;
  failed: number;
  /** Distinct labels of failed writes, for the banner copy. */
  failedLabels: string[];
  /** Distinct underlying error messages of failed writes, for diagnostics. */
  failedErrors: string[];
  online: boolean;
}

interface Storage {
  load(): WriteQueueEntry[];
  save(entries: WriteQueueEntry[]): void;
}

export interface WriteQueueOptions {
  executor?: Executor;
  storage?: Storage;
  /** Promise-based delay between retries (injected so tests run instantly). */
  delay?: (ms: number) => Promise<void>;
  isOnline?: () => boolean;
  /** Auto-retry attempts before an entry is marked failed (needs manual retry). */
  maxAuto?: number;
  /** Backoff base in ms; doubles each attempt, capped at 30s. */
  backoffBase?: number;
}

const genId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.floor(Math.random() * 1e9)}`;

function stringifyError(error: unknown): string {
  if (error == null) return 'Unknown error';
  const e = error as { message?: unknown };
  if (typeof e.message === 'string') return e.message;
  try { return JSON.stringify(error); } catch { return String(error); }
}

export class WriteQueue {
  private entries: WriteQueueEntry[] = [];
  private executor: Executor;
  private storage: Storage;
  private delay: (ms: number) => Promise<void>;
  private isOnline: () => boolean;
  private maxAuto: number;
  private backoffBase: number;
  private runPromise: Promise<void> | null = null;
  private listeners = new Set<() => void>();
  private snapshot: WriteQueueState;

  constructor(opts: WriteQueueOptions = {}) {
    this.executor = opts.executor ?? (async () => ({ error: new Error('write queue executor not configured') }));
    this.storage = opts.storage ?? defaultStorage();
    this.delay = opts.delay ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    // Assume online unless the browser explicitly reports offline. (navigator
    // may be absent, or expose a non-boolean onLine, outside a real browser.)
    this.isOnline = opts.isOnline ?? (() => {
      try { return typeof navigator === 'undefined' || navigator.onLine !== false; }
      catch { return true; }
    });
    this.maxAuto = opts.maxAuto ?? 5;
    this.backoffBase = opts.backoffBase ?? 500;
    this.entries = this.storage.load();
    this.snapshot = this.computeSnapshot();
  }

  /** Register the real (Supabase) executor at boot. */
  setExecutor(executor: Executor) {
    this.executor = executor;
  }

  /** Enqueue a write and kick the processor. */
  enqueue(op: WriteOp, label = op.table): string {
    const id = genId();
    this.entries.push({ id, op, label, attempts: 0, status: 'pending' });
    this.persist();
    this.notify();
    void this.run();
    return id;
  }

  /** Move every failed entry back to pending and reprocess (manual "Retry"). */
  retryFailed(): void {
    let changed = false;
    for (const e of this.entries) {
      if (e.status === 'failed') { e.status = 'pending'; e.attempts = 0; e.lastError = undefined; changed = true; }
    }
    if (changed) { this.persist(); this.notify(); void this.run(); }
  }

  /** Drop every failed entry (user chose "Dismiss"/"Stop trying"). These changes
   *  stay applied locally but are abandoned for write-through; the banner clears. */
  discardFailed(): void {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.status !== 'failed');
    if (this.entries.length !== before) { this.persist(); this.notify(); }
  }

  /** Called by the browser 'online' event — resume any pending writes. */
  resume(): void {
    void this.run();
  }

  getState(): WriteQueueState {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Process pending entries FIFO until none remain or we go offline.
   *  Returns the in-flight run when one is already active, so callers (and
   *  tests) can await completion. */
  run(): Promise<void> {
    if (this.runPromise) return this.runPromise;
    this.runPromise = this.process().finally(() => { this.runPromise = null; });
    return this.runPromise;
  }

  private async process(): Promise<void> {
    try {
      let entry: WriteQueueEntry | undefined;
      while ((entry = this.entries.find((e) => e.status === 'pending'))) {
        // Offline: leave the entry pending (don't burn an attempt) and stop;
        // the 'online' event will call resume() → run() again.
        if (!this.isOnline()) break;

        const { error } = await this.executor(entry.op);
        if (!error) {
          this.remove(entry.id);
          continue;
        }

        entry.attempts++;
        entry.lastError = stringifyError(error);
        reportError(error, 'write-queue', {
          table: entry.op.table, kind: entry.op.kind, attempts: entry.attempts,
        });

        if (entry.attempts >= this.maxAuto) {
          entry.status = 'failed';
          this.persist();
          this.notify();
          continue; // surfaced for manual retry; move on so it doesn't block others
        }
        this.persist();
        this.notify();
        await this.delay(this.backoff(entry.attempts));
      }
    } finally {
      this.persist();
      this.notify();
    }
  }

  private backoff(attempt: number): number {
    return Math.min(30_000, this.backoffBase * 2 ** (attempt - 1));
  }

  private remove(id: string): void {
    this.entries = this.entries.filter((e) => e.id !== id);
    this.persist();
    this.notify();
  }

  private persist(): void {
    try { this.storage.save(this.entries); } catch { /* storage full / unavailable — non-fatal */ }
  }

  private computeSnapshot(): WriteQueueState {
    const failedLabels = new Set<string>();
    const failedErrors = new Set<string>();
    let pending = 0;
    let failed = 0;
    for (const e of this.entries) {
      if (e.status === 'failed') { failed++; failedLabels.add(e.label); if (e.lastError) failedErrors.add(e.lastError); }
      else pending++;
    }
    return { pending, failed, failedLabels: [...failedLabels], failedErrors: [...failedErrors], online: this.isOnline() };
  }

  private notify(): void {
    this.snapshot = this.computeSnapshot();
    for (const l of this.listeners) l();
  }
}

const STORAGE_KEY = 'ucg.writeQueue.v1';

function defaultStorage(): Storage {
  const available = () => {
    try { return typeof localStorage !== 'undefined'; } catch { return false; }
  };
  return {
    load() {
      if (!available()) return [];
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw) as WriteQueueEntry[];
        // On reload, any entry that was mid-flight is simply pending again
        // (writes are idempotent — upsert / delete-then-insert).
        return parsed.map((e) => (e.status === 'failed' ? e : { ...e, status: 'pending' as const }));
      } catch { return []; }
    },
    save(entries) {
      if (!available()) return;
      try {
        if (entries.length === 0) localStorage.removeItem(STORAGE_KEY);
        else localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
      } catch { /* quota / unavailable */ }
    },
  };
}

// ---------------------------------------------------------------------------
// App singleton — configured with the Supabase executor in supabase.ts.
// ---------------------------------------------------------------------------
export const writeQueue = new WriteQueue();

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => writeQueue.resume());
  // 'offline' has no entries to process but should refresh the banner copy.
  window.addEventListener('offline', () => writeQueue.resume());
}

/** Enqueue a write through the app singleton. */
export function enqueueWrite(op: WriteOp, label?: string): void {
  writeQueue.enqueue(op, label);
}
export const subscribeWriteQueue = (listener: () => void) => writeQueue.subscribe(listener);
export const getWriteQueueState = (): WriteQueueState => writeQueue.getState();
export const retryFailedWrites = () => writeQueue.retryFailed();
export const discardFailedWrites = () => writeQueue.discardFailed();
