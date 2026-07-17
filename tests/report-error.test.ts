import { describe, it, expect, beforeEach } from 'vitest';
import { pushCapped, reportError, getRecentErrors, setErrorReporter } from '../src/lib/report-error';

describe('pushCapped (pure ring-buffer logic)', () => {
  it('keeps only the last `max` entries, oldest dropped first', () => {
    const ring: number[] = [];
    for (let i = 1; i <= 5; i++) pushCapped(ring, i, 3);
    expect(ring).toEqual([3, 4, 5]);
  });

  it('is a no-op push when under the cap', () => {
    const ring: string[] = [];
    pushCapped(ring, 'a', 10);
    pushCapped(ring, 'b', 10);
    expect(ring).toEqual(['a', 'b']);
  });
});

describe('getRecentErrors (report-error ring buffer)', () => {
  beforeEach(() => {
    // Swallow the sink so tests don't spam console/log; reportError never throws.
    setErrorReporter(() => {});
  });

  it('captures entries pushed via reportError, newest last, capped at 10', () => {
    for (let i = 0; i < 15; i++) reportError(`boom-${i}`, 'test-context');
    const recent = getRecentErrors();
    expect(recent.length).toBe(10);
    expect(recent[recent.length - 1].message).toContain('boom-14');
    expect(recent[0].message).toContain('boom-5');
  });

  it('truncates overlong messages to ~500 chars', () => {
    reportError('x'.repeat(2000), 'test-context');
    const recent = getRecentErrors();
    expect(recent[recent.length - 1].message.length).toBeLessThanOrEqual(520); // context prefix + cap
  });

  it('captures direct console.error calls too', () => {
    console.error('a direct console.error call', { detail: 1 });
    const recent = getRecentErrors();
    expect(recent[recent.length - 1].message).toContain('a direct console.error call');
  });
});
