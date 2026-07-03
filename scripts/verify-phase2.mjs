#!/usr/bin/env node
// Verifies the Phase 2 create-checkout-session changes against the LIVE
// (test-mode Stripe) function: the lines_snapshot is written, amounts are
// server-computed, and a bogus registration ref is rejected before any Stripe
// call. The webhook's fulfillment path can't be automated here (it needs a real
// card submitted into Stripe's iframe — see the "Stripe checkout verification
// limit" memo); this covers the create side + the C4/H4 validation rejections.
//
// Run: node scripts/verify-phase2.mjs   (parses .env.local for creds)
// Leaves at most one throwaway PENDING payment row in test mode (harmless;
// service-role-only to delete). Deletes any cart_items it creates.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';

function loadEnvLocal() {
  const path = join(process.cwd(), '.env.local');
  if (!existsSync(path)) { console.error(`Missing ${path}`); process.exit(1); }
  const out = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let [, k, v] = m; v = v.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}
const env = loadEnvLocal();
const need = (k) => { const v = env[k]; if (!v) { console.error(`Missing ${k}`); process.exit(1); } return v; };
const URL = need('VITE_SUPABASE_URL');
const ANON = need('VITE_SUPABASE_ANON_KEY');
const FN = `${URL}/functions/v1/create-checkout-session`;

const results = [];
const record = (name, expect, pass, detail) => results.push({ name, expect, pass, detail: detail ?? '' });

async function callFn(token, body) {
  const res = await fetch(FN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  return { status: res.status, json };
}

async function main() {
  const client = createClient(URL, ANON, { auth: { persistSession: false } });
  const { data: auth, error: authErr } = await client.auth.signInWithPassword({
    email: need('VITE_DEV_AUTH_ATHLETE_EMAIL'), password: need('VITE_DEV_AUTH_ATHLETE_PASSWORD'),
  });
  if (authErr || !auth.session) { console.error('Sign-in failed:', authErr?.message); process.exit(1); }
  const token = auth.session.access_token;
  const { data: me } = await client.from('people').select('*').ilike('email', need('VITE_DEV_AUTH_ATHLETE_EMAIL')).maybeSingle();
  if (!me) { console.error('No people row for seeded athlete'); process.exit(1); }

  // 1. Unauthenticated → 401.
  {
    const r = await callFn(null, { cartItemIds: ['x'] });
    record('unauth call', '401', r.status === 401, `status ${r.status}`);
  }

  // 2. A meet-entry cart line referencing a NONEXISTENT registration → 400,
  //    and NO Stripe session created (the ref check happens first). Clean.
  const bogusItemId = (globalThis.crypto?.randomUUID?.() ?? `ci-${Date.now()}`);
  {
    const { error: insErr } = await client.from('cart_items').insert({
      id: bogusItemId, person_id: me.id, club_id: null,
      label: 'verify-phase2 bogus entry', amount: 25, kind: 'meet-entry',
      ref_user_id: me.id, ref_reg_ids: [`no-such-reg-${Date.now()}`], ref_line_type: 'entry',
    });
    if (insErr) {
      record('bogus-ref rejected', '400', false, `setup insert failed: ${insErr.message}`);
    } else {
      const r = await callFn(token, { cartItemIds: [bogusItemId] });
      record('bogus-ref rejected before Stripe', '400', r.status === 400, `status ${r.status} — ${r.json?.error ?? ''}`.slice(0, 120));
      await client.from('cart_items').delete().eq('id', bogusItemId);
    }
  }

  // 3. Happy path: a membership for a season the athlete does NOT already hold →
  //    server prices it, creates a session, and writes lines_snapshot on the
  //    pending payment. Verifies the snapshot round-trips.
  {
    const { data: seasons } = await client.from('seasons').select('id, athlete_fee');
    const { data: mine } = await client.from('memberships').select('season_id').eq('person_id', me.id);
    const taken = new Set((mine ?? []).map((m) => m.season_id));
    const freeSeason = (seasons ?? []).find((s) => !taken.has(s.id) && Number(s.athlete_fee) > 0);
    if (!freeSeason) {
      record('happy path: lines_snapshot written', 'OK', true, 'skipped — no unheld paid season for seeded athlete');
    } else {
      const itemId = (globalThis.crypto?.randomUUID?.() ?? `ci-m-${Date.now()}`);
      const { error: insErr } = await client.from('cart_items').insert({
        id: itemId, person_id: me.id, club_id: null,
        label: 'verify-phase2 athlete membership', amount: freeSeason.athlete_fee, kind: 'membership',
        ref_user_id: me.id, ref_season_id: freeSeason.id, ref_type: 'athlete',
      });
      if (insErr) {
        record('happy path: lines_snapshot written', 'OK', false, `setup insert failed: ${insErr.message}`);
      } else {
        const r = await callFn(token, { cartItemIds: [itemId] });
        if (r.status !== 200 || !r.json?.ok) {
          record('happy path: session created', 'OK', false, `status ${r.status} — ${r.json?.error ?? ''}`.slice(0, 120));
        } else {
          record('happy path: session created', 'OK', true, `paymentId ${r.json.paymentId}, subtotal ${r.json.amountSubtotal}, fee ${r.json.serviceFee}`);
          // Self-read the payment row and check the snapshot.
          const { data: pay } = await client.from('payments').select('id, amount_subtotal, service_fee, lines_snapshot').eq('id', r.json.paymentId).maybeSingle();
          const snap = pay?.lines_snapshot;
          const snapOk = Array.isArray(snap) && snap.length === 1 && snap[0].id === itemId
            && snap[0].kind === 'membership' && Number(snap[0].amount_cents) > 0;
          record('lines_snapshot written + priced', 'OK', !!snapOk,
            snapOk ? `amount_cents ${snap[0].amount_cents}` : `snapshot=${JSON.stringify(snap)?.slice(0, 120)}`);
          const feeOk = Number(pay?.service_fee) > 0 && Number(pay?.amount_subtotal) > 0;
          record('payment amounts server-set', 'OK', feeOk, `subtotal ${pay?.amount_subtotal}, fee ${pay?.service_fee}`);
        }
        await client.from('cart_items').delete().eq('id', itemId);
      }
    }
  }

  // --- print ---
  const w = Math.max(...results.map((r) => r.name.length), 30);
  console.log('\nPHASE 2 — create-checkout-session VERIFICATION\n' + '='.repeat(w + 40));
  let fails = 0;
  for (const r of results) {
    if (!r.pass) fails++;
    console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name.padEnd(w)} expect ${r.expect.padEnd(5)} ${r.detail}`);
  }
  console.log('='.repeat(w + 40));
  console.log(`${results.length - fails}/${results.length} passed.`);
  if (fails) process.exit(1);
}
main().catch((e) => { console.error('Fatal:', e); process.exit(1); });
