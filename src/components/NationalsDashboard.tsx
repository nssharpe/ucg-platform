import { Fragment, type ReactNode } from 'react';
import { useDB } from '../lib/store';
import { APPARATUS } from '../lib/types';
import type { DB, Event, Registration } from '../lib/types';
import { eligibleTeams, isAllAround, TEAM_MIN_PER_APPARATUS } from '../lib/nationals-teams';
import { FinalsLineupEditor } from './FinalsLineupEditor';
import { Badge } from './ui';

/** Scope the dashboard to ONE club (a club manager's own view) or ONE
 *  independent athlete (`me.mainClubId === null`, mirrors the gate used at
 *  every other independent-athlete surface, e.g. `MyRegistrations.tsx`). */
export type NationalsDashboardScope = { clubId: string } | { personId: string };

/**
 * Nationals summary dashboard (event-mgmt v2 Phase 5, spec §L.3): five
 * read-only, registration-based planning sections for a `kind: 'nationals'`
 * event, scoped to one club or one independent athlete. Mounted from
 * `Club.tsx` (club scope), `MyRegistrations.tsx` (independent-athlete scope),
 * and an admin "view as" selector on `Events.tsx`'s `EventDetail`.
 *
 * This is a PLANNING summary — pre-scores, never scored results. The eligible
 * teams table is where the C2 finals-lineup editor will later attach a picker
 * per row; C2/C3 (the editor + scheduler) are separate later tasks and are
 * NOT built here. Renders nothing for a non-nationals event.
 *
 * Reads `db.*` directly on every render (never destructures/caches a nested
 * path) — `mutate()` mutates the shared store object in place, so a stale
 * local copy would never see a later push (the in-place-mutation trap,
 * CLAUDE.md).
 */
