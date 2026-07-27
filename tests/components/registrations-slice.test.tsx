// @vitest-environment jsdom
// Phase 3 (2026-07-27 data-layer-scale). registrations-slice.ts's networked
// (isSupabaseConfigured: true) branches are exercised live against the
// scale-seeded staging dataset per the task's verification requirements —
// deliberately NOT unit-mocked here, matching Phase 2's own precedent
// (scores-slice.ts has no dedicated unit test file either): the module
// unconditionally imports `useCapabilities` (for MyRegistrationsBoot), which
// pulls in the real auth/capabilities stack, so swapping isSupabaseConfigured
// to true via vi.mock risks import-time crashes deep in code this test isn't
// trying to exercise. What IS safely testable here, with the real store.ts
// and the test env's real isSupabaseConfigured===false (vitest.config blanks
// the Supabase env vars), is the demo-mode fallback path every hook takes —
// genuine behavior (CI/a fresh clone runs unconfigured, per CLAUDE.md), and
// exactly the same isSupabaseConfigured branch cart-line-removal.test.tsx
// already proves is safe to exercise in jsdom.
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { mutate, resetDemo } from '../../src/lib/store';
import {
  useEventRegistrations, useClubRegistrations, useMyRegistrations,
  fetchEventRegistrationsOnce, fetchRegistrationsForPerson, fetchRegistrationById,
} from '../../src/lib/registrations-slice';
import type { Registration } from '../../src/lib/types';

function reg(overrides: Partial<Registration> = {}): Registration {
  return {
    id: 'r1', eventId: 'e1', athleteId: 'a1', clubId: 'club-a', discipline: 'MAG',
    levelId: 'L5', apparatus: ['FX', 'PH'], sessionId: null,
    ...overrides,
  };
}

beforeEach(() => {
  resetDemo();
  mutate((d) => { d.registrations = []; });
});

function EventHarness({ eventId }: { eventId: string }) {
  const { rows, status } = useEventRegistrations(eventId);
  return <div data-testid="out">{status}:{rows.map((r) => r.id).sort().join(',')}</div>;
}

function ClubHarness({ clubId }: { clubId: string }) {
  const { rows, status } = useClubRegistrations(clubId);
  return <div data-testid="out">{status}:{rows.map((r) => r.id).sort().join(',')}</div>;
}

function MineHarness() {
  const rows = useMyRegistrations();
  return <div data-testid="out">{rows.map((r) => r.id).sort().join(',')}</div>;
}

describe('registrations-slice demo-mode fallback (isSupabaseConfigured: false)', () => {
  it('useEventRegistrations filters db.registrations by eventId and is always status "ready"', () => {
    mutate((d) => {
      d.registrations.push(reg({ id: 'r1', eventId: 'e1' }));
      d.registrations.push(reg({ id: 'r2', eventId: 'e1' }));
      d.registrations.push(reg({ id: 'r3', eventId: 'e2' }));
    });
    render(<EventHarness eventId="e1" />);
    expect(screen.getByTestId('out').textContent).toBe('ready:r1,r2');
  });

  it('useEventRegistrations returns an empty ready result for an undefined eventId', () => {
    mutate((d) => { d.registrations.push(reg({ id: 'r1', eventId: 'e1' })); });
    render(<EventHarness eventId={undefined as unknown as string} />);
    expect(screen.getByTestId('out').textContent).toBe('ready:');
  });

  it('useClubRegistrations filters db.registrations by clubId across every event (shape #5)', () => {
    mutate((d) => {
      d.registrations.push(reg({ id: 'r1', eventId: 'e1', clubId: 'club-a' }));
      d.registrations.push(reg({ id: 'r2', eventId: 'e2', clubId: 'club-a' }));
      d.registrations.push(reg({ id: 'r3', eventId: 'e1', clubId: 'club-b' }));
    });
    render(<ClubHarness clubId="club-a" />);
    expect(screen.getByTestId('out').textContent).toBe('ready:r1,r2');
  });

  it('useMyRegistrations returns db.registrations synchronously (caller filters by athleteId, matching the useMyScores precedent)', () => {
    mutate((d) => {
      d.registrations.push(reg({ id: 'r1', athleteId: 'a1' }));
      d.registrations.push(reg({ id: 'r2', athleteId: 'a2' }));
    });
    render(<MineHarness />);
    expect(screen.getByTestId('out').textContent).toBe('r1,r2');
  });

  it('fetchEventRegistrationsOnce reads db.registrations filtered by eventId', async () => {
    mutate((d) => {
      d.registrations.push(reg({ id: 'r1', eventId: 'e1' }));
      d.registrations.push(reg({ id: 'r2', eventId: 'e2' }));
    });
    const rows = await fetchEventRegistrationsOnce('e1');
    expect(rows.map((r) => r.id)).toEqual(['r1']);
  });

  it('fetchRegistrationsForPerson (shape #6) reads db.registrations filtered by athleteId, uncached', async () => {
    mutate((d) => {
      d.registrations.push(reg({ id: 'r1', athleteId: 'a1' }));
      d.registrations.push(reg({ id: 'r2', athleteId: 'a2' }));
    });
    expect((await fetchRegistrationsForPerson('a1')).map((r) => r.id)).toEqual(['r1']);
    // A subsequent write is reflected on the NEXT call — proves this never
    // reads from a warm cache (the whole point of shape #6).
    mutate((d) => { d.registrations.push(reg({ id: 'r3', athleteId: 'a1' })); });
    expect((await fetchRegistrationsForPerson('a1')).map((r) => r.id).sort()).toEqual(['r1', 'r3']);
  });

  it('fetchRegistrationById finds a single registration by id, or null', async () => {
    mutate((d) => { d.registrations.push(reg({ id: 'r1' })); });
    expect((await fetchRegistrationById('r1'))?.id).toBe('r1');
    expect(await fetchRegistrationById('missing')).toBeNull();
  });
});
