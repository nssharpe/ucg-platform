// Supabase client — scaffolded for the backend migration.
//
// The app currently runs entirely on the localStorage store (src/lib/store.ts).
// When you're ready to move to a real backend:
//   1. Create a Supabase project, run supabase/migrations/*.sql.
//   2. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (see .env.example).
//   3. Implement the repository methods below against `supabase`, and flip
//      the store to call them. Until env vars are set this module is inert,
//      so the prototype keeps working with zero backend.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const isSupabaseConfigured = Boolean(url && anonKey);

/** Null until env vars are provided — callers must guard on isSupabaseConfigured. */
export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(url!, anonKey!, { auth: { persistSession: true, autoRefreshToken: true } })
  : null;

/**
 * Repository surface the app data-layer will call once the backend is live.
 * Mirrors the reads/writes the localStorage store performs today, so swapping
 * is a matter of implementing these and routing the store through them.
 *
 * Left as a typed contract (not implemented) on purpose — implement table by
 * table as you migrate, verifying each against the prototype's behavior.
 */
export interface UcgRepository {
  // reads
  loadAll(): Promise<unknown>; // hydrate the in-memory snapshot on boot
  // people
  upsertPerson(person: unknown): Promise<void>;
  setMembership(personId: string, seasonId: string, patch: unknown): Promise<void>;
  // registrations
  upsertRegistration(reg: unknown): Promise<void>;
  deleteRegistration(id: string): Promise<void>;
  // scoring
  upsertScore(score: unknown): Promise<void>;
  // money
  addCartItem(ownerKey: string, item: unknown): Promise<void>;
  checkoutCart(ownerKey: string): Promise<void>;
  // realtime: subscribe to live score inserts for a meet (drives live results)
  subscribeScores(meetId: string, onChange: () => void): () => void;
}

/** Example realtime wiring for live results once the backend is live. */
export function subscribeMeetScores(meetId: string, onChange: () => void): () => void {
  if (!supabase) return () => {};
  const channel = supabase
    .channel(`scores:${meetId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'scores', filter: `meet_id=eq.${meetId}` }, onChange)
    .subscribe();
  return () => { supabase.removeChannel(channel); };
}
