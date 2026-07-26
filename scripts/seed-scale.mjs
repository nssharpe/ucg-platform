#!/usr/bin/env node
// Scale-seed harness (Phase 1 of docs/specs/2026-07-24-data-layer-scale.md).
//
// Generates a realistic ~2-year-projection volume of data (see the spec's
// "Projected volume" table) into STAGING ONLY, so the current data layer —
// and later the slice-layer refactor — can be measured and tested against
// real volume instead of prod's current few-thousand-row reality.
//
// Usage:
//   node scripts/seed-scale.mjs                 # seed the default 2-year projection
//   node scripts/seed-scale.mjs --scale 0.1      # seed 10% volume (fast smoke run)
//   node scripts/seed-scale.mjs --scale 2        # seed 2x the projection
//   node scripts/seed-scale.mjs --clean          # remove every row this script ever generated
//
// ---------------------------------------------------------------------------
// SAFETY — this is the most important part of this file.
// ---------------------------------------------------------------------------
// It must be structurally impossible to point this at production:
//   - The target project is ALWAYS read from STAGING_SUPABASE_URL /
//     STAGING_SUPABASE_SERVICE_ROLE_KEY in .env.local. There is no --url or
//     --project-ref flag, and none should ever be added — a CLI override is
//     exactly the footgun this guards against.
//   - Before constructing a Supabase client (i.e. before any possible
//     network call), the URL is checked: it must contain the STAGING project
//     ref (xogpiksqtkayxwmczlbx) and must NOT contain the PROD ref
//     (wkyerxlgricfphopocoz). Either check failing aborts immediately.
//   - Every row this script writes gets a distinctive, greppable tag so
//     `--clean` can remove EXACTLY what was generated and nothing else —
//     never the real seeded staging fixtures (dev-club, Dev Athlete/Manager/
//     Admin, the demo seed pushed via Admin → Demo tools; see
//     supabase/README.md "Staging project"). Ids are app-generated TEXT
//     everywhere except `payments.id` (the lone uuid PK in the schema, per
//     CLAUDE.md) — so every generated row's own `id` is prefixed `scale-`,
//     EXCEPT payments, which is tagged via `stripe_session_id`/
//     `stripe_payment_intent_id` (also prefixed `scale-`) instead, since its
//     `id` can't carry a text prefix. `--clean` filters on the right column
//     per table.
//
// ---------------------------------------------------------------------------
// Schema notes (read the *ToRow mappers in src/lib/supabase.ts and the
// migrations before changing this file — do not guess column names):
// ---------------------------------------------------------------------------
//   - registrations.camp_survey has SELECT revoked from anon/authenticated
//     (migration 20260717205348) — this script never selects it back, and
//     since these are ordinary (non-camp) registrations it's simply omitted
//     from every insert (nullable, defaults to null).
//   - registrations/scores/etc. ids are deterministic (index-based), and
//     every insert here is an `upsert` on the table's `id` PK — so re-running
//     the same `--scale` twice is idempotent for every text-id table.
//     `payments` is the one exception: it's a plain `insert` (its uuid `id`
//     is freshly randomized every run), so re-running without `--clean` in
//     between adds MORE payment rows rather than replacing them.
//
// This is a plain Node script (not compiled through Vite), so it talks to
// Supabase directly via @supabase/supabase-js rather than importing
// src/lib/supabase.ts (which touches `import.meta.env`, undefined outside
// Vite) — schema constants below are a deliberately small, self-contained
// copy, not an import of src/lib/types.ts.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STAGING_REF = 'xogpiksqtkayxwmczlbx';
const PROD_REF = 'wkyerxlgricfphopocoz';
const TAG = 'scale-';

// ---------------------------------------------------------------------------
// Env + SAFETY GUARD (before any client is constructed, before any network call)
// ---------------------------------------------------------------------------
function loadEnvLocal() {
  const path = join(ROOT, '.env.local');
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    console.error(`Missing ${path} — this script needs STAGING_SUPABASE_URL / STAGING_SUPABASE_SERVICE_ROLE_KEY there.`);
    process.exit(1);
  }
  return Object.fromEntries(
    text
      .split(/\r?\n/)
      .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
      .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
  );
}

