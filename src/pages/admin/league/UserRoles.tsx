import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Combo, Field } from '../../../components/ui';
import { useToast } from '../../../components/ui-hooks';
import { STATE_REGIONS } from '../../../lib/types';
import type { Athlete } from '../../../lib/types';
import { fetchAllRoles, fetchRegionalRepRegions, setRegionalRepRegion, pushUserRole } from '../../../lib/supabase';
import { useAdminPeople } from '../../../lib/people-admin-slice';

// ---------- User Roles (W12 task 1) ----------
// 'admin' = Full League Admin (only role that can emulate users / access all admin features).
// 'sanctioning' = Sanctioning Team (will see events to vote on — voting UI is a later wave).
const ROLE_DEFS = [
  { role: 'admin', label: 'Full League Admin', desc: 'Full admin access, including user emulation.' },
  { role: 'sanctioning', label: 'Sanctioning Team', desc: 'Will see events to vote on (voting UI coming in a later wave).' },
  { role: 'regional_rep', label: 'Regional Representative', desc: 'Represents a region. Set each rep’s region below.' },
  { role: 'finance_admin', label: 'Finance Admin', desc: 'Access to finance tools (finance dashboard coming in a later phase).' },
  { role: 'refund_manager', label: 'Refund manager', desc: 'Reviews and processes refund requests (event-management v2 Phase 3).' },
] as const;

// Canonical NAIGC regions for the Regional Representative dropdown: the distinct
// region VALUES from STATE_REGIONS, sorted, plus "Outside US".
const REGION_OPTIONS: string[] = (() => {
  const set = new Set<string>(Object.values(STATE_REGIONS));
  set.add('Outside US');
  return Array.from(set).sort();
})();

export function UserRoles() {
  const toast = useToast();
  // Phase 4 (data-layer-scale.md): db.people at boot no longer covers the
  // whole league — this page grants roles to ANY account, same league-wide
  // shape (#3) as every other admin-only whole-league surface.
  const { rows: adminPeopleRows } = useAdminPeople();
  // Load all role assignments from Supabase on mount.
  const [roleMap, setRoleMap] = useState<Map<string, Set<string>>>(new Map()); // userId → Set<role>
  const [regionMap, setRegionMap] = useState<Record<string, string>>({}); // userId → region (regional reps)
  const [loading, setLoading] = useState(true);
  const [addingRole, setAddingRole] = useState<string | null>(null); // role being added
  const [addPersonId, setAddPersonId] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    // `loading` already initializes to true and this effect runs once on mount,
    // so no synchronous setLoading(true) is needed (it would only cause a
    // cascading render). setLoading(false) happens in the async .then below.
    Promise.all([fetchAllRoles(), fetchRegionalRepRegions()]).then(([rows, regions]) => {
      if (!live) return;
      const map = new Map<string, Set<string>>();
      for (const { userId, role } of rows) {
        if (!map.has(userId)) map.set(userId, new Set());
        map.get(userId)!.add(role);
      }
      setRoleMap(map);
      setRegionMap(regions);
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

  const setRegion = (userId: string, region: string) => {
    setRegionalRepRegion(userId, region);
    setRegionMap((prev) => ({ ...prev, [userId]: region }));
  };

  // Find person by authUserId.
  const personByAuthId = useMemo(() => {
    const m = new Map<string, Athlete>();
    for (const p of adminPeopleRows) { if (p.authUserId) m.set(p.authUserId, p); }
    return m;
  }, [adminPeopleRows]);

  const peopleWithAccount = useMemo(() =>
    adminPeopleRows.filter((p) => p.authUserId)
      .map((p) => ({ value: p.id, label: `${p.firstName} ${p.lastName}`, sub: p.email }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    [adminPeopleRows]
  );

  const doAddRole = (role: string) => {
    if (!addPersonId) { toast('Select a person first.'); return; }
    const person = adminPeopleRows.find((p) => p.id === addPersonId);
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
                <thead><tr><th>Person</th><th>Email</th>{role === 'regional_rep' && <th>Region</th>}<th>Auth user ID</th><th /></tr></thead>
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
                      {role === 'regional_rep' && (
                        <td>
                          <select
                            className="input"
                            value={regionMap[userId] ?? ''}
                            onChange={(e) => {
                              const region = e.target.value;
                              if (!region) return;
                              setRegion(userId, region);
                              const name = person ? `${person.firstName} ${person.lastName}` : userId;
                              toast(`Set ${name}’s region to ${region}.`);
                            }}
                            style={{ fontSize: 13, padding: '4px 8px' }}
                          >
                            <option value="" disabled>Select region…</option>
                            {REGION_OPTIONS.map((r) => (
                              <option key={r} value={r}>{r}</option>
                            ))}
                          </select>
                        </td>
                      )}
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