export function NationalsDashboard({ eventId, scope }: { eventId: string; scope: NationalsDashboardScope }) {
  const db = useDB();
  const event = db.events.find((e) => e.id === eventId);
  if (!event || event.kind !== 'nationals') return null;

  return (
    <div className="card card-pad" style={{ marginBottom: 18 }}>
      <h3 className="card-title">Nationals summary</h3>
      <EligibleTeamsSection event={event} scope={scope} />
      <DecathlonSection event={event} scope={scope} />
      <CoachListSection event={event} scope={scope} />
      <BanquetGapSection event={event} scope={scope} />
      <AssignedSessionsSection event={event} scope={scope} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared scope helpers
// ---------------------------------------------------------------------------

/** Non-refunded, non-waitlisted registrations for `eventId` within `scope`. */
function scopedActiveRegs(db: DB, eventId: string, scope: NationalsDashboardScope): Registration[] {
  return db.registrations.filter((r) => {
    if (r.eventId !== eventId || r.refunded || r.waitlisted) return false;
    return 'clubId' in scope ? r.clubId === scope.clubId : r.athleteId === scope.personId;
  });
}

/** The club id relevant to this scope: the scope's own club, or — for an
 *  independent athlete — the club they actually registered under for this
 *  event (an "independent" athlete has `mainClubId: null` but their
 *  `Registration.clubId` still names the affiliated club they competed for,
 *  since self-registration always picks one of the athlete's own main/alt
 *  clubs). Falls back to the athlete's `mainClubId`/first `altClubIds` entry,
 *  then null if the athlete truly has no club association on file. */
function resolveScopeClubId(db: DB, event: Event, scope: NationalsDashboardScope): string | null {
  if ('clubId' in scope) return scope.clubId;
  const athlete = db.people.find((p) => p.id === scope.personId);
  const regs = scopedActiveRegs(db, event.id, scope);
  return regs[0]?.clubId ?? athlete?.mainClubId ?? athlete?.altClubIds?.[0] ?? null;
}

function nameOf(db: DB, personId: string): string {
  const p = db.people.find((x) => x.id === personId);
  return p ? `${p.firstName} ${p.lastName}` : 'Unknown';
}

function SectionHeading({ children }: { children: ReactNode }) {
  return <h4 style={{ margin: '0 0 8px', fontSize: 14, fontWeight: 700 }}>{children}</h4>;
}

const SECTION_STYLE = { marginBottom: 18 };
const MUTED_NOTE_STYLE = { fontSize: 13, color: 'var(--ink-soft)', margin: 0 };

// ---------------------------------------------------------------------------
// 1. Eligible teams — spec §L.3 item 1
// ---------------------------------------------------------------------------

function EligibleTeamsSection({ event, scope }: { event: Event; scope: NationalsDashboardScope }) {
  const db = useDB();

  if (!('clubId' in scope)) {
    return (
      <div style={SECTION_STYLE}>
        <SectionHeading>Eligible teams</SectionHeading>
        <p style={MUTED_NOTE_STYLE}>Teams are club-scoped — nothing to show for an independent athlete.</p>
      </div>
    );
  }

  const regs = scopedActiveRegs(db, event.id, scope);
  const peopleById = new Map(db.people.map((p) => [p.id, p]));
  const teams = eligibleTeams(regs, peopleById);
  const levelName = (levelId: string) => db.levels.find((l) => l.id === levelId)?.name ?? levelId;

  return (
    <div style={SECTION_STYLE}>
      <SectionHeading>Eligible teams</SectionHeading>
      {teams.length === 0 ? (
        <p style={MUTED_NOTE_STYLE}>No apparatus has {TEAM_MIN_PER_APPARATUS}+ registered athletes yet.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>Discipline</th>
                <th>Level</th>
                <th>Placement category</th>
                <th>Apparatus counts</th>
              </tr>
            </thead>
            <tbody>
              {teams.map((team) => (
                <Fragment key={`${team.clubId}|${team.discipline}|${team.levelId}|${team.category}`}>
                  <tr>
                    <td>{team.discipline === 'TNT' ? 'T&T' : team.discipline}</td>
                    <td>{levelName(team.levelId)}</td>
                    <td>{team.category}</td>
                    <td style={{ fontSize: 13 }}>
                      {APPARATUS[team.discipline]
                        .filter((a) => (team.apparatusRegIds[a.code]?.length ?? 0) > 0)
                        .map((a) => {
                          const count = team.apparatusRegIds[a.code].length;
                          const eligible = team.eligibleApparatus.includes(a.code);
                          return (
                            <span
                              key={a.code}
                              style={{ marginRight: 10, fontWeight: eligible ? 700 : 400, color: eligible ? 'var(--green-600)' : 'var(--ink)' }}
                            >
                              {a.code}: {count}{eligible ? ' ✓' : ''}
                            </span>
                          );
                        })}
                    </td>
                  </tr>
                  {team.eligibleApparatus.length > 0 && (
                    <tr>
                      <td colSpan={4} style={{ paddingTop: 0 }}>
                        <FinalsLineupEditor event={event} team={team} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 2. Decathlon / Omnithon summary — spec §L.3 item 2 (registration-based,
//    pre-scores planning list — NOT scored results)
// ---------------------------------------------------------------------------

function DecathlonSection({ event, scope }: { event: Event; scope: NationalsDashboardScope }) {
  const db = useDB();
  const regs = scopedActiveRegs(db, event.id, scope);

  const byAthlete = new Map<string, { wag?: boolean; mag?: boolean; tnt?: boolean }>();
  for (const r of regs) {
    if (!isAllAround(r, r.discipline)) continue;
    const entry = byAthlete.get(r.athleteId) ?? {};
    if (r.discipline === 'WAG') entry.wag = true;
    if (r.discipline === 'MAG') entry.mag = true;
    if (r.discipline === 'TNT') entry.tnt = true;
    byAthlete.set(r.athleteId, entry);
  }

  const rows = [...byAthlete.entries()]
    .filter(([, e]) => e.wag && e.mag)
    .map(([athleteId, e]) => ({ athleteId, omnithon: !!e.tnt }));

  return (
    <div style={SECTION_STYLE}>
      <SectionHeading>Decathlon / Omnithon</SectionHeading>
      {rows.length === 0 ? (
        <p style={MUTED_NOTE_STYLE}>No athlete in scope is registered all-around in both WAG and MAG.</p>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13.5 }}>
          {rows.map((row) => (
            <li key={row.athleteId}>
              {nameOf(db, row.athleteId)} — {row.omnithon ? 'Omnithon (WAG + MAG + T&T all-around)' : 'Decathlon (WAG + MAG all-around)'}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 3. Club coach list — spec §L.3 item 3
// ---------------------------------------------------------------------------

function CoachListSection({ event, scope }: { event: Event; scope: NationalsDashboardScope }) {
  const db = useDB();
  const clubId = resolveScopeClubId(db, event, scope);
  const club = clubId ? db.clubs.find((c) => c.id === clubId) : undefined;
  const coaches = clubId ? db.people.filter((p) => p.mainClubId === clubId && p.roles?.coach) : [];

  return (
    <div style={SECTION_STYLE}>
      <SectionHeading>Coaches{club ? ` — ${club.name}` : ''}</SectionHeading>
      {coaches.length === 0 ? (
        <Badge tone="warn">No coaches on file{club ? ` for ${club.name}` : ''}</Badge>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13.5 }}>
          {coaches.map((c) => (
            <li key={c.id}>{c.firstName} {c.lastName}{c.email ? ` — ${c.email}` : ''}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 4. Banquet-ticket gap list — spec §L.3 item 4
// ---------------------------------------------------------------------------

/** Every person id with a paid, non-refunded, ASSIGNED banquet ticket for
 *  `eventId` — scanned across ALL invoices (not just the current scope's own)
 *  since `addonAssigneeId` directly names the ticket-holder regardless of who
 *  paid for it (e.g. a club buying a ticket for one of its athletes). Covers
 *  both the current per-unit `refLineType: 'banquet'` addon lines and the
 *  legacy `kind: 'banquet'` line shape. */
function ticketedPersonIds(db: DB, eventId: string): Set<string> {
  const ids = new Set<string>();
  for (const inv of db.invoices) {
    for (const item of inv.items) {
      if (item.refEventId !== eventId || item.refunded) continue;
      const isBanquet = item.refLineType === 'banquet' || item.kind === 'banquet';
      if (!isBanquet) continue;
      if (item.addonAssigneeId && item.addonAssigneeId !== 'extra') ids.add(item.addonAssigneeId);
    }
  }
  return ids;
}

function BanquetGapSection({ event, scope }: { event: Event; scope: NationalsDashboardScope }) {
  const db = useDB();
  if (!event.banquet) return null;

  const regs = scopedActiveRegs(db, event.id, scope);
  const athleteIds = regs.map((r) => r.athleteId);
  const clubId = resolveScopeClubId(db, event, scope);
  const coachIds = clubId ? db.people.filter((p) => p.mainClubId === clubId && p.roles?.coach).map((p) => p.id) : [];
  const registrantIds = [...new Set([...athleteIds, ...coachIds])];

  const ticketed = ticketedPersonIds(db, event.id);
  const missing = registrantIds.filter((id) => !ticketed.has(id));

  return (
    <div style={SECTION_STYLE}>
      <SectionHeading>Banquet ticket gap</SectionHeading>
      {missing.length === 0 ? (
        <p style={MUTED_NOTE_STYLE}>Everyone in scope has a banquet ticket.</p>
      ) : (
        <>
          <Badge tone="warn">{missing.length} without a ticket</Badge>
          <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 13.5 }}>
            {missing.map((id) => <li key={id}>{nameOf(db, id)}</li>)}
          </ul>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 5. Assigned-sessions table — spec §L.3 item 5
// ---------------------------------------------------------------------------

function AssignedSessionsSection({ event, scope }: { event: Event; scope: NationalsDashboardScope }) {
  const db = useDB();

  // There is no dedicated "session draft" flag in the data model (Event only
  // carries an overall publication `status` plus a freeform `sessions` array)
  // — "once the event's sessions leave draft" is read as: the event itself is
  // published (`status !== 'draft'`) AND at least one session has been
  // created. Flagging this interpretation per the task brief.
  if (event.status === 'draft' || event.sessions.length === 0) return null;

  const regs = scopedActiveRegs(db, event.id, scope);
  const levelIds = [...new Set(regs.map((r) => r.levelId))];
  if (levelIds.length === 0) return null;

  const levelName = (levelId: string) => db.levels.find((l) => l.id === levelId)?.name ?? levelId;
  const rows = levelIds.map((levelId) => {
    const levelRegs = regs.filter((r) => r.levelId === levelId);
    const sessionIds = [...new Set(levelRegs.map((r) => r.sessionId).filter((id): id is string => !!id))];
    const names = sessionIds.map((id) => event.sessions.find((s) => s.id === id)?.name ?? id);
    return { levelId, names, partial: sessionIds.length > 1 };
  });

  return (
    <div>
      <SectionHeading>Assigned sessions</SectionHeading>
      <table className="tbl">
        <thead><tr><th>Level</th><th>Session(s)</th></tr></thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.levelId}>
              <td>{levelName(row.levelId)}</td>
              <td>
                {row.names.length ? row.names.join(', ') : '—'}
                {row.partial ? ' (partial)' : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
