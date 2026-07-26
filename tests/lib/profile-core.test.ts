import { describe, it, expect } from 'vitest';
import { isProfileDirty } from '../../src/lib/profile-core';
import type { Athlete } from '../../src/lib/types';

function makeAthlete(overrides: Partial<Athlete> = {}): Athlete {
  return {
    id: 'p-1',
    kind: 'athlete',
    roles: { athlete: true, coach: false },
    firstName: 'Jamie',
    lastName: 'Rivera',
    email: 'jamie@example.com',
    dob: '',
    gender: 'Female',
    gradYear: 0,
    studentStatus: '',
    shirt: '',
    country: 'US',
    state: '',
    phone: '',
    mainClubId: null,
    altClubIds: [],
    levels: {},
    emergency: { contact: '', relation: '', phone: '' },
    dietary: [],
    dietaryNotes: '',
    memberships: [],
    achievements: [],
    ...overrides,
  };
}

describe('isProfileDirty', () => {
  it('is false for an identical (but distinct) clone', () => {
    const snapshot = makeAthlete();
    const draft = makeAthlete();
    expect(isProfileDirty(snapshot, draft)).toBe(false);
  });

  it('is false when the same object reference is passed for both', () => {
    const snapshot = makeAthlete();
    expect(isProfileDirty(snapshot, snapshot)).toBe(false);
  });

  it('is true when a top-level scalar field changes', () => {
    const snapshot = makeAthlete();
    const draft = makeAthlete({ phone: '(555) 123-4567' });
    expect(isProfileDirty(snapshot, draft)).toBe(true);
  });

  it('is true when a nested object field changes', () => {
    const snapshot = makeAthlete();
    const draft = makeAthlete({ emergency: { contact: 'Pat Rivera', relation: '', phone: '' } });
    expect(isProfileDirty(snapshot, draft)).toBe(true);
  });

  it('is true when an array field changes', () => {
    const snapshot = makeAthlete();
    const draft = makeAthlete({ altClubIds: ['club-A'] });
    expect(isProfileDirty(snapshot, draft)).toBe(true);
  });

  it('is false when arrays contain equal elements in the same order', () => {
    const snapshot = makeAthlete({ dietary: ['Vegetarian', 'Gluten-free'] });
    const draft = makeAthlete({ dietary: ['Vegetarian', 'Gluten-free'] });
    expect(isProfileDirty(snapshot, draft)).toBe(false);
  });

  it('is true when dietary array order changes', () => {
    const snapshot = makeAthlete({ dietary: ['Vegetarian', 'Gluten-free'] });
    const draft = makeAthlete({ dietary: ['Gluten-free', 'Vegetarian'] });
    expect(isProfileDirty(snapshot, draft)).toBe(true);
  });

  it('reverting a change back to the snapshot value is clean again', () => {
    const snapshot = makeAthlete();
    let draft = makeAthlete({ firstName: 'Jordan' });
    expect(isProfileDirty(snapshot, draft)).toBe(true);
    draft = makeAthlete({ firstName: 'Jamie' });
    expect(isProfileDirty(snapshot, draft)).toBe(false);
  });
});
