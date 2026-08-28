// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RegistrationEditor } from '../../src/components/RegistrationEditor';
import { ToastCtx } from '../../src/components/ui-hooks';
import type { Athlete, Event, Level, Registration, Season } from '../../src/lib/types';

function athlete(overrides: Partial<Athlete> = {}): Athlete {
  return {
    id: 'a1', kind: 'athlete', roles: { athlete: true, coach: false },
    firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com', dob: '2010-01-01',
    gender: 'Female', gradYear: 1900, studentStatus: 'Student', shirt: 'M', country: 'US',
    state: 'CA', phone: '', mainClubId: 'club-a', altClubIds: [], levels: {},
    emergency: { contact: '', relation: '', phone: '' }, dietary: [], dietaryNotes: '',
    memberships: [], achievements: [],
    ...overrides,
  };
}

function level(overrides: Partial<Level> = {}): Level {
  return { id: 'L5', discipline: 'MAG', name: 'Level 5', svMax: null, vaults: 1, order: 5, ...overrides };
}

const season: Season = {
  id: 's26', name: '2025–26', startsOn: '2025-07-01', endsOn: '2026-06-30',
  athleteFee: 35, coachFee: 20, clubFee: 109, active: true,
};

function event(overrides: Partial<Event> = {}): Event {
  return {
    id: 'e1', slug: 'e1', name: 'Test Meet', hostClubId: 'host-club', city: 'Anytown',
    state: 'CA', timezone: 'America/Los_Angeles', startDate: '2026-03-01', endDate: '2026-03-01',
    status: 'live', regOpens: '2026-01-01T00:00:00', regCloses: '2026-02-15T00:00:00',
    entryFee: 40, secondDisciplineFee: 25, disciplines: ['MAG'], sessions: [],
    ...overrides,
  };
}

function reg(overrides: Partial<Registration> = {}): Registration {
  return {
    id: 'r1', eventId: 'e1', athleteId: 'a1', clubId: 'club-a', discipline: 'MAG',
    levelId: 'L5', apparatus: ['FX', 'PH'], sessionId: null,
    ...overrides,
  };
}

const levels = [level({ id: 'L5', name: 'Level 5', order: 5 }), level({ id: 'L6', name: 'Level 6', order: 6 })];

function saveButton() {
  return screen.getByRole('button', { name: /Add change to cart|^Save$|Add to cart|Register/ });
}

describe('RegistrationEditor change-fee derivation (3h)', () => {
  it('editing a paid reg with no change yet does NOT surface the change fee ("Save", not "Add change to cart")', () => {
    render(
      <RegistrationEditor
        event={event()} athlete={athlete()} clubId="club-a"
        existing={[reg()]} allAthletes={[athlete()]} levels={levels} season={season}
        onSave={() => {}} onCancel={() => {}}
      />,
    );
    expect(saveButton()).toHaveTextContent('Save');
  });

  it('adding a discipline to a paid reg surfaces "Add change to cart"', () => {
    render(
      <RegistrationEditor
        event={event({ disciplines: ['MAG', 'WAG'] })} athlete={athlete()} clubId="club-a"
        existing={[reg()]} allAthletes={[athlete()]} levels={[...levels, level({ id: 'W5', discipline: 'WAG', name: 'WAG 5' })]}
        season={season} onSave={() => {}} onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('checkbox', { name: /WAG/ }));
    const fxBoxes = screen.getAllByRole('checkbox', { name: /FX — Floor/i });
    fireEvent.click(fxBoxes[fxBoxes.length - 1]);
    expect(saveButton()).toHaveTextContent('Add change to cart');
  });

  it('changing the discipline level on a paid reg surfaces "Add change to cart"', () => {
    render(
      <RegistrationEditor
        event={event()} athlete={athlete()} clubId="club-a"
        existing={[reg()]} allAthletes={[athlete()]} levels={levels} season={season}
        onSave={() => {}} onCancel={() => {}}
      />,
    );
    const select = screen.getByDisplayValue('Level 5');
    fireEvent.change(select, { target: { value: 'L6' } });
    expect(saveButton()).toHaveTextContent('Add change to cart');
  });

  it('an apparatus-only tweak within the same discipline does NOT surface the change fee', () => {
    render(
      <RegistrationEditor
        event={event()} athlete={athlete()} clubId="club-a"
        existing={[reg({ apparatus: ['FX', 'PH'] })]} allAthletes={[athlete()]} levels={levels} season={season}
        onSave={() => {}} onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('checkbox', { name: /SR — Still Rings/i }));
    expect(saveButton()).toHaveTextContent('Save');
    expect(screen.getByText(/Make a chargeable change/)).toBeInTheDocument();
  });

  it('a club-only switch with originalClubId set is eligible (chargeable) even with no other change', () => {
    render(
      <RegistrationEditor
        event={event()} athlete={athlete()} clubId="club-b" originalClubId="club-a"
        existing={[reg({ clubId: 'club-a' })]} allAthletes={[athlete()]} levels={levels} season={season}
        onSave={() => {}} onCancel={() => {}}
      />,
    );
    expect(saveButton()).toHaveTextContent('Add change to cart');
  });

  it('without originalClubId, a differing clubId prop is not recognized as a club switch (defaults originalClubId to clubId)', () => {
    render(
      <RegistrationEditor
        event={event()} athlete={athlete()} clubId="club-b"
        existing={[reg({ clubId: 'club-a' })]} allAthletes={[athlete()]} levels={levels} season={season}
        onSave={() => {}} onCancel={() => {}}
      />,
    );
    expect(saveButton()).toHaveTextContent('Save');
  });

  it('a brand-new registration (no existing rows) always shows "Register", never the change-fee label', () => {
    render(
      <RegistrationEditor
        event={event()} athlete={athlete()} clubId="club-a"
        existing={[]} allAthletes={[athlete()]} levels={levels} season={season}
        onSave={() => {}} onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('checkbox', { name: /MAG/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /FX — Floor/i }));
    expect(saveButton()).toHaveTextContent('Register');
  });
});

