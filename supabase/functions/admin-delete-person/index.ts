// admin-delete-person — GDPR/COPPA-adjacent admin-operated delete/anonymize
// (F5, docs/specs/2026-07-18-...-recon-export-seasons.md §F5). Deletes what has
// no financial/legal significance, ANONYMIZES retained financial/competition
// history in place, and KEEPS waiver signatures untouched (legal retention,
// flagged for counsel). Money/auth-adjacent — fable-reviewed before merge.
//
// Auth: caller must hold the `admin` role (NOT finance_admin) + pass the AAL
// guard (service-role client bypasses RLS-level is_admin() hardening).
// verify_jwt STAYS TRUE (default) — not one of the no-verify-jwt trio.
//
// --- Deletion model -----------------------------------------------------
// The `people` row itself is NEVER hard-deleted while anything with lasting
// significance still references it (registrations.athlete_id and
// refund_requests.requester_person_id and waiver_signatures.person_id are all
// ON DELETE CASCADE — a hard delete would silently destroy paid competition
// history, approved refunds, AND legally-retained waiver signatures). Instead
// the SAME row is scrubbed in place into a tombstone (name -> "Deleted user",
// contact/PII columns blanked, auth_user_id -> null) so every FK pointing at
// this id stays intact with no rewrite needed elsewhere. Only when NOTHING
// meaningful references the person (no registrations/invoices/invoice_items/
// payments/refund_requests/waiver_signatures left) is the row hard-deleted.
//
// DELETE outright (no financial/legal significance):
//   - registrations that were NEVER paid (paid=false AND updated_pending=false
//     — a paid reg mid-change-fee-repending is NOT "never paid", so it's left
//     alone and falls under retain-anonymize instead) — their scores cascade
//     with them (scores.reg_id ON DELETE CASCADE).
//   - this person's own cart_items (person_id match) AND any cart_items where
//     they're the referenced entrant in someone ELSE's/a club's cart
//     (ref_user_id match) — both are unpaid-pending, no financial event yet.
//   - waitlist_groups (person_id match).
//   - waiver_sign_requests — the "guardian link" no-login signing tokens
//     (NOT waiver_signatures, which are KEPT — see below).
//   - refund_requests that are still 'pending'/'rejected' (no money moved).
//   - account_invites (pending account-setup invites — moot once deleted).
//   - event_admins grants held by this person's auth user id (would otherwise
//     dangle — event_admins.user_id has no FK to auth.users).
//   - person_alt_clubs rows (alt-club affiliation, no PII value beyond the FK).
//
// RETAIN + ANONYMIZE (financial/competition history — the row stays, only
// the denormalized name text embedded in it is scrubbed):
//   - invoice_items.label and payments.lines_snapshot[].label: cart/invoice
//     line labels for meet-entry/change-fee/membership lines are built as
//     "<event> entry — <First> <Last> (...)" (Club.tsx/Events.tsx/
//     Membership.tsx/MyRegistrations.tsx) — a denormalized PII field baked
//     into otherwise-generic financial rows. Every occurrence of the person's
//     OLD full name (captured before the people-row scrub) is replaced with
//     "Deleted user"; amounts/dates/kinds are untouched.
//   - registrations (paid), scores, invoices, invoice_items, payments,
//     approved refund_requests: no PII columns beyond the label scrub above —
//     they simply keep pointing at the now-tombstoned people row.
//
// KEEP AS-IS (explicitly, pending counsel):
//   - waiver_signatures — the legal e-signature evidence record.
//   - memberships rows (season/status history) and sanction_requests/
//     sanction_votes/club_requests filed by the person — administrative
//     history, not itself PII beyond an id FK that still resolves correctly
//     against the tombstoned row.
//
// Auth user: `auth.admin.deleteUser` when auth_user_id was set — best-effort,
// logged to error_logs on failure (DB-side work has already committed by then).
//
// Idempotent-ish: every delete/update is a WHERE-scoped statement that simply
// matches nothing on a re-run once the target rows are gone/already scrubbed.
// A second run against an already-tombstoned row requires confirmName to
// match the CURRENT name ("Deleted user") — expected, not a bug.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { requireAalForEnrolledCaller } from '../_shared/aal-guard.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

interface Payload {
  personId?: string;
  confirmName?: string;
}

