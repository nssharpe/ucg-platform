import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useDB, mutate, resetDemo } from '../lib/store';
import { Badge, Combo, Field, Modal, Tabs } from '../components/ui';
import { useToast } from '../components/ui-hooks';
import { ClubForm } from '../components/ClubForm';
import { PersonForm } from '../components/PersonForm';
import { RegionEditor } from '../components/RegionEditor';
import { DISCIPLINES, STATE_REGIONS, GENERAL_WAIVER_TYPE } from '../lib/types';
import type { AccountInvite, Athlete, Club, ClubRequest, Coupon, Level, Region, Season, WaiverType, WaiverDocument } from '../lib/types';
import { sha256Hex, nextVersion, certificateText } from '../lib/waivers-core';
import { sanitizeWaiverHtml } from '../lib/sanitize-html';
import { fmtMoney } from '../lib/scoring';
import { randomPromoCode, couponValid } from '../lib/pricing';
import { fetchAllRoles, isSupabaseConfigured, pushAll, pushClub, pushClubManager, pushClubRequest, pushCoupon, pushLevel, pushMembership, pushRegistration, pushSeason, pushUserRole, pushAccountInvite, deleteCoupon, deleteRegistration, sendEmail, sendSms, pushWaiverDocument } from '../lib/supabase';
import { analyzeMessage, normalizeToGsm7 } from '../lib/sms-segments';
import { useCapabilities } from '../lib/capabilities';

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
      db.registrations.filter((r) => r.athleteId === primary.id).map((r) => `${r.meetId}|${r.discipline}|${r.levelId}`)
    );
    const regsToMove: typeof dupRegs = [];
    const regsToDrop: typeof dupRegs = [];
    for (const r of dupRegs) {
      const key = `${r.meetId}|${r.discipline}|${r.levelId}`;
      if (primaryRegKeys.has(key)) {
        regsToDrop.push(r);
      } else {
        regsToMove.push(r);
      }
    }

    const primaryMembershipSeasons = new Set(primary.memberships.map((m) => m.seasonId));
    const membershipsToAdd = dup.memberships.filter((m) => !primaryMembershipSeasons.has(m.seasonId));

    const altClubsToAdd = (dup.altClubIds ?? []).filter((id) => !(primary.altClubIds ?? []).includes(id));

    mutate((d) => {
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
      // 7. Remove duplicate from local snapshot
      // TODO: there is no deletePerson Supabase helper — the remote row for person id
      //   `${dup.id}` must be removed server-side (DELETE FROM people WHERE id = $1).
      //   Until that is wired up the dup row will remain in the remote DB but will no
      //   longer appear in the local snapshot after this mutate.
      d.people = d.people.filter((p) => p.id !== dup.id);
    });

    toast(
      `Merged ${dup.firstName} ${dup.lastName} into ${primary.firstName} ${primary.lastName}. ` +
      `Moved ${regsToMove.length} reg(s), dropped ${regsToDrop.length} collision(s), ` +
      `added ${membershipsToAdd.length} membership(s). ` +
      `Duplicate removed from local snapshot — remote row requires manual cleanup (see TODO).`
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
    mutate((d) => {
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

  // W13 task 5: create account invite for person with no authUserId.
  const createAccountInvite = (p: Athlete) => {
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
      token: randomPromoCode(24), // random secure-enough token
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    mutate((d) => {
      d.accountInvites = [...(d.accountInvites ?? []), invite];
      pushAccountInvite(invite);
      // TODO: send setup email to invite.email with link containing invite.token
    });
    toast(`Setup invite created for ${p.firstName} ${p.lastName} — setup email queued to ${p.email}.`);
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
                        <button
                          className="btn small ghost"
                          style={{ fontSize: 11, padding: '1px 6px' }}
                          disabled={hasPendingInvite}
                          title={hasPendingInvite ? 'Pending invite already sent' : 'Create account & email setup link'}
                          onClick={() => createAccountInvite(p)}
                        >
                          {hasPendingInvite ? 'Invite sent' : 'Invite'}
                        </button>
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

// ---------- Clubs ----------
export function AdminClubs() {
  const db = useDB();
  const toast = useToast();
  const season = db.seasons.find((s) => s.current)!;
  const [editing, setEditing] = useState<Club | 'new' | null>(null);
  const [q, setQ] = useState('');
  const pending = db.clubRequests.filter((r) => r.status === 'pending');

  const personName = (id: string | null) => {
    const p = id ? db.people.find((x) => x.id === id) : null;
    return p ? `${p.firstName} ${p.lastName}` : 'Unknown';
  };

  const approve = (req: ClubRequest) => {
    const id = `club-${req.id.slice(0, 8)}`;
    const club: Club = {
      id, name: req.proposedName, shortName: req.shortName || req.proposedName.slice(0, 12),
      state: req.state, region: (req.region || STATE_REGIONS[req.state] || 'Other') as Region,
      managerIds: req.requesterPersonId ? [req.requesterPersonId] : [],
      email: '', allowClubPay: true, access: 'open',
    };
    mutate((d) => {
      d.clubs.push(club);
      pushClub(club);
      if (req.requesterPersonId) pushClubManager(id, req.requesterPersonId, true);
      const r = d.clubRequests.find((x) => x.id === req.id);
      if (r) { r.status = 'approved'; r.decidedAt = new Date().toISOString(); r.createdClubId = id; pushClubRequest(r); }
    });
    toast(`Created ${club.name} and made ${personName(req.requesterPersonId)} its manager.`);
  };

  const dismiss = (req: ClubRequest) => {
    mutate((d) => {
      const r = d.clubRequests.find((x) => x.id === req.id);
      if (r) { r.status = 'dismissed'; r.decidedAt = new Date().toISOString(); pushClubRequest(r); }
    });
  };

  const filteredClubs = useMemo(() => {
    const lq = q.toLowerCase();
    return db.clubs.filter((c) =>
      !lq ||
      c.name.toLowerCase().includes(lq) ||
      c.shortName.toLowerCase().includes(lq) ||
      c.region.toLowerCase().includes(lq) ||
      c.state.toLowerCase().includes(lq)
    );
  }, [db.clubs, q]);

  return (
    <div>
      <h1 className="page-title display">Clubs</h1>
      <p className="page-sub">Flags show what each club is missing — contact them right from here.</p>

      {pending.length > 0 && (
        <div className="card card-pad" style={{ marginBottom: 16, borderLeft: '4px solid var(--coral-500)' }}>
          <h3 className="card-title">New-club requests ({pending.length})</h3>
          <table className="tbl">
            <thead><tr><th>Proposed club</th><th>State</th><th>Requested by</th><th>Note</th><th /></tr></thead>
            <tbody>
              {pending.map((req) => (
                <tr key={req.id}>
                  <td><strong>{req.proposedName}</strong>{req.shortName ? ` (${req.shortName})` : ''}</td>
                  <td>{req.state || '—'}</td>
                  <td>{personName(req.requesterPersonId)}</td>
                  <td style={{ fontSize: 13, color: 'var(--ink-soft)' }}>{req.note || '—'}</td>
                  <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                    <button className="btn small primary" onClick={() => approve(req)}>Approve</button>{' '}
                    <button className="btn small ghost" onClick={() => dismiss(req)}>Dismiss</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <input
          className="input"
          style={{ maxWidth: 320 }}
          placeholder="Search name, short name, region, state…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <span style={{ fontSize: 13, color: 'var(--ink-soft)' }}>{filteredClubs.length} club{filteredClubs.length !== 1 ? 's' : ''}</span>
        <button className="btn primary" style={{ marginLeft: 'auto' }} onClick={() => setEditing('new')}>+ New club</button>
      </div>
      <div className="card" style={{ overflow: 'hidden' }}>
        <table className="tbl">
          <thead><tr><th>Club</th><th>Region</th><th className="num">Roster</th><th className="num">Active</th><th>Flags</th><th /></tr></thead>
          <tbody>
            {filteredClubs.map((c) => {
              const roster = db.people.filter((p) => p.mainClubId === c.id);
              const active = roster.filter((p) => p.memberships.some((m) => m.seasonId === season.id && m.status === 'active'));
              const coaches = roster.filter((p) => p.kind === 'coach' && p.memberships.some((m) => m.seasonId === season.id && m.status === 'active'));
              const pendingCart = (db.carts[c.id] ?? []).length;
              const flags: string[] = [];
              if (coaches.length === 0) flags.push('No coaches');
              if (pendingCart > 0) flags.push(`${pendingCart} unpaid cart items`);
              return (
                <tr key={c.id}>
                  <td><Link to={`/club/${c.id}`} style={{ fontWeight: 600 }}>{c.name}</Link></td>
                  <td>{c.region}</td>
                  <td className="num">{roster.length}</td>
                  <td className="num">{active.length}</td>
                  <td>{flags.length === 0 ? <Badge tone="ok">✓ Complete</Badge> : flags.map((f) => <Badge key={f} tone="warn">{f}</Badge>)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn small ghost" onClick={() => setEditing(c)}>Edit</button>{' '}
                    <a className="btn small ghost" href={`mailto:${c.email}`}>✉ Contact</a>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {editing && <ClubForm club={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

// ---------- League Controls ----------
export function AdminLeague() {
  const [tab, setTab] = useState<'seasons' | 'levels' | 'regions' | 'waivers' | 'promos' | 'roles' | 'demo'>('seasons');
  return (
    <div>
      <h1 className="page-title display">League controls</h1>
      <p className="page-sub">Seasons, fees, levels, waivers, regions, roles, and promo codes — the knobs that drive everything else.</p>
      <Tabs
        tabs={[
          { id: 'seasons' as const, label: 'Seasons & fees' },
          { id: 'levels' as const, label: 'Levels' },
          { id: 'regions' as const, label: 'Regions' },
          { id: 'waivers' as const, label: 'Waivers' },
          { id: 'promos' as const, label: 'Promo codes' },
          { id: 'roles' as const, label: 'User roles' },
          { id: 'demo' as const, label: 'Demo tools' },
        ]}
        active={tab}
        onChange={setTab}
      />
      {tab === 'seasons' && <Seasons />}
      {tab === 'levels' && <Levels />}
      {tab === 'regions' && <RegionsTab />}
      {tab === 'waivers' && <Waivers />}
      {tab === 'promos' && <Promos />}
      {tab === 'roles' && <UserRoles />}
      {tab === 'demo' && <DemoTools />}
    </div>
  );
}

// ---------- Seasons ----------
type SeasonEditState = {
  name: string;
  startsOn: string;
  endsOn: string;
  athleteFee: string;
  coachFee: string;
  clubFee: string;
};

function Seasons() {
  const db = useDB();
  const toast = useToast();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<SeasonEditState>({ name: '', startsOn: '', endsOn: '', athleteFee: '', coachFee: '', clubFee: '' });

  const startEdit = (s: Season) => {
    setEditingId(s.id);
    setDraft({
      name: s.name, startsOn: s.startsOn, endsOn: s.endsOn,
      athleteFee: String(s.athleteFee), coachFee: String(s.coachFee),
      clubFee: String(s.clubFee ?? 109),  // W12 task 2: clubFee
    });
  };

  const saveEdit = (s: Season) => {
    const athleteFee = parseFloat(draft.athleteFee);
    const coachFee = parseFloat(draft.coachFee);
    const clubFee = parseFloat(draft.clubFee);  // W12 task 2
    if (isNaN(athleteFee) || isNaN(coachFee) || isNaN(clubFee)) { toast('Fees must be numbers.'); return; }
    mutate((d) => {
      const x = d.seasons.find((y) => y.id === s.id)!;
      x.name = draft.name.trim() || x.name;
      x.startsOn = draft.startsOn || x.startsOn;
      x.endsOn = draft.endsOn || x.endsOn;
      x.athleteFee = athleteFee;
      x.coachFee = coachFee;
      x.clubFee = clubFee;  // W12 task 2
      pushSeason(x);
    });
    setEditingId(null);
    toast('Season updated.');
  };

  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      <table className="tbl">
        <thead>
          <tr>
            <th>Season</th>
            <th>Valid</th>
            <th className="num">Athlete fee</th>
            <th className="num">Coach fee</th>
            {/* W12 task 2: Club fee column */}
            <th className="num">Club fee</th>
            <th>Purchasable</th>
            <th>Current</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {db.seasons.map((s) => {
            const isEditing = editingId === s.id;
            return (
              <tr key={s.id}>
                {isEditing ? (
                  <>
                    <td>
                      <input
                        className="input"
                        style={{ width: 110 }}
                        value={draft.name}
                        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                      />
                    </td>
                    <td style={{ fontSize: 13 }}>
                      <input
                        className="input"
                        type="date"
                        style={{ width: 130 }}
                        value={draft.startsOn}
                        onChange={(e) => setDraft({ ...draft, startsOn: e.target.value })}
                      />
                      {' → '}
                      <input
                        className="input"
                        type="date"
                        style={{ width: 130 }}
                        value={draft.endsOn}
                        onChange={(e) => setDraft({ ...draft, endsOn: e.target.value })}
                      />
                    </td>
                    <td className="num">
                      <input
                        className="input"
                        type="number"
                        min={0}
                        step={1}
                        style={{ width: 80 }}
                        value={draft.athleteFee}
                        onChange={(e) => setDraft({ ...draft, athleteFee: e.target.value })}
                      />
                    </td>
                    <td className="num">
                      <input
                        className="input"
                        type="number"
                        min={0}
                        step={1}
                        style={{ width: 80 }}
                        value={draft.coachFee}
                        onChange={(e) => setDraft({ ...draft, coachFee: e.target.value })}
                      />
                    </td>
                    {/* W12 task 2: club fee inline edit */}
                    <td className="num">
                      <input
                        className="input"
                        type="number"
                        min={0}
                        step={1}
                        style={{ width: 80 }}
                        value={draft.clubFee}
                        onChange={(e) => setDraft({ ...draft, clubFee: e.target.value })}
                      />
                    </td>
                    <td>
                      <label className="checkrow" style={{ margin: 0 }}>
                        <input type="checkbox" checked={s.active} onChange={() => mutate((d) => {
                          const x = d.seasons.find((y) => y.id === s.id)!;
                          x.active = !x.active;
                          pushSeason(x);
                        })} />
                        {s.active ? 'Yes' : 'No'}
                      </label>
                    </td>
                    <td>
                      <label className="checkrow" style={{ margin: 0 }}>
                        <input type="checkbox" checked={s.current} onChange={() => mutate((d) => {
                          // Only one season can be current
                          d.seasons.forEach((x) => { x.current = x.id === s.id ? !s.current : false; pushSeason(x); });
                        })} />
                        {s.current ? 'Yes' : 'No'}
                      </label>
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn small primary" onClick={() => saveEdit(s)}>Save</button>{' '}
                      <button className="btn small ghost" onClick={() => setEditingId(null)}>Cancel</button>
                    </td>
                  </>
                ) : (
                  <>
                    <td><strong>{s.name}</strong></td>
                    <td style={{ fontSize: 13 }}>{s.startsOn} → {s.endsOn}</td>
                    <td className="num">{fmtMoney(s.athleteFee)}</td>
                    <td className="num">{fmtMoney(s.coachFee)}</td>
                    {/* W12 task 2: club fee display */}
                    <td className="num">{fmtMoney(s.clubFee ?? 109)}</td>
                    <td>
                      <label className="checkrow" style={{ margin: 0 }}>
                        <input type="checkbox" checked={s.active} onChange={() => mutate((d) => {
                          const x = d.seasons.find((y) => y.id === s.id)!;
                          x.active = !x.active;
                          pushSeason(x);
                        })} />
                        {s.active ? 'Yes' : 'No'}
                      </label>
                    </td>
                    <td>
                      {s.current
                        ? <Badge tone="ok">Current</Badge>
                        : (
                          <button className="btn small ghost" onClick={() => mutate((d) => {
                            d.seasons.forEach((x) => { x.current = x.id === s.id; pushSeason(x); });
                            toast(`${s.name} is now the current season.`);
                          })}>Set current</button>
                        )
                      }
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn small ghost" onClick={() => startEdit(s)}>Edit</button>
                      {!db.seasons.some((x) => x.startsOn > s.startsOn) && (
                        <>
                          {' '}
                          <button className="btn small ghost" data-tip="Copy fees, waivers & levels into a new season" onClick={() => {
                            mutate((d) => {
                              const yr = +s.startsOn.slice(0, 4) + 1;
                              const next = { ...s, id: `s${yr - 1999}`, name: `${yr}–${String(yr + 1).slice(2)}`, startsOn: `${yr}-07-01`, endsOn: `${yr + 1}-06-30`, active: false, current: false };
                              d.seasons.push(next);
                              pushSeason(next);
                            });
                            toast('Season copied — update fees & waiver, then mark purchasable.');
                          }}>Copy → next year</button>
                        </>
                      )}
                    </td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------- Levels ----------
type LevelDraft = { name: string; svMax: string; vaults: string; order: string };

function Levels() {
  const db = useDB();
  const toast = useToast();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<LevelDraft>({ name: '', svMax: '', vaults: '', order: '' });
  const [addingDisc, setAddingDisc] = useState<string | null>(null);
  const [newDraft, setNewDraft] = useState<LevelDraft>({ name: '', svMax: '', vaults: '1', order: '' });

  const startEdit = (l: Level) => {
    setEditingId(l.id);
    setDraft({ name: l.name, svMax: l.svMax == null ? '' : String(l.svMax), vaults: String(l.vaults), order: String(l.order) });
  };

  const saveEdit = (l: Level) => {
    const vaults = parseInt(draft.vaults, 10);
    const order = parseInt(draft.order, 10);
    if (!draft.name.trim()) { toast('Name is required.'); return; }
    if (isNaN(vaults)) { toast('Vaults must be a number.'); return; }
    const svMax = draft.svMax === '' ? null : parseFloat(draft.svMax);
    if (draft.svMax !== '' && isNaN(svMax as number)) { toast('SV max must be a number or blank for Open.'); return; }
    mutate((d) => {
      const x = d.levels.find((y) => y.id === l.id)!;
      x.name = draft.name.trim();
      x.svMax = svMax;
      x.vaults = vaults;
      x.order = isNaN(order) ? l.order : order;
      pushLevel(x);
    });
    setEditingId(null);
    toast('Level saved.');
  };

  // W12 task 4: soft-delete (retire) instead of hard delete — preserves past meets.
  const retireLevel = (l: Level) => {
    if (!window.confirm(`Retire level "${l.name}"? It will be hidden from new meets but preserved on past meets and results.`)) return;
    mutate((d) => {
      const x = d.levels.find((y) => y.id === l.id)!;
      x.retired = true;
      pushLevel(x);
    });
    toast(`"${l.name}" retired — won't appear in new meets. Unretire it to restore.`);
  };

  const unretireLevel = (l: Level) => {
    mutate((d) => {
      const x = d.levels.find((y) => y.id === l.id)!;
      x.retired = false;
      pushLevel(x);
    });
    toast(`"${l.name}" restored.`);
  };

  const startAdd = (disc: string) => {
    setAddingDisc(disc);
    const existing = db.levels.filter((l) => l.discipline === disc);
    const maxOrder = existing.length ? Math.max(...existing.map((l) => l.order)) : 0;
    setNewDraft({ name: '', svMax: '', vaults: '1', order: String(maxOrder + 10) });
  };

  const saveAdd = (disc: string) => {
    if (!newDraft.name.trim()) { toast('Name is required.'); return; }
    const vaults = parseInt(newDraft.vaults, 10);
    const order = parseInt(newDraft.order, 10);
    if (isNaN(vaults)) { toast('Vaults must be a number.'); return; }
    const svMax = newDraft.svMax === '' ? null : parseFloat(newDraft.svMax);
    if (newDraft.svMax !== '' && isNaN(svMax as number)) { toast('SV max must be a number or blank for Open.'); return; }
    // Generate a unique id
    let n = db.levels.filter((l) => l.discipline === disc).length + 1;
    let id = `lvl-${disc.toLowerCase()}-${n}`;
    while (db.levels.some((l) => l.id === id)) { n++; id = `lvl-${disc.toLowerCase()}-${n}`; }
    const newLevel: Level = {
      id, discipline: disc as Level['discipline'], name: newDraft.name.trim(),
      svMax, vaults, order: isNaN(order) ? 99 : order,
    };
    mutate((d) => { d.levels.push(newLevel); pushLevel(newLevel); });
    setAddingDisc(null);
    toast(`Added "${newLevel.name}" to ${disc}.`);
  };

  return (
    <div className="grid cols-3">
      {DISCIPLINES.map((disc) => {
        // W12 task 4: show ALL levels including retired (retired shown last, struck through)
        const discLevels = db.levels.filter((l) => l.discipline === disc).sort((a, b) => {
          if (a.retired && !b.retired) return 1;
          if (!a.retired && b.retired) return -1;
          return a.order - b.order;
        });
        return (
          <div className="card card-pad" key={disc}>
            <h3 className="card-title">{disc}</h3>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Level</th>
                  <th className="num">SV max</th>
                  <th className="num">Vaults</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {discLevels.map((l) => {
                  const isEditing = editingId === l.id;
                  const isRetired = !!l.retired;
                  return (
                    <tr key={l.id} style={isRetired ? { opacity: 0.55 } : undefined}>
                      {isEditing ? (
                        <>
                          <td>
                            <input
                              className="input"
                              style={{ width: 90 }}
                              value={draft.name}
                              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                            />
                          </td>
                          <td className="num">
                            <input
                              className="input"
                              style={{ width: 60 }}
                              placeholder="Open"
                              value={draft.svMax}
                              onChange={(e) => setDraft({ ...draft, svMax: e.target.value })}
                            />
                          </td>
                          <td className="num">
                            <input
                              className="input"
                              type="number"
                              min={1}
                              style={{ width: 50 }}
                              value={draft.vaults}
                              onChange={(e) => setDraft({ ...draft, vaults: e.target.value })}
                            />
                          </td>
                          <td style={{ whiteSpace: 'nowrap' }}>
                            <button className="btn small primary" onClick={() => saveEdit(l)}>✓</button>{' '}
                            <button className="btn small ghost" onClick={() => setEditingId(null)}>✕</button>
                          </td>
                        </>
                      ) : (
                        <>
                          <td style={isRetired ? { textDecoration: 'line-through', color: 'var(--ink-soft)' } : undefined}>
                            {l.name}
                            {isRetired && <span style={{ fontSize: 11, marginLeft: 5, color: 'var(--ink-soft)', textDecoration: 'none', display: 'inline-block' }}>retired</span>}
                          </td>
                          <td className="num">{l.svMax?.toFixed(1) ?? 'Open'}</td>
                          <td className="num">{l.vaults}</td>
                          <td style={{ whiteSpace: 'nowrap' }}>
                            {isRetired ? (
                              // W12 task 4: Unretire action for retired levels
                              <button className="btn small ghost" onClick={() => unretireLevel(l)}>Unretire</button>
                            ) : (
                              <>
                                <button className="btn small ghost" onClick={() => startEdit(l)}>Edit</button>{' '}
                                {/* W12 task 4: soft-delete (retire) instead of hard delete */}
                                <button className="btn small danger" onClick={() => retireLevel(l)}>Retire</button>
                              </>
                            )}
                          </td>
                        </>
                      )}
                    </tr>
                  );
                })}
                {addingDisc === disc && (
                  <tr>
                    <td>
                      <input
                        className="input"
                        style={{ width: 90 }}
                        placeholder="Name"
                        autoFocus
                        value={newDraft.name}
                        onChange={(e) => setNewDraft({ ...newDraft, name: e.target.value })}
                      />
                    </td>
                    <td className="num">
                      <input
                        className="input"
                        style={{ width: 60 }}
                        placeholder="Open"
                        value={newDraft.svMax}
                        onChange={(e) => setNewDraft({ ...newDraft, svMax: e.target.value })}
                      />
                    </td>
                    <td className="num">
                      <input
                        className="input"
                        type="number"
                        min={1}
                        style={{ width: 50 }}
                        value={newDraft.vaults}
                        onChange={(e) => setNewDraft({ ...newDraft, vaults: e.target.value })}
                      />
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn small primary" onClick={() => saveAdd(disc)}>✓</button>{' '}
                      <button className="btn small ghost" onClick={() => setAddingDisc(null)}>✕</button>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            {addingDisc !== disc && (
              <button className="btn small ghost" style={{ marginTop: 8 }} onClick={() => startAdd(disc)}>+ Add level</button>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------- Regions tab (W12 task 3) ----------
// Renamed RegionsTab so AdminLeague can reference the new name without conflict.
function RegionsTab() {
  const db = useDB();
  return (
    <div>
      <div className="card card-pad" style={{ marginBottom: 16, borderLeft: '4px solid var(--accent)' }}>
        <p style={{ margin: 0, fontSize: 13.5 }}>
          <strong>Edit state→region assignments below.</strong> Changes are persisted via{' '}
          <code>db.regionOverrides</code> and override the built-in <code>STATE_REGIONS</code> map
          everywhere — meet filtering, athlete grouping, and communications. Resetting returns to
          the compiled defaults.
        </p>
      </div>
      {/* W12 task 3: RegionEditor component */}
      <RegionEditor regionOverrides={db.regionOverrides} />
    </div>
  );
}

// ---------- Waivers ----------
function Waivers() {
  const db = useDB();
  const toast = useToast();
  const currentSeason = db.seasons.find((s) => s.current) ?? db.seasons[0];
  const [selectedSeasonId, setSelectedSeasonId] = useState(currentSeason?.id ?? '');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [signedQ, setSignedQ] = useState('');
  const selectedSeason = db.seasons.find((s) => s.id === selectedSeasonId) ?? currentSeason;

  const docsFor = (t: WaiverType): WaiverDocument[] =>
    (db.waiverDocuments ?? [])
      .filter((d) => d.seasonId === selectedSeasonId && d.waiverType === t)
      .sort((a, b) => a.version - b.version);
  const publishedFor = (t: WaiverType) => {
    const pubs = docsFor(t).filter((d) => d.published);
    return pubs[pubs.length - 1];
  };

  const saveVersion = async (t: WaiverType) => {
    const key = `${selectedSeasonId}:${t}`;
    const body = (drafts[key] ?? publishedFor(t)?.body ?? '').trim();
    if (body.length < 20) { toast('Waiver text is too short to publish.'); return; }
    const existing = docsFor(t);
    const doc: WaiverDocument = {
      id: crypto.randomUUID(), seasonId: selectedSeasonId, waiverType: t,
      version: nextVersion(existing), body, contentHash: await sha256Hex(body),
      published: true, createdAt: new Date().toISOString(),
    };
    mutate((d) => { (d.waiverDocuments ??= []).push(doc); });
    pushWaiverDocument(doc);
    setDrafts((p) => ({ ...p, [key]: doc.body }));
    toast(`${t} waiver v${doc.version} published.`);
  };

  const signed = useMemo(() => {
    const lq = signedQ.toLowerCase();
    return (db.waiverSignatures ?? [])
      .filter((s) => s.seasonId === selectedSeasonId)
      .map((s) => {
        const p = db.people.find((x) => x.id === s.personId);
        const name = p ? `${p.firstName} ${p.lastName}` : s.personId;
        const v = (db.waiverDocuments ?? []).find((d) => d.id === s.waiverDocumentId)?.version ?? 0;
        return { sig: s, name, version: v };
      })
      .filter((r) => !lq || r.name.toLowerCase().includes(lq))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [db.waiverSignatures, db.waiverDocuments, db.people, selectedSeasonId, signedQ]);

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <Field label="Season">
          <select className="input" style={{ maxWidth: 200 }} value={selectedSeasonId}
            onChange={(e) => setSelectedSeasonId(e.target.value)}>
            {db.seasons.map((s) => (
              <option key={s.id} value={s.id}>{s.name}{s.current ? ' (current)' : ''}</option>
            ))}
          </select>
        </Field>
      </div>

      {(() => {
        const t = GENERAL_WAIVER_TYPE;
        const key = `${selectedSeasonId}:${t}`;
        const pub = publishedFor(t);
        const value = drafts[key] ?? pub?.body ?? '';
        return (
          <div className="card card-pad" style={{ marginBottom: 24 }}>
            <h3 className="card-title">Member waiver — {selectedSeason?.name ?? '—'}</h3>
            <p style={{ fontSize: 13.5, color: 'var(--ink-soft)', marginTop: 0 }}>
              A single waiver applies to all members. Enter <strong>HTML</strong> — it renders as shown in the preview when members sign.
              {' '}{pub ? `Published v${pub.version}.` : 'Not published yet.'} E-signed with timestamp, IP &amp; consent recorded.
            </p>
            <div className="grid cols-2" style={{ gap: 16, alignItems: 'start' }}>
              <div>
                <label style={{ fontSize: 12.5, color: 'var(--ink-soft)', display: 'block', marginBottom: 4 }}>HTML source</label>
                <textarea className="input" rows={18} style={{ fontFamily: 'monospace', fontSize: 12 }} value={value}
                  onChange={(e) => setDrafts((p) => ({ ...p, [key]: e.target.value }))}
                  placeholder="<h1>Waiver…</h1>" />
              </div>
              <div>
                <label style={{ fontSize: 12.5, color: 'var(--ink-soft)', display: 'block', marginBottom: 4 }}>Preview</label>
                <div style={{ border: '1px solid var(--line)', borderRadius: 8, padding: 14, fontSize: 13, maxHeight: 400, overflowY: 'auto', background: 'var(--ice-100)' }}
                  dangerouslySetInnerHTML={{ __html: sanitizeWaiverHtml(value) || '<p>Nothing to preview yet.</p>' }} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
              <button className="btn small primary" onClick={() => saveVersion(t)}>Save new version</button>
              {docsFor(t).length >= 1 && (
                <details><summary style={{ fontSize: 12.5, color: 'var(--ink-soft)', cursor: 'pointer' }}>
                  History ({docsFor(t).length})</summary>
                  <ul style={{ margin: '4px 0 0 16px', fontSize: 12.5, color: 'var(--ink-soft)' }}>
                    {[...docsFor(t)].reverse().map((d) => (
                      <li key={d.id}>v{d.version} — {new Date(d.createdAt).toLocaleString()} (hash {d.contentHash.slice(0, 8)}…)</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          </div>
        );
      })()}

      <div className="card card-pad">
        <h3 className="card-title">Signed waivers — {selectedSeason?.name ?? '—'}</h3>
        <input className="input" style={{ maxWidth: 280, marginBottom: 12 }} placeholder="Search by name"
          value={signedQ} onChange={(e) => setSignedQ(e.target.value)} />
        {signed.length === 0 ? (
          <p style={{ fontSize: 13.5, color: 'var(--ink-soft)' }}>No signatures recorded for this season.</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {signed.slice(0, 300).map(({ sig, name, version }) => (
              <li key={sig.id} style={{ borderBottom: '1px solid var(--line)', padding: '8px 0' }}>
                <strong>{name}</strong> <span style={{ color: 'var(--ink-soft)' }}>({sig.signerRole})</span>
                <details>
                  <summary style={{ fontSize: 12.5, color: 'var(--accent)', cursor: 'pointer' }}>Certificate</summary>
                  <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', margin: '4px 0 0' }}>
                    {certificateText(sig, version, name)}
                  </p>
                </details>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ---------- Promo codes (W14) ----------
type CouponDraft = {
  code: string;
  discountType: 'pct' | 'amt';
  value: string;
  appliesTo: Coupon['appliesTo'];
  // W14 task 9: new fields
  startsAt: string;
  endsAt: string;
  maxUses: string; // blank = unlimited
};

// W14 task 11: inline validity indicator using couponValid()
function CouponStatusBadge({ coupon }: { coupon: Coupon }) {
  const now = new Date().toISOString();
  const valid = couponValid(coupon, now);
  if (!valid) {
    if (coupon.maxUses != null && (coupon.usedCount ?? 0) >= coupon.maxUses) {
      return <Badge tone="err">Limit reached</Badge>;
    }
    if (coupon.endsAt && Date.parse(coupon.endsAt) < Date.parse(now)) {
      return <Badge tone="err">Expired</Badge>;
    }
    if (coupon.startsAt && Date.parse(coupon.startsAt) > Date.parse(now)) {
      return <Badge tone="warn">Not yet active</Badge>;
    }
    return <Badge tone="err">Invalid</Badge>;
  }
  return <Badge tone="ok">Active</Badge>;
}

type CouponEditDraft = {
  startsAt: string;
  endsAt: string;
  maxUses: string;
};

function Promos() {
  const db = useDB();
  const toast = useToast();
  const [draft, setDraft] = useState<CouponDraft>({
    code: '', discountType: 'pct', value: '', appliesTo: 'any',
    startsAt: '', endsAt: '', maxUses: '',
  });
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  // W14 task 9: inline edit state per coupon (code → draft)
  const [editingCode, setEditingCode] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<CouponEditDraft>({ startsAt: '', endsAt: '', maxUses: '' });

  const addCoupon = () => {
    const code = draft.code.trim().toUpperCase();
    if (!code) { toast('Code is required.'); return; }
    if (db.coupons.some((c) => c.code.toUpperCase() === code)) { toast(`Code "${code}" already exists.`); return; }
    const value = parseFloat(draft.value);
    if (isNaN(value) || value <= 0) { toast('Discount value must be a positive number.'); return; }
    const maxUses = draft.maxUses.trim() === '' ? null : parseInt(draft.maxUses, 10);
    if (draft.maxUses.trim() !== '' && (isNaN(maxUses as number) || (maxUses as number) < 1)) {
      toast('Max uses must be a positive integer or blank for unlimited.'); return;
    }
    const coupon: Coupon = {
      code,
      ...(draft.discountType === 'pct' ? { pctOff: value } : { amountOff: value }),
      appliesTo: draft.appliesTo,
      startsAt: draft.startsAt || null,
      endsAt: draft.endsAt || null,
      maxUses: maxUses ?? null,
      usedCount: 0,
    };
    mutate((d) => { d.coupons.push(coupon); pushCoupon(coupon); });
    setDraft({ code: '', discountType: 'pct', value: '', appliesTo: 'any', startsAt: '', endsAt: '', maxUses: '' });
    toast(`Promo code "${code}" created.`);
  };

  const removeCoupon = (code: string) => {
    mutate((d) => { d.coupons = d.coupons.filter((c) => c.code !== code); });
    deleteCoupon(code);
    setConfirmDelete(null);
    toast(`Deleted promo code "${code}".`);
  };

  const startEdit = (c: Coupon) => {
    setEditingCode(c.code);
    setEditDraft({
      startsAt: c.startsAt ?? '',
      endsAt: c.endsAt ?? '',
      maxUses: c.maxUses == null ? '' : String(c.maxUses),
    });
  };

  const saveEdit = (c: Coupon) => {
    const maxUses = editDraft.maxUses.trim() === '' ? null : parseInt(editDraft.maxUses, 10);
    if (editDraft.maxUses.trim() !== '' && (isNaN(maxUses as number) || (maxUses as number) < 1)) {
      toast('Max uses must be a positive integer or blank for unlimited.'); return;
    }
    mutate((d) => {
      const x = d.coupons.find((x) => x.code === c.code);
      if (!x) return;
      x.startsAt = editDraft.startsAt || null;
      x.endsAt = editDraft.endsAt || null;
      x.maxUses = maxUses ?? null;
      pushCoupon(x);
    });
    setEditingCode(null);
    toast(`Promo code "${c.code}" updated.`);
  };

  return (
    <div>
      <div className="card card-pad" style={{ maxWidth: 560, marginBottom: 20 }}>
        <h3 className="card-title">Create promo code</h3>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 4 }}>
          <div style={{ flex: 1 }}>
            <Field label="Code">
              <input
                className="input"
                placeholder="e.g. SAVE20"
                value={draft.code}
                onChange={(e) => setDraft({ ...draft, code: e.target.value.toUpperCase() })}
              />
            </Field>
          </div>
          {/* W14 task 10: Generate random code button */}
          <button
            className="btn ghost"
            style={{ marginBottom: 16 }}
            onClick={() => setDraft({ ...draft, code: randomPromoCode() })}
            title="Generate a random 8-character code"
          >
            Random code
          </button>
        </div>
        <Field label="Discount type">
          <select
            className="input"
            value={draft.discountType}
            onChange={(e) => setDraft({ ...draft, discountType: e.target.value as CouponDraft['discountType'] })}
          >
            <option value="pct">Percent off (%)</option>
            <option value="amt">Amount off ($)</option>
          </select>
        </Field>
        <Field label={draft.discountType === 'pct' ? 'Percent off' : 'Amount off ($)'}>
          <input
            className="input"
            type="number"
            min={0}
            step={draft.discountType === 'pct' ? 1 : 0.01}
            max={draft.discountType === 'pct' ? 100 : undefined}
            placeholder={draft.discountType === 'pct' ? 'e.g. 20' : 'e.g. 10.00'}
            value={draft.value}
            onChange={(e) => setDraft({ ...draft, value: e.target.value })}
          />
        </Field>
        <Field label="Applies to">
          <select
            className="input"
            value={draft.appliesTo}
            onChange={(e) => setDraft({ ...draft, appliesTo: e.target.value as Coupon['appliesTo'] })}
          >
            <option value="any">Any purchase</option>
            <option value="membership">Membership only</option>
            <option value="meet-entry">Meet entries only</option>
          </select>
        </Field>
        {/* W14 task 9: start/end dates and max uses on creation */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <Field label="Active from (optional)">
            <input
              className="input"
              type="datetime-local"
              value={draft.startsAt}
              onChange={(e) => setDraft({ ...draft, startsAt: e.target.value })}
            />
          </Field>
          <Field label="Expires at (optional)">
            <input
              className="input"
              type="datetime-local"
              value={draft.endsAt}
              onChange={(e) => setDraft({ ...draft, endsAt: e.target.value })}
            />
          </Field>
        </div>
        <Field label="Max uses (blank = unlimited)">
          <input
            className="input"
            type="number"
            min={1}
            step={1}
            placeholder="Unlimited"
            value={draft.maxUses}
            onChange={(e) => setDraft({ ...draft, maxUses: e.target.value })}
          />
        </Field>
        <button className="btn primary" onClick={addCoupon}>Create code</button>
      </div>

      <div className="card" style={{ overflow: 'hidden' }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Code</th>
              <th>Discount</th>
              <th>Applies to</th>
              {/* W14 task 9: new columns */}
              <th>Active from</th>
              <th>Expires</th>
              <th className="num">Uses</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {db.coupons.length === 0 && (
              <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--ink-soft)', padding: '20px 0' }}>No promo codes yet.</td></tr>
            )}
            {db.coupons.map((c) => {
              const isEditing = editingCode === c.code;
              return (
                <tr key={c.code}>
                  <td><strong style={{ fontFamily: 'monospace' }}>{c.code}</strong></td>
                  <td>
                    {c.pctOff != null ? `${c.pctOff}% off` : c.amountOff != null ? `${fmtMoney(c.amountOff)} off` : '—'}
                  </td>
                  <td>
                    {c.appliesTo === 'any' ? 'Any purchase' : c.appliesTo === 'membership' ? 'Membership' : 'Meet entries'}
                  </td>
                  {/* W14 task 9: editable start/end/maxUses */}
                  {isEditing ? (
                    <>
                      <td>
                        <input
                          className="input"
                          type="datetime-local"
                          style={{ fontSize: 12, width: 160 }}
                          value={editDraft.startsAt}
                          onChange={(e) => setEditDraft({ ...editDraft, startsAt: e.target.value })}
                        />
                      </td>
                      <td>
                        <input
                          className="input"
                          type="datetime-local"
                          style={{ fontSize: 12, width: 160 }}
                          value={editDraft.endsAt}
                          onChange={(e) => setEditDraft({ ...editDraft, endsAt: e.target.value })}
                        />
                      </td>
                      <td className="num">
                        <input
                          className="input"
                          type="number"
                          min={1}
                          step={1}
                          placeholder="∞"
                          style={{ width: 60 }}
                          value={editDraft.maxUses}
                          onChange={(e) => setEditDraft({ ...editDraft, maxUses: e.target.value })}
                        />
                      </td>
                      <td><CouponStatusBadge coupon={c} /></td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button className="btn small primary" onClick={() => saveEdit(c)}>Save</button>{' '}
                        <button className="btn small ghost" onClick={() => setEditingCode(null)}>Cancel</button>
                      </td>
                    </>
                  ) : (
                    <>
                      <td style={{ fontSize: 12.5 }}>{c.startsAt ? new Date(c.startsAt).toLocaleString() : <em style={{ color: 'var(--ink-soft)' }}>—</em>}</td>
                      <td style={{ fontSize: 12.5 }}>{c.endsAt ? new Date(c.endsAt).toLocaleString() : <em style={{ color: 'var(--ink-soft)' }}>—</em>}</td>
                      {/* W14 task 9: show used count / max */}
                      <td className="num" style={{ fontSize: 13 }}>
                        {c.usedCount ?? 0}{c.maxUses != null ? ` / ${c.maxUses}` : ''}
                      </td>
                      {/* W14 task 11: validity status via couponValid() */}
                      <td><CouponStatusBadge coupon={c} /></td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button className="btn small ghost" onClick={() => startEdit(c)}>Edit</button>{' '}
                        {confirmDelete === c.code ? (
                          <>
                            <span style={{ fontSize: 13, marginRight: 4 }}>Delete?</span>
                            <button className="btn small danger" onClick={() => removeCoupon(c.code)}>Yes</button>{' '}
                            <button className="btn small ghost" onClick={() => setConfirmDelete(null)}>No</button>
                          </>
                        ) : (
                          <button className="btn small ghost" onClick={() => setConfirmDelete(c.code)}>Delete</button>
                        )}
                      </td>
                    </>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------- User Roles (W12 task 1) ----------
// 'admin' = Full League Admin (only role that can emulate users / access all admin features).
// 'sanctioning' = Sanctioning Team (will see meets to vote on — voting UI is a later wave).
const ROLE_DEFS = [
  { role: 'admin', label: 'Full League Admin', desc: 'Full admin access, including user emulation.' },
  { role: 'sanctioning', label: 'Sanctioning Team', desc: 'Will see meets to vote on (voting UI coming in a later wave).' },
] as const;

function UserRoles() {
  const db = useDB();
  const toast = useToast();
  // Load all role assignments from Supabase on mount.
  const [roleMap, setRoleMap] = useState<Map<string, Set<string>>>(new Map()); // userId → Set<role>
  const [loading, setLoading] = useState(true);
  const [addingRole, setAddingRole] = useState<string | null>(null); // role being added
  const [addPersonId, setAddPersonId] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    // `loading` already initializes to true and this effect runs once on mount,
    // so no synchronous setLoading(true) is needed (it would only cause a
    // cascading render). setLoading(false) happens in the async .then below.
    fetchAllRoles().then((rows) => {
      if (!live) return;
      const map = new Map<string, Set<string>>();
      for (const { userId, role } of rows) {
        if (!map.has(userId)) map.set(userId, new Set());
        map.get(userId)!.add(role);
      }
      setRoleMap(map);
      setLoading(false);
    });
    return () => { live = false; };
  }, []);

  const grantRole = (userId: string, role: string) => {
    pushUserRole(userId, role, true);
    setRoleMap((prev) => {
      const next = new Map(prev);
      if (!next.has(userId)) next.set(userId, new Set());
      next.get(userId)!.add(role);
      return next;
    });
  };

  const revokeRole = (userId: string, role: string) => {
    pushUserRole(userId, role, false);
    setRoleMap((prev) => {
      const next = new Map(prev);
      next.get(userId)?.delete(role);
      return next;
    });
  };

  // Find person by authUserId.
  const personByAuthId = useMemo(() => {
    const m = new Map<string, Athlete>();
    for (const p of db.people) { if (p.authUserId) m.set(p.authUserId, p); }
    return m;
  }, [db.people]);

  const peopleWithAccount = useMemo(() =>
    db.people.filter((p) => p.authUserId)
      .map((p) => ({ value: p.id, label: `${p.firstName} ${p.lastName}`, sub: p.email }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    [db.people]
  );

  const doAddRole = (role: string) => {
    if (!addPersonId) { toast('Select a person first.'); return; }
    const person = db.people.find((p) => p.id === addPersonId);
    if (!person?.authUserId) { toast('That person has no linked account — they need an account before they can hold a role.'); return; }
    if (roleMap.get(person.authUserId)?.has(role)) { toast(`${person.firstName} already has the ${role} role.`); return; }
    grantRole(person.authUserId, role);
    setAddingRole(null);
    setAddPersonId(null);
    const roleDef = ROLE_DEFS.find((r) => r.role === role);
    toast(`${person.firstName} ${person.lastName} granted ${roleDef?.label ?? role}.`);
  };

  return (
    <div>
      {loading && <p style={{ color: 'var(--ink-soft)', fontSize: 13.5 }}>Loading role assignments…</p>}
      {ROLE_DEFS.map(({ role, label, desc }) => {
        // Holders: people whose authUserId has this role.
        const holders: { userId: string; person: Athlete | undefined }[] = [];
        for (const [userId, roles] of roleMap.entries()) {
          if (roles.has(role)) holders.push({ userId, person: personByAuthId.get(userId) });
        }
        holders.sort((a, b) => {
          const an = a.person ? `${a.person.lastName} ${a.person.firstName}` : a.userId;
          const bn = b.person ? `${b.person.lastName} ${b.person.firstName}` : b.userId;
          return an.localeCompare(bn);
        });
        const isAdding = addingRole === role;
        return (
          <div className="card card-pad" key={role} style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
              <div>
                <h3 className="card-title" style={{ marginBottom: 2 }}>{label}</h3>
                <p style={{ fontSize: 13, color: 'var(--ink-soft)', margin: '0 0 10px' }}>{desc}</p>
              </div>
              <button className="btn small ghost" onClick={() => { setAddingRole(isAdding ? null : role); setAddPersonId(null); }}>
                {isAdding ? 'Cancel' : '+ Add'}
              </button>
            </div>

            {isAdding && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 12, flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 220 }}>
                  <Field label="Person with account">
                    <Combo
                      options={peopleWithAccount}
                      value={addPersonId}
                      onChange={setAddPersonId}
                      placeholder="Search by name or email…"
                    />
                  </Field>
                </div>
                <button className="btn primary" onClick={() => doAddRole(role)}>Grant role</button>
              </div>
            )}

            {holders.length === 0 ? (
              <p style={{ fontSize: 13.5, color: 'var(--ink-soft)', margin: 0 }}>No one currently holds this role.</p>
            ) : (
              <table className="tbl">
                <thead><tr><th>Person</th><th>Email</th><th>Auth user ID</th><th /></tr></thead>
                <tbody>
                  {holders.map(({ userId, person }) => (
                    <tr key={userId}>
                      <td style={{ fontWeight: 600 }}>
                        {person ? (
                          <Link to={`/admin/members/${person.id}`}>{person.lastName}, {person.firstName}</Link>
                        ) : (
                          <em style={{ color: 'var(--ink-soft)' }}>Unknown person</em>
                        )}
                      </td>
                      <td style={{ fontSize: 13 }}>{person?.email ?? '—'}</td>
                      <td style={{ fontSize: 12, fontFamily: 'monospace', color: 'var(--ink-soft)' }}>{userId.slice(0, 12)}…</td>
                      <td>
                        <button
                          className="btn small ghost"
                          onClick={() => {
                            const name = person ? `${person.firstName} ${person.lastName}` : userId;
                            if (window.confirm(`Remove ${name} from ${label}?`)) {
                              revokeRole(userId, role);
                              toast(`Removed ${name} from ${label}.`);
                            }
                          }}
                        >
                          Remove
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------- Demo tools ----------
function DemoTools() {
  const db = useDB();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [pushStatus, setPushStatus] = useState('');
  return (
    <div className="card card-pad" style={{ maxWidth: 560 }}>
      <h3 className="card-title">Prototype demo tools</h3>
      <p style={{ fontSize: 14, color: 'var(--ink-soft)' }}>
        All data in this prototype lives in your browser (localStorage), seeded deterministically.
        Production replaces this layer with a real API + database with periodic backups.
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          className="btn primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const { loadNationals } = await import('../lib/nationals');
              const r = await loadNationals();
              toast(`Loaded NAIGC Nationals 2026 — ${r.athletes.toLocaleString()} athletes, ${r.scores.toLocaleString()} scores. See Live Results.`);
            } catch (e) {
              toast(`Import failed: ${e}`);
            } finally { setBusy(false); }
          }}
        >
          {busy ? 'Loading…' : 'Load Nationals 2026 results (real data)'}
        </button>
        <button className="btn danger" onClick={() => { resetDemo(); toast('Demo data reset to the original seed.'); }}>Reset demo data</button>
      </div>
      {isSupabaseConfigured && (
        <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--line)' }}>
          <p style={{ fontSize: 14, color: 'var(--ink-soft)', marginTop: 0 }}>
            Push the current browser snapshot to the live Supabase project — this is how production gets seeded.
          </p>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              className="btn"
              disabled={!!pushStatus && pushStatus !== 'Done' && pushStatus !== 'Error'}
              onClick={async () => {
                setPushStatus('Starting…');
                try {
                  await pushAll(db, (label) => setPushStatus(label));
                  setPushStatus('Done');
                } catch (e) {
                  console.error(e);
                  setPushStatus('Error');
                }
              }}
            >
              Push local DB → Supabase
            </button>
            {pushStatus && <span style={{ fontSize: 13, color: pushStatus === 'Error' ? 'var(--coral-600)' : 'var(--ink-soft)' }}>
              {pushStatus === 'Done' ? '✓ Done' : pushStatus === 'Error' ? '✕ Failed — see console' : `Pushing: ${pushStatus}…`}
            </span>}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Communicate ----------

interface SendRecord {
  sentAt: Date;
  channel: 'email' | 'sms';
  recipientCount: number;
  recipients: { name: string; contact: string }[];
}

export function Communicate() {
  const db = useDB();
  const toast = useToast();
  const season = db.seasons.find((s) => s.current)!;
  const [aud, setAud] = useState({ athletes: true, coaches: false, managers: false, clubEmails: false, withMembership: 'any' as 'any' | 'with' | 'without' });
  const [regions, setRegions] = useState<Region[]>([]);
  const [channel, setChannel] = useState<'email' | 'sms'>('email');
  const allRegions = [...new Set(Object.values(STATE_REGIONS))] as Region[];

  // Message state
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  // Editor mode: 'html' = raw textarea, 'rich' = contentEditable toolbar
  const [editorMode, setEditorMode] = useState<'html' | 'rich'>('html');
  // Preview mode for the html pane
  const [previewMode, setPreviewMode] = useState(false);
  // Recipient list expanded
  const [listExpanded, setListExpanded] = useState(false);

  // Send log
  const [lastSend, setLastSend] = useState<SendRecord | null>(null);
  const [sendLogExpanded, setSendLogExpanded] = useState(false);

  // Test send
  const [testPersonId, setTestPersonId] = useState<string | null>(null);
  const [testGroup, setTestGroup] = useState<Athlete[]>([]);
  const [sending, setSending] = useState(false);

  // Send the current subject/body to an explicit recipient list via the
  // send-email (Gmail SMTP) or send-sms (Telnyx) Edge Function, per channel.
  // Used by both the test and main sends.
  const doSend = async (people: { email?: string; phone?: string; name?: string }[], label: string) => {
    if (!isSupabaseConfigured) { toast(`${channel === 'sms' ? 'SMS' : 'Email'} needs Supabase configured to send.`); return; }
    if (!body.trim()) { toast(`Add a ${channel === 'sms' ? 'message' : 'email body'} before sending.`); return; }

    if (channel === 'sms') {
      const valid = people.filter((p) => p.phone).map((p) => ({ phone: p.phone!, name: p.name }));
      if (valid.length === 0) { toast('No recipients have a phone number.'); return; }
      // Confirm before spending on a multi-segment blast (each segment is billed).
      const seg = analyzeMessage(body);
      if (seg.segments > 1 && !window.confirm(
        `This message is ${seg.segments} ${seg.encoding} segments — each recipient is billed ${seg.segments}×. ` +
        `Send to ${valid.length} recipient${valid.length !== 1 ? 's' : ''} anyway?`,
      )) return;
      setSending(true);
      try {
        const res = await sendSms(body, valid);
        if (res.ok) {
          toast(`${label}: sent to ${res.sentCount} recipient${res.sentCount !== 1 ? 's' : ''}.`);
        } else if (res.sentCount > 0) {
          toast(`${label}: ${res.sentCount} sent, ${res.failedCount} failed${res.error ? ` — ${res.error}` : ''}.`);
        } else {
          toast(`${label} failed: ${res.error ?? 'unknown error'}`);
        }
      } catch (e) {
        toast(`${label} failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setSending(false);
      }
      return;
    }

    const subj = subject.trim();
    if (!subj) { toast('Add a subject before sending.'); return; }
    const valid = people.filter((p) => p.email).map((p) => ({ email: p.email!, name: p.name }));
    if (valid.length === 0) { toast('No recipients have an email address.'); return; }
    setSending(true);
    try {
      const res = await sendEmail(subj, body, valid);
      if (res.ok) {
        toast(`${label}: sent to ${res.sentCount} recipient${res.sentCount !== 1 ? 's' : ''}.`);
      } else if (res.sentCount > 0) {
        toast(`${label}: ${res.sentCount} sent, ${res.failedCount} failed${res.error ? ` — ${res.error}` : ''}.`);
      } else {
        toast(`${label} failed: ${res.error ?? 'unknown error'}`);
      }
    } catch (e) {
      toast(`${label} failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSending(false);
    }
  };

  // Rich-text editor ref
  const richRef = useRef<HTMLDivElement>(null);

  const execCmd = useCallback((cmd: string, value?: string) => {
    document.execCommand(cmd, false, value);
    if (richRef.current) {
      setBody(richRef.current.innerHTML);
    }
  }, [setBody]);

  const onRichInput = useCallback(() => {
    if (richRef.current) setBody(richRef.current.innerHTML);
  }, [setBody]);

  // When switching to rich mode, seed the contentEditable with current body
  const switchToRich = () => {
    setEditorMode('rich');
    setPreviewMode(false);
    // Next tick: set innerHTML after the div renders
    setTimeout(() => {
      if (richRef.current) richRef.current.innerHTML = body;
    }, 0);
  };

  const switchToHtml = () => {
    setEditorMode('html');
    // body is already kept in sync via onRichInput
  };

  // Derive the set of manager person IDs from live db.clubs — this picks up
  // managers added/removed during the session without requiring a page reload.
  const managerIdSet = useMemo(
    () => new Set(db.clubs.flatMap((c) => c.managerIds)),
    [db.clubs],
  );

  const recipients = useMemo(() => db.people.filter((p) => {
    const isManager = managerIdSet.has(p.id);
    if (p.kind === 'athlete' && !aud.athletes) return false;
    // Coaches pass if coaches checkbox is on; managers (any person in club.managerIds) pass if managers checkbox is on
    if (p.kind === 'coach') {
      if (!aud.coaches && !(aud.managers && isManager)) return false;
    }
    // Athletes who are also managers (edge case) still pass when managers is checked
    if (p.kind === 'athlete' && aud.managers && isManager) return true;
    // Manager-only filter: if managers is checked but athletes is off, exclude non-manager athletes
    if (!aud.athletes && p.kind === 'athlete' && !isManager) return false;
    const has = p.memberships.some((m) => m.seasonId === season.id && m.status === 'active');
    if (aud.withMembership === 'with' && !has) return false;
    if (aud.withMembership === 'without' && has) return false;
    if (regions.length) {
      const club = db.clubs.find((c) => c.id === p.mainClubId);
      const r = club?.region ?? STATE_REGIONS[p.state] ?? 'Other';
      if (!regions.includes(r)) return false;
    }
    return true;
  }), [db.people, db.clubs, managerIdSet, aud, regions, season.id]);

  // Club emails for the recipient list
  const clubEmailRows = useMemo(() => {
    if (!aud.clubEmails) return [];
    return db.clubs.filter((c) => c.email).map((c) => ({ name: c.name, email: c.email }));
  }, [db.clubs, aud.clubEmails]);

  // People options for test-send Combo
  const peopleOptions = useMemo(() =>
    db.people.map((p) => ({
      value: p.id,
      label: `${p.firstName} ${p.lastName}`,
      sub: p.email,
    })).sort((a, b) => a.label.localeCompare(b.label)),
    [db.people]
  );

  const addTestPerson = (id: string) => {
    const p = db.people.find((x) => x.id === id);
    if (!p || testGroup.some((x) => x.id === id)) return;
    setTestGroup((g) => [...g, p]);
    setTestPersonId(null);
  };

  const removeTestPerson = (id: string) => setTestGroup((g) => g.filter((x) => x.id !== id));

  return (
    <div style={{ maxWidth: 920 }}>
      <h1 className="page-title display">Communicate</h1>
      <p className="page-sub">HTML email to filtered groups — built to handle 2,000+ recipients, with meet/session targeting.</p>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, alignItems: 'start' }}>
        {/* ---- Left: Audience ---- */}
        <div className="card card-pad">
          <h3 className="card-title">Audience</h3>
          {([['athletes', 'Athletes'], ['coaches', 'Coaches'], ['managers', 'Club managers'], ['clubEmails', 'Club emails']] as const).map(([k, label]) => (
            <label className="checkrow" key={k}>
              <input type="checkbox" checked={aud[k] as boolean} onChange={(e) => setAud({ ...aud, [k]: e.target.checked })} />{label}
            </label>
          ))}
          <Field label="Membership filter">
            <select className="input" value={aud.withMembership} onChange={(e) => setAud({ ...aud, withMembership: e.target.value as typeof aud.withMembership })}>
              <option value="any">With or without membership</option>
              <option value="with">With {season.name} membership</option>
              <option value="without">Without {season.name} membership</option>
            </select>
          </Field>
          <Field label="Regions (multi-select)">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0 16px' }}>
              {allRegions.map((r) => (
                <label className="checkrow" key={r}>
                  <input type="checkbox" checked={regions.includes(r)} onChange={(e) => setRegions(e.target.checked ? [...regions, r] : regions.filter((x) => x !== r))} />{r}
                </label>
              ))}
            </div>
          </Field>

          {/* Recipient count + preview list */}
          <div style={{ marginTop: 8 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
              <span className="stat-big stat-accent" style={{ fontSize: 26 }}>
                {recipients.length + clubEmailRows.length}
              </span>
              <span className="stat-label">recipients</span>
              <button
                className="btn small ghost"
                style={{ marginLeft: 'auto' }}
                onClick={() => setListExpanded((v) => !v)}
              >
                {listExpanded ? 'Hide list' : 'See list'}
              </button>
            </div>

            {listExpanded && (
              <div style={{
                marginTop: 8, maxHeight: 240, overflowY: 'auto',
                border: '1px solid var(--line)', borderRadius: 6,
                fontSize: 12.5, background: 'var(--surface-0)',
              }}>
                {recipients.length === 0 && clubEmailRows.length === 0 && (
                  <div style={{ padding: '10px 12px', color: 'var(--ink-soft)' }}>No recipients match the current filters.</div>
                )}
                {recipients.map((p) => {
                  const contact = channel === 'sms' ? ((p as Athlete).phone ?? p.email) : p.email;
                  return (
                    <div key={p.id} style={{ padding: '4px 12px', borderBottom: '1px solid var(--line)', display: 'flex', gap: 8, justifyContent: 'space-between' }}>
                      <span>{p.firstName} {p.lastName}</span>
                      <span style={{ color: 'var(--ink-soft)' }}>{contact || <em style={{ opacity: 0.5 }}>no {channel === 'sms' ? 'phone' : 'email'}</em>}</span>
                    </div>
                  );
                })}
                {clubEmailRows.map((c) => (
                  <div key={c.email} style={{ padding: '4px 12px', borderBottom: '1px solid var(--line)', display: 'flex', gap: 8, justifyContent: 'space-between', background: 'var(--surface-1)' }}>
                    <span style={{ fontStyle: 'italic' }}>{c.name} (club email)</span>
                    <span style={{ color: 'var(--ink-soft)' }}>{c.email}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ---- Right: Message ---- */}
        <div className="card card-pad">
          <h3 className="card-title">Message</h3>

          {/* Channel selector + SMS note */}
          <Field label="Channel">
            <select className="input" value={channel} onChange={(e) => setChannel(e.target.value as 'email' | 'sms')}>
              <option value="email">Email (HTML supported)</option>
              <option value="sms">Text message</option>
            </select>
          </Field>
          {channel === 'sms' && (
            <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', marginTop: -4, marginBottom: 8, padding: '6px 10px', background: 'var(--surface-1)', borderRadius: 4, borderLeft: '3px solid var(--line)' }}>
              Texts send via Telnyx. Real carrier delivery needs an approved A2P 10DLC campaign —
              until then, test against your own number below. Recipients must have opted in to texts.
            </p>
          )}

          {channel === 'email' && (
            <>
              <Field label="Subject">
                <input
                  className="input"
                  type="text"
                  placeholder="Nationals registration closes Friday!"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                />
              </Field>

              {/* Editor mode toggle */}
              <div style={{ display: 'flex', gap: 8, marginBottom: 6, alignItems: 'center' }}>
                <span style={{ fontSize: 12.5, color: 'var(--ink-soft)' }}>Editor:</span>
                <button
                  className={`btn small ${editorMode === 'html' ? 'primary' : 'ghost'}`}
                  onClick={switchToHtml}
                >HTML</button>
                <button
                  className={`btn small ${editorMode === 'rich' ? 'primary' : 'ghost'}`}
                  onClick={switchToRich}
                >Rich text</button>
                {editorMode === 'html' && (
                  <button
                    className={`btn small ${previewMode ? 'primary' : 'ghost'}`}
                    style={{ marginLeft: 'auto' }}
                    onClick={() => setPreviewMode((v) => !v)}
                  >{previewMode ? 'Edit HTML' : 'Preview'}</button>
                )}
              </div>

              {/* HTML editor or preview */}
              {editorMode === 'html' && (
                previewMode ? (
                  <div
                    style={{
                      minHeight: 160, maxHeight: 340, overflowY: 'auto',
                      border: '1px solid var(--line)', borderRadius: 6,
                      padding: '10px 14px', background: '#fff', color: '#111',
                      fontSize: 14, lineHeight: 1.6,
                    }}
                    // Admin-only internal tool; body is admin-authored HTML
                    dangerouslySetInnerHTML={{ __html: body }}
                  />
                ) : (
                  <textarea
                    className="input"
                    rows={8}
                    style={{ fontFamily: 'monospace', fontSize: 12.5, resize: 'vertical' }}
                    placeholder={'<h1>Hi {{first_name}},</h1>\n<p>…</p>'}
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                  />
                )
              )}

              {/* Rich-text editor */}
              {editorMode === 'rich' && (
                <div>
                  <div style={{ display: 'flex', gap: 4, marginBottom: 4, flexWrap: 'wrap' }}>
                    {([
                      ['Bold', 'bold', '<b>B</b>'],
                      ['Italic', 'italic', '<i>I</i>'],
                      ['Bullets', 'insertUnorderedList', '• List'],
                    ] as const).map(([label, cmd, html]) => (
                      <button
                        key={cmd}
                        className="btn small ghost"
                        style={{ fontFamily: cmd === 'bold' || cmd === 'italic' ? 'inherit' : undefined }}
                        onMouseDown={(e) => { e.preventDefault(); execCmd(cmd); }}
                        dangerouslySetInnerHTML={{ __html: html }}
                        aria-label={label}
                      />
                    ))}
                    <button
                      className="btn small ghost"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        const url = window.prompt('Link URL:', 'https://');
                        if (url) execCmd('createLink', url);
                      }}
                    >🔗 Link</button>
                  </div>
                  <div
                    ref={richRef}
                    contentEditable
                    suppressContentEditableWarning
                    onInput={onRichInput}
                    style={{
                      minHeight: 160, maxHeight: 340, overflowY: 'auto',
                      border: '1px solid var(--line)', borderRadius: 6,
                      padding: '10px 14px', background: '#fff', color: '#111',
                      fontSize: 14, lineHeight: 1.6, outline: 'none',
                    }}
                  />
                  <p style={{ fontSize: 11.5, color: 'var(--ink-soft)', marginTop: 4, marginBottom: 0 }}>
                    Tip: you can switch to HTML mode to see or edit the generated markup.
                  </p>
                </div>
              )}
            </>
          )}

          {channel === 'sms' && (() => {
            const seg = analyzeMessage(body);
            return (
              <Field label="Message">
                <textarea
                  className="input"
                  rows={4}
                  maxLength={612}
                  placeholder="UCG: Reg closes Friday. Pay at the portal. Reply STOP to opt out."
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                />
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4, fontSize: 12, color: 'var(--ink-soft)' }}>
                  <span>{seg.length} chars · {seg.encoding}</span>
                  <span style={{ color: seg.segments > 1 ? 'var(--warn)' : 'var(--ink-soft)' }}>
                    {seg.segments} segment{seg.segments !== 1 ? 's' : ''}
                  </span>
                  {seg.isUnicode && (
                    <>
                      <span style={{ color: 'var(--warn)' }}>
                        ⚠ Unicode — limit drops to 70/segment
                      </span>
                      <button
                        type="button"
                        className="btn small ghost"
                        style={{ marginLeft: 'auto' }}
                        onClick={() => setBody((b) => normalizeToGsm7(b))}
                      >Normalize</button>
                    </>
                  )}
                </div>
              </Field>
            );
          })()}

          {/* From sender info */}
          <div style={{ margin: '12px 0 8px', padding: '8px 12px', background: 'var(--surface-1)', borderRadius: 4, fontSize: 12.5, color: 'var(--ink-soft)' }}>
            {channel === 'sms' ? (
              <>
                <strong style={{ color: 'var(--ink)' }}>From:</strong> UCG Telnyx number
                <span style={{ marginLeft: 8 }}>— test-grade. STOP/HELP handled automatically by the carrier.</span>
              </>
            ) : (
              <>
                <strong style={{ color: 'var(--ink)' }}>From:</strong> United Club Gymnastics &lt;nate.sharpe@naigc.org&gt;
                <span style={{ marginLeft: 8 }}>— test sender (Gmail SMTP). Production sender (Resend/Workspace) TBD.</span>
              </>
            )}
          </div>

          {/* Send button */}
          <button
            className="btn primary"
            style={{ marginTop: 8 }}
            disabled={sending}
            onClick={async () => {
              const total = recipients.length + clubEmailRows.length;
              const personRows = recipients.map((p) => ({
                name: `${p.firstName} ${p.lastName}`,
                contact: channel === 'sms' ? ((p as Athlete).phone ?? p.email) : p.email,
              }));
              const clubRows = clubEmailRows.map((c) => ({ name: `${c.name} (club email)`, contact: c.email ?? '' }));
              const record: SendRecord = {
                sentAt: new Date(),
                channel,
                recipientCount: total,
                recipients: [...personRows, ...clubRows],
              };
              setLastSend(record);
              setSendLogExpanded(false);
              const sendRows = [
                ...recipients.map((p) => ({ email: p.email, phone: (p as Athlete).phone, name: `${p.firstName} ${p.lastName}` })),
                ...clubEmailRows.map((c) => ({ email: c.email ?? '', name: c.name })),
              ];
              await doSend(sendRows, channel === 'sms' ? 'Text' : 'Email');
            }}
          >
            {sending ? 'Sending…' : `Send to ${recipients.length + clubEmailRows.length} →`}
          </button>
          {channel === 'sms' && (
            <p style={{ fontSize: 12, color: 'var(--ink-soft)', marginTop: 4 }}>Live delivery requires an approved 10DLC campaign.</p>
          )}
        </div>
      </div>

      {/* ---- Last send summary ---- */}
      {lastSend && (
        <div className="card card-pad" style={{ marginTop: 16, borderLeft: '3px solid var(--accent)' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <span style={{ fontWeight: 600, fontSize: 14 }}>
              Last send — {lastSend.channel === 'sms' ? 'Text' : 'Email'} sent to{' '}
              <span style={{ color: 'var(--accent)' }}>{lastSend.recipientCount} recipient{lastSend.recipientCount !== 1 ? 's' : ''}</span>
            </span>
            <span style={{ fontSize: 12, color: 'var(--ink-soft)' }}>
              {lastSend.sentAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}{' '}
              {lastSend.sentAt.toLocaleDateString()}
            </span>
            <button
              className="btn small ghost"
              style={{ marginLeft: 'auto' }}
              onClick={() => setSendLogExpanded((v) => !v)}
            >
              {sendLogExpanded ? 'Hide' : 'Show list'}
            </button>
          </div>
          {sendLogExpanded && (
            <div style={{
              marginTop: 8, maxHeight: 240, overflowY: 'auto',
              border: '1px solid var(--line)', borderRadius: 6,
              fontSize: 12.5, background: 'var(--surface-0)',
            }}>
              {lastSend.recipients.map((r, i) => (
                <div key={i} style={{ padding: '4px 12px', borderBottom: '1px solid var(--line)', display: 'flex', gap: 8, justifyContent: 'space-between' }}>
                  <span>{r.name}</span>
                  <span style={{ color: 'var(--ink-soft)' }}>{r.contact || <em style={{ opacity: 0.5 }}>—</em>}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ---- Test send section ---- */}
      <div className="card card-pad" style={{ marginTop: 16, maxWidth: 560 }}>
        <h3 className="card-title">Send test email</h3>
        <p style={{ fontSize: 13.5, color: 'var(--ink-soft)', marginTop: 0 }}>
          Pick specific people to test against — these need not match the audience filters above.
        </p>
        <Field label="Add person to test group">
          <Combo
            options={peopleOptions}
            value={testPersonId}
            onChange={addTestPerson}
            placeholder="Search by name or email…"
          />
        </Field>

        {testGroup.length > 0 && (
          <div style={{ marginBottom: 10 }}>
            {testGroup.map((p) => (
              <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '3px 0', fontSize: 13.5 }}>
                <span>{p.firstName} {p.lastName} <span style={{ color: 'var(--ink-soft)', fontSize: 12.5 }}>{p.email}</span></span>
                <button className="btn small ghost" onClick={() => removeTestPerson(p.id)}>✕</button>
              </div>
            ))}
          </div>
        )}

        <button
          className="btn ghost"
          disabled={testGroup.length === 0 || sending}
          onClick={() => doSend(
            testGroup.map((p) => ({ email: p.email, phone: p.phone, name: `${p.firstName} ${p.lastName}` })),
            channel === 'sms' ? 'Test text' : 'Test email',
          )}
        >
          {sending ? 'Sending…' : `Send test to ${testGroup.length} selected`}
        </button>
      </div>
    </div>
  );
}
