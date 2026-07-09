// _shared/event-comm.ts — pure filter + recipient-shaping logic for
// event-scoped communication (send-event-email, event-mgmt v2 §J). NO Deno/
// Supabase imports here — this module is unit-tested by vitest running under
// node (see tests/event-comm.test.ts) as well as imported by the
// send-event-email Edge Function at runtime, mirroring the owner-checklist.ts
// pattern (shared pure module, dual-imported by client + Edge Function).

export type EventCommRole = 'athlete' | 'manager' | 'clubEmail';

export interface EventCommFilters {
  roles: EventCommRole[];
  sessionIds?: string[];
  levelIds?: string[];
  disciplines?: string[];
}

/** Minimal shape of a registration row needed to apply session/level/
 *  discipline facet filters. Field names match the DB's snake_case columns
 *  since the Edge Function reads rows straight off `registrations`. */
export interface RegistrationFacetRow {
  session_id: string | null;
  level_id: string | null;
  discipline: string;
  refunded: boolean | null;
}

/** True iff `reg` matches every filter that was actually specified — an
 *  absent/empty filter array imposes no constraint (matches everything on
 *  that facet). Always excludes refunded registrations: a refunded entry's
 *  athlete/club is no longer a real registrant of the event. */
export function matchesEventCommFilters(reg: RegistrationFacetRow, filters: Pick<EventCommFilters, 'sessionIds' | 'levelIds' | 'disciplines'>): boolean {
  if (reg.refunded) return false;
  if (filters.sessionIds?.length && !(reg.session_id != null && filters.sessionIds.includes(reg.session_id))) return false;
  if (filters.levelIds?.length && !(reg.level_id != null && filters.levelIds.includes(reg.level_id))) return false;
  if (filters.disciplines?.length && !filters.disciplines.includes(reg.discipline)) return false;
  return true;
}

export interface NamedContact {
  email: string;
  name?: string;
}

/** Dedupe a list of candidate recipients by email (case-insensitive), drop
 *  anything without a plausible email address, and preserve first-seen order
 *  (and that occurrence's name) for stable output. Shared by every audience
 *  (athletes / club managers / club emails) so a person reachable through two
 *  roles — e.g. an athlete who also manages their club — is emailed once. */
export function dedupeContacts(candidates: { email: string | null | undefined; name?: string | null }[]): NamedContact[] {
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const seen = new Map<string, NamedContact>();
  for (const c of candidates) {
    const email = c.email?.trim();
    if (!email || !EMAIL_RE.test(email)) continue;
    const key = email.toLowerCase();
    if (!seen.has(key)) seen.set(key, { email, name: c.name?.trim() || undefined });
  }
  return [...seen.values()];
}
