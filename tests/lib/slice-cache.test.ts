import { describe, it, expect, vi } from 'vitest';
import { createEventScopedSlice, mineCacheKey } from '../../src/lib/slice-cache';

interface Row { id: string; eventId: string; label: string }

function makeSlice(fetchScope: (key: string) => Promise<Row[]>) {
  return createEventScopedSlice<Row>({ fetchScope, idOf: (r) => r.id });
}

describe('mineCacheKey (pure)', () => {
  it('is order-independent over the id list', () => {
    expect(mineCacheKey('p1', ['a', 'b', 'c'])).toBe(mineCacheKey('p1', ['c', 'a', 'b']));
  });

  it('differs when personId differs', () => {
    expect(mineCacheKey('p1', ['a'])).not.toBe(mineCacheKey('p2', ['a']));
  });

  it('differs when the id set differs', () => {
    expect(mineCacheKey('p1', ['a', 'b'])).not.toBe(mineCacheKey('p1', ['a']));
  });

  it('is stable for an empty id list', () => {
    expect(mineCacheKey('p1', [])).toBe('p1|');
  });
});

describe('createEventScopedSlice — status transitions (pure, no React)', () => {
  it('getSnapshot for a never-seen key is loading with empty rows', () => {
    const slice = makeSlice(async () => []);
    expect(slice.getSnapshot('e1')).toEqual({ rows: [], status: 'loading' });
  });

  it('ensure() fetches once, then reports ready with the fetched rows', async () => {
    const rows: Row[] = [{ id: 's1', eventId: 'e1', label: 'a' }];
    const fetchScope = vi.fn(async () => rows);
    const slice = makeSlice(fetchScope);
    slice.ensure('e1');
    expect(slice.getSnapshot('e1').status).toBe('loading');
    await vi.waitFor(() => expect(slice.getSnapshot('e1').status).toBe('ready'));
    expect(slice.getSnapshot('e1').rows).toEqual(rows);
    expect(fetchScope).toHaveBeenCalledTimes(1);
  });

  it('ensure() called again while already cached/in-flight does not refetch', async () => {
    const fetchScope = vi.fn(async () => [{ id: 's1', eventId: 'e1', label: 'a' }]);
    const slice = makeSlice(fetchScope);
    slice.ensure('e1');
    slice.ensure('e1'); // while in flight
    await vi.waitFor(() => expect(slice.getSnapshot('e1').status).toBe('ready'));
    slice.ensure('e1'); // already cached
    expect(fetchScope).toHaveBeenCalledTimes(1);
  });

  it('a rejected fetch sets status error and preserves any prior rows', async () => {
    let call = 0;
    const fetchScope = vi.fn(async () => {
      call++;
      if (call === 1) return [{ id: 's1', eventId: 'e1', label: 'a' }];
      throw new Error('boom');
    });
    const slice = makeSlice(fetchScope);
    slice.ensure('e1');
    await vi.waitFor(() => expect(slice.getSnapshot('e1').status).toBe('ready'));

    slice.invalidate('e1');
    await vi.waitFor(() => expect(slice.getSnapshot('e1').status).toBe('error'));
    // Rows from the last successful fetch are kept, not wiped by the failure.
    expect(slice.getSnapshot('e1').rows).toEqual([{ id: 's1', eventId: 'e1', label: 'a' }]);
  });

  it('applyLocalUpsert on an UNLOADED key is a no-op (status stays loading)', () => {
    const slice = makeSlice(async () => []);
    slice.applyLocalUpsert('e1', { id: 's1', eventId: 'e1', label: 'a' });
    expect(slice.getSnapshot('e1')).toEqual({ rows: [], status: 'loading' });
  });

  it('applyLocalUpsert on a loaded key inserts a new row and replaces an existing one by id', async () => {
    const fetchScope = vi.fn(async () => [{ id: 's1', eventId: 'e1', label: 'a' }]);
    const slice = makeSlice(fetchScope);
    slice.ensure('e1');
    await vi.waitFor(() => expect(slice.getSnapshot('e1').status).toBe('ready'));

    slice.applyLocalUpsert('e1', { id: 's2', eventId: 'e1', label: 'b' });
    expect(slice.getSnapshot('e1').rows.map((r) => r.id).sort()).toEqual(['s1', 's2']);

    slice.applyLocalUpsert('e1', { id: 's1', eventId: 'e1', label: 'a-edited' });
    const s1 = slice.getSnapshot('e1').rows.find((r) => r.id === 's1');
    expect(s1?.label).toBe('a-edited');
    expect(slice.getSnapshot('e1').rows).toHaveLength(2); // replaced, not duplicated
  });

  it('applyLocalRemove drops the row by id and keeps status', async () => {
    const fetchScope = vi.fn(async () => [
      { id: 's1', eventId: 'e1', label: 'a' },
      { id: 's2', eventId: 'e1', label: 'b' },
    ]);
    const slice = makeSlice(fetchScope);
    slice.ensure('e1');
    await vi.waitFor(() => expect(slice.getSnapshot('e1').status).toBe('ready'));

    slice.applyLocalRemove('e1', 's1');
    expect(slice.getSnapshot('e1').rows.map((r) => r.id)).toEqual(['s2']);
    expect(slice.getSnapshot('e1').status).toBe('ready');
  });

  it('different scope keys are cached independently', async () => {
    const fetchScope = vi.fn(async (key: string) => [{ id: `${key}-s1`, eventId: key, label: 'a' }]);
    const slice = makeSlice(fetchScope);
    slice.ensure('e1');
    slice.ensure('e2');
    await vi.waitFor(() => {
      expect(slice.getSnapshot('e1').status).toBe('ready');
      expect(slice.getSnapshot('e2').status).toBe('ready');
    });
    expect(slice.getSnapshot('e1').rows[0].id).toBe('e1-s1');
    expect(slice.getSnapshot('e2').rows[0].id).toBe('e2-s1');
    expect(fetchScope).toHaveBeenCalledTimes(2);
  });

  it('ensure()/invalidate() with an empty key is a no-op', () => {
    const fetchScope = vi.fn(async () => []);
    const slice = makeSlice(fetchScope);
    slice.ensure('');
    slice.invalidate('');
    expect(fetchScope).not.toHaveBeenCalled();
  });
});
