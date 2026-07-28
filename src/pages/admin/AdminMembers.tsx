import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useDB, mutate } from '../../lib/store';
import { Badge, Combo, Field, Modal } from '../../components/ui';
import { useToast } from '../../components/ui-hooks';
import { PersonForm } from '../../components/PersonForm';
import { STATE_REGIONS } from '../../lib/types';
import type { AccountInvite, Athlete, Membership, MembershipType, Registration } from '../../lib/types';
import { randomPromoCode } from '../../lib/pricing';
import { fetchAllRoles, pushAccountInvite, pushClubManager, pushMembership, pushRegistration, pushUserRole, deleteRegistration, sendEmail, pushPerson, deletePerson, adminResetMfa, fetchMembershipsForPersonRemote, fetchPersonRemote, type SendEmailResult } from '../../lib/supabase';
import { fetchRegistrationsForPerson, applyLocalRegistrationUpsert, applyLocalRegistrationRemove } from '../../lib/registrations-slice';
import { escapeHtml } from '../../lib/sanitize-html';
import { useCapabilities } from '../../lib/capabilities';
import { membershipTypeOf } from '../../lib/capabilities-core';
import { currentSeason } from '../../lib/season-lifecycle';
import { useAdminPeople, invalidateAdminPeople } from '../../lib/people-admin-slice';
import { useAdminMemberships, groupAdminMembershipsByPerson } from '../../lib/memberships-admin-slice';

const membershipTypeLabel = (t: MembershipType) => (t === 'coach' ? 'Coach' : 'Athlete');
function localEffectiveRoles(p: Athlete): { athlete: boolean; coach: boolean } {
  if (p.roles) return p.roles;
  return { athlete: p.kind !== 'coach', coach: p.kind === 'coach' };
}

