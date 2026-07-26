import { describe, it, expect } from 'vitest';
import { labelFor, resolveLabel } from '../src/lib/navHistory';
import type { DB, Event } from '../src/lib/types';

function db(events: Partial<Event>[] = []): DB {
  return { events } as unknown as DB;
}

describe('labelFor (pure, path-only)', () => {
  it('known static routes map to their labels', () => {
    expect(labelFor('/')).toBe('Home');
    expect(labelFor('/results')).toBe('Live Results');
    expect(labelFor('/events')).toBe('Events');
  });

  it('a results detail route falls back to the generic "Results" label', () => {
    expect(labelFor('/results/test-meet')).toBe('Results');
  });

  it('an unmatched route falls back to capitalised path segments', () => {
    expect(labelFor('/some/random/path')).toBe('Some / Random / Path');
  });
});

describe('resolveLabel (H4.5 — db-aware event title resolution)', () => {
  it('resolves a /results/:slug route to the matching event\'s display name', () => {
    const store = db([{ slug: 'test-meet', name: '2026 Test Invitational' }]);
    expect(resolveLabel('/results/test-meet', store)).toBe('2026 Test Invitational');
  });

  it('falls back to the generic label when no event matches the slug', () => {
    const store = db([{ slug: 'other-meet', name: 'Other Meet' }]);
    expect(resolveLabel('/results/unknown-slug', store)).toBe('Results');
  });

  it('falls back to the generic label when the store has no events', () => {
    expect(resolveLabel('/results/test-meet', db())).toBe('Results');
  });

  it('defers to labelFor unchanged for every other route', () => {
    const store = db([{ slug: 'test-meet', name: '2026 Test Invitational' }]);
    expect(resolveLabel('/', store)).toBe('Home');
    expect(resolveLabel('/events/test-meet', store)).toBe('Event');
    expect(resolveLabel('/club/abc', store)).toBe('Club Roster');
  });
});
