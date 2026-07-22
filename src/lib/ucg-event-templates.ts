// Pure, zero-runtime-deps templates for the two UCG-hosted events (spec
// 2026-07-20 §FlipFest/Nationals model): FlipFest (summer camp) and
// Nationals (championship). Each template is a `Partial<Event>` prefill fed
// into `EventWizard`'s new `template` prop — the admin reviews/adjusts every
// field before saving; nothing here is written to the DB directly.
import { DISCIPLINES } from './types';
import type { DB, Discipline, Event, EventSession, Season } from './types';

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** First Monday on/after `monthIndex`/1 of `year` (UTC, DST-safe). */
function firstMondayOfMonth(year: number, monthIndex: number): Date {
  const d = new Date(Date.UTC(year, monthIndex, 1));
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const diff = (8 - day) % 7; // days until the next Monday (0 if `d` is already Monday)
  d.setUTCDate(d.getUTCDate() + diff);
  return d;
}

/** First weekday `targetDow` (0=Sun..6=Sat) on/after `monthIndex`/`day` of `year`. */
function firstWeekdayOnOrAfter(year: number, monthIndex: number, day: number, targetDow: number): Date {
  const d = new Date(Date.UTC(year, monthIndex, day));
  const diff = (targetDow - d.getUTCDay() + 7) % 7;
  d.setUTCDate(d.getUTCDate() + diff);
  return d;
}

/** FlipFest's default Mon–Fri window: the SECOND full week of August (the
 *  first full Mon–Fri week starting on/after the month's first Monday, plus
 *  one more week) — a prefill only, the admin adjusts before saving. */
export function flipfestDateWindow(year: number): { startDate: string; endDate: string } {
  const firstMonday = firstMondayOfMonth(year, 7); // August = month index 7
  const secondMonday = new Date(firstMonday);
  secondMonday.setUTCDate(firstMonday.getUTCDate() + 7);
  const friday = new Date(secondMonday);
  friday.setUTCDate(secondMonday.getUTCDate() + 4);
  return { startDate: isoDate(secondMonday), endDate: isoDate(friday) };
}

/** Nationals' default Fri–Sun window: the third Friday of April (mid-month) —
 *  a prefill only, the admin adjusts before saving. */
export function nationalsDateWindow(year: number): { startDate: string; endDate: string } {
  const firstFriday = firstWeekdayOnOrAfter(year, 3, 1, 5); // April = month index 3, Friday dow=5
  const thirdFriday = new Date(firstFriday);
  thirdFriday.setUTCDate(firstFriday.getUTCDate() + 14);
  const sunday = new Date(thirdFriday);
  sunday.setUTCDate(thirdFriday.getUTCDate() + 2);
  return { startDate: isoDate(thirdFriday), endDate: isoDate(sunday) };
}

/** The host club to prefill: the `is_league_host`-flagged club, but ONLY when
 *  exactly one exists — with none or several, the admin picks manually.
 *  Exported for `EventWizard`'s UCG-hosted submit-time host-club resolution
 *  (the host club input is hidden for UCG-hosted events, per PM feedback
 *  2026-07-22 — the wizard falls back to this same lookup). */
export function singleLeagueHostClubId(db: DB): string | undefined {
  const hosts = db.clubs.filter((c) => c.isLeagueHost);
  return hosts.length === 1 ? hosts[0].id : undefined;
}

/** FlipFest (NAIGC-hosted summer camp) template for `season` — named for the
 *  calendar year of the season's August, i.e. `season.startsOn`'s year. */
