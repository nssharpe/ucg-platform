import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useDB, mutate } from '../../lib/store';
import { Badge, Combo, Field, Modal } from '../../components/ui';
import { useToast } from '../../components/ui-hooks';
import { PersonForm } from '../../components/PersonForm';
import { STATE_REGIONS } from '../../lib/types';
import type { AccountInvite, Athlete } from '../../lib/types';
import { randomPromoCode } from '../../lib/pricing';
import { fetchAllRoles, pushAccountInvite, pushClubManager, pushMembership, pushRegistration, pushUserRole, deleteRegistration, sendEmail, pushPerson, deletePerson, type SendEmailResult } from '../../lib/supabase';
import { escapeHtml } from '../../lib/sanitize-html';
import { useCapabilities } from '../../lib/capabilities';

// ---------- Merge Athletes modal ----------
function MergeAthletesModal({ onClose }: { onClose: () => void }) {
  const db = useDB();
  const toast = useToast();
  const [primaryId, setPrimaryId] = useState<string | null>(null);
  const [dupId, setDupId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const peopleOptions = useMemo(() =>
    db.people.map((p) => ({
      value: p.id,
      label: `${p.firstName} ${p.lastName}`,
      sub: p.email,
    })).sort((a, b) => a.label.localeCompare(b.label)),
    [db.people]
  );

  const primary = primaryId ? db.people.find((p) => p.id === primaryId) ?? null : null;
  const dup = dupId ? db.people.find((p) => p.id === dupId) ?? null : null;

  const canConfirm = primary && dup && primary.id !== dup.id;

  const doMerge = () => {
    if (!primary || !dup) return;
    if (primary.id === dup.id) { toast('Cannot merge a person into themselves.'); return; }

    // Compute what will change before mutating
    const dupRegs = db.registrations.filter((r) => r.athleteId === dup.id);
    const primaryRegKeys = new Set(
      db.registrations.filter((r) => r.athleteId === primary.id).map((r) => `${r.eventId}|${r.discipline}|${r.levelId}`)
    );
    const regsToMove: typeof dupRegs = [];
    const regsToDrop: typeof dupRegs = [];
    for (const r of dupRegs) {
      const key = `${r.eventId}|${r.discipline}|${r.levelId}`;
      if (primaryRegKeys.has(key)) {
        regsToDrop.push(r);
      } else {
        regsToMove.push(r);
      }
    }

    const primaryMembershipSeasons = new Set(primary.memberships.map((m) => m.seasonId));
    const membershipsToAdd = dup.memberships.filter((m) => !primaryMembershipSeasons.has(m.seasonId));

    const altClubsToAdd = (dup.altClubIds ?? []).filter((id) => !(primary.altClubIds ?? []).includes(id));

    const applied = mutate((d) => {
      // 1. Repoint registrations: move clean ones to primary
      for (const r of regsToMove) {
        const dr = d.registrations.find((x) => x.id === r.id);
        if (dr) {
          dr.athleteId = primary.id;
          pushRegistration(dr, dr.sessionId);
        }
      }
      // 2. Drop collision registrations (and their scores)
      for (const r of regsToDrop) {
        // Drop scores for this reg
        d.scores = d.scores.filter((s) => s.regId !== r.id);
        // Drop the registration
        d.registrations = d.registrations.filter((x) => x.id !== r.id);
        deleteRegistration(r.id);
      }
      // 3. Merge memberships for seasons primary doesn't have
      const dp = d.people.find((x) => x.id === primary.id)!;
      for (const m of membershipsToAdd) {
        dp.memberships.push(m);
        pushMembership(primary.id, m);
      }
      // 4. Replace dup.id with primary.id in club managerIds
      for (const club of d.clubs) {
        if (club.managerIds.includes(dup.id)) {
          const alreadyHasPrimary = club.managerIds.includes(primary.id);
          club.managerIds = club.managerIds.filter((id) => id !== dup.id);
          if (!alreadyHasPrimary) {
            club.managerIds.push(primary.id);
            pushClubManager(club.id, primary.id, true);
          }
          pushClubManager(club.id, dup.id, false);
        }
      }
      // 5. Merge altClubIds
      for (const clubId of altClubsToAdd) {
        dp.altClubIds = dp.altClubIds ?? [];
        dp.altClubIds.push(clubId);
      }
      // 6. Carry over authUserId if primary lacks one
      if (!dp.authUserId && dup.authUserId) {
        dp.authUserId = dup.authUserId;
      }
      // 6b. Persist the primary's merged changes (authUserId + alt clubs).
      pushPerson(dp);
      // 7. Remove the duplicate locally AND remotely (cascades its child rows).
      d.people = d.people.filter((p) => p.id !== dup.id);
      deletePerson(dup.id);
    });
    if (!applied) return; // offline read-only gate — no false merge report

    toast(
      `Merged ${dup.firstName} ${dup.lastName} into ${primary.firstName} ${primary.lastName}. ` +
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
            <li>Registrations from duplicate: {db.registrations.filter((r) => r.athleteId === dup.id).length} total (collisions with primary will be dropped)</li>
            <li>Memberships from duplicate: {dup.memberships.filter((m) => !primary.memberships.some((pm) => pm.seasonId === m.seasonId)).length} new season(s) will transfer</li>
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
            <button className="btn danger" onClick={doMerge}>
              Confirm — merge and remove duplicate
            </button>
            <button className="btn ghost" onClick={() => setConfirming(false)}>Back</button>
          </>
        )}
      </div>
    </Modal>
  );
}

