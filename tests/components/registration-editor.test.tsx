// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RegistrationEditor } from '../../src/components/RegistrationEditor';
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