// UAT G-06 (2026-08-27, owner decision): a checked discipline with ZERO
// apparatus is a legitimate "attending, not competing" state — Save must
// stay enabled, the row must actually be saved (apparatus: []) rather than
// silently dropped, and a warning toast must fire once from the save path.
describe('RegistrationEditor zero-apparatus "attending, not competing" (UAT G-06)', () => {
  it('a brand-new registration with a discipline checked but NO apparatus keeps Save enabled', () => {
    render(
      <RegistrationEditor
        event={event()} athlete={athlete()} clubId="club-a"
        existing={[]} allAthletes={[athlete()]} levels={levels} season={season}
        onSave={() => {}} onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('checkbox', { name: /MAG/ }));
    expect(saveButton()).not.toBeDisabled();
    expect(saveButton()).toHaveTextContent('Register');
  });

  it('saving a checked, zero-apparatus discipline produces a real row (apparatus: []) and warns once', () => {
    let saved: Registration[] = [];
    const toastSpy = vi.fn();
    render(
      <ToastCtx.Provider value={toastSpy}>
        <RegistrationEditor
          event={event()} athlete={athlete()} clubId="club-a"
          existing={[]} allAthletes={[athlete()]} levels={levels} season={season}
          onSave={(regs) => { saved = regs; }} onCancel={() => {}}
        />
      </ToastCtx.Provider>,
    );
    fireEvent.click(screen.getByRole('checkbox', { name: /MAG/ }));
    fireEvent.click(saveButton());
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ discipline: 'MAG', apparatus: [] });
    expect(toastSpy).toHaveBeenCalledTimes(1);
    expect(toastSpy.mock.calls[0][0]).toMatch(/attending, not competing/i);
  });

  it('clearing all apparatus on an existing PAID reg (still checked) is a free save, not a chargeable change', () => {
    let saved: Registration[] = [];
    render(
      <RegistrationEditor
        event={event()} athlete={athlete()} clubId="club-a"
        existing={[reg({ apparatus: ['FX', 'PH'] })]} allAthletes={[athlete()]} levels={levels} season={season}
        onSave={(regs) => { saved = regs; }} onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('checkbox', { name: /FX — Floor/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /PH — Pommel Horse/i }));
    expect(saveButton()).not.toBeDisabled();
    expect(saveButton()).toHaveTextContent('Save'); // not "Add change to cart" — not eligible
    fireEvent.click(saveButton());
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ id: 'r1', discipline: 'MAG', apparatus: [] });
  });
});

describe('RegistrationEditor "stay registered for at least 1 discipline" toast wording (UAT G-06)', () => {
  it('unchecking the only discipline re-checks it and warns using "apparatus", not the old "events" typo', () => {
    const toastSpy = vi.fn();
    render(
      <ToastCtx.Provider value={toastSpy}>
        <RegistrationEditor
          event={event()} athlete={athlete()} clubId="club-a"
          existing={[reg()]} allAthletes={[athlete()]} levels={levels} season={season}
          onSave={() => {}} onCancel={() => {}}
        />
      </ToastCtx.Provider>,
    );
    fireEvent.click(screen.getByRole('checkbox', { name: /MAG/ }));
    expect(toastSpy).toHaveBeenCalledTimes(1);
    expect(toastSpy.mock.calls[0][0]).toContain('If you remove all selected apparatus');
    expect(toastSpy.mock.calls[0][0]).not.toContain('If you remove all selected events');
    // The discipline stays checked (the uncheck was refused).
    expect(screen.getByRole('checkbox', { name: /MAG/ })).toBeChecked();
  });
});