const env = loadEnvLocal();
const SUPABASE_URL = env.STAGING_SUPABASE_URL;
const SERVICE_ROLE_KEY = env.STAGING_SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Missing STAGING_SUPABASE_URL / STAGING_SUPABASE_SERVICE_ROLE_KEY in .env.local — aborting before any connection.');
  process.exit(1);
}
if (SUPABASE_URL.includes(PROD_REF)) {
  console.error(`REFUSING TO RUN: STAGING_SUPABASE_URL contains the PRODUCTION project ref (${PROD_REF}).`);
  console.error('This script must NEVER touch production. Aborting before any connection is made.');
  process.exit(1);
}
if (!SUPABASE_URL.includes(STAGING_REF)) {
  console.error(`REFUSING TO RUN: STAGING_SUPABASE_URL does not contain the expected staging project ref (${STAGING_REF}).`);
  console.error(`Got: ${SUPABASE_URL}`);
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log([
    'Usage:',
    '  node scripts/seed-scale.mjs                 seed the default 2-year projection (staging only)',
    '  node scripts/seed-scale.mjs --scale 0.1      seed 10% volume (fast smoke run)',
    '  node scripts/seed-scale.mjs --scale 2        seed 2x the projection',
    '  node scripts/seed-scale.mjs --clean          remove every row this script ever generated',
  ].join('\n'));
  process.exit(0);
}
const CLEAN = args.includes('--clean');
const scaleIdx = args.indexOf('--scale');
const SCALE = scaleIdx >= 0 ? Number(args[scaleIdx + 1]) : 1;
if (!Number.isFinite(SCALE) || SCALE <= 0) {
  console.error('--scale must be a positive number');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Small local schema constants (kept independent of src/ — see header)
// ---------------------------------------------------------------------------
const APPARATUS = {
  MAG: ['FX', 'PH', 'SR', 'VT', 'PB', 'HB'],
  WAG: ['VT', 'UB', 'BB', 'FX'],
  TNT: ['TR', 'DM', 'TU', 'SY'],
};
const FIRST_NAMES = [
  'Emma', 'Olivia', 'Ava', 'Sophia', 'Isabella', 'Mia', 'Amelia', 'Harper', 'Evelyn', 'Abigail',
  'Liam', 'Noah', 'Oliver', 'Elijah', 'James', 'William', 'Benjamin', 'Lucas', 'Henry', 'Alexander',
  'Maya', 'Jordan', 'Riley', 'Casey', 'Avery', 'Skylar', 'Cameron', 'Peyton', 'Quinn', 'Rowan',
];
const LAST_NAMES = [
  'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez',
  'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson', 'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin',
  'Lee', 'Perez', 'Thompson', 'White', 'Harris', 'Sanchez', 'Clark', 'Ramirez', 'Lewis', 'Robinson',
];
const STATES = [
  ['MN', 'Midwest'], ['OH', 'Midwest'], ['WI', 'Midwest'], ['IL', 'Midwest'], ['MI', 'Midwest'],
  ['NY', 'Northeast'], ['MA', 'Northeast'], ['PA', 'Mid-Atlantic'], ['NJ', 'Mid-Atlantic'],
  ['GA', 'Southeast'], ['FL', 'Southeast'], ['NC', 'Southeast'],
  ['TX', 'South Central'], ['OK', 'South Central'],
  ['CA', 'West'], ['WA', 'West'], ['CO', 'West'], ['AZ', 'West'],
];

// ---------------------------------------------------------------------------
// Random helpers
// ---------------------------------------------------------------------------
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const randInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));
const randFloat = (min, max) => min + Math.random() * (max - min);
const round2 = (n) => Math.round(n * 100) / 100;
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function randomDateBetween(startIso, endIso) {
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return new Date(startIso).toISOString();
  return new Date(start + Math.random() * (end - start)).toISOString();
}

// ---------------------------------------------------------------------------
// Volume targets — the 2-year projection from the spec's table, scaled by --scale.
// ---------------------------------------------------------------------------
function targets(scale) {
  return {
    clubs: Math.max(10, Math.round(60 * scale)),
    people: Math.max(20, Math.round(6000 * scale)),
    events: Math.max(4, Math.round(80 * scale)),
    sessionsPerEvent: 3,
    registrations: Math.max(20, Math.round(50000 * scale)),
    scores: Math.max(20, Math.round(175000 * scale)),
    memberships: Math.max(10, Math.round(11000 * scale)),
    invoices: Math.max(10, Math.round(18000 * scale)),
    invoiceItems: Math.max(10, Math.round(25000 * scale)),
    payments: Math.max(10, Math.round(18000 * scale)),
  };
}

