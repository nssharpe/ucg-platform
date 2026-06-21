import { describe, it, expect } from 'vitest';
import { WriteQueue, type WriteOp, type ExecResult, type WriteQueueEntry } from '../src/lib/write-queue';

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
});
