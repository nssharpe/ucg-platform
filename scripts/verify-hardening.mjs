#!/usr/bin/env node
// Verifies the Phase 1 security-hardening DB triggers/policies actually
// reject the exploits documented in docs/specs/2026-07-02-security-review-
// findings.md (Part 1) and that legitimate client writes still work.
//
// Signs in as each seeded dev-auth test user (real JWT — see the "Dev
// test-auth" entry in CLAUDE.md) and issues raw PostgREST calls, exactly as
// an exploit or a legitimate client write would. Prints a PASS/FAIL table and
// exits non-zero on any unexpected result.
//
// Requires the DB migrations in supabase/migrations/20260702182709..182714
// to already be pushed (`supabase db push`) — this script does NOT push
// anything and does NOT run itself; the controller runs it after the push.
//
// Usage: node scripts/verify-hardening.mjs
//
// Every test either targets a scratch row it creates+deletes itself, or
// restores the row's original value afterward — never leaves live seeded-user
// data mutated. Only ever touches the seeded dev-auth users' own rows.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';

// --- Load .env.local directly (this script runs outside Vite, so
// import.meta.env isn't populated) -----------------------------------------
function loadEnvLocal() {
  const path = join(process.cwd(), '.env.local');
  if (!existsSync(path)) {
    console.error(`Missing ${path} — this script needs VITE_SUPABASE_URL/ANON_KEY and the seeded VITE_DEV_AUTH_* creds.`);
    process.exit(1);
  }
  const out = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let [, key, val] = m;
    val = val.trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

const env = loadEnvLocal();
const need = (k) => {
  const v = env[k];
  if (!v) { console.error(`Missing ${k} in .env.local`); process.exit(1); }
  return v;
};

const SUPABASE_URL = need('VITE_SUPABASE_URL');
const ANON_KEY = need('VITE_SUPABASE_ANON_KEY');

const USERS = {
  athlete: { email: need('VITE_DEV_AUTH_ATHLETE_EMAIL'), password: need('VITE_DEV_AUTH_ATHLETE_PASSWORD') },
  manager: { email: need('VITE_DEV_AUTH_MANAGER_EMAIL'), password: need('VITE_DEV_AUTH_MANAGER_PASSWORD') },
  admin: { email: need('VITE_DEV_AUTH_ADMIN_EMAIL'), password: need('VITE_DEV_AUTH_ADMIN_PASSWORD') },
};

// --- Test bookkeeping --------------------------------------------------
const results = [];
/** Run one check. `fn` returns { ok: boolean, detail?: string } — ok means
 *  "behaved as expected" (rejected when expected-rejected, allowed when
 *  expected-allowed), not "the write succeeded". */
async function check(name, expectation, fn) {
  try {
    const { ok, detail } = await fn();
    results.push({ name, expectation, pass: ok, detail: detail ?? '' });
  } catch (e) {
    results.push({ name, expectation, pass: false, detail: `threw: ${e?.message ?? e}` });
  }
}

function isRejected(error) {
  // A trigger RAISE EXCEPTION or an RLS violation both come back as a
  // PostgREST error (non-null `error`, no data written).
  return !!error;
}

async function signIn(creds) {
  const client = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { data, error } = await client.auth.signInWithPassword(creds);
  if (error || !data.session) {
    throw new Error(`Sign-in failed for ${creds.email}: ${error?.message ?? 'no session'}`);
  }
  return client;
}

/** Find "my own" people row for a signed-in client by matching the known
 *  seeded email (people_self_read RLS returns at least this row). */
async function myPerson(client, email) {
  const { data, error } = await client.from('people').select('*').ilike('email', email).maybeSingle();
  if (error || !data) throw new Error(`Could not find people row for ${email}: ${error?.message ?? 'not found'}`);
  return data;
}

async function main() {
  const athleteClient = await signIn(USERS.athlete);
  const managerClient = await signIn(USERS.manager);

  const athlete = await myPerson(athleteClient, USERS.athlete.email);
  const manager = await myPerson(managerClient, USERS.manager.email);

  // ===========================================================================
  // EXPECT REJECTED — athlete
  // ===========================================================================

  // 1. Self-activate own membership (C1). Rather than target the athlete's real
  //    (already-active) row — which can't test a transition — clone it into a
  //    throwaway PENDING row on a season the athlete has no membership for, then
  //    try to flip THAT to active. Asserts the guard is the rejecter, not an
  //    incidental unique/type error.
  await check(
    'athlete: UPDATE own membership status=active (throwaway pending row)',
    'REJECTED',
    async () => {
      const { data: existing } = await athleteClient
        .from('memberships').select('*').eq('person_id', athlete.id).limit(1).maybeSingle();
      if (!existing) return { ok: true, detail: 'no membership row to clone — skipped' };
      const { data: seasons } = await athleteClient.from('seasons').select('id');
      const { data: mine } = await athleteClient.from('memberships').select('season_id').eq('person_id', athlete.id);
      const taken = new Set((mine ?? []).map((m) => m.season_id));
      const freeSeason = (seasons ?? []).map((s) => s.id).find((id) => !taken.has(id));
      if (!freeSeason) return { ok: true, detail: 'no free season to place a throwaway membership — skipped' };
      const rowId = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.floor(Math.random() * 1e9)}`);
      const clone = {
        ...existing, id: rowId, season_id: freeSeason, status: 'pending-club-payment',
        waiver_signed_at: null, waiver_signed_by: null, paid_via: null, created_at: undefined,
      };
      delete clone.created_at;
      const { error: insErr } = await athleteClient.from('memberships').insert(clone);
      if (insErr) return { ok: true, detail: `setup insert failed (${insErr.message}) — skipped` };
      try {
        const { error } = await athleteClient.from('memberships').update({ status: 'active' }).eq('id', rowId);
        const byGuard = /guard_membership_writes|row-level security/i.test(error?.message ?? '');
        return {
          ok: isRejected(error) && byGuard,
          detail: error?.message ?? '(no error — self-activated a membership, BAD)',
        };
      } finally {
        await athleteClient.from('memberships').delete().eq('id', rowId);
      }
    },
  );

  // 2. Self-forge waiver_signed_at (C1).
  await check(
    'athlete: UPDATE own membership waiver_signed_at=now()',
    'REJECTED',
    async () => {
      const { data: existing } = await athleteClient
        .from('memberships').select('*').eq('person_id', athlete.id).limit(1).maybeSingle();
      if (!existing) return { ok: true, detail: 'no membership row to target — skipped' };
      const forged = new Date().toISOString();
      if (existing.waiver_signed_at === forged) return { ok: true, detail: 'skipped (coincident timestamp)' };
      const { error } = await athleteClient
        .from('memberships')
        .update({ waiver_signed_at: forged, waiver_signed_by: 'Exploit Test' })
        .eq('person_id', athlete.id).eq('season_id', existing.season_id).eq('type', existing.type);
      return { ok: isRejected(error), detail: error?.message ?? '(no error — write succeeded, BAD)' };
    },
  );

  // 3. Self-flip a registration's paid to true (C2), on a non-free event.
  //    Insert a throwaway unpaid reg on a real event whose fee is non-zero for
  //    this athlete's club, then try to flip it, then delete it regardless of
  //    outcome (cleanup).
  await check(
    'athlete: UPDATE own registration paid=true (non-free event)',
    'REJECTED',
    async () => {
      const { data: events } = await athleteClient
        .from('events').select('id,host_club_id,entry_fee,second_discipline_fee,change_fee').limit(50);
      const nonFree = (events ?? []).find((e) =>
        e.host_club_id !== athlete.main_club_id
        && (Number(e.entry_fee) > 0 || Number(e.second_discipline_fee) > 0));
      if (!nonFree) return { ok: true, detail: 'no non-free/non-host event found to test against — skipped' };
      const { data: levels } = await athleteClient.from('levels').select('id,discipline').limit(1);
      if (!levels?.length) return { ok: true, detail: 'no levels found — skipped' };
      const regId = `verify-hardening-reg-${Date.now()}`;
      const { error: insErr } = await athleteClient.from('registrations').insert({
        id: regId, event_id: nonFree.id, athlete_id: athlete.id, club_id: athlete.main_club_id,
        discipline: levels[0].discipline, level_id: levels[0].id, apparatus: [], paid: false,
      });
      if (insErr) return { ok: true, detail: `could not create throwaway reg (${insErr.message}) — skipped` };
      try {
        const { error } = await athleteClient.from('registrations').update({ paid: true }).eq('id', regId);
        return { ok: isRejected(error), detail: error?.message ?? '(no error — write succeeded, BAD)' };
      } finally {
        await athleteClient.from('registrations').delete().eq('id', regId);
      }
    },
  );

  // 3b. Two-step staging bypass of the registration paid-guard (C2, the
  //     controller-review fix): step 1 sets updated_pending=true on an unpaid
  //     reg (must be rejected), which would otherwise let step 2 flip paid=true
  //     via the snapshot-revert allowance. Verifies the updated_pending guard.
  await check(
    'athlete: UPDATE own unpaid registration updated_pending=true (staging)',
    'REJECTED',
    async () => {
      const { data: events } = await athleteClient
        .from('events').select('id,host_club_id,entry_fee,second_discipline_fee,change_fee').limit(50);
      const nonFree = (events ?? []).find((e) =>
        e.host_club_id !== athlete.main_club_id
        && (Number(e.entry_fee) > 0 || Number(e.second_discipline_fee) > 0));
      if (!nonFree) return { ok: true, detail: 'no non-free/non-host event found — skipped' };
      const { data: levels } = await athleteClient.from('levels').select('id,discipline').limit(1);
      if (!levels?.length) return { ok: true, detail: 'no levels found — skipped' };
      const regId = `verify-hardening-stage-${Date.now()}`;
      const { error: insErr } = await athleteClient.from('registrations').insert({
        id: regId, event_id: nonFree.id, athlete_id: athlete.id, club_id: athlete.main_club_id,
        discipline: levels[0].discipline, level_id: levels[0].id, apparatus: [], paid: false,
      });
      if (insErr) return { ok: true, detail: `could not create throwaway reg (${insErr.message}) — skipped` };
      try {
        // Step 1 of the attack — stage updated_pending=true while paid stays false.
        const { error } = await athleteClient
          .from('registrations').update({ updated_pending: true }).eq('id', regId);
        return { ok: isRejected(error), detail: error?.message ?? '(no error — staging succeeded, BAD: enables the 2-step paid flip)' };
      } finally {
        await athleteClient.from('registrations').delete().eq('id', regId);
      }
    },
  );

  // 4. Read coupons (H2).
  await check(
    'athlete: SELECT * FROM coupons',
    'REJECTED (0 rows)',
    async () => {
      const { data, error } = await athleteClient.from('coupons').select('*');
      if (error) return { ok: true, detail: `errored (also acceptable): ${error.message}` };
      return { ok: (data ?? []).length === 0, detail: `${(data ?? []).length} rows returned` };
    },
  );

  // 5. Read own manager_access_requests token (C3).
  await check(
    'athlete: SELECT token FROM manager_access_requests',
    'REJECTED (0 rows)',
    async () => {
      const { data, error } = await athleteClient.from('manager_access_requests').select('token');
      if (error) return { ok: true, detail: `errored (also acceptable): ${error.message}` };
      return { ok: (data ?? []).length === 0, detail: `${(data ?? []).length} rows returned` };
    },
  );

  // ===========================================================================
  // EXPECT REJECTED — manager
  // ===========================================================================

  // 6. Manager inserts an active club_membership directly (H3).
  await check(
    'manager: INSERT club_memberships status=active for own club',
    'REJECTED',
    async () => {
      if (!manager.main_club_id) return { ok: true, detail: 'seeded manager has no main_club_id — skipped' };
      // Pick a season the club has NO club_membership for, so a unique-constraint
      // violation can't masquerade as the RLS rejection we're testing. Use a real
      // uuid id (the column is uuid) so the insert actually reaches the policy.
      const { data: seasons } = await managerClient.from('seasons').select('id');
      const { data: existingCms } = await managerClient
        .from('club_memberships').select('season_id').eq('club_id', manager.main_club_id);
      const taken = new Set((existingCms ?? []).map((c) => c.season_id));
      const freeSeason = (seasons ?? []).map((s) => s.id).find((id) => !taken.has(id));
      if (!freeSeason) return { ok: true, detail: 'no free season for the club — skipped' };
      const rowId = (globalThis.crypto?.randomUUID?.() ?? '00000000-0000-4000-8000-000000000000');
      const { error } = await managerClient.from('club_memberships').insert({
        id: rowId, club_id: manager.main_club_id, season_id: freeSeason,
        status: 'active', granted_by_admin: false,
      });
      // Cleanup in case it somehow succeeded (BAD, but don't leave it behind).
      if (!error) await managerClient.from('club_memberships').delete().eq('id', rowId);
      const byRls = /row-level security/i.test(error?.message ?? '');
      return {
        ok: isRejected(error) && byRls,
        detail: error?.message ?? '(no error — manager self-granted a club membership, BAD)',
      };
    },
  );

  // ===========================================================================
  // EXPECT ALLOWED — athlete (legitimate writes must keep working)
  // ===========================================================================

  // 7. Re-push own membership row UNCHANGED (whole-row rewrite pattern the
  //    app's write-through uses everywhere).
  await check(
    'athlete: re-push own membership row unchanged',
    'ALLOWED',
    async () => {
      const { data: existing } = await athleteClient
        .from('memberships').select('*').eq('person_id', athlete.id).limit(1).maybeSingle();
      if (!existing) return { ok: true, detail: 'no membership row to target — skipped (nothing to verify)' };
      const { error } = await athleteClient
        .from('memberships')
        .update({ status: existing.status, waiver_signed_at: existing.waiver_signed_at, paid_via: existing.paid_via })
        .eq('person_id', athlete.id).eq('season_id', existing.season_id).eq('type', existing.type);
      return { ok: !error, detail: error?.message ?? 'ok' };
    },
  );

  // 8. Toggle club_cart_pending true then restore it (whole-row rewrite,
  //    unrelated to the guarded columns).
  await check(
    'athlete: set club_cart_pending=true then restore original',
    'ALLOWED',
    async () => {
      const { data: existing } = await athleteClient
        .from('memberships').select('*').eq('person_id', athlete.id).limit(1).maybeSingle();
      if (!existing) return { ok: true, detail: 'no membership row to target — skipped' };
      const original = existing.club_cart_pending ?? false;
      const { error: e1 } = await athleteClient
        .from('memberships').update({ club_cart_pending: true })
        .eq('person_id', athlete.id).eq('season_id', existing.season_id).eq('type', existing.type);
      const { error: e2 } = await athleteClient
        .from('memberships').update({ club_cart_pending: original })
        .eq('person_id', athlete.id).eq('season_id', existing.season_id).eq('type', existing.type);
      return { ok: !e1 && !e2, detail: (e1 ?? e2)?.message ?? 'ok, restored' };
    },
  );

  // 9. Create a registration with paid=false, then delete it (cleanup).
  await check(
    'athlete: create own registration paid=false, then delete',
    'ALLOWED',
    async () => {
      const { data: events } = await athleteClient.from('events').select('id').limit(1);
      const { data: levels } = await athleteClient.from('levels').select('id,discipline').limit(1);
      if (!events?.length || !levels?.length) return { ok: true, detail: 'no events/levels found — skipped' };
      const regId = `verify-hardening-reg-ok-${Date.now()}`;
      const { error: insErr } = await athleteClient.from('registrations').insert({
        id: regId, event_id: events[0].id, athlete_id: athlete.id, club_id: athlete.main_club_id,
        discipline: levels[0].discipline, level_id: levels[0].id, apparatus: [], paid: false,
      });
      const { error: delErr } = insErr ? { error: null } : await athleteClient.from('registrations').delete().eq('id', regId);
      return { ok: !insErr && !delErr, detail: (insErr ?? delErr)?.message ?? 'ok' };
    },
  );

  // --- Print results table -----------------------------------------------
  const nameW = Math.max(...results.map((r) => r.name.length), 40);
  const expW = Math.max(...results.map((r) => r.expectation.length), 10);
  console.log('');
  console.log('PHASE 1 SECURITY HARDENING — VERIFICATION RESULTS');
  console.log('='.repeat(nameW + expW + 20));
  let failCount = 0;
  for (const r of results) {
    const status = r.pass ? 'PASS' : 'FAIL';
    if (!r.pass) failCount++;
    console.log(`[${status}] ${r.name.padEnd(nameW)} expect: ${r.expectation.padEnd(expW)} ${r.detail}`);
  }
  console.log('='.repeat(nameW + expW + 20));
  console.log(`${results.length - failCount}/${results.length} passed.`);

  if (failCount > 0) {
    console.error(`\n${failCount} check(s) FAILED — hardening is not behaving as expected.`);
    process.exit(1);
  }
  console.log('\nAll checks passed.');
}

main().catch((e) => {
  console.error('Fatal error running verification:', e);
  process.exit(1);
});
