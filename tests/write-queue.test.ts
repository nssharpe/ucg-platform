import { describe, it, expect } from 'vitest';
import {
  WriteQueue, classifyWriteError, humanizeWriteError,
  type WriteOp, type ExecResult, type WriteQueueEntry,
} from '../src/lib/write-queue';

// In-memory storage stub matching the queue's Storage interface.
function memStorage() {
  let saved: WriteQueueEntry[] = [];
  return {
    store: {
      load: () => saved.map((e) => ({ ...e })),
      save: (e: WriteQueueEntry[]) => { saved = e.map((x) => ({ ...x })); },
    },
    raw: () => saved,
  };
}

const noDelay = () => Promise.resolve();
const upsert = (table: string): WriteOp => ({ kind: 'upsert', table, rows: [{ id: '1' }] });

describe('WriteQueue', () => {
  it('runs a successful write and clears the queue', async () => {
    const calls: WriteOp[] = [];
    const q = new WriteQueue({
      executor: async (op) => { calls.push(op); return { error: null }; },
      delay: noDelay, storage: memStorage().store,
    });
    q.enqueue(upsert('scores'));
    await q.run();
    expect(calls).toHaveLength(1);
    expect(q.getState()).toMatchObject({ pending: 0, failed: 0 });
  });

  it('retries a transient failure then succeeds', async () => {
    let attempts = 0;
    const q = new WriteQueue({
      executor: async (): Promise<ExecResult> => {
        attempts++;
        return attempts < 3 ? { error: new Error('boom') } : { error: null };
      },
      delay: noDelay, storage: memStorage().store, maxAuto: 5,
    });
    q.enqueue(upsert('scores'));
    await q.run();
    expect(attempts).toBe(3);
    expect(q.getState()).toMatchObject({ pending: 0, failed: 0 });
  });

  it('marks an entry failed after exhausting auto-retries', async () => {
    let attempts = 0;
    const q = new WriteQueue({
      executor: async (): Promise<ExecResult> => { attempts++; return { error: new Error('nope') }; },
      delay: noDelay, storage: memStorage().store, maxAuto: 3,
    });
    q.enqueue(upsert('registrations'));
    await q.run();
    expect(attempts).toBe(3);
    expect(q.getState()).toMatchObject({ pending: 0, failed: 1, failedLabels: ['registrations'] });
  });

  it('does not let one failed entry block the others', async () => {
    const succeeded: string[] = [];
    const q = new WriteQueue({
      executor: async (op): Promise<ExecResult> => {
        if (op.table === 'bad') return { error: new Error('x') };
        succeeded.push(op.table);
        return { error: null };
      },
      delay: noDelay, storage: memStorage().store, maxAuto: 2,
    });
    q.enqueue(upsert('bad'));
    q.enqueue(upsert('good'));
    await q.run();
    expect(succeeded).toEqual(['good']);
    expect(q.getState()).toMatchObject({ failed: 1, pending: 0 });
  });

  it('retryFailed re-attempts failed writes (manual retry)', async () => {
    let healthy = false;
    const q = new WriteQueue({
      executor: async (): Promise<ExecResult> => (healthy ? { error: null } : { error: new Error('down') }),
      delay: noDelay, storage: memStorage().store, maxAuto: 2,
    });
    q.enqueue(upsert('scores'));
    await q.run();
    expect(q.getState().failed).toBe(1);

    healthy = true;
    q.retryFailed();
    await q.run();
    expect(q.getState()).toMatchObject({ pending: 0, failed: 0 });
  });

  it('holds writes while offline and resumes when back online', async () => {
    let online = false;
    let calls = 0;
    const q = new WriteQueue({
      executor: async (): Promise<ExecResult> => { calls++; return { error: null }; },
      delay: noDelay, storage: memStorage().store, isOnline: () => online,
    });
    q.enqueue(upsert('scores'));
    await q.run();
    expect(calls).toBe(0);                       // nothing sent while offline
    expect(q.getState()).toMatchObject({ pending: 1, online: false });

    online = true;
    q.resume();
    await q.run();
    expect(calls).toBe(1);
    expect(q.getState()).toMatchObject({ pending: 0, online: true });
  });

  it('persists the queue so a reload recovers unsaved writes', async () => {
    const mem = memStorage();
    let online = false;
    const q1 = new WriteQueue({
      executor: async (): Promise<ExecResult> => ({ error: null }),
      delay: noDelay, storage: mem.store, isOnline: () => online,
    });
    q1.enqueue(upsert('scores'));
    await q1.run();
    expect(mem.raw()).toHaveLength(1);           // still queued (was offline)

    // Simulate a reload: a fresh queue hydrates from the same storage, online now.
    online = true;
    const q2 = new WriteQueue({
      executor: async (): Promise<ExecResult> => ({ error: null }),
      delay: noDelay, storage: mem.store, isOnline: () => true,
    });
    expect(q2.getState().pending).toBe(1);
    await q2.run();
    expect(q2.getState().pending).toBe(0);
    expect(mem.raw()).toHaveLength(0);
  });

  it('processes writes in FIFO order', async () => {
    const order: string[] = [];
    const q = new WriteQueue({
      executor: async (op): Promise<ExecResult> => { order.push(op.table); return { error: null }; },
      delay: noDelay, storage: memStorage().store,
    });
    q.enqueue(upsert('a'));
    q.enqueue(upsert('b'));
    q.enqueue(upsert('c'));
    await q.run();
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('removes a permanent failure immediately (no retry) and fires onPermanentFailure', async () => {
    let attempts = 0;
    const calls: Array<{ entry: WriteQueueEntry; error: unknown }> = [];
    const err = { code: '42501', message: 'permission denied for table scores' };
    const q = new WriteQueue({
      executor: async (): Promise<ExecResult> => { attempts++; return { error: err }; },
      delay: noDelay, storage: memStorage().store, maxAuto: 5,
      onPermanentFailure: (entry, error) => calls.push({ entry, error }),
    });
    q.enqueue(upsert('scores'), 'scores');
    await q.run();

    expect(attempts).toBe(1); // no retry at all
    expect(q.getState()).toMatchObject({ pending: 0, failed: 0 }); // gone, not 'failed'
    expect(calls).toHaveLength(1);
    expect(calls[0].entry.label).toBe('scores');
    expect(calls[0].error).toBe(err);
  });

  it('a rollback sync scheduled from onPermanentFailure waits for the queue to drain', async () => {
    // Mirrors the supabase.ts wiring: onPermanentFailure schedules a sync
    // behind writeQueue.run(). run() is called re-entrantly from inside the
    // process loop (where onPermanentFailure fires), so it must return the
    // in-flight run promise, and that promise must resolve only AFTER every
    // remaining pending entry has been dealt with — otherwise the sync would
    // wipe the optimistic state of a write that succeeds moments later.
    const events: string[] = [];
    let bAttempts = 0;
    let syncRuns = 0;
    const q = new WriteQueue({
      executor: async (op): Promise<ExecResult> => {
        if (op.table === 'a') return { error: { code: '42501', message: 'permission denied for table a' } };
        bAttempts++;
        events.push(`b-attempt-${bAttempts}`);
        return bAttempts < 2 ? { error: new Error('transient hiccup') } : { error: null };
      },
      delay: noDelay, storage: memStorage().store,
    });
    let syncScheduled = false;
    q.setOnPermanentFailure(() => {
      events.push('permanent');
      if (syncScheduled) return; // coalesce, as the real wiring does
      syncScheduled = true;
      void q.run().then(() => { syncRuns++; events.push('sync'); });
    });

    q.enqueue(upsert('a')); // permanent-fails on first attempt
    q.enqueue(upsert('b')); // transient-fails once, then succeeds
    await q.run();
    await Promise.resolve(); // let the sync .then callback flush

    expect(events).toEqual(['permanent', 'b-attempt-1', 'b-attempt-2', 'sync']);
    expect(syncRuns).toBe(1); // exactly one sync for the burst
    expect(q.getState()).toMatchObject({ pending: 0, failed: 0 });
  });

  it('setOnPermanentFailure registers the callback used by process()', async () => {
    const calls: unknown[] = [];
    const q = new WriteQueue({
      executor: async (): Promise<ExecResult> => ({ error: { code: '23505', message: 'duplicate key' } }),
      delay: noDelay, storage: memStorage().store,
    });
    q.setOnPermanentFailure((_entry, error) => calls.push(error));
    q.enqueue(upsert('scores'));
    await q.run();
    expect(calls).toHaveLength(1);
  });

  it('a transient failure still retries up to the default budget (8) then fails', async () => {
    let attempts = 0;
    const q = new WriteQueue({
      executor: async (): Promise<ExecResult> => { attempts++; return { error: new Error('network hiccup') }; },
      delay: noDelay, storage: memStorage().store, // default maxAuto = 8
    });
    q.enqueue(upsert('scores'));
    await q.run();
    expect(attempts).toBe(8);
    expect(q.getState()).toMatchObject({ pending: 0, failed: 1 });
  });

  it('does not burn an attempt or fire onPermanentFailure while offline', async () => {
    let online = false;
    let calls = 0;
    const permCalls: unknown[] = [];
    const q = new WriteQueue({
      executor: async (): Promise<ExecResult> => { calls++; return { error: null }; },
      delay: noDelay, storage: memStorage().store, isOnline: () => online,
      onPermanentFailure: (_e, err) => permCalls.push(err),
    });
    q.enqueue(upsert('scores'));
    await q.run();
    expect(calls).toBe(0);
    expect(permCalls).toHaveLength(0);
    expect(q.getState()).toMatchObject({ pending: 1, online: false });

    online = true;
    q.resume();
    await q.run();
    expect(calls).toBe(1);
  });
});

describe('classifyWriteError', () => {
  const cases: Array<[string, unknown, 'permanent' | 'transient']> = [
    ['RLS denial by code', { code: '42501', message: 'permission denied for table x' }, 'permanent'],
    ['RLS denial by message only', { message: 'new row violates row-level security policy for table x' }, 'permanent'],
    ['policy recursion 42P17', { code: '42P17', message: 'infinite recursion detected in policy' }, 'permanent'],
    ['unique violation 23505', { code: '23505', message: 'duplicate key value violates unique constraint' }, 'permanent'],
    ['foreign key violation 23503', { code: '23503', message: 'insert or update violates foreign key constraint' }, 'permanent'],
    ['not-null violation 23502', { code: '23502', message: 'null value in column violates not-null constraint' }, 'permanent'],
    ['constraint violation by message only', { message: 'new row violates check constraint "positive_amount"' }, 'permanent'],
    ['PostgREST JWT/auth code', { code: 'PGRST301', message: 'JWT expired' }, 'permanent'],
    ['HTTP 400', { status: 400, message: 'Bad Request' }, 'permanent'],
    ['HTTP 401', { status: 401, message: 'Unauthorized' }, 'permanent'],
    ['HTTP 403', { status: 403, message: 'Forbidden' }, 'permanent'],
    ['HTTP 404', { status: 404, message: 'Not Found' }, 'permanent'],
    ['HTTP 409', { status: 409, message: 'Conflict' }, 'permanent'],
    ['HTTP 422', { status: 422, message: 'Unprocessable Entity' }, 'permanent'],
    ['statusCode field (not status)', { statusCode: 403, message: 'nope' }, 'permanent'],
    ['P0001 raised trigger exception (guard_membership_writes)', { code: 'P0001', message: 'guard_membership_writes: non-privileged caller cannot set status=active' }, 'permanent'],
    ['fetch TypeError', new TypeError('Failed to fetch'), 'transient'],
    ['NetworkError message', { message: 'A NetworkError occurred' }, 'transient'],
    ['Safari Load failed', { message: 'Load failed' }, 'transient'],
    ['AbortError (timeout/cancel)', { name: 'AbortError', message: 'The operation was aborted' }, 'transient'],
    ['HTTP 429', { status: 429, message: 'Too Many Requests' }, 'transient'],
    ['HTTP 500', { status: 500, message: 'Internal Server Error' }, 'transient'],
    ['HTTP 503', { status: 503, message: 'Service Unavailable' }, 'transient'],
    ['null error', null, 'transient'],
    ['undefined error', undefined, 'transient'],
    ['unrecognized shape defaults transient', { message: 'something odd happened' }, 'transient'],
    ['bare Error with unrelated message', new Error('kaboom'), 'transient'],
  ];

  it.each(cases)('%s', (_label, error, expected) => {
    expect(classifyWriteError(error)).toBe(expected);
  });
});

describe('humanizeWriteError', () => {
  it('maps RLS/permission errors to a plain-English reason', () => {
    expect(humanizeWriteError({ code: '42501', message: 'permission denied for table x' }))
      .toBe("you don't have permission to make this change");
    expect(humanizeWriteError({ message: 'new row violates row-level security policy for table x' }))
      .toBe("you don't have permission to make this change");
  });

  it('maps a P0001 trigger refusal to a plain-English reason', () => {
    expect(humanizeWriteError({ code: 'P0001', message: 'guard_membership_writes: non-privileged caller cannot set status=active' }))
      .toBe("you don't have permission to make this change");
  });

  it('maps integrity-constraint errors to a plain-English reason', () => {
    expect(humanizeWriteError({ code: '23505', message: 'duplicate key value violates unique constraint' }))
      .toBe('this change conflicts with existing data');
    expect(humanizeWriteError({ message: 'new row violates check constraint "positive_amount"' }))
      .toBe('this change conflicts with existing data');
  });

  it('falls back to the raw message for anything else', () => {
    expect(humanizeWriteError({ message: 'something odd happened' })).toBe('something odd happened');
    expect(humanizeWriteError(null)).toBe('Unknown error');
  });
});
