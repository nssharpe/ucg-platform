import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useDB, mutate } from '../../lib/store';
import { Badge } from '../../components/ui';
import { useToast } from '../../components/ui-hooks';
import { ClubForm } from '../../components/ClubForm';
import { STATE_REGIONS } from '../../lib/types';
import type { Club, ClubRequest, Region } from '../../lib/types';
import { pushClub, pushClubManager, pushClubRequest } from '../../lib/supabase';
import { currentSeason } from '../../lib/season-lifecycle';
import { useAdminMemberships, groupAdminMembershipsByPerson } from '../../lib/memberships-admin-slice';

// ---------- Clubs ----------
export function AdminClubs() {
  const db = useDB();
  const toast = useToast();
  const season = currentSeason(db)!;
  const [editing, setEditing] = useState<Club | 'new' | null>(null);
  const [q, setQ] = useState('');
  const pending = db.clubRequests.filter((r) => r.status === 'pending');

  // memberships are Tier 2 boot-scoped to the caller's own + managed-club
  // rows (whats-next.md §7) — this admin page shows every club's roster, so
  // it fetches every membership on demand instead (CONTRACT shape #4). The
  // per-club Active/Roster stats below gate on `status === 'ready'` — a
  // partial read here would silently show "0 active" for a club whose data
  // just hasn't arrived yet, not an obviously-missing row.
  const { rows: adminMembershipRows, status: membershipsStatus } = useAdminMemberships();
  const membershipsByPerson = useMemo(() => groupAdminMembershipsByPerson(adminMembershipRows), [adminMembershipRows]);

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
    const applied = mutate((d) => {
      d.clubs.push(club);
      pushClub(club);
      if (req.requesterPersonId) pushClubManager(id, req.requesterPersonId, true);
      const r = d.clubRequests.find((x) => x.id === req.id);
      if (r) { r.status = 'approved'; r.decidedAt = new Date().toISOString(); r.createdClubId = id; pushClubRequest(r); }
    });
    if (!applied) return; // offline read-only gate — no false success toast
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
      {membershipsStatus === 'loading' && (
        <p style={{ color: 'var(--ink-soft)', fontSize: 13, marginBottom: 8 }}>Loading membership status…</p>
      )}
      <div className="card" style={{ overflow: 'hidden' }}>
        <table className="tbl">
          <thead><tr><th>Club</th><th>Region</th><th className="num">Roster</th><th className="num">Active</th><th>Flags</th><th /></tr></thead>
          <tbody>
            {filteredClubs.map((c) => {
              const roster = db.people.filter((p) => p.mainClubId === c.id);
              const membershipsReady = membershipsStatus === 'ready';
              const hasActiveMembership = (p: (typeof roster)[number]) =>
                (membershipsByPerson.get(p.id) ?? []).some((m) => m.seasonId === season.id && m.status === 'active');
              const active = membershipsReady ? roster.filter(hasActiveMembership) : [];
              const coaches = membershipsReady ? roster.filter((p) => p.kind === 'coach' && hasActiveMembership(p)) : [];
              const pendingCart = (db.carts[c.id] ?? []).length;
              const flags: string[] = [];
              // "No coaches" depends on membership data being loaded — never
              // flag it from an empty-because-still-loading set.
              if (membershipsReady && coaches.length === 0) flags.push('No coaches');
              if (pendingCart > 0) flags.push(`${pendingCart} unpaid cart items`);
              return (
                <tr key={c.id}>
                  <td><Link to={`/club/${c.id}`} style={{ fontWeight: 600 }}>{c.name}</Link></td>
                  <td>{c.region}</td>
                  <td className="num">{roster.length}</td>
                  <td className="num">{membershipsReady ? active.length : '…'}</td>
                  <td>{!membershipsReady ? null : flags.length === 0 ? <Badge tone="ok">✓ Complete</Badge> : flags.map((f) => <Badge key={f} tone="warn">{f}</Badge>)}</td>
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
