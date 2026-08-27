import { describe, it, expect } from 'vitest';
import { eventIdsForCartItems } from '../../src/lib/pricing';

describe('eventIdsForCartItems (UAT M-12-03: club-cart registration-grid staleness)', () => {
  const events = [
    { id: 'ev-1', name: 'Fall Classic' },
    { id: 'ev-2', name: 'Winter Invitational' },
  ];

  it('returns nothing for an empty item list', () => {
    expect(eventIdsForCartItems([], events)).toEqual([]);
  });

  it('matches an item whose label includes the event name', () => {
    expect(eventIdsForCartItems([{ label: 'Fall Classic entry — Jane Doe' }], events)).toEqual(['ev-1']);
  });

  it('matches multiple distinct events, de-duplicated, in first-seen order', () => {
    const items = [
      { label: 'Fall Classic entry — Jane Doe' },
      { label: 'Winter Invitational entry — John Doe' },
      { label: 'Fall Classic entry — Jill Doe' },
    ];
    expect(eventIdsForCartItems(items, events)).toEqual(['ev-1', 'ev-2']);
  });

  it('skips an item whose label matches no known event (e.g. a membership or add-on line)', () => {
    const items = [{ label: 'UCG Athlete Membership — 2026-27' }];
    expect(eventIdsForCartItems(items, events)).toEqual([]);
  });

  it('is independent of any registration slice — an empty/incomplete regs set never affects this', () => {
    // This is the whole point of the fix: unlike the refRegIds->regs lookup
    // it complements, this derivation never depends on a slice being loaded.
    const items = [{ label: 'Winter Invitational entry — Jane Doe' }];
    expect(eventIdsForCartItems(items, [])).toEqual([]);
    expect(eventIdsForCartItems(items, events)).toEqual(['ev-2']);
  });
});
