// Data layer shaped like an async API so a real backend can swap in later.
// Backed by a seeded in-memory DB persisted to localStorage.
import { useSyncExternalStore } from 'react';
import type { DB, Role, RoleId } from './types';
import { buildSeed } from './seed';
import { isSupabaseConfigured, loadAll } from './supabase';

const LS_KEY = 'ucg-db-v1';
const SEED_VERSION = 3;

let db: DB = load();
const listeners = new Set<() => void>();
let snapshotVersion = 0;

function load(): DB {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.__v === SEED_VERSION) return parsed.db;
    }
  } catch { /* fall through to fresh seed */ }
  return buildSeed();
}

function persist() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ __v: SEED_VERSION, db }));
  } catch { /* storage full or unavailable — demo continues in memory */ }
}

export function getDB(): DB {
  return db;
}

/** Mutate the DB inside fn; persists + notifies subscribers (multi-tab safe). */
export function mutate(fn: (db: DB) => void) {
  fn(db);
  snapshotVersion++;
  persist();
  listeners.forEach((l) => l());
}

export function resetDemo() {
  db = buildSeed();
  snapshotVersion++;
  persist();
  listeners.forEach((l) => l());
}

/** Replace the in-memory snapshot with a fresh load from Supabase, if configured. */
export async function syncFromSupabase() {
  if (!isSupabaseConfigured) return;
  const remote = await loadAll();
  if (!remote) return;
  // A completely empty remote means the backend hasn't been seeded yet —
  // keep the local snapshot so it can be pushed (Admin → Demo tools).
  if (!remote.seasons.length && !remote.clubs.length && !remote.people.length && !remote.meets.length) return;
  db = remote;
  snapshotVersion++;
  persist();
  listeners.forEach((l) => l());
}

// Boot hydration: keep the localStorage/seed snapshot for first paint (no
// flash), then replace it with Supabase data once it arrives.
if (isSupabaseConfigured) void syncFromSupabase();

// Cross-tab sync
window.addEventListener('storage', (e) => {
  if (e.key === LS_KEY && e.newValue) {
    try {
      const parsed = JSON.parse(e.newValue);
      if (parsed.__v === SEED_VERSION) {
        db = parsed.db;
        snapshotVersion++;
        listeners.forEach((l) => l());
      }
    } catch { /* ignore malformed cross-tab payload */ }
  }
});

export function useDB(): DB {
  useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => snapshotVersion,
  );
  return db;
}

// ---- Roles / demo personas ----
export const ROLES: Role[] = [
  { id: 'admin', label: 'League Admin', personaName: 'Julia (UCG HQ)', description: 'Full league controls: seasons, levels, members, meets, comms.' },
  { id: 'club-manager', label: 'Club Manager', personaName: 'Coach at U. Minnesota', description: 'Roster, meet registration, club cart & invoices.' },
  { id: 'athlete', label: 'Athlete', personaName: 'Maya Okafor', description: 'Membership, profile, meet signup, scores.' },
  { id: 'judge', label: 'Judge', personaName: 'Panel judge', description: 'Score entry with built-in SV calculators.' },
  { id: 'meet-host', label: 'Meet Host', personaName: 'Ohio State (host)', description: 'Sessions, squads, schedule, meet dashboard.' },
  { id: 'spectator', label: 'Spectator', personaName: 'Public', description: 'Live results. No login needed.' },
];

const ROLE_KEY = 'ucg-role';
let currentRole: RoleId = (sessionStorage.getItem(ROLE_KEY) as RoleId) || 'admin';
const roleListeners = new Set<() => void>();

export function useRole(): RoleId {
  return useSyncExternalStore(
    (cb) => { roleListeners.add(cb); return () => roleListeners.delete(cb); },
    () => currentRole,
  );
}

export function setRole(r: RoleId) {
  currentRole = r;
  sessionStorage.setItem(ROLE_KEY, r);
  roleListeners.forEach((l) => l());
}

// Persona context: which club/athlete the current role "is".
// Admins can impersonate any person in db.people; null = the default seed persona.
export interface Persona {
  athleteId: string;
  clubId: string;
  hostClubId: string;
}

const DEFAULT_PERSONA: Persona = {
  athleteId: 'p-1', // Maya Okafor
  clubId: 'club-1', // U. Minnesota
  hostClubId: 'club-6', // Ohio State, hosts Midwest Regional
};

const PERSON_KEY = 'ucg-view-person';
let viewPersonId: string | null = sessionStorage.getItem(PERSON_KEY);
const personaListeners = new Set<() => void>();

/** The raw impersonation selection (null = default persona). */
export function useViewPersonId(): string | null {
  return useSyncExternalStore(
    (cb) => { personaListeners.add(cb); return () => personaListeners.delete(cb); },
    () => viewPersonId,
  );
}

export function setViewPersonId(id: string | null) {
  viewPersonId = id;
  if (id) sessionStorage.setItem(PERSON_KEY, id);
  else sessionStorage.removeItem(PERSON_KEY);
  personaListeners.forEach((l) => l());
}

/** Non-reactive persona snapshot. Falls back to the seed default if the
 *  selected person no longer exists (e.g. after a demo reset). */
export function getPersona(): Persona {
  const person = viewPersonId ? db.people.find((p) => p.id === viewPersonId) : undefined;
  if (!person) return DEFAULT_PERSONA;
  return {
    athleteId: person.id,
    clubId: person.mainClubId ?? DEFAULT_PERSONA.clubId,
    hostClubId: DEFAULT_PERSONA.hostClubId,
  };
}

/** Reactive persona — tracks both the impersonation selection and DB changes. */
export function usePersona(): Persona {
  useViewPersonId();
  useDB();
  return getPersona();
}

// ---- Password gate ----
const GATE_KEY = 'ucg-gate-ok';
// SHA-256 of the access password
const GATE_HASH = 'a362d06a6c7b321fa6a9fc17c5219549e062fcc8db93f409236175704d718ac6';

export async function checkPassword(pw: string): Promise<boolean> {
  const data = new TextEncoder().encode(pw.trim());
  const buf = await crypto.subtle.digest('SHA-256', data);
  const hex = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  if (hex === GATE_HASH) {
    localStorage.setItem(GATE_KEY, GATE_HASH);
    return true;
  }
  return false;
}

export function isUnlocked(): boolean {
  return localStorage.getItem(GATE_KEY) === GATE_HASH;
}