// Camps ask NOTHING discipline-related (PM feedback 2026-07-23): a single
// confirmation line replaces the per-discipline checkboxes entirely. A
// brand-new camp registration always saves exactly ONE row, carrying
// event.disciplines[0] (levelId:'', apparatus:[], sessionId:null) purely
// because `registrations.discipline` is a NOT NULL enum — never shown or
// asked about. Editing a legacy (pre-change) multi-row camp registration
// must not delete/re-add rows.
describe('RegistrationEditor camp mode (no discipline UI)', () => {
  function campEvent(overrides: Partial<Event> = {}): Event {
    return event({ eventType: 'camp', disciplines: ['MAG', 'WAG'], sessions: [], ...overrides });
  }

  it('renders no discipline checkboxes, level select, apparatus checkboxes, or session picker — just a confirmation line', () => {
    render(
      <RegistrationEditor
        event={campEvent()} athlete={athlete()} clubId="club-a"
        existing={[]} allAthletes={[athlete()]} levels={levels} season={season}
        onSave={() => {}} onCancel={() => {}}
      />,
    );
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByText(/level/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByText(/Apparatus/i)).not.toBeInTheDocument();
    expect(screen.getByText(/will be registered for/)).toBeInTheDocument();
  });

  it('Save is enabled immediately for a brand-new camp registration — no toggle needed', () => {
    render(
      <RegistrationEditor
        event={campEvent()} athlete={athlete()} clubId="club-a"
        existing={[]} allAthletes={[athlete()]} levels={levels} season={season}
        onSave={() => {}} onCancel={() => {}}
      />,
    );
    expect(saveButton()).not.toBeDisabled();
    expect(saveButton()).toHaveTextContent('Register');
  });

  it('saves exactly ONE row for a brand-new camp registration, carrying the first event discipline', () => {
    let saved: Registration[] = [];
    render(
      <RegistrationEditor
        event={campEvent()} athlete={athlete()} clubId="club-a"
        existing={[]} allAthletes={[athlete()]} levels={levels} season={season}
        onSave={(regs) => { saved = regs; }} onCancel={() => {}}
      />,
    );
    fireEvent.click(saveButton());
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ discipline: 'MAG', levelId: '', apparatus: [], sessionId: null });
  });

  it('falls back to MAG when the camp event has no disciplines configured', () => {
    let saved: Registration[] = [];
    render(
      <RegistrationEditor
        event={campEvent({ disciplines: [] })} athlete={athlete()} clubId="club-a"
        existing={[]} allAthletes={[athlete()]} levels={levels} season={season}
        onSave={(regs) => { saved = regs; }} onCancel={() => {}}
      />,
    );
    fireEvent.click(saveButton());
    expect(saved).toHaveLength(1);
    expect(saved[0].discipline).toBe('MAG');
  });

  it('editing a legacy multi-row camp registration keeps every row as-is — no delete/re-add churn', () => {
    const legacyRows = [
      reg({ id: 'r-mag', discipline: 'MAG', levelId: '', apparatus: [], sessionId: null }),
      reg({ id: 'r-wag', discipline: 'WAG', levelId: '', apparatus: [], sessionId: null }),
    ];
    render(
      <RegistrationEditor
        event={campEvent()} athlete={athlete()} clubId="club-a"
        existing={legacyRows}
        allAthletes={[athlete()]} levels={levels} season={season}
        onSave={() => {}} onCancel={() => {}}
      />,
    );
    expect(screen.getByText(/^Registered for/)).toBeInTheDocument();
    // Nothing to change (same club) — Save is disabled, matching the
    // must-stay-registered / no-op-edit guard for non-camp events.
    expect(saveButton()).toBeDisabled();
  });

  it('a club-only switch on a legacy multi-row camp registration is chargeable and preserves both rows', () => {
    let saved: Registration[] = [];
    const legacyRows = [
      reg({ id: 'r-mag', clubId: 'club-a', discipline: 'MAG', levelId: '', apparatus: [], sessionId: null }),
      reg({ id: 'r-wag', clubId: 'club-a', discipline: 'WAG', levelId: '', apparatus: [], sessionId: null }),
    ];
    render(
      <RegistrationEditor
        event={campEvent()} athlete={athlete()} clubId="club-b" originalClubId="club-a"
        existing={legacyRows}
        allAthletes={[athlete()]} levels={levels} season={season}
        onSave={(regs) => { saved = regs; }} onCancel={() => {}}
      />,
    );
    expect(saveButton()).toHaveTextContent('Add change to cart');
    fireEvent.click(saveButton());
    expect(saved).toHaveLength(2);
    expect(saved.map((r) => r.id).sort()).toEqual(['r-mag', 'r-wag']);
    expect(saved.every((r) => r.clubId === 'club-b')).toBe(true);
  });
});
