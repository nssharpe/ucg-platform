// Data layer shaped like an async API so a real backend can swap in later.
// Backed by a seeded in-memory DB persisted to localStorage.
import { useSyncExternalStore } from 'react';
import type { DB, Role, RoleId } from './types';
import { buildSeed } from './seed';

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

// Persona context: which club/athlete the current role "is"
export const PERSONA = {
  athleteId: 'p-1', // Maya Okafor
  clubId: 'club-1', // U. Minnesota
  hostClubId: 'club-6', // Ohio State, hosts Midwest Regional
};

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