// ---------- Revoke membership confirmation modal (W13 task 6) ----------
function RevokeMembershipModal({ person, seasonId, onClose }: { person: Athlete; seasonId: string; onClose: () => void }) {
  const toast = useToast();
  const [confirmed, setConfirmed] = useState(false);

  const doRevoke = () => {
    const applied = mutate((d) => {
      const dp = d.people.find((x) => x.id === person.id);
      if (!dp) return;
      const m = dp.memberships.find((x) => x.seasonId === seasonId);
      if (m) {
        // Remove the membership — revoke means remove, not just mark inactive.
        dp.memberships = dp.memberships.filter((x) => x.seasonId !== seasonId);
        // Push the updated person (removes membership server-side via replace).
        pushMembership(person.id, { ...m, status: 'none' });
      }
    });
    if (!applied) return; // offline read-only gate — no false success toast
    toast(`Membership revoked for ${person.firstName} ${person.lastName}.`);
    onClose();
  };

  return (
    <Modal title="Revoke membership" onClose={onClose}>
      <p style={{ fontSize: 14, color: 'var(--ink-soft)', marginTop: 0 }}>
        <strong>Warning:</strong> This removes <strong>{person.firstName} {person.lastName}</strong>'s
        membership for this season. They will be removed from all future registered competitions
        in this season. This action cannot be easily undone — the member would need to re-register.
      </p>
      <label className="checkrow" style={{ margin: '12px 0' }}>
        <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
        I understand this removes them from all future competitions this season.
      </label>
      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <button className="btn danger" disabled={!confirmed} onClick={doRevoke}>
          Revoke membership
        </button>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
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
  const [revoking, setRevoking] = useState<{ person: Athlete; seasonId: string } | null>(null);
  const season = db.seasons.find((s) => s.current)!;

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

  const rows = useMemo(() => db.people
    .filter((p) => {
      const m = p.memberships.find((x) => x.seasonId === season.id);
      const status = m?.status === 'active' ? 'active' : m?.status === 'pending-club-payment' ? 'pending' : 'none';
      if (filter !== 'all' && status !== filter) return false;
      const club = db.clubs.find((c) => c.id === p.mainClubId);
      return (p.firstName + ' ' + p.lastName + ' ' + p.email + ' ' + (club?.name ?? '')).toLowerCase().includes(q.toLowerCase());
    })
    .sort((a, b) => a.lastName.localeCompare(b.lastName)), [db, q, filter, season.id]);

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
        <span style={{ alignSelf: 'center', fontSize: 13, color: 'var(--ink-soft)' }}>{rows.length} people</span>
        <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
          {caps.actingAsAdmin && (
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
            {rows.slice(0, 120).map((p) => {
              const m = p.memberships.find((x) => x.seasonId === season.id);
              const club = db.clubs.find((c) => c.id === p.mainClubId);
              const isAdminUser = !!p.authUserId && adminUserIds.has(p.authUserId);
              const hasPendingInvite = (db.accountInvites ?? []).some(
                (inv) => inv.personId === p.id && inv.status === 'pending',
              );
              return (
                <tr key={p.id}>
                  <td><Link to={`/admin/members/${p.id}`} style={{ fontWeight: 600 }}>{p.lastName}, {p.firstName}</Link></td>
                  <td>{p.kind === 'coach' ? <Badge tone="navy">Coach</Badge> : 'Athlete'}</td>
                  <td style={{ fontSize: 13.5 }}>{club?.name ?? <em>Independent</em>}</td>
                  <td>{club?.region ?? STATE_REGIONS[p.state] ?? 'Other'}</td>
                  <td>
                    {m?.status === 'active' ? (
                      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        <Badge tone="ok">Active</Badge>
                        {/* W13 task 6: revoke via confirmation modal */}
                        <button
                          className="btn small ghost"
                          style={{ fontSize: 11, padding: '1px 6px' }}
                          onClick={() => setRevoking({ person: p, seasonId: season.id })}
                        >
                          Revoke
                        </button>
                      </span>
                    ) : m?.status === 'pending-club-payment' ? (
                      <Badge tone="warn">Pending</Badge>
                    ) : (
                      <Badge tone="err">None</Badge>
                    )}
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
                      <label className="checkrow" style={{ margin: 0 }} data-tip="Grant or revoke league admin">
                        <input type="checkbox" checked={isAdminUser} onChange={() => toggleAdmin(p)} /> Admin
                      </label>
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
          onClose={() => setRevoking(null)}
        />
      )}
    </div>
  );
}