// ---------------------------------------------------------------------------
// Batched writes (PostgREST won't accept the full row set in one call)
// ---------------------------------------------------------------------------
const BATCH = 1000;
async function upsertBatched(table, rows, label) {
  let done = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const part = rows.slice(i, i + BATCH);
    const { error } = await supabase.from(table).upsert(part);
    if (error) throw new Error(`[${table}] upsert failed at row ${i}: ${error.message}`);
    done += part.length;
    process.stdout.write(`\r[seed-scale] ${label}: ${done}/${rows.length}   `);
  }
  console.log('');
}
async function insertBatched(table, rows, label) {
  let done = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const part = rows.slice(i, i + BATCH);
    const { error } = await supabase.from(table).insert(part);
    if (error) throw new Error(`[${table}] insert failed at row ${i}: ${error.message}`);
    done += part.length;
    process.stdout.write(`\r[seed-scale] ${label}: ${done}/${rows.length}   `);
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// Row generators
// ---------------------------------------------------------------------------
function genClubs(n) {
  const clubs = [];
  for (let i = 1; i <= n; i++) {
    const [state, region] = pick(STATES);
    clubs.push({
      id: `${TAG}club-${i}`,
      name: `Scale Test Gymnastics Club ${i}`,
      short_name: `STGC${i}`,
      state,
      region,
      email: `scale-club-${i}@example.invalid`,
      allow_club_pay: Math.random() < 0.6,
      access: 'open',
    });
  }
  return clubs;
}

function genPeople(n, clubs) {
  const people = [];
  for (let i = 1; i <= n; i++) {
    const club = clubs[i % clubs.length];
    const isCoach = Math.random() < 0.08;
    const gradYear = randInt(2025, 2029);
    const birthYear = gradYear - randInt(18, 22);
    people.push({
      id: `${TAG}person-${i}`,
      kind: isCoach ? 'coach' : 'athlete',
      roles: { athlete: !isCoach, coach: isCoach },
      first_name: pick(FIRST_NAMES),
      last_name: pick(LAST_NAMES),
      email: `scale-person-${i}@example.invalid`,
      dob: `${birthYear}-0${randInt(1, 9)}-1${randInt(0, 9)}`,
      gender: pick(['Male', 'Female']),
      placement: {},
      grad_year: gradYear,
      student_status: 'Student',
      shirt: pick(['XS', 'S', 'M', 'L', 'XL']),
      country: 'USA',
      state: club.state,
      outside_us: false,
      phone: null,
      sms_consent: true,
      sms_consent_at: null,
      main_club_id: club.id,
      levels: {},
      emergency: {},
      dietary: [],
      dietary_notes: '',
      achievements: [],
    });
  }
  return people;
}

function genEvents(n, clubs, now) {
  const events = [];
  const twoYearsAgo = new Date(now);
  twoYearsAgo.setFullYear(now.getFullYear() - 2);
  for (let i = 1; i <= n; i++) {
    const host = Math.random() < 0.85 ? pick(clubs) : null;
    const startDate = new Date(randomDateBetween(twoYearsAgo.toISOString(), now.toISOString()));
    const endDate = new Date(startDate.getTime() + 2 * 86400000);
    const disciplines = pick([['MAG'], ['WAG'], ['MAG', 'WAG'], ['TNT']]);
    events.push({
      id: `${TAG}event-${i}`,
      slug: `${TAG}event-${i}`,
      name: `Scale Test Meet ${i}`,
      host_club_id: host ? host.id : null,
      city: 'Testville',
      state: host ? host.state : 'MN',
      timezone: 'America/Chicago',
      start_date: startDate.toISOString().slice(0, 10),
      end_date: endDate.toISOString().slice(0, 10),
      status: 'complete',
      reg_opens: new Date(startDate.getTime() - 60 * 86400000).toISOString(),
      reg_closes: new Date(startDate.getTime() - 3 * 86400000).toISOString(),
      last_date_to_edit: new Date(startDate.getTime() - 5 * 86400000).toISOString(),
      entry_fee: 65,
      second_discipline_fee: 25,
      disciplines,
      event_type: 'competition',
      kind: 'standard',
    });
  }
  return events;
}

function genSessions(events, perEvent) {
  const sessions = [];
  let n = 0;
  for (const ev of events) {
    for (let s = 1; s <= perEvent; s++) {
      n++;
      sessions.push({
        id: `${TAG}session-${n}`,
        event_id: ev.id,
        name: `Session ${s}`,
        discipline: pick(ev.disciplines.length ? ev.disciplines : ['MAG']),
        date: ev.start_date,
        time: `${String(8 + s).padStart(2, '0')}:00`,
        level_ids: [],
        sort_order: s,
      });
    }
  }
  return sessions;
}

function genRegistrations(count, events, sessionsByEvent, athletes, levelsByDiscipline) {
  const regs = [];
  for (let i = 1; i <= count; i++) {
    const ev = events[randInt(0, events.length - 1)];
    const discipline = pick(ev.disciplines.length ? ev.disciplines : ['MAG']);
    const athlete = athletes[randInt(0, athletes.length - 1)];
    const evSessions = (sessionsByEvent[ev.id] || []).filter((s) => s.discipline === discipline);
    const session = evSessions.length ? pick(evSessions) : null;
    const levelChoices = levelsByDiscipline[discipline] || [];
    const level = levelChoices.length ? pick(levelChoices) : null;
    const apparatusPool = APPARATUS[discipline] || APPARATUS.MAG;
    const apparatusCount = discipline === 'WAG' ? apparatusPool.length : randInt(2, apparatusPool.length);
    const apparatus = shuffle(apparatusPool).slice(0, apparatusCount);
    regs.push({
      id: `${TAG}reg-${i}`,
      event_id: ev.id,
      athlete_id: athlete.id,
      club_id: athlete.main_club_id,
      discipline,
      level_id: level ? level.id : null,
      apparatus,
      apparatus_levels: null,
      session_id: session ? session.id : null,
      squad_id: null,
      refunded: false,
      refund_requested: false,
      keep_listed: false,
      partner_athlete_id: null,
      paid: Math.random() < 0.9,
      updated_pending: false,
      created_at: randomDateBetween(ev.reg_opens, ev.reg_closes ?? ev.start_date),
    });
  }
  return regs;
}

function genScores(regs, target) {
  const scores = [];
  let n = 0;
  for (const reg of regs) {
    if (n >= target) break;
    for (const code of reg.apparatus) {
      if (n >= target) break;
      n++;
      const sv = round2(randFloat(9, 14));
      const deductions = round2(randFloat(0.5, 3));
      scores.push({
        id: `${TAG}score-${n}`,
        event_id: reg.event_id,
        session_id: reg.session_id,
        reg_id: reg.id,
        apparatus: code,
        sv,
        deductions,
        e_score: null,
        final: round2(sv - deductions),
        source: 'manual',
        entered_by: 'scale-seed',
        entered_at: reg.created_at,
        flashed: false,
        scratched: false,
      });
    }
  }
  return scores;
}

function genMemberships(count, people, seasons) {
  const memberships = [];
  if (!seasons.length) return memberships;
  const seen = new Set();
  let guard = 0;
  const guardLimit = count * 20;
  while (memberships.length < count && guard < guardLimit) {
    guard++;
    const person = people[randInt(0, people.length - 1)];
    const season = seasons[randInt(0, seasons.length - 1)];
    const type = person.kind === 'coach' ? 'coach' : 'athlete';
    const key = `${person.id}|${season.id}|${type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    memberships.push({
      id: `${TAG}membership:${person.id}:${season.id}:${type}`,
      person_id: person.id,
      season_id: season.id,
      type,
      status: pick(['active', 'active', 'active', 'pending-club-payment', 'none']),
      waiver_signed_at: new Date().toISOString(),
      waiver_signed_by: person.id,
      paid_via: 'card',
      activated_by_admin: false,
      club_cart_pending: false,
    });
  }
  return memberships;
}

function genInvoices(count, people, clubs, from, to) {
  const invoices = [];
  for (let i = 1; i <= count; i++) {
    const selfPay = Math.random() < 0.7;
    const person = pick(people);
    const createdAt = randomDateBetween(from.toISOString(), to.toISOString());
    const paid = Math.random() < 0.92;
    invoices.push({
      id: `${TAG}invoice-${i}`,
      number: `SCALE-${i}`,
      club_id: selfPay ? null : pick(clubs).id,
      athlete_id: selfPay ? person.id : null,
      coupon_code: null,
      created_at: createdAt,
      paid_at: paid ? new Date(new Date(createdAt).getTime() + randInt(0, 3) * 86400000).toISOString() : null,
    });
  }
  return invoices;
}

function genInvoiceItems(count, invoices) {
  const items = [];
  const KIND_LABEL_AMOUNT = {
    'meet-entry': ['Meet Entry Fee', 65],
    membership: ['Season Membership', 55],
    banquet: ['Banquet Ticket', 25],
    addon: ['T-Shirt Add-on', 20],
    donation: ['Donation', 10],
  };
  const kinds = Object.keys(KIND_LABEL_AMOUNT);
  for (let i = 1; i <= count; i++) {
    const inv = pick(invoices);
    const kind = pick(kinds);
    const [label, amount] = KIND_LABEL_AMOUNT[kind];
    items.push({
      id: `${TAG}invoice-item-${i}`,
      invoice_id: inv.id,
      label,
      amount,
      kind,
      ref_user_id: inv.athlete_id,
      refunded: false,
    });
  }
  return items;
}

function genPayments(count, invoices, people) {
  const payments = [];
  for (let i = 1; i <= count; i++) {
    const inv = pick(invoices);
    const subtotal = randInt(2000, 20000); // cents
    payments.push({
      id: randomUUID(),
      stripe_session_id: `${TAG}cs-${i}`,
      stripe_payment_intent_id: `${TAG}pi-${i}`,
      person_id: inv.athlete_id ?? pick(people).id,
      status: 'paid',
      amount_subtotal: subtotal,
      service_fee: Math.ceil(subtotal * 0.03 + 30),
      stripe_fee: Math.round(subtotal * 0.029 + 30),
      currency: 'usd',
      cart_item_ids: null,
      ref_reg_ids: null,
      ref_season_id: null,
      ref_type: null,
      invoice_id: inv.id,
      stripe_event_id: `${TAG}evt-${i}`,
      created_at: inv.created_at,
      fulfilled_at: inv.paid_at ?? inv.created_at,
    });
  }
  return payments;
}

// ---------------------------------------------------------------------------
// Clean — child-to-parent FK-safe order. Filters are reused for the row-count
// report below (before/after), so the count report and the delete always
// agree on what "a scale- row" means for each table.
// ---------------------------------------------------------------------------
const CLEANUP_STEPS = [
  ['scores', (q) => q.like('id', `${TAG}%`)],
  ['registrations', (q) => q.like('id', `${TAG}%`)],
  ['event_sessions', (q) => q.like('id', `${TAG}%`)],
  ['invoice_items', (q) => q.like('id', `${TAG}%`)],
  // payments.id is a uuid (can't carry the text prefix) — tagged via
  // stripe_session_id instead (see genPayments above).
  ['payments', (q) => q.like('stripe_session_id', `${TAG}%`)],
  ['invoices', (q) => q.like('id', `${TAG}%`)],
  ['memberships', (q) => q.like('id', `${TAG}%`)],
  ['events', (q) => q.like('id', `${TAG}%`)],
  ['people', (q) => q.like('id', `${TAG}%`)],
  ['clubs', (q) => q.like('id', `${TAG}%`)],
];

async function reportCounts(label) {
  console.log(`[seed-scale] row counts (${label}):`);
  for (const [table, applyFilter] of CLEANUP_STEPS) {
    const { count, error } = await applyFilter(supabase.from(table).select('*', { count: 'exact', head: true }));
    console.log(`  ${table}: ${error ? `ERROR ${error.message}` : count}`);
  }
}

async function clean() {
  for (const [table, applyFilter] of CLEANUP_STEPS) {
    const { error, count } = await applyFilter(supabase.from(table).delete({ count: 'exact' }));
    if (error) throw new Error(`[clean] ${table} failed: ${error.message}`);
    console.log(`[clean] ${table}: removed ${count ?? '?'} rows`);
  }
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------
async function seed(scale) {
  const t = targets(scale);
  console.log('[seed-scale] targets:', t);

  console.log('[seed-scale] fetching Tier-1 reference data (seasons, levels)...');
  const [{ data: seasons, error: seasonsErr }, { data: levels, error: levelsErr }] = await Promise.all([
    supabase.from('seasons').select('id,name,active'),
    supabase.from('levels').select('id,discipline'),
  ]);
  if (seasonsErr) throw new Error(`fetching seasons failed: ${seasonsErr.message}`);
  if (levelsErr) throw new Error(`fetching levels failed: ${levelsErr.message}`);
  if (!seasons?.length) {
    throw new Error(
      'No seasons found on staging. This harness generates volume against EXISTING Tier-1 ' +
      'reference data (seasons/levels) rather than fabricating it — push the demo seed first ' +
      '(Admin → Demo tools → pushAll) or apply real season/level fixtures, then re-run.',
    );
  }
  console.log(`[seed-scale] found ${seasons.length} season(s), ${levels?.length ?? 0} level(s)`);

  const levelsByDiscipline = {};
  for (const l of levels ?? []) (levelsByDiscipline[l.discipline] ??= []).push(l);

  const now = new Date();
  const twoYearsAgo = new Date(now);
  twoYearsAgo.setFullYear(now.getFullYear() - 2);

  console.log('[seed-scale] generating + writing clubs...');
  const clubs = genClubs(t.clubs);
  await upsertBatched('clubs', clubs, 'clubs');

  console.log('[seed-scale] generating + writing people...');
  const people = genPeople(t.people, clubs);
  await upsertBatched('people', people, 'people');
  const athletes = people.filter((p) => p.kind === 'athlete');

  console.log('[seed-scale] generating + writing events...');
  const events = genEvents(t.events, clubs, now);
  await upsertBatched('events', events, 'events');

  console.log('[seed-scale] generating + writing event_sessions...');
  const sessions = genSessions(events, t.sessionsPerEvent);
  await upsertBatched('event_sessions', sessions, 'event_sessions');
  const sessionsByEvent = {};
  for (const s of sessions) (sessionsByEvent[s.event_id] ??= []).push(s);

  console.log('[seed-scale] generating + writing registrations...');
  const regs = genRegistrations(t.registrations, events, sessionsByEvent, athletes, levelsByDiscipline);
  await upsertBatched('registrations', regs, 'registrations');

  console.log('[seed-scale] generating + writing scores...');
  const scores = genScores(regs, t.scores);
  await upsertBatched('scores', scores, 'scores');

  console.log('[seed-scale] generating + writing memberships...');
  const memberships = genMemberships(t.memberships, people, seasons);
  await upsertBatched('memberships', memberships, 'memberships');

  console.log('[seed-scale] generating + writing invoices...');
  const invoices = genInvoices(t.invoices, people, clubs, twoYearsAgo, now);
  await upsertBatched('invoices', invoices, 'invoices');

  console.log('[seed-scale] generating + writing invoice_items...');
  const invoiceItems = genInvoiceItems(t.invoiceItems, invoices);
  await upsertBatched('invoice_items', invoiceItems, 'invoice_items');

  console.log('[seed-scale] generating + writing payments...');
  const payments = genPayments(t.payments, invoices, people);
  await insertBatched('payments', payments, 'payments');

  console.log('[seed-scale] generated:');
  console.log(
    `  clubs ${clubs.length}, people ${people.length}, events ${events.length}, sessions ${sessions.length}, ` +
    `registrations ${regs.length}, scores ${scores.length}, memberships ${memberships.length}, ` +
    `invoices ${invoices.length}, invoice_items ${invoiceItems.length}, payments ${payments.length}`,
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
console.log(`[seed-scale] target: ${SUPABASE_URL} (staging ref ${STAGING_REF} confirmed, prod ref absent)`);
console.log(`[seed-scale] mode: ${CLEAN ? 'CLEAN' : `SEED (scale=${SCALE})`}`);

async function main() {
  if (CLEAN) {
    await reportCounts('before clean');
    await clean();
    await reportCounts('after clean');
    console.log('[seed-scale] clean complete.');
    return;
  }
  await reportCounts('before seed');
  await seed(SCALE);
  await reportCounts('after seed');
  console.log('[seed-scale] seed complete. Run with --clean when you are done measuring.');
}

main().catch((e) => {
  console.error('[seed-scale] FAILED:', e.stack || e.message || e);
  process.exit(1);
});