interface Manifest {
  deleted: Record<string, number>;
  anonymized: Record<string, number>;
  kept: string[];
  authUserDeleted: boolean;
  personDeleted: boolean; // true = hard-deleted, false = tombstoned in place
  alreadyTombstoned: boolean;
}

function normalizeName(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Replace every occurrence of `oldFullName` inside `label` with a scrubbed
 *  placeholder. No-op (returns the input unchanged) when the name is blank or
 *  doesn't appear — most labels don't reference this person at all. */
function scrubLabel(label: string, oldFullName: string): string {
  if (!oldFullName.trim()) return label;
  return label.split(oldFullName).join('Deleted user');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // --- Authenticate ---
  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return json({ ok: false, error: 'Missing Authorization header.' }, 401);
  const { data: userData, error: userErr } = await db.auth.getUser(token);
  if (userErr || !userData.user) return json({ ok: false, error: 'Invalid or expired session.' }, 401);
  const callerAuthUserId = userData.user.id;

  // --- Authorize: admin ONLY (not finance_admin). Fail closed. ---
  const { data: roleRows, error: roleErr } = await db.from('user_roles').select('role').eq('user_id', callerAuthUserId);
  if (roleErr) return json({ ok: false, error: 'Could not verify permissions.' }, 500);
  const isAdmin = ((roleRows ?? []) as { role: string }[]).some((r) => r.role === 'admin');
  if (!isAdmin) return json({ ok: false, error: 'Admin role required to delete/anonymize a person.' }, 403);

  // AAL guard right after the role gate (service-role client bypasses RLS).
  const aalDenied = await requireAalForEnrolledCaller(db, callerAuthUserId, token, corsHeaders);
  if (aalDenied) return aalDenied;

  // --- Resolve the caller's own person row (self-delete guard). ---
  const { data: callerPersonRow, error: callerPersonErr } = await db
    .from('people').select('id').eq('auth_user_id', callerAuthUserId).maybeSingle();
  if (callerPersonErr) return json({ ok: false, error: 'Could not verify your account.' }, 500);
  const callerPersonId = (callerPersonRow as { id: string } | null)?.id ?? null;

  // --- Validate payload ---
  let payload: Payload;
  try { payload = await req.json(); } catch { return json({ ok: false, error: 'Invalid JSON body.' }, 400); }
  const personId = (payload.personId ?? '').trim();
  const confirmName = (payload.confirmName ?? '').trim();
  if (!personId) return json({ ok: false, error: 'personId is required.' }, 400);
  if (!confirmName) return json({ ok: false, error: 'confirmName is required.' }, 400);

  if (callerPersonId && callerPersonId === personId) {
    return json({ ok: false, error: 'You cannot delete your own person record.' }, 400);
  }

  // --- Load the target. ---
  const { data: personRow, error: personErr } = await db
    .from('people')
    .select('id, auth_user_id, first_name, last_name, email')
    .eq('id', personId)
    .maybeSingle();
  if (personErr) return json({ ok: false, error: 'Could not look up the person.' }, 500);
  if (!personRow) return json({ ok: false, error: 'Person not found — they may already have been fully deleted.' }, 404);
  const person = personRow as { id: string; auth_user_id: string | null; first_name: string; last_name: string; email: string };

  const currentFullName = `${person.first_name} ${person.last_name}`.trim();
  if (normalizeName(currentFullName) !== normalizeName(confirmName)) {
    return json({ ok: false, error: `Typed name does not match this person's current name ("${currentFullName}").` }, 400);
  }

  // --- Guard: refuse if the person is a club manager — self-reference trap
  //     (CLAUDE.md): removing them here would silently orphan club
  //     management. Admin must remove the club_managers row(s) first. ---
  const { data: managerRows, error: managerErr } = await db
    .from('club_managers').select('club_id').eq('person_id', personId);
  if (managerErr) return json({ ok: false, error: 'Could not check club-manager status.' }, 500);
  const managerClubIds = ((managerRows ?? []) as { club_id: string }[]).map((r) => r.club_id);
  if (managerClubIds.length > 0) {
    return json({
      ok: false,
      error: `This person still manages ${managerClubIds.length} club(s) (${managerClubIds.join(', ')}). Remove them as a manager on those clubs first, then retry.`,
    }, 400);
  }

  const alreadyTombstoned = person.first_name === 'Deleted' && person.last_name === 'user';
  const oldFullName = alreadyTombstoned ? '' : currentFullName; // nothing to scrub a second time

  const manifest: Manifest = {
    deleted: {}, anonymized: {}, kept: [], authUserDeleted: false, personDeleted: false, alreadyTombstoned,
  };
  const logFailure = async (step: string, message: string) => {
    await db.from('error_logs').insert({
      context: 'admin-delete-person', message: `${step}: ${message}`, detail: { personId },
    }).then(() => {}, () => {});
  };

  // -------------------------------------------------------------------
  // 1. DELETE outright — no financial/legal significance.
  // -------------------------------------------------------------------
  {
    const { data: rows, error } = await db
      .from('registrations').delete()
      .eq('athlete_id', personId).eq('paid', false).eq('updated_pending', false)
      .select('id');
    if (error) await logFailure('delete unpaid registrations', error.message);
    manifest.deleted.registrations = error ? 0 : (rows ?? []).length;
  }
  {
    const { data: rows, error } = await db
      .from('cart_items').delete()
      .or(`person_id.eq.${personId},ref_user_id.eq.${personId}`)
      .select('id');
    if (error) await logFailure('delete cart_items', error.message);
    manifest.deleted.cartItems = error ? 0 : (rows ?? []).length;
  }
  {
    const { data: rows, error } = await db.from('waitlist_groups').delete().eq('person_id', personId).select('id');
    if (error) await logFailure('delete waitlist_groups', error.message);
    manifest.deleted.waitlistGroups = error ? 0 : (rows ?? []).length;
  }
  {
    const { data: rows, error } = await db.from('waiver_sign_requests').delete().eq('person_id', personId).select('id');
    if (error) await logFailure('delete waiver_sign_requests', error.message);
    manifest.deleted.guardianLinks = error ? 0 : (rows ?? []).length;
  }
  {
    const { data: rows, error } = await db
      .from('refund_requests').delete()
      .eq('requester_person_id', personId).neq('status', 'approved')
      .select('id');
    if (error) await logFailure('delete non-approved refund_requests', error.message);
    manifest.deleted.pendingOrRejectedRefundRequests = error ? 0 : (rows ?? []).length;
  }
  {
    const { data: rows, error } = await db.from('account_invites').delete().eq('person_id', personId).select('id');
    if (error) await logFailure('delete account_invites', error.message);
    manifest.deleted.accountInvites = error ? 0 : (rows ?? []).length;
  }
  if (person.auth_user_id) {
    const { data: rows, error } = await db.from('event_admins').delete().eq('user_id', person.auth_user_id).select('id');
    if (error) await logFailure('delete event_admins grants', error.message);
    manifest.deleted.eventAdminGrants = error ? 0 : (rows ?? []).length;
  } else {
    manifest.deleted.eventAdminGrants = 0;
  }
  {
    const { data: rows, error } = await db.from('person_alt_clubs').delete().eq('person_id', personId).select('person_id');
    if (error) await logFailure('delete person_alt_clubs', error.message);
    manifest.deleted.altClubLinks = error ? 0 : (rows ?? []).length;
  }

  // -------------------------------------------------------------------
  // 2. ANONYMIZE — scrub the denormalized name out of retained financial
  //    line labels. Skipped entirely on a re-run (oldFullName === '').
  // -------------------------------------------------------------------
  manifest.anonymized.invoiceItemLabels = 0;
  manifest.anonymized.paymentSnapshotLines = 0;
  if (oldFullName) {
    const { data: items, error } = await db
      .from('invoice_items').select('id, label').eq('ref_user_id', personId);
    if (error) {
      await logFailure('load invoice_items for scrub', error.message);
    } else {
      for (const it of (items ?? []) as { id: string; label: string }[]) {
        const scrubbed = scrubLabel(it.label, oldFullName);
        if (scrubbed === it.label) continue;
        const { error: updErr } = await db.from('invoice_items').update({ label: scrubbed }).eq('id', it.id);
        if (updErr) { await logFailure(`scrub invoice_item ${it.id}`, updErr.message); continue; }
        manifest.anonymized.invoiceItemLabels++;
      }
    }

    // payments.lines_snapshot: any payment whose person_id is this person
    // (self-paid) OR whose ref_reg_ids overlaps a registration id they're
    // still linked to (club-paid entry) may carry a snapshot line for them.
    const { data: remainingRegs } = await db.from('registrations').select('id').eq('athlete_id', personId);
    const regIds = ((remainingRegs ?? []) as { id: string }[]).map((r) => r.id);
    const orParts = [`person_id.eq.${personId}`];
    if (regIds.length > 0) orParts.push(`ref_reg_ids.ov.{${regIds.join(',')}}`);
    const { data: pays, error: payErr } = await db
      .from('payments').select('id, lines_snapshot').or(orParts.join(','));
    if (payErr) {
      await logFailure('load payments for snapshot scrub', payErr.message);
    } else {
      type SnapLine = { label?: string; ref_user_id?: string; [k: string]: unknown };
      for (const pay of (pays ?? []) as { id: string; lines_snapshot: SnapLine[] | null }[]) {
        if (!Array.isArray(pay.lines_snapshot)) continue;
        let changed = false;
        const next = pay.lines_snapshot.map((line) => {
          if (line.ref_user_id !== personId || typeof line.label !== 'string') return line;
          const scrubbed = scrubLabel(line.label, oldFullName);
          if (scrubbed === line.label) return line;
          changed = true;
          return { ...line, label: scrubbed };
        });
        if (!changed) continue;
        const { error: updErr } = await db.from('payments').update({ lines_snapshot: next }).eq('id', pay.id);
        if (updErr) { await logFailure(`scrub payment ${pay.id} snapshot`, updErr.message); continue; }
        manifest.anonymized.paymentSnapshotLines++;
      }
    }
  }

  manifest.kept = ['waiver_signatures', 'memberships', 'club_requests', 'sanction_requests', 'sanction_votes'];

  // -------------------------------------------------------------------
  // 3. Decide hard-delete vs tombstone-in-place: hard-delete ONLY if
  //    nothing with cascade-significance remains attached to this id.
  // -------------------------------------------------------------------
  const remainingCounts = await Promise.all([
    db.from('registrations').select('id', { count: 'exact', head: true }).eq('athlete_id', personId),
    db.from('invoices').select('id', { count: 'exact', head: true }).eq('athlete_id', personId),
    db.from('invoice_items').select('id', { count: 'exact', head: true }).eq('ref_user_id', personId),
    db.from('payments').select('id', { count: 'exact', head: true }).eq('person_id', personId),
    db.from('refund_requests').select('id', { count: 'exact', head: true }).eq('requester_person_id', personId),
    db.from('waiver_signatures').select('id', { count: 'exact', head: true }).eq('person_id', personId),
  ]);
  const anyQueryFailed = remainingCounts.some((r) => r.error);
  if (anyQueryFailed) {
    for (const r of remainingCounts) if (r.error) await logFailure('count remaining refs', r.error.message);
  }
  // Fail-safe: if we couldn't confirm the counts, never risk a hard delete —
  // fall back to tombstoning (reversible-ish; a hard delete is not).
  const hasRemainingRefs = anyQueryFailed || remainingCounts.some((r) => (r.count ?? 0) > 0);

  if (!hasRemainingRefs) {
    const { error: delErr } = await db.from('people').delete().eq('id', personId);
    if (delErr) {
      await logFailure('hard-delete people row', delErr.message);
      // Fall through to tombstone as a safety net so the person isn't left
      // half-scrubbed with a normal name still on file.
    } else {
      manifest.personDeleted = true;
    }
  }
  if (!manifest.personDeleted) {
    const { error: scrubErr } = await db.from('people').update({
      first_name: 'Deleted', last_name: 'user',
      email: `deleted-${personId}@ucg.invalid`,
      dob: null, gender: null, placement: {}, grad_year: null, student_status: null,
      shirt: null, country: null, state: null, phone: null,
      main_club_id: null, levels: {}, emergency: {}, dietary: [], dietary_notes: '',
      auth_user_id: null,
    }).eq('id', personId);
    if (scrubErr) {
      await logFailure('tombstone people row', scrubErr.message);
      return json({ ok: false, error: 'Deletion partially completed but the person record could not be scrubbed — see error_logs.', manifest }, 500);
    }
  }

  // -------------------------------------------------------------------
  // 4. Delete the auth user (best-effort, after DB work has committed).
  // -------------------------------------------------------------------
  if (person.auth_user_id) {
    const { error: authDelErr } = await db.auth.admin.deleteUser(person.auth_user_id);
    if (authDelErr) {
      await logFailure('delete auth user', authDelErr.message);
    } else {
      manifest.authUserDeleted = true;
    }
  }

  return json({ ok: true, manifest });
});