// ---------- Merge Athletes modal ----------
// Phase 3 (data-layer-scale), CONTRACT shape #6: this is the sharpest case in
// the whole refactor. `dup`/`primary` are ARBITRARY people (not the signed-in
// admin, not scoped to one event/club), and this read feeds a mutate() that
// reassigns/hard-deletes registration rows and then deletes the person — an
// incomplete read here silently ORPHANS registrations against a deleted
// athleteId (data corruption, not a wrong count). Never a slice/cache: always
// a fresh, targeted fetchRegistrationsForPerson call for BOTH people, run
// again right before the destructive merge (not reused from an earlier
// preview fetch) so completeness comes from the query, not from hoping a
// cache is still warm.
function MergeAthletesModal({ onClose }: { onClose: () => void }) {
  const db = useDB();
  const toast = useToast();
  const [primaryId, setPrimaryId] = useState<string | null>(null);
  const [dupId, setDupId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [merging, setMerging] = useState(false);
  // Preview-only count, refetched whenever the duplicate selection changes.
  // NEVER reused for the actual merge below — doMerge always re-fetches.
  // Keyed by id (not a bare number) so the render can tell "loading for the
  // CURRENTLY selected dup" apart from "stale count for a previous one" —
  // this also avoids a synchronous setState-in-effect reset call (CLAUDE.md
  // ESLint trap) when the selection changes or is cleared.
  const [dupRegCount, setDupRegCount] = useState<{ id: string; count: number } | null>(null);

  // Phase 4 (data-layer-scale.md): db.people at boot no longer carries
  // everyone — this picker needs the WHOLE league (an admin merging two
  // arbitrary accounts could easily be picking across clubs neither of them
  // manages), so it's league-wide admin data (shape #3), same as the
  // memberships/registrations this modal already fetches fresh at merge
  // time below. The cached league-wide list is fine for BROWSING/picking;
  // doMerge re-fetches fresh person rows right before the destructive write
  // (never trusts this cache for the write itself — see its own comment).
  const { rows: adminPeopleRows } = useAdminPeople();
  const peopleOptions = useMemo(() =>
    adminPeopleRows.map((p) => ({
      value: p.id,
      label: `${p.firstName} ${p.lastName}`,
      sub: p.email,
    })).sort((a, b) => a.label.localeCompare(b.label)),
    [adminPeopleRows]
  );

  const primary = primaryId ? adminPeopleRows.find((p) => p.id === primaryId) ?? null : null;
  const dup = dupId ? adminPeopleRows.find((p) => p.id === dupId) ?? null : null;

  useEffect(() => {
    if (!dup) return;
    let live = true;
    fetchRegistrationsForPerson(dup.id).then((regs) => { if (live) setDupRegCount({ id: dup.id, count: regs.length }); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dup?.id]);

  // Preview-only memberships, same reasoning/shape as dupRegCount above:
  // adminPeopleRows (league-wide, shape #3) deliberately leaves
  // `.memberships` empty (every existing consumer of that shape already
  // pairs it with a separate memberships fetch rather than trusting an
  // embedded field), so the summary below needs its own fetch. NEVER reused
  // for the actual merge — doMerge always re-fetches fresh right before the
  // destructive write.
  const [previewMemberships, setPreviewMemberships] = useState<{ primaryId: string; dupId: string; primary: Membership[]; dup: Membership[] } | null>(null);
  useEffect(() => {
    if (!primary || !dup) return;
    let live = true;
    Promise.all([fetchMembershipsForPersonRemote(primary.id), fetchMembershipsForPersonRemote(dup.id)])
      .then(([primaryMs, dupMs]) => { if (live) setPreviewMemberships({ primaryId: primary.id, dupId: dup.id, primary: primaryMs, dup: dupMs }); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primary?.id, dup?.id]);
  const previewNewSeasonCount = (primary && dup && previewMemberships?.primaryId === primary.id && previewMemberships?.dupId === dup.id)
    ? previewMemberships.dup.filter((m) => !previewMemberships.primary.some((pm) => pm.seasonId === m.seasonId)).length
    : null;

  const canConfirm = primary && dup && primary.id !== dup.id;

  const doMerge = async () => {
    if (!primary || !dup) return;
    if (primary.id === dup.id) { toast('Cannot merge a person into themselves.'); return; }

    setMerging(true);
    // memberships are Tier 2 boot-scoped to the caller's own + managed-club
    // rows (whats-next.md §7) — `primary`/`dup` are ARBITRARY people, so
    // `.memberships` off the (post-scoping) db.people objects can no longer
    // be trusted here. Same reasoning as the registrations fetch just below —
    // and, per Phase 4 (data-layer-scale.md), the SAME reasoning now also
    // applies to the person rows themselves: `primary`/`dup` above come from
    // the CACHED league-wide adminPeopleRows picker, which is fine for
    // browsing but must never feed a destructive write. Fetch fresh person
    // rows (freshPrimary/freshDup) right here, right before mutating, and use
    // ONLY those from this point on — completeness/freshness comes from the
    // query, never from hoping a cache is still warm.
    const [dupRegs, primaryRegs, dupMemberships, primaryMemberships, freshDup, freshPrimary] = await Promise.all([
      fetchRegistrationsForPerson(dup.id),
      fetchRegistrationsForPerson(primary.id),
      fetchMembershipsForPersonRemote(dup.id),
      fetchMembershipsForPersonRemote(primary.id),
      fetchPersonRemote(dup.id),
      fetchPersonRemote(primary.id),
    ]);
    setMerging(false);
    if (!freshDup || !freshPrimary) {
      toast('Could not re-fetch one of these people (they may have just been deleted elsewhere) — merge cancelled.', { variant: 'error' });
      return;
    }

    // Compute what will change before mutating
    const primaryRegKeys = new Set(
      primaryRegs.map((r) => `${r.eventId}|${r.discipline}|${r.levelId}`)
    );
    const regsToMove: Registration[] = [];
    const regsToDrop: Registration[] = [];
    for (const r of dupRegs) {
      const key = `${r.eventId}|${r.discipline}|${r.levelId}`;
      if (primaryRegKeys.has(key)) {
        regsToDrop.push(r);
      } else {
        regsToMove.push(r);
      }
    }

    const primaryMembershipSeasons = new Set(primaryMemberships.map((m) => m.seasonId));
    const membershipsToAdd = dupMemberships.filter((m) => !primaryMembershipSeasons.has(m.seasonId));

    // altClubIds/authUserId read off the FRESH fetch, not the picker-sourced
    // primary/dup (Phase 4 — same "never trust the cache for a destructive
    // write" rule as the memberships/registrations fetches above).
    const altClubsToAdd = (freshDup.altClubIds ?? []).filter((id) => !(freshPrimary.altClubIds ?? []).includes(id));

    const applied = mutate((d) => {
      // 1. Repoint registrations: move clean ones to primary. Falls back to
      // the freshly-fetched row (`r`) when not found in d.registrations —
      // that array is empty in Supabase-configured mode once Stage 4 lands,
      // so relying on finding it there would silently no-op EVERY repoint
      // (the write-side twin of the read-side completeness bug this whole
      // function exists to close).
      for (const r of regsToMove) {
        const idx = d.registrations.findIndex((x) => x.id === r.id);
        const base = idx >= 0 ? d.registrations[idx] : r;
        const next: Registration = { ...base, athleteId: freshPrimary.id };
        if (idx >= 0) d.registrations[idx] = next;
        pushRegistration(next, next.sessionId);
        applyLocalRegistrationUpsert(next);
      }
      // 2. Drop collision registrations (and their scores)
      for (const r of regsToDrop) {
        // Drop scores for this reg
        d.scores = d.scores.filter((s) => s.regId !== r.id);
        // Drop the registration
        d.registrations = d.registrations.filter((x) => x.id !== r.id);
        deleteRegistration(r.id);
        applyLocalRegistrationRemove(r);
      }
      // 3. Merge memberships for seasons primary doesn't have. Reset from the
      // freshly-fetched `primaryMemberships` (not the possibly Tier
      // 2-incomplete `dp.memberships` already in local state — primary may
      // not be the admin's own self/managed-club person) before appending
      // the delta, so local state matches the DB immediately rather than
      // waiting on the next full sync. Phase 4: `d.people` at boot may not
      // contain primary/dup at all (both are arbitrary people, same as their
      // memberships/registrations above) — `dp` falls back to the freshly-
      // fetched row (a plain object, not one that lives in `d.people`) so
      // this never throws/no-ops the way a bare `.find(...)!` would; the
      // fallback branch's edits are still persisted via pushMembership/
      // pushPerson below even though there's no local d.people row to patch.
      const dpIdx = d.people.findIndex((x) => x.id === freshPrimary.id);
      const dp = dpIdx >= 0 ? d.people[dpIdx] : { ...freshPrimary };
      dp.memberships = [...primaryMemberships];
      for (const m of membershipsToAdd) {
        dp.memberships.push(m);
        pushMembership(freshPrimary.id, m);
      }
      // 4. Replace dup.id with primary.id in club managerIds
      for (const club of d.clubs) {
        if (club.managerIds.includes(freshDup.id)) {
          const alreadyHasPrimary = club.managerIds.includes(freshPrimary.id);
          club.managerIds = club.managerIds.filter((id) => id !== freshDup.id);
          if (!alreadyHasPrimary) {
            club.managerIds.push(freshPrimary.id);
            pushClubManager(club.id, freshPrimary.id, true);
          }
          pushClubManager(club.id, freshDup.id, false);
        }
      }
      // 5. Merge altClubIds
      for (const clubId of altClubsToAdd) {
        dp.altClubIds = dp.altClubIds ?? [];
        dp.altClubIds.push(clubId);
      }
      // 6. Carry over authUserId if primary lacks one
      if (!dp.authUserId && freshDup.authUserId) {
        dp.authUserId = freshDup.authUserId;
      }
      // 6b. Persist the primary's merged changes (authUserId + alt clubs).
      pushPerson(dp);
      // 7. Remove the duplicate locally AND remotely (cascades its child rows).
      d.people = d.people.filter((p) => p.id !== freshDup.id);
      deletePerson(freshDup.id);
    });
    if (!applied) return; // offline read-only gate — no false merge report

    // Phase 4: the league-wide picker cache (adminPeopleRows) doesn't see
    // this merge's push*/deletePerson calls the way a local mutate() would
    // patch a slice — refetch it so the members list/picker reflect the
    // merge without needing a manual page reload.
    invalidateAdminPeople();

    toast(
      `Merged ${freshDup.firstName} ${freshDup.lastName} into ${freshPrimary.firstName} ${freshPrimary.lastName}. ` +
      `Moved ${regsToMove.length} reg(s), dropped ${regsToDrop.length} collision(s), ` +
      `added ${membershipsToAdd.length} membership(s). The duplicate account was deleted.`
    );
    onClose();
  };

  return (
    <Modal title="Merge duplicate athlete accounts" onClose={onClose}>
      <p style={{ fontSize: 14, color: 'var(--ink-soft)', marginTop: 0 }}>
        Pick the <strong>primary</strong> account (the one to keep) and the <strong>duplicate</strong> (to be merged in and removed). All registrations, memberships, and club manager roles will transfer to the primary.
      </p>
      <Field label="Primary (keep this one)">
        <Combo
          options={peopleOptions}
          value={primaryId}
          onChange={setPrimaryId}
          placeholder="Search by name or email…"
        />
      </Field>
      <Field label="Duplicate (merge this one in)">
        <Combo
          options={peopleOptions}
          value={dupId}
          onChange={setDupId}
          placeholder="Search by name or email…"
        />
      </Field>

      {primary && dup && primary.id === dup.id && (
        <p style={{ color: 'var(--coral-600)', fontSize: 13 }}>Cannot merge a person into themselves.</p>
      )}

      {canConfirm && !confirming && (
        <div style={{ marginTop: 12, padding: '10px 14px', background: 'var(--surface-1)', borderRadius: 6, fontSize: 13.5 }}>
          <strong>Summary of what will happen:</strong>
          <ul style={{ margin: '6px 0 0 16px', lineHeight: 1.7 }}>
            <li>Keep: <strong>{primary.firstName} {primary.lastName}</strong> ({primary.email})</li>
            <li>Remove: <strong>{dup.firstName} {dup.lastName}</strong> ({dup.email})</li>
            <li>Registrations from duplicate: {dup && dupRegCount?.id === dup.id ? `${dupRegCount.count} total (collisions with primary will be dropped)` : 'loading…'}</li>
            <li>Memberships from duplicate: {previewNewSeasonCount === null ? 'loading…' : `${previewNewSeasonCount} new season(s) will transfer`}</li>
            <li>Club manager roles on: {db.clubs.filter((c) => c.managerIds.includes(dup.id)).map((c) => c.name).join(', ') || 'none'}</li>
            {!primary.authUserId && dup.authUserId && <li>Auth account will transfer from duplicate to primary</li>}
          </ul>
          <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', marginTop: 6, marginBottom: 0 }}>
            The duplicate's remote database row will need manual cleanup (see TODO comment in code).
          </p>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        {!confirming ? (
          <>
            <button
              className="btn primary"
              disabled={!canConfirm}
              onClick={() => setConfirming(true)}
            >
              Review &amp; confirm merge…
            </button>
            <button className="btn ghost" onClick={onClose}>Cancel</button>
          </>
        ) : (
          <>
            <button className="btn danger" disabled={merging} onClick={doMerge}>
              {merging ? 'Merging…' : 'Confirm — merge and remove duplicate'}
            </button>
            <button className="btn ghost" disabled={merging} onClick={() => setConfirming(false)}>Back</button>
          </>
        )}
      </div>
    </Modal>
  );
}

// ---------- Revoke membership confirmation modal (W13 task 6) ----------
// T2 (typed-membership residuals): revokes ONLY the given type's row — athlete
// and coach memberships are independent per season, so this must not touch
// the other type's row.
function RevokeMembershipModal({ person, seasonId, type, onClose }: {
  person: Athlete; seasonId: string; type: MembershipType; onClose: () => void;
}) {
  const toast = useToast();
  const [confirmed, setConfirmed] = useState(false);

  const doRevoke = () => {
    const applied = mutate((d) => {
      const dp = d.people.find((x) => x.id === person.id);
      if (!dp) return;
      const m = dp.memberships.find((x) => x.seasonId === seasonId && membershipTypeOf(x) === type);
      if (m) {
        // Remove the membership — revoke means remove, not just mark inactive.
        // Filter by (seasonId, type) ONLY — the other type's row for this
        // season, if any, must survive.
        dp.memberships = dp.memberships.filter((x) => !(x.seasonId === seasonId && membershipTypeOf(x) === type));
        // Push the updated person (removes membership server-side via replace).
        pushMembership(person.id, { ...m, status: 'none' });
      }
    });
    if (!applied) return; // offline read-only gate — no false success toast
    toast(`${membershipTypeLabel(type)} membership revoked for ${person.firstName} ${person.lastName}.`);
    onClose();
  };

  return (
    <Modal title={`Revoke ${membershipTypeLabel(type).toLowerCase()} membership`} onClose={onClose}>
      <p style={{ fontSize: 14, color: 'var(--ink-soft)', marginTop: 0 }}>
        <strong>Warning:</strong> This removes <strong>{person.firstName} {person.lastName}</strong>'s
        {' '}{membershipTypeLabel(type).toLowerCase()} membership for this season.
        {type === 'athlete'
          ? ' They will be removed from all future registered competitions in this season.'
          : ' Their athlete registrations, if any, are unaffected.'}
        {' '}This action cannot be easily undone — the member would need to re-register.
      </p>
      <label className="checkrow" style={{ margin: '12px 0' }}>
        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
        {type === 'athlete'
          ? 'I understand this removes them from all future competitions this season.'
          : 'I understand this revokes their coach membership for this season.'}
      </label>
      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <button className="btn danger" disabled={!confirmed} onClick={doRevoke}>
          Revoke {membershipTypeLabel(type).toLowerCase()} membership
        </button>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

// ---------- Reset 2FA confirmation modal ----------
function ResetMfaModal({ person, onClose }: { person: Athlete; onClose: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const doReset = async () => {
    if (!person.authUserId) return;
    setBusy(true);
    const res = await adminResetMfa({ targetUserId: person.authUserId });
    setBusy(false);
    if (res.ok) toast(`Two-factor authentication reset for ${person.firstName} ${person.lastName}.`);
    else toast(`Reset failed: ${res.error ?? 'unknown error'}.`, { variant: 'error' });
    onClose();
  };

  return (
    <Modal title="Reset two-factor authentication?" onClose={onClose}>
      <p style={{ marginTop: 0, fontSize: 14 }}>
        This removes ALL authenticator app and passkey factors from{' '}
        <strong>{person.firstName} {person.lastName}</strong>'s account. They'll be able to sign in with just
        their password again, and can set up a new factor from their Profile page. Use this when they've lost
        their device.
      </p>
      <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
        <button
          className="btn primary"
          style={{ background: 'var(--coral-600)', borderColor: 'var(--coral-600)' }}
          disabled={busy}
          onClick={doReset}
        >
          {busy ? 'Resetting…' : 'Yes, reset 2FA'}
        </button>
        <button className="btn ghost" disabled={busy} onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

// ---------- Members ----------
export function AdminMembers() {
  const db = useDB();
  const toast = useToast();
  const caps = useCapabilities();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'active' | 'pending' | 'none'>('all');
  const [editing, setEditing] = useState<Athlete | 'new' | null>(null);
  const [showMerge, setShowMerge] = useState(false);
  // W13 task 6: revoke confirmation
  const [revoking, setRevoking] = useState<{ person: Athlete; seasonId: string; type: MembershipType } | null>(null);
  // Auth-hardening Phase B: admin break-glass MFA reset confirmation
  const [resettingMfa, setResettingMfa] = useState<Athlete | null>(null);
  const season = currentSeason(db)!;

  // Admin grants: which auth users hold the 'admin' role (admin reads all rows).
  const [adminUserIds, setAdminUserIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    let live = true;
    fetchAllRoles().then((rows) => {
      if (live) setAdminUserIds(new Set(rows.filter((r) => r.role === 'admin').map((r) => r.userId)));
    });
    return () => { live = false; };
  }, []);

  const toggleAdmin = (p: Athlete) => {
    if (!p.authUserId) return;
    const grant = !adminUserIds.has(p.authUserId);
    pushUserRole(p.authUserId, 'admin', grant);
    setAdminUserIds((prev) => {
      const next = new Set(prev);
      if (grant) next.add(p.authUserId!); else next.delete(p.authUserId!);
      return next;
    });
    toast(grant ? `${p.firstName} is now a league admin.` : `Removed admin from ${p.firstName}.`);
  };

  // Branded account-setup invite. Claiming is by email-match at signup
  // (link_or_create_person), so the link just routes to signup and the copy
  // tells them to use THIS email. Admin-only path → reuses sendEmail.
  const sendInviteEmail = async (p: Athlete): Promise<SendEmailResult> => {
    const appUrl = window.location.origin + import.meta.env.BASE_URL.replace(/\/$/, '');
    const link = `${appUrl}/#/?signup=1`;
    const subject = 'Set up your United Club Gymnastics account';
    const html = `<p>Hi ${escapeHtml(p.firstName)},</p>
<p>An account has been created for you on the United Club Gymnastics platform.
To activate it, sign up using <strong>this email address</strong> (${escapeHtml(p.email)}):</p>
<p><a href="${link}">Create your account &rarr;</a></p>
<p>Use the same email shown above so your existing record is linked automatically.</p>`;
    return sendEmail(subject, html, [{ email: p.email, name: `${p.firstName} ${p.lastName}` }]);
  };

  // W13 task 5: create account invite for person with no authUserId.
  const createAccountInvite = async (p: Athlete) => {
    if (!p.email) { toast('Person has no email address on file — add an email first.'); return; }
    // Guard against duplicate pending invites.
    const existing = (db.accountInvites ?? []).find(
      (inv) => inv.personId === p.id && inv.status === 'pending',
    );
    if (existing) {
      toast(`A pending setup invite already exists for ${p.firstName} (created ${new Date(existing.createdAt).toLocaleDateString()}).`);
      return;
    }
    const invite: AccountInvite = {
      // react-hooks/purity false positive: this line only ever runs inside
      // this async onClick-triggered handler, never during render — but the
      // rule's whole-component reachability heuristic starts flagging it once
      // the component's `rows` memo shape grows more elaborate (T2,
      // typed-membership residuals — unrelated to this pre-existing code).
      // eslint-disable-next-line react-hooks/purity
      id: `inv-${Date.now()}-${p.id.slice(0, 8)}`,
      personId: p.id,
      email: p.email,
      token: randomPromoCode(24),
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    const applied = mutate((d) => {
      d.accountInvites = [...(d.accountInvites ?? []), invite];
      pushAccountInvite(invite);
    });
    if (!applied) return; // offline read-only gate — don't email an invite that wasn't created
    const res = await sendInviteEmail(p);
    if (res.ok && res.sentCount > 0) {
      toast(`Setup invite emailed to ${p.email}.`);
    } else {
      toast(`Invite created, but the email failed: ${res.error ?? 'unknown error'}. Use Resend to retry.`);
    }
  };

  const resendAccountInvite = async (p: Athlete) => {
    const res = await sendInviteEmail(p);
    toast(res.ok && res.sentCount > 0
      ? `Setup invite re-sent to ${p.email}.`
      : `Resend failed: ${res.error ?? 'unknown error'}.`);
  };

  // Phase 4 (data-layer-scale.md): this is the whole-league members table —
  // db.people at boot no longer carries everyone, so this is league-wide
  // admin data (shape #3), same as the memberships needed to classify each
  // row's status. Falls back to boot-scoped db.people/p.memberships while
  // loading so the page doesn't flash empty (a rare cold-boot moment;
  // self-corrects once the fetch resolves). `{rows.length} people` below
  // MUST gate on `adminPeopleStatus === 'ready'` — a count computed from a
  // still-loading league-wide fetch would silently undercount, not visibly
  // read as "not loaded yet".
  const { rows: adminPeopleRows, status: adminPeopleStatus } = useAdminPeople();
  const { rows: adminMembershipRows, status: adminMembershipsStatus } = useAdminMemberships();
  const adminMembershipsByPerson = useMemo(() => groupAdminMembershipsByPerson(adminMembershipRows), [adminMembershipRows]);
  const peopleReady = adminPeopleStatus === 'ready';
  const membershipsReady = adminMembershipsStatus === 'ready';

  // Precomputed here (inside the memo, not the JSX-mapping render callback
  // below) so the per-row `roles`/`typeRows` derivation (T2, typed-membership
  // residuals) stays alongside the rest of the row's derived view-model.
  const rows = useMemo(() => (peopleReady ? adminPeopleRows : db.people)
    .filter((p) => {
      const memberships = membershipsReady ? (adminMembershipsByPerson.get(p.id) ?? []) : p.memberships;
      const seasonMemberships = memberships.filter((x) => x.seasonId === season.id);
      // Filter semantics (T2, typed-membership residuals): a person counts as
      // 'active' for this coarse dropdown if ANY type (athlete or coach) is
      // active for the season; 'pending' if any type is pending-club-payment
      // (and none active); else 'none'. The Membership column below shows the
      // full per-type breakdown.
      const status = seasonMemberships.some((x) => x.status === 'active')
        ? 'active'
        : seasonMemberships.some((x) => x.status === 'pending-club-payment')
          ? 'pending'
          : 'none';
      if (filter !== 'all' && status !== filter) return false;
      const club = db.clubs.find((c) => c.id === p.mainClubId);
      return (p.firstName + ' ' + p.lastName + ' ' + p.email + ' ' + (club?.name ?? '')).toLowerCase().includes(q.toLowerCase());
    })
    .sort((a, b) => a.lastName.localeCompare(b.lastName))
    .map((p) => {
      const roles = localEffectiveRoles(p);
      const memberships = membershipsReady ? (adminMembershipsByPerson.get(p.id) ?? []) : p.memberships;
      const typeRows = (['athlete', 'coach'] as MembershipType[])
        .filter((t) => roles[t])
        .map((type) => ({
          type,
          m: memberships.find((x) => x.seasonId === season.id && membershipTypeOf(x) === type),
        }));
      return { p, roles, typeRows };
    }), [db, q, filter, season.id, adminPeopleRows, peopleReady, adminMembershipsByPerson, membershipsReady]);

  return (
    <div>
      <h1 className="page-title display">Members</h1>
      <p className="page-sub">Every athlete and coach. Each member has a unique URL — click through to view/edit details, waiver history, and toggle membership for any season.</p>
      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        <input className="input" style={{ maxWidth: 320 }} placeholder="Search name, email, club…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input" style={{ maxWidth: 220 }} value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
          <option value="all">All statuses ({season.name})</option>
          <option value="active">Active members</option>
          <option value="pending">Pending club payment</option>
          <option value="none">No membership</option>
        </select>
        <span style={{ alignSelf: 'center', fontSize: 13, color: 'var(--ink-soft)' }}>{peopleReady ? `${rows.length} people` : 'Loading…'}</span>
        <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
          {caps.isAdmin && (
            <button className="btn ghost" onClick={() => setShowMerge(true)}>Merge duplicates…</button>
          )}
          <button className="btn primary" onClick={() => setEditing('new')}>+ New person</button>
        </div>
      </div>
      <div className="card" style={{ overflow: 'hidden' }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Club</th>
              <th>Region</th>
              <th>Membership</th>
              <th>Account</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 120).map(({ p, roles, typeRows }) => {
              const club = db.clubs.find((c) => c.id === p.mainClubId);
              const isAdminUser = !!p.authUserId && adminUserIds.has(p.authUserId);
              const hasPendingInvite = (db.accountInvites ?? []).some(
                (inv) => inv.personId === p.id && inv.status === 'pending',
              );
              return (
                <tr key={p.id}>
                  <td><Link to={`/admin/members/${p.id}`} style={{ fontWeight: 600 }}>{p.lastName}, {p.firstName}</Link></td>
                  {/* Type column: derived from p.roles (fallback p.kind) — same
                      rule as Profile's admin header (effectiveRoles/
                      adminRoleLabel) — rather than the raw legacy p.kind, so a
                      dual-role member reads as "Athlete/Coach" (T2). */}
                  <td>
                    {roles.coach && <Badge tone="navy">Coach</Badge>}
                    {roles.coach && roles.athlete && ' '}
                    {roles.athlete && (roles.coach ? <Badge tone="info">Athlete</Badge> : 'Athlete')}
                  </td>
                  <td style={{ fontSize: 13.5 }}>{club?.name ?? <em>Independent</em>}</td>
                  <td>{club?.region ?? STATE_REGIONS[p.state] ?? 'Other'}</td>
                  <td>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {typeRows.map(({ type, m }) => (
                        <span key={type} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                          {typeRows.length > 1 && (
                            <span style={{ fontSize: 11, color: 'var(--ink-soft)' }}>{membershipTypeLabel(type)}:</span>
                          )}
                          {m?.status === 'active' ? (
                            <>
                              <Badge tone="ok">Active</Badge>
                              {/* W13 task 6: revoke via confirmation modal */}
                              <button
                                className="btn small ghost"
                                style={{ fontSize: 11, padding: '1px 6px' }}
                                onClick={() => setRevoking({ person: p, seasonId: season.id, type })}
                              >
                                Revoke
                              </button>
                            </>
                          ) : m?.status === 'pending-club-payment' ? (
                            <Badge tone="warn">Pending</Badge>
                          ) : (
                            <Badge tone="err">None</Badge>
                          )}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td style={{ fontSize: 12.5 }}>
                    {!p.authUserId ? (
                      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        <span style={{ color: 'var(--ink-soft)' }}>No account</span>
                        {/* W13 task 5: create account invite */}
                        {hasPendingInvite ? (
                          <button
                            className="btn small ghost"
                            style={{ fontSize: 11, padding: '1px 6px' }}
                            title="Re-send the account setup email"
                            onClick={() => resendAccountInvite(p)}
                          >
                            Resend
                          </button>
                        ) : (
                          <button
                            className="btn small ghost"
                            style={{ fontSize: 11, padding: '1px 6px' }}
                            title="Create account & email setup link"
                            onClick={() => createAccountInvite(p)}
                          >
                            Invite
                          </button>
                        )}
                      </span>
                    ) : (
                      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                        <label className="checkrow" style={{ margin: 0 }} data-tip="Grant or revoke league admin">
                          <input type="checkbox" checked={isAdminUser} onChange={() => toggleAdmin(p)} /> Admin
                        </label>
                        <button
                          className="btn small ghost"
                          style={{ fontSize: 11, padding: '1px 6px' }}
                          title="Remove all their 2FA factors — use if they've lost their device"
                          onClick={() => setResettingMfa(p)}
                        >
                          Reset 2FA
                        </button>
                      </span>
                    )}
                  </td>
                  <td><button className="btn small ghost" onClick={() => setEditing(p)}>Edit</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {editing && <PersonForm person={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
      {showMerge && <MergeAthletesModal onClose={() => setShowMerge(false)} />}
      {/* W13 task 6: revoke confirmation modal */}
      {revoking && (
        <RevokeMembershipModal
          person={revoking.person}
          seasonId={revoking.seasonId}
          type={revoking.type}
          onClose={() => setRevoking(null)}
        />
      )}
      {resettingMfa && <ResetMfaModal person={resettingMfa} onClose={() => setResettingMfa(null)} />}
    </div>
  );
}