export function flipfestTemplate(season: Season, db: DB): Partial<Event> {
  const year = Number(season.startsOn.slice(0, 4));
  const { startDate, endDate } = flipfestDateWindow(year);
  const hostClubId = singleLeagueHostClubId(db);
  return {
    name: `FlipFest ${year}`,
    eventType: 'camp',
    kind: 'standard',
    ucgHosted: 'flipfest',
    timezone: 'America/Los_Angeles',
    venue: 'FlipFest',
    // Real, fixed FlipFest address (PM feedback 2026-07-22 — the wizard's
    // location inputs are hidden for FlipFest, so these must be baked in).
    streetAddress: '272 Lake Frances Rd',
    city: 'Crossville',
    state: 'TN',
    country: 'United States',
    startDate,
    endDate,
    campConfig: { overnightSurvey: true },
    // All three disciplines by default — the wizard's discipline/session
    // picker is hidden for camps, so this seeds the default sessions the
    // camp registration flow actually reads (EventWizard's `initialSessions`
    // derives sessions from these disciplines the same way Nationals does).
    disciplines: [...DISCIPLINES],
    // Placeholder price/sizes — the admin reviews before saving.
    tshirtAddon: { price: 20, sizes: ['S', 'M', 'L', 'XL'] },
    entryFee: 200,
    ...(hostClubId ? { hostClubId } : {}),
  };
}

/** Nationals (championship) template for `season` — named for the calendar
 *  year of the season's April, i.e. `season.endsOn`'s year. `db` supplies the
 *  single-league-host-club lookup. */
export function nationalsTemplate(season: Season, db: DB): Partial<Event> {
  const year = Number(season.endsOn.slice(0, 4));
  const { startDate, endDate } = nationalsDateWindow(year);
  const hostClubId = singleLeagueHostClubId(db);
  return {
    name: `UCG Nationals ${year}`,
    kind: 'nationals',
    eventType: 'competition',
    ucgHosted: 'nationals',
    timezone: 'America/Los_Angeles',
    disciplines: [...DISCIPLINES],
    startDate,
    endDate,
    ...(hostClubId ? { hostClubId } : {}),
  };
}

// ---- Nationals sessions × gyms (PM feedback 2026-07-22, create-mode only) ----
// Nationals runs every discipline at every session, split across gyms — each
// gym holds one discipline's level group. `EventWizard` collects the two
// lists below and this pure builder cross-products them into the
// `EventSession[]` the rest of the app actually understands. Extracted here
// (not in the component) so the cross-product/naming/level-propagation logic
// is independently unit-testable.

export interface NationalsSessionSlot {
  /** Auto-assigned "Session 1"/"Session 2"/… — not user-editable text. */
  name: string;
  date: string;
  time: string;
}

export interface NationalsGym {
  name: string;
  discipline: Discipline;
  levelIds: string[];
}

const disciplineLabel = (d: Discipline) => (d === 'TNT' ? 'T&T' : d);

/** Cross product of session slots × gyms → one `EventSession` per (slot, gym)
 *  pair, e.g. `"Session 2 — Orange (MAG)"`. All Nationals-create sessions are
 *  `phase: 'prelim'` — finals sessions aren't part of this create-time model
 *  (finals lineups/scheduling live on the event's own admin surfaces). */
export function buildNationalsSessions(
  slots: NationalsSessionSlot[],
  gyms: NationalsGym[],
  eventId: string,
): EventSession[] {
  const out: EventSession[] = [];
  let i = 0;
  for (const slot of slots) {
    for (const gym of gyms) {
      i++;
      out.push({
        id: `${eventId}-s${i}`,
        name: `${slot.name} — ${gym.name} (${disciplineLabel(gym.discipline)})`,
        discipline: gym.discipline,
        date: slot.date,
        time: slot.time,
        levelIds: gym.levelIds,
        squads: [],
        phase: 'prelim',
      });
    }
  }
  return out;
}

/** A season's existing FlipFest/Nationals instance: the event with matching
 *  `ucgHosted` whose `startDate` falls in the season's [startsOn, endsOn]
 *  window. Enforced softly — the Seasons table only offers "Create" when this
 *  returns undefined, "Edit" otherwise; nothing stops two instances existing. */
export function findUcgEvent(db: DB, season: Season, which: 'flipfest' | 'nationals'): Event | undefined {
  return db.events.find(
    (e) => e.ucgHosted === which && e.startDate >= season.startsOn && e.startDate <= season.endsOn,
  );
}
