import type {
  DB, Athlete, Club, Level, Event, Registration, Score, Season, Discipline, Invoice,
  WaiverDocument,
} from './types';
import { APPARATUS, STATE_REGIONS, GENERAL_WAIVER_TYPE } from './types';
import { DEFAULT_WAIVER_HTML, DEFAULT_WAIVER_HASH } from './waiver-default';

// Deterministic PRNG so every visitor sees the same demo data
let _s = 42;
const rnd = () => ((_s = (_s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = <T,>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)];
const round = (n: number, d = 3) => Math.round(n * 10 ** d) / 10 ** d;

const FIRST = ['Avery', 'Jordan', 'Riley', 'Maya', 'Ethan', 'Sofia', 'Liam', 'Zoe', 'Noah', 'Chloe',
  'Owen', 'Priya', 'Lucas', 'Nina', 'Caleb', 'Tessa', 'Diego', 'Hannah', 'Marcus', 'Lily',
  'Jonah', 'Grace', 'Felix', 'Ruby', 'Aiden', 'Sasha', 'Tyler', 'Emma', 'Devon', 'Kira',
  'Sam', 'Jade', 'Cole', 'Mira', 'Reese', 'Anya', 'Quinn', 'Leah', 'Brett', 'Dana',
  'Theo', 'Iris', 'Wes', 'Nora', 'Jude', 'Skye', 'Drew', 'Faye', 'Kai', 'Wren'];
const LAST = ['Chen', 'Patel', 'Garcia', 'Kim', 'Nguyen', 'Brooks', 'Rivera', 'Tanaka', 'Olsen', 'Murphy',
  'Silva', 'Khan', 'Wright', 'Park', 'Diaz', 'Foster', 'Romano', 'Webb', 'Hayes', 'Cruz',
  'Bauer', 'Singh', 'Wolfe', 'Reyes', 'Dunn', 'Mori', 'Lane', 'Vega', 'Holt', 'Frost'];

export function buildSeed(): DB {
  const seasons: Season[] = [
    { id: 's25', name: '2024–25', startsOn: '2024-07-01', endsOn: '2025-06-30', athleteFee: 35, coachFee: 20, clubFee: 100, active: false, current: false },
    { id: 's26', name: '2025–26', startsOn: '2025-07-01', endsOn: '2026-06-30', athleteFee: 35, coachFee: 20, clubFee: 109, active: true, current: true },
    { id: 's27', name: '2026–27', startsOn: '2026-07-01', endsOn: '2027-06-30', athleteFee: 40, coachFee: 20, clubFee: 109, active: true, current: false },
  ];

  const levels: Level[] = [
    { id: 'wag-silver', discipline: 'WAG', name: 'Xcel Silver', svMax: 10.0, vaults: 2, order: 1 },
    { id: 'wag-plat', discipline: 'WAG', name: 'Xcel Platinum', svMax: 10.0, vaults: 2, order: 2 },
    { id: 'wag-diamond', discipline: 'WAG', name: 'Xcel Diamond', svMax: 10.0, vaults: 2, order: 3 },
    { id: 'wag-l9', discipline: 'WAG', name: 'Level 9', svMax: 10.1, vaults: 2, order: 4 },
    { id: 'wag-open', discipline: 'WAG', name: 'Open Scoring', svMax: null, vaults: 2, order: 5 },
    { id: 'wag-masters', discipline: 'WAG', name: 'Masters', svMax: null, vaults: 2, order: 6 },
    { id: 'mag-dev', discipline: 'MAG', name: 'Developmental', svMax: 12.7, vaults: 1, order: 1 },
    { id: 'mag-int', discipline: 'MAG', name: 'Intermediate', svMax: 13.2, vaults: 1, order: 2 },
    { id: 'mag-adv', discipline: 'MAG', name: 'Advanced', svMax: null, vaults: 1, order: 3 },
    { id: 'mag-masters', discipline: 'MAG', name: 'Masters', svMax: null, vaults: 1, order: 4 },
    { id: 'tnt-new', discipline: 'TNT', name: 'New Flyers', svMax: null, vaults: 1, order: 1 },
    { id: 'tnt-int', discipline: 'TNT', name: 'Intermediate Flyers', svMax: null, vaults: 1, order: 2 },
    { id: 'tnt-high', discipline: 'TNT', name: 'High Flyers', svMax: null, vaults: 1, order: 3 },
  ];

  const clubDefs: [string, string, string][] = [
    ['University of Minnesota Gymnastics Club', 'Minnesota', 'Minnesota'],
    ['South Carolina Gymnastics Club', 'Gamecocks', 'South Carolina'],
    ['Texas A&M Club Gymnastics', 'Texas A&M', 'Texas'],
    ['Boston Community Gymnastics', 'Boston', 'Massachusetts'],
    ['Golden Bear Gymnastics', 'Cal', 'California'],
    ['Ohio State Club Gymnastics', 'Ohio State', 'Ohio'],
    ['Capital City Flyers', 'Cap City', 'District of Columbia'],
    ['Georgia Tech Gymkana', 'GT', 'Georgia'],
  ];

  const clubs: Club[] = clubDefs.map(([name, shortName, state], i) => ({
    id: `club-${i + 1}`,
    name, shortName, state,
    region: STATE_REGIONS[state] ?? 'Other',
    managerIds: [],
    email: `${shortName.toLowerCase().replace(/[^a-z]/g, '')}@clubs.ucg.org`,
    allowClubPay: i % 3 !== 2,
    access: 'open',
  }));

  const people: Athlete[] = [];
  let pid = 0;
  const mkPerson = (kind: 'athlete' | 'coach', clubIdx: number, disciplines: Discipline[]): Athlete => {
    pid += 1;
    const firstName = FIRST[pid % FIRST.length];
    const lastName = LAST[(pid * 7) % LAST.length];
    const club = clubs[clubIdx];
    const gender: Athlete['gender'] = disciplines.includes('WAG') && rnd() < 0.85 ? 'Female'
      : disciplines.includes('MAG') && rnd() < 0.85 ? 'Male'
      : pick(['Male', 'Female', 'Non-binary']);
    const lv: Athlete['levels'] = {};
    for (const d of disciplines) {
      const opts = levels.filter((l) => l.discipline === d);
      lv[d] = pick(opts).id;
    }
    const hasMembership = rnd() < 0.82;
    const pendingClub = !hasMembership && rnd() < 0.4;
    return {
      id: `p-${pid}`,
      kind,
      roles: { athlete: kind !== 'coach', coach: kind === 'coach' },
      firstName, lastName,
      email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}${pid}@example.com`,
      dob: `${kind === 'coach' ? 1985 + (pid % 12) : 1998 + (pid % 9)}-0${1 + (pid % 9)}-1${pid % 9}`,
      gender,
      placement: gender !== 'Male' && gender !== 'Female' ? { WAG: 'women+', MAG: 'men+' } : undefined,
      gradYear: rnd() < 0.15 ? 1900 : 2020 + (pid % 9),
      studentStatus: rnd() < 0.6 ? 'Student' : 'Non-Student',
      shirt: pick(['Adult S', 'Adult M', 'Adult L', 'Adult XL']),
      country: 'United States',
      state: club.state,
      phone: `(${200 + (pid % 700)}) 555-0${100 + (pid % 900)}`,
      mainClubId: club.id,
      altClubIds: rnd() < 0.15 ? [clubs[(clubIdx + 1) % clubs.length].id] : [],
      levels: lv,
      emergency: { contact: `${pick(FIRST)} ${lastName}`, relation: pick(['Parent', 'Sibling', 'Partner', 'Friend']), phone: '(612) 555-0199' },
      dietary: rnd() < 0.25 ? [pick(['Vegetarian', 'Vegan', 'Gluten-free', 'Peanut Allergy'])] : [],
      dietaryNotes: '',
      memberships: hasMembership
        ? [{ seasonId: 's26', type: 'athlete', status: 'active', waiverSignedAt: '2025-08-1' + (pid % 9) + 'T12:00:00Z', waiverSignedBy: `${firstName} ${lastName}`, paidVia: rnd() < 0.6 ? 'card' : 'club' }]
        : pendingClub
          ? [{ seasonId: 's26', type: 'athlete', status: 'pending-club-payment', waiverSignedAt: '2025-09-01T12:00:00Z', waiverSignedBy: `${firstName} ${lastName}`, paidVia: null }]
          : [],
      achievements: rnd() < 0.3 ? [pick(['First kip', 'Giants', 'Salto on floor', 'Placed at Nationals', 'Omnithon finisher'])] : [],
    };
  };

  // ~9 athletes + 1-2 coaches per club
  clubs.forEach((club, ci) => {
    const n = 7 + Math.floor(rnd() * 5);
    for (let i = 0; i < n; i++) {
      const dRoll = rnd();
      const ds: Discipline[] = dRoll < 0.42 ? ['WAG'] : dRoll < 0.78 ? ['MAG'] : dRoll < 0.9 ? ['TNT'] : ['WAG', 'TNT'];
      people.push(mkPerson('athlete', ci, ds));
    }
    const coach = mkPerson('coach', ci, []);
    people.push(coach);
    club.managerIds.push(coach.id);
  });

  // Name the personas we feature in the role switcher
  people[0].firstName = 'Maya'; people[0].lastName = 'Okafor'; people[0].kind = 'athlete';
  people[0].levels = { WAG: 'wag-plat' };
  people[0].memberships = [{ seasonId: 's26', type: 'athlete', status: 'active', waiverSignedAt: '2025-08-02T12:00:00Z', waiverSignedBy: 'Maya Okafor', paidVia: 'card' }];

  // ---- Events ----
  const tz = 'America/Chicago';
  const mkSessions = (eventId: string): Event['sessions'] => [
    { id: `${eventId}-s1`, name: 'Session 1 — WAG Xcel Silver & Platinum', discipline: 'WAG', date: '2026-04-10', time: '09:00', levelIds: ['wag-silver', 'wag-plat'], squads: [] },
    { id: `${eventId}-s2`, name: 'Session 2 — WAG Diamond / L9 / Open', discipline: 'WAG', date: '2026-04-10', time: '14:00', levelIds: ['wag-diamond', 'wag-l9', 'wag-open'], squads: [] },
    { id: `${eventId}-s3`, name: 'Session 3 — MAG All Levels', discipline: 'MAG', date: '2026-04-11', time: '09:00', levelIds: ['mag-dev', 'mag-int', 'mag-adv', 'mag-masters'], squads: [] },
    { id: `${eventId}-s4`, name: 'Session 4 — T&T All Flights', discipline: 'TNT', date: '2026-04-11', time: '15:00', levelIds: ['tnt-new', 'tnt-int', 'tnt-high'], squads: [] },
  ];

  const events: Event[] = [
    {
      id: 'meet-nat26', slug: 'ucg-nationals-2026', name: 'UCG Nationals 2026',
      hostClubId: 'club-1', city: 'Minneapolis', state: 'Minnesota', timezone: tz,
      startDate: '2026-07-09', endDate: '2026-07-11', status: 'live',
      regOpens: '2026-04-15T12:00', regCloses: '2026-06-24T23:59',
      entryFee: 95, secondDisciplineFee: 45,
      tshirtAddon: { price: 15, sizes: ['Adult S', 'Adult M', 'Adult L', 'Adult XL'] },
      disciplines: ['MAG', 'WAG', 'TNT'],
      sessions: [
        { id: 'nat26-s1', name: 'Session 1 — WAG Xcel Silver', discipline: 'WAG', date: '2026-07-09', time: '09:00', levelIds: ['wag-silver'], squads: [] },
        { id: 'nat26-s2', name: 'Session 2 — WAG Xcel Platinum', discipline: 'WAG', date: '2026-07-09', time: '14:00', levelIds: ['wag-plat'], squads: [] },
        { id: 'nat26-s3', name: 'Session 3 — WAG Diamond / L9 / Open', discipline: 'WAG', date: '2026-07-10', time: '09:00', levelIds: ['wag-diamond', 'wag-l9', 'wag-open'], squads: [] },
        { id: 'nat26-s4', name: 'Session 4 — MAG Dev & Intermediate', discipline: 'MAG', date: '2026-07-10', time: '14:00', levelIds: ['mag-dev', 'mag-int'], squads: [] },
        { id: 'nat26-s5', name: 'Session 5 — MAG Advanced & Masters', discipline: 'MAG', date: '2026-07-11', time: '09:00', levelIds: ['mag-adv', 'mag-masters'], squads: [] },
        { id: 'nat26-s6', name: 'Session 6 — T&T All Flights', discipline: 'TNT', date: '2026-07-11', time: '14:00', levelIds: ['tnt-new', 'tnt-int', 'tnt-high'], squads: [] },
      ],
      banquet: { price: 45, name: 'Nationals Banquet' },
    },
    {
      id: 'meet-mw26', slug: 'midwest-regional-2026', name: 'Midwest Regional Championship',
      hostClubId: 'club-6', city: 'Columbus', state: 'Ohio', timezone: 'America/New_York',
      startDate: '2026-04-10', endDate: '2026-04-11', status: 'live',
      regOpens: '2026-02-01T12:00', regCloses: '2026-03-27T23:59',
      entryFee: 60, secondDisciplineFee: 30,
      disciplines: ['MAG', 'WAG', 'TNT'],
      sessions: mkSessions('mw26'),
    },
    {
      id: 'meet-ne25', slug: 'northeast-open-2025', name: 'Northeast Open 2025',
      hostClubId: 'club-4', city: 'Boston', state: 'Massachusetts', timezone: 'America/New_York',
      startDate: '2025-11-15', endDate: '2025-11-15', status: 'live',
      regOpens: '2025-09-01T12:00', regCloses: '2025-11-01T23:59',
      entryFee: 55, secondDisciplineFee: 25,
      disciplines: ['MAG', 'WAG'],
      sessions: mkSessions('ne25').slice(0, 3),
    },
  ];

  // ---- Registrations ----
  const registrations: Registration[] = [];
  let rid = 0;
  const register = (event: Event, a: Athlete, intoSquads: boolean) => {
    for (const d of Object.keys(a.levels) as Discipline[]) {
      if (!event.disciplines.includes(d)) continue;
      const levelId = a.levels[d]!;
      const session = event.sessions.find((s) => s.discipline === d && s.levelIds.includes(levelId))
        ?? event.sessions.find((s) => s.discipline === d);
      if (!session) continue;
      rid += 1;
      const evts = APPARATUS[d].map((e) => e.code).filter(() => rnd() < 0.92);
      registrations.push({
        id: `reg-${rid}`,
        eventId: event.id, athleteId: a.id, clubId: a.mainClubId!,
        discipline: d, levelId,
        apparatus: evts.length ? evts : [APPARATUS[d][0].code],
        sessionId: session.id,
      });
      if (intoSquads) {
        let sq = session.squads.find((q) => !q.holding && q.athleteRegIds.length < 8);
        if (!sq) {
          sq = { id: `${session.id}-q${session.squads.length + 1}`, name: `Squad ${String.fromCharCode(65 + session.squads.length)}`, startEvent: session.squads.length % APPARATUS[d].length, athleteRegIds: [] };
          session.squads.push(sq);
        }
        sq.athleteRegIds.push(`reg-${rid}`);
      }
    }
  };

  const members = people.filter((p) => p.kind === 'athlete' && p.memberships.some((m) => m.seasonId === 's26' && m.status === 'active'));
  members.forEach((a, i) => {
    if (i % 3 !== 2) register(events[0], a, false); // Nationals: open reg, no squads yet
    register(events[1], a, true); // Midwest regional: squadded, in progress
    if (i % 2 === 0) register(events[2], a, true); // Past event
  });

  // ---- Scores ----
  const scores: Score[] = [];
  const scoreEvent = (event: Event, complete: boolean) => {
    for (const session of event.sessions) {
      for (const sq of session.squads) {
        for (const regId of sq.athleteRegIds) {
          const reg = registrations.find((r) => r.id === regId)!;
          const level = levels.find((l) => l.id === reg.levelId)!;
          for (const ev of reg.apparatus) {
            if (!complete && rnd() < 0.45) continue; // in-progress: partial scores
            const svCap = level.svMax ?? 14.0;
            const sv = round(Math.min(svCap, svCap - rnd() * 1.6), 1);
            const ded = round(0.7 + rnd() * 1.9, 3);
            scores.push({
              id: `${event.id}|${regId}|${ev}`,
              eventId: event.id, sessionId: session.id, regId, apparatus: ev,
              sv, deductions: ded, final: round(Math.max(0, sv - ded)),
              enteredBy: 'judge-demo', enteredAt: new Date().toISOString(), flashed: true,
            });
          }
        }
      }
    }
  };
  scoreEvent(events[2], true);
  scoreEvent(events[1], false);

  // ---- Invoices ----
  const invoices: Invoice[] = [];
  let inv = 0;
  for (const p of members.slice(0, 14)) {
    inv += 1;
    invoices.push({
      id: `inv-${inv}`, number: `UCG-2026-${String(inv).padStart(4, '0')}`,
      clubId: p.memberships[0].paidVia === 'club' ? p.mainClubId : null,
      athleteId: p.memberships[0].paidVia === 'club' ? null : p.id,
      createdAt: '2025-08-15T12:00:00Z', paidAt: '2025-08-15T12:01:00Z',
      items: [{ id: `ii-${inv}`, label: `Athlete membership 2025–26 — ${p.firstName} ${p.lastName}`, amount: 35, kind: 'membership', refUserId: p.id }],
    });
  }

  // A single waiver covers all members; seeded from the official NAIGC waiver HTML.
  const waiverDocuments: WaiverDocument[] = [{
    id: 'seed-waiver-general',
    seasonId: 's26',
    waiverType: GENERAL_WAIVER_TYPE,
    version: 1,
    body: DEFAULT_WAIVER_HTML,
    contentHash: DEFAULT_WAIVER_HASH,
    published: true,
    createdAt: new Date().toISOString(),
  }];

  return {
    seasons, levels, clubs, people, events, registrations, scores, invoices,
    waiverDocuments,
    waiverSignatures: [],
    coupons: [
      { code: 'EARLYBIRD', pctOff: 10, appliesTo: 'meet-entry' },
      { code: 'NEWCLUB26', amountOff: 10, appliesTo: 'membership' },
    ],
    carts: {},
    clubRequests: [],
  };
}
