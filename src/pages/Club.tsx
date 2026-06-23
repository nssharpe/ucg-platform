import { useMemo, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { useDB, mutate } from '../lib/store';
import { useCapabilities } from '../lib/capabilities';
import { Badge, Combo, Field, Modal, Tabs } from '../components/ui';
import { useToast, useFmtDate } from '../components/ui-hooks';
import { CLUB_ACCESS_LABELS } from '../lib/types';
import type { Athlete, Club, ClubAccess, Registration } from '../lib/types';
import { fmtMoney } from '../lib/scoring';
import {
  deleteRegistration, pushCart, pushClub, pushClubManager, pushInvoice,
  pushMembership, pushPerson, pushRegistration, requestManagerAccess, sendClubInvite,
  inviteAccount,
} from '../lib/supabase';
import { ClubForm } from '../components/ClubForm';
import { RegistrationEditor } from '../components/RegistrationEditor';

// ---- sort helpers -----------------------------------------------------------

type SortCol = 'firstName' | 'lastName' | 'WAG' | 'MAG' | 'TNT' | 'studentStatus';

function sortRoster(
  roster: Athlete[],
  col: SortCol,
  dir: 'asc' | 'desc',
  lvlName: (id?: string) => string,
) {
  return [...roster].sort((a, b) => {
    let va: string;
    let vb: string;
    if (col === 'WAG' || col === 'MAG' || col === 'TNT') {
      va = lvlName(a.levels[col]);
      vb = lvlName(b.levels[col]);
    } else {
      va = String(a[col] ?? '');
      vb = String(b[col] ?? '');
    }
    const cmp = va.localeCompare(vb);
    return dir === 'asc' ? cmp : -cmp;
  });
}

// ---- ClubPage ---------------------------------------------------------------

export function ClubPage() {
  const { clubId } = useParams();
  const db = useDB();
  const caps = useCapabilities();
  const toast = useToast();
  const navigate = useNavigate();
  const club = db.clubs.find((c) => c.id === clubId);
  const [tab, setTab] = useState<'roster' | 'meetreg'>('roster');
  const [editingClub, setEditingClub] = useState(false);
  const [addingAthlete, setAddingAthlete] = useState(false);
  if (!club) return <p>Club not found.</p>;

  const canManage = caps.actingAsAdmin || caps.managedClubIds.includes(club.id);

  const isMember = caps.personId
    ? (() => {
        const p = db.people.find((x) => x.id === caps.personId);
        return !!p && (p.mainClubId === club.id || p.altClubIds.includes(club.id));
      })()
    : false;
  const isManager = canManage;

  const rosterSize = db.people.filter((p) => p.mainClubId === club.id).length;

  const managerNames = club.managerIds
    .map((id) => db.people.find((p) => p.id === id))
    .filter((p): p is Athlete => !!p)
    .map((p) => `${p.firstName} ${p.lastName}`);

  // Clubs the user can switch between from here: league admins see all clubs,
  // managers see the clubs they manage. Only shown when there's a real choice.
  const switchableClubs = (caps.actingAsAdmin
    ? db.clubs
    : db.clubs.filter((c) => caps.managedClubIds.includes(c.id))
  ).slice().sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h1 className="page-title display" style={{ marginBottom: 0 }}>{club.name}</h1>
        {switchableClubs.length > 1 && (
          <div style={{ minWidth: 240 }}>
            <Combo
              options={switchableClubs.map((c) => ({ value: c.id, label: c.name, sub: `${c.state} · ${c.region}` }))}
              value={club.id}
              placeholder="Switch club…"
              onChange={(v) => { if (v && v !== club.id) navigate(`/club/${v}`); }}
            />
          </div>
        )}
      </div>
      <p className="page-sub">
        {club.shortName && club.shortName !== club.name && <><strong>{club.shortName}</strong> · </>}
        {club.state} · {club.region} region · <a href={`mailto:${club.email}`}>{club.email}</a> ·
        {rosterSize} member{rosterSize !== 1 ? 's' : ''}
        {caps.actingAsAdmin && <> · <Link to="/admin/clubs">all clubs</Link></>}
      </p>

      {managerNames.length > 0 && (
        <p style={{ fontSize: 14, color: 'var(--ink-soft)', marginBottom: 10 }}>
          <strong>Club managers:</strong> {managerNames.join(', ')}
        </p>
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 18, flexWrap: 'wrap' }}>
        <Link className="btn ghost small" to={`/club/${club.id}/cart`}>Club cart & invoices →</Link>
        {canManage && (
          <>
            <button className="btn ghost small" onClick={() => setEditingClub(true)}>Edit club details</button>
            <button className="btn ghost small" data-tip="Ask UCG to sanction a meet hosted by your club" onClick={() => alert('Sanction request form — wires to league admin approval queue (post-MVP).')}>Request meet sanction</button>
            <button className="btn ghost small" data-tip="Create an account for an athlete and email them a set-password link" onClick={() => setAddingAthlete(true)}>Add athlete</button>
          </>
        )}
        {!isManager && isMember && caps.personId && (
          <button
            className="btn ghost small"
            onClick={() => {
              requestManagerAccess(club.id).then((res) => toast(res.ok
                ? "Request sent — the club's managers and league admins have been notified."
                : `Request failed: ${res.error ?? 'unknown error'}.`));
            }}
          >
            Request manager access
          </button>
        )}
      </div>

      {canManage && <ClubManagers club={club} />}
      {canManage && <ClubSettings club={club} />}

      <Tabs
        tabs={[{ id: 'roster' as const, label: `Roster (${rosterSize})` }, { id: 'meetreg' as const, label: 'Meet registration' }]}
        active={tab}
        onChange={setTab}
      />
      {tab === 'roster' ? <Roster clubId={club.id} canManage={canManage} /> : <MeetRegGrid clubId={club.id} canManage={canManage} />}

      {editingClub && <ClubForm club={club} onClose={() => setEditingClub(false)} />}
      {addingAthlete && <AddAthleteModal clubId={club.id} clubName={club.name} onClose={() => setAddingAthlete(false)} />}
    </div>
  );
}

// ---- AddAthleteModal --------------------------------------------------------
// Creates a real account for an athlete (first/last/email) with this club as
// their main club, and emails them a set-password link (invite-account fn).
function AddAthleteModal({ clubId, clubName, onClose }: { clubId: string; clubName: string; onClose: () => void }) {
  const toast = useToast();
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const valid = first.trim() && last.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  const submit = async () => {
    if (!valid) { toast('Enter a first name, last name, and a valid email.'); return; }
    setBusy(true);
    const res = await inviteAccount({ clubId, email: email.trim(), firstName: first.trim(), lastName: last.trim(), kind: 'athlete' });
    setBusy(false);
    if (res.ok) { toast(`Account created — a set-password link was emailed to ${email.trim()}.`); onClose(); }
    else { toast(res.error ?? 'Could not create the account.', { variant: 'error' }); }
  };

  return (
    <Modal title={`Add athlete to ${clubName}`} onClose={onClose}>
      <p style={{ color: 'var(--ink-soft)', marginTop: 0, fontSize: 14 }}>
        We’ll create their account with {clubName} as their main club and email them a link to
        set a password. After signing in they land on the membership page.
      </p>
      <div className="grid cols-2">
        <Field label="First name"><input className="input" value={first} onChange={(e) => setFirst(e.target.value)} /></Field>
        <Field label="Last name"><input className="input" value={last} onChange={(e) => setLast(e.target.value)} /></Field>
      </div>
      <Field label="Email"><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
      <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
        <button className="btn primary" disabled={!valid || busy} onClick={submit}>{busy ? 'Creating…' : 'Create account & email link'}</button>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

// ---- ClubSettings (access + allowClubPay) -----------------------------------

function ClubSettings({ club }: { club: Club }) {
  const toast = useToast();
  const [access, setAccess] = useState<ClubAccess>(club.access ?? 'open');
  const [allowClubPay, setAllowClubPay] = useState(club.allowClubPay);

  const save = () => {
    mutate((d) => {
      const c = d.clubs.find((x) => x.id === club.id)!;
      c.access = access;
      c.allowClubPay = allowClubPay;
      pushClub(c);
    });
    toast('Club settings saved.');
  };

  return (
    <div className="card card-pad" style={{ marginBottom: 18 }}>
      <h3 className="card-title">Club settings</h3>
      <div className="grid cols-2" style={{ gap: 12 }}>
        <Field label="Membership eligibility" hint="Who may register with or compete for this club.">
          <select
            className="input"
            value={access}
            onChange={(e) => setAccess(e.target.value as ClubAccess)}
          >
            {(Object.entries(CLUB_ACCESS_LABELS) as [ClubAccess, string][]).map(([val, label]) => (
              <option key={val} value={val}>{label}</option>
            ))}
          </select>
        </Field>
        <Field label="Club payments">
          <label className="checkrow" style={{ paddingTop: 8 }}>
            <input
              type="checkbox"
              checked={allowClubPay}
              onChange={(e) => setAllowClubPay(e.target.checked)}
            />
            Athletes may push membership fees to the club cart
          </label>
        </Field>
      </div>
      <div style={{ marginTop: 12 }}>
        <button className="btn primary small" onClick={save}>Save settings</button>
      </div>
    </div>
  );
}

// ---- ClubManagers -----------------------------------------------------------

function ClubManagers({ club }: { club: Club }) {
  const db = useDB();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const managers = club.managerIds
    .map((id) => db.people.find((p) => p.id === id))
    .filter((p): p is Athlete => !!p);
  const candidates = db.people
    .filter((p) =>
      !club.managerIds.includes(p.id) &&
      (p.mainClubId === club.id || p.altClubIds.includes(club.id)),
    )
    .map((p) => ({ value: p.id, label: `${p.firstName} ${p.lastName}`, sub: `${p.kind} · ${p.email}` }));

  const addManager = (personId: string) => {
    mutate((d) => {
      const c = d.clubs.find((x) => x.id === club.id)!;
      if (!c.managerIds.includes(personId)) c.managerIds.push(personId);
      pushClubManager(club.id, personId, true);
    });
    toast('Manager added.');
  };

  const removeManager = (personId: string) => {
    mutate((d) => {
      const c = d.clubs.find((x) => x.id === club.id)!;
      c.managerIds = c.managerIds.filter((id) => id !== personId);
      pushClubManager(club.id, personId, false);
    });
  };

  const inviteByEmail = () => {
    const addr = email.trim().toLowerCase();
    if (!addr) return;
    const existing = db.people.find((p) => p.email.toLowerCase() === addr);
    if (existing) { addManager(existing.id); setEmail(''); return; }
    const id = crypto.randomUUID();
    const local = addr.split('@')[0];
    const person: Athlete = {
      id, kind: 'coach', roles: { athlete: false, coach: true }, firstName: local, lastName: '(invited)', email: addr,
      dob: '', gender: 'Other', gradYear: 1900, studentStatus: 'Non-Student', shirt: '',
      country: 'USA', state: club.state ?? '', phone: '', mainClubId: club.id, altClubIds: [],
      levels: {}, emergency: { contact: '', relation: '', phone: '' }, dietary: [], dietaryNotes: '',
      memberships: [], achievements: [],
    };
    mutate((d) => { d.people.push(person); pushPerson(person); });
    addManager(id);
    setEmail('');
    sendClubInvite({ clubId: club.id, kind: 'coach', email: addr, name: `${person.firstName} ${person.lastName}` })
      .then((res) => toast(res.ok
        ? `Coach invited — a setup email was sent to ${addr}.`
        : `Coach added as manager, but the email failed: ${res.error ?? 'unknown error'}.`));
  };

  return (
    <div className="card card-pad" style={{ marginBottom: 18 }}>
      <h3 className="card-title">Club managers</h3>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        {managers.length === 0 && <span style={{ color: 'var(--ink-soft)', fontSize: 14 }}>No managers yet.</span>}
        {managers.map((m) => (
          <span key={m.id} className="badge navy" style={{ gap: 8 }}>
            {m.firstName} {m.lastName}
            <button type="button" title="Remove manager" onClick={() => removeManager(m.id)}
              style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0 }}>✕</button>
          </span>
        ))}
      </div>
      <div className="grid cols-2" style={{ gap: 12 }}>
        <Field label="Add an existing member as manager">
          <Combo options={candidates} value={null} onChange={addManager} placeholder="Search people…" />
        </Field>
        <Field label="Or invite a coach by email">
          <div style={{ display: 'flex', gap: 8 }}>
            <input type="email" value={email} placeholder="coach@club.org"
              onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') inviteByEmail(); }} />
            <button className="btn small" type="button" onClick={inviteByEmail} disabled={!email.trim()}>Invite</button>
          </div>
        </Field>
      </div>
    </div>
  );
}

// ---- Roster -----------------------------------------------------------------

function Roster({ clubId, canManage }: { clubId: string; canManage: boolean }) {
  const db = useDB();
  const caps = useCapabilities();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [inviting, setInviting] = useState<string | null>(null);

  const invite = async (p: Athlete) => {
    if (!p.email) { toast('This member has no email on file.', { variant: 'error' }); return; }
    setInviting(p.id);
    const res = await sendClubInvite({ clubId, kind: 'membership', email: p.email, name: `${p.firstName} ${p.lastName}` });
    setInviting(null);
    if (res.ok) toast(`Membership invite emailed to ${p.email}.`);
    else toast(res.error ?? 'Could not send the invite.', { variant: 'error' });
  };
  const [sortCol, setSortCol] = useState<SortCol>('lastName');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const season = db.seasons.find((s) => s.current)!;

  const lvlName = (id?: string) => db.levels.find((l) => l.id === id)?.name ?? '—';

  const allRoster = useMemo(
    () => db.people.filter((p) => p.mainClubId === clubId),
    [db, clubId],
  );

  const filtered = search.trim()
    ? allRoster.filter((p) =>
        `${p.firstName} ${p.lastName}`.toLowerCase().includes(search.trim().toLowerCase()),
      )
    : allRoster;

  const roster = useMemo(
    () => sortRoster(filtered, sortCol, sortDir, lvlName),
    [filtered, sortCol, sortDir, db.levels],
  );

  const handleSort = (col: SortCol) => {
    if (col === sortCol) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortCol(col); setSortDir('asc'); }
  };

  const sortIcon = (col: SortCol) =>
    col === sortCol ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '';

  return (
    <div>
      <div style={{ marginBottom: 10 }}>
        <input
          type="search"
          className="input"
          placeholder="Search by name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ maxWidth: 260 }}
        />
      </div>
      <div className="card" style={{ overflow: 'hidden' }}>
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ cursor: 'pointer' }} onClick={() => handleSort('firstName')}>First{sortIcon('firstName')}</th>
              <th style={{ cursor: 'pointer' }} onClick={() => handleSort('lastName')}>Last{sortIcon('lastName')}</th>
              <th>Type</th>
              <th>Membership</th>
              <th style={{ cursor: 'pointer' }} onClick={() => handleSort('WAG')}>WAG{sortIcon('WAG')}</th>
              <th style={{ cursor: 'pointer' }} onClick={() => handleSort('MAG')}>MAG{sortIcon('MAG')}</th>
              <th style={{ cursor: 'pointer' }} onClick={() => handleSort('TNT')}>T&amp;T{sortIcon('TNT')}</th>
              <th style={{ cursor: 'pointer' }} onClick={() => handleSort('studentStatus')}>Student{sortIcon('studentStatus')}</th>
              {canManage && <th></th>}
            </tr>
          </thead>
          <tbody>
            {roster.map((p) => {
              const m = p.memberships.find((x) => x.seasonId === season?.id);
              return (
                <tr key={p.id}>
                  <td>
                    {caps.isAdmin
                      ? <Link to={`/admin/members/${p.id}`}>{p.firstName}</Link>
                      : p.firstName}
                  </td>
                  <td>
                    {caps.isAdmin
                      ? <Link to={`/admin/members/${p.id}`} style={{ fontWeight: 600 }}>{p.lastName}</Link>
                      : <strong>{p.lastName}</strong>}
                  </td>
                  <td>{p.kind === 'coach' ? <Badge tone="navy">Coach</Badge> : 'Athlete'}</td>
                  <td>
                    {m?.status === 'active' ? <Badge tone="ok">✓ {season?.name}</Badge>
                      : m?.status === 'pending-club-payment' ? <Badge tone="warn">Pending club $</Badge>
                      : <Badge tone="err">None</Badge>}
                  </td>
                  <td>{lvlName(p.levels.WAG)}</td>
                  <td>{lvlName(p.levels.MAG)}</td>
                  <td>{lvlName(p.levels.TNT)}</td>
                  <td>{p.studentStatus === 'Student' ? '🎓' : '—'}</td>
                  {canManage && (
                    <td style={{ textAlign: 'right' }}>
                      {m?.status !== 'active' && (
                        <button
                          className="btn ghost small"
                          disabled={inviting === p.id || !p.email}
                          data-tip={p.email ? 'Email a link to purchase membership' : 'No email on file'}
                          onClick={() => invite(p)}
                        >
                          {inviting === p.id ? 'Sending…' : 'Invite'}
                        </button>
                      )}
                    </td>
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

// ---- MeetRegGrid (three-card layout) ----------------------------------------

function MeetRegGrid({ clubId, canManage }: { clubId: string; canManage: boolean }) {
  const db = useDB();
  const toast = useToast();
  const openMeets = db.meets.filter((m) => m.status === 'reg-open' || m.status === 'reg-closed');
  const [meetId, setMeetId] = useState(openMeets.find((m) => m.status === 'reg-open')?.id ?? openMeets[0]?.id);
  const meet = db.meets.find((m) => m.id === meetId);
  const season = db.seasons.find((s) => s.current)!;

  // Modal state for RegistrationEditor
  const [editingAthleteId, setEditingAthleteId] = useState<string | null>(null);
  const [registerAthleteId, setRegisterAthleteId] = useState<string | null>(null);

  const athletes = useMemo(() => db.people.filter(
    (p) => p.kind === 'athlete' && p.mainClubId === clubId,
  ).sort((a, b) => a.lastName.localeCompare(b.lastName)), [db, clubId]);

  if (!meet) return <p>No meets accepting registration.</p>;

  const regClosed = meet.status !== 'reg-open';

  // changeFee applies if the fee is defined and we're past the startsAt date
  const changeFeeApplies = !!(
    meet.changeFee &&
    new Date() >= new Date(meet.changeFee.startsAt)
  );

  // All non-refunded regs for this meet + club
  const allRegs = db.registrations.filter(
    (r) => r.meetId === meet.id && r.clubId === clubId && !r.refunded,
  );

  const regsFor = (athleteId: string) => allRegs.filter((r) => r.athleteId === athleteId);
  const hasActiveReg = (athleteId: string) => regsFor(athleteId).length > 0;
  const hasMembership = (athlete: Athlete) =>
    !!athlete.memberships.find((m) => m.seasonId === season?.id && m.status === 'active');

  // Split athletes into three groups
  const registered = athletes.filter((a) => hasActiveReg(a.id));
  const unregisteredWithMembership = athletes.filter((a) => !hasActiveReg(a.id) && hasMembership(a));
  const withoutMembership = athletes.filter((a) => !hasActiveReg(a.id) && !hasMembership(a));

  const lvlName = (id?: string) => db.levels.find((l) => l.id === id)?.name ?? '—';

  // Summarize registrations for a given athlete as "WAG – Silver – VT, BB, FX"
  const regSummary = (athleteId: string) => {
    const regs = regsFor(athleteId);
    if (regs.length === 0) return null;
    return regs.map((r) => `${r.discipline === 'TNT' ? 'T&T' : r.discipline} – ${lvlName(r.levelId)} – ${r.events.join(', ')}`).join(' / ');
  };

  // Persist registration changes from RegistrationEditor
  const saveRegs = (athleteId: string, newRegs: Registration[]) => {
    mutate((d) => {
      const existingForAthlete = d.registrations.filter(
        (r) => r.meetId === meet.id && r.athleteId === athleteId && r.clubId === clubId && !r.refunded,
      );

      // Disciplines covered by new regs
      const newDiscSet = new Set(newRegs.map((r) => r.discipline));

      // Remove regs for disciplines no longer covered (athlete deselected them)
      for (const old of existingForAthlete) {
        if (!newDiscSet.has(old.discipline)) {
          d.registrations = d.registrations.filter((r) => r.id !== old.id);
          deleteRegistration(old.id);
        }
      }

      // Upsert each new reg
      for (const reg of newRegs) {
        const idx = d.registrations.findIndex((r) => r.id === reg.id);
        if (idx >= 0) {
          d.registrations[idx] = reg;
        } else {
          d.registrations.push(reg);
        }
        pushRegistration(reg);
      }

      // If changeFee applies and we're editing, add a fee line to the club cart
      if (changeFeeApplies && existingForAthlete.length > 0 && meet.changeFee) {
        const cart = d.carts[clubId] ?? (d.carts[clubId] = []);
        const athlete = d.people.find((p) => p.id === athleteId)!;
        cart.push({
          id: `ci-change-${Date.now()}-${athleteId}`,
          label: `${meet.name} change fee — ${athlete.firstName} ${athlete.lastName}`,
          amount: meet.changeFee.amount,
          kind: 'meet-entry',
          refUserId: athleteId,
        });
        pushCart(clubId, cart, true);
      }
    });

    setEditingAthleteId(null);
    setRegisterAthleteId(null);
    toast(changeFeeApplies ? 'Registration updated. Change fee added to club cart.' : 'Registration saved.');
  };

  // Add entries to club cart (for unregistered athletes after editor saves)
  const addToCart = (athleteId: string, regs: Registration[]) => {
    saveRegs(athleteId, regs);
    // Queue cart items for the newly registered disciplines
    mutate((d) => {
      const cart = d.carts[clubId] ?? (d.carts[clubId] = []);
      const already = new Set(cart.filter((c) => c.kind === 'meet-entry').map((c) => c.refUserId));
      const athlete = d.people.find((p) => p.id === athleteId)!;
      const allMeetRegs = d.registrations.filter(
        (r) => r.meetId === meet.id && r.athleteId === athleteId && !r.refunded,
      );
      if (!already.has(athleteId)) {
        const isSecond = allMeetRegs.length > 1;
        cart.push({
          id: `ci-${Date.now()}-${athleteId}`,
          label: `${meet.name} entry — ${athlete.firstName} ${athlete.lastName} (${regs.map((r) => r.discipline).join('+')})`,
          amount: isSecond ? meet.secondDisciplineFee : meet.entryFee,
          kind: 'meet-entry',
          refUserId: athleteId,
        });
        pushCart(clubId, cart, true);
      }
    });
  };

  const requestRefund = (athleteId: string) => {
    mutate((d) => {
      for (const r of d.registrations.filter((x) => x.meetId === meet.id && x.athleteId === athleteId && x.clubId === clubId && !x.refunded)) {
        r.refundRequested = true;
        pushRegistration(r);
      }
    });
    toast('Refund requested — pending league admin approval.');
  };

  const editingAthlete = editingAthleteId ? db.people.find((p) => p.id === editingAthleteId) : null;
  const registerAthlete = registerAthleteId ? db.people.find((p) => p.id === registerAthleteId) : null;

  return (
    <div>
      {/* Meet selector */}
      <div className="grid cols-3" style={{ marginBottom: 14, alignItems: 'end' }}>
        <Field label="Meet">
          <select className="input" value={meetId} onChange={(e) => setMeetId(e.target.value)}>
            {openMeets.map((m) => <option key={m.id} value={m.id}>{m.name}{m.status !== 'reg-open' ? ' (closed)' : ''}</option>)}
          </select>
        </Field>
        <Field label="Entry fees">
          <div style={{ paddingTop: 8, fontSize: 14 }}>
            {fmtMoney(meet.entryFee)} first discipline · {fmtMoney(meet.secondDisciplineFee)} additional
            {meet.changeFee && (
              <span style={{ color: 'var(--warn-600, #a16207)', marginLeft: 8 }}>
                · Change fee {fmtMoney(meet.changeFee.amount)} after {new Date(meet.changeFee.startsAt).toLocaleDateString()}
              </span>
            )}
          </div>
        </Field>
        <Field label="Disciplines">
          <div style={{ paddingTop: 8, fontSize: 14 }}>
            {meet.disciplines.join(', ')}
          </div>
        </Field>
      </div>

      {regClosed && (
        <div className="card card-pad" style={{ borderLeft: '4px solid var(--coral-500)', marginBottom: 14 }}>
          Registration is closed for this meet. Changes require a league admin override.
        </div>
      )}

      {/* Card 1: Already registered */}
      <div className="card card-pad" style={{ marginBottom: 18 }}>
        <h3 className="card-title">Registered ({registered.length})</h3>
        {registered.length === 0 ? (
          <p style={{ color: 'var(--ink-soft)', fontSize: 14 }}>No club members registered yet.</p>
        ) : (
          <table className="tbl">
            <thead>
              <tr>
                <th>Athlete</th>
                <th>Registration</th>
                <th>Status</th>
                {canManage && <th />}
              </tr>
            </thead>
            <tbody>
              {registered.map((a) => {
                const regs = regsFor(a.id);
                const anyRefundReq = regs.some((r) => r.refundRequested);
                const summary = regSummary(a.id);
                return (
                  <tr key={a.id}>
                    <td><strong>{a.firstName} {a.lastName}</strong></td>
                    <td style={{ fontSize: 13 }}>{summary}</td>
                    <td>
                      {anyRefundReq
                        ? <Badge tone="warn">Refund requested</Badge>
                        : <Badge tone="ok">Registered</Badge>}
                    </td>
                    {canManage && (
                      <td style={{ whiteSpace: 'nowrap', display: 'flex', gap: 6 }}>
                        {!regClosed && (
                          <button
                            className="btn small ghost"
                            onClick={() => setEditingAthleteId(a.id)}
                          >
                            Edit
                          </button>
                        )}
                        {!anyRefundReq && (
                          <button
                            className="btn small ghost"
                            style={{ color: 'var(--coral-500)' }}
                            onClick={() => requestRefund(a.id)}
                          >
                            Refund
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Card 2: Members with membership, not yet registered */}
      {canManage && (
        <div className="card card-pad" style={{ marginBottom: 18 }}>
          <h3 className="card-title">Ready to register ({unregisteredWithMembership.length})</h3>
          <p style={{ fontSize: 13, color: 'var(--ink-soft)', marginBottom: 12 }}>
            Active members not yet registered for this meet.
          </p>
          {unregisteredWithMembership.length === 0 ? (
            <p style={{ color: 'var(--ink-soft)', fontSize: 14 }}>All members with memberships are registered.</p>
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th>Athlete</th>
                  <th>Disciplines available</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {unregisteredWithMembership.map((a) => (
                  <tr key={a.id}>
                    <td><strong>{a.firstName} {a.lastName}</strong></td>
                    <td style={{ fontSize: 13, color: 'var(--ink-soft)' }}>
                      {meet.disciplines.map((d) => (d === 'TNT' ? 'T&T' : d)).join(', ')}
                    </td>
                    <td>
                      <button
                        className="btn small primary"
                        disabled={regClosed}
                        onClick={() => setRegisterAthleteId(a.id)}
                      >
                        Register
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Card 3: Members without membership */}
      {canManage && withoutMembership.length > 0 && (
        <div className="card card-pad" style={{ marginBottom: 18 }}>
          <h3 className="card-title">No membership ({withoutMembership.length})</h3>
          <p style={{ fontSize: 13, color: 'var(--ink-soft)', marginBottom: 12 }}>
            These athletes need an active membership before they can register for a meet.{' '}
            <Link to="/membership">View membership options →</Link>
          </p>
          <table className="tbl">
            <thead>
              <tr>
                <th>Athlete</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {withoutMembership.map((a) => (
                <tr key={a.id}>
                  <td><strong>{a.firstName} {a.lastName}</strong></td>
                  <td>
                    <button
                      className="btn small ghost"
                      onClick={() => {
                        sendClubInvite({ clubId, kind: 'membership', email: a.email, name: `${a.firstName} ${a.lastName}` })
                          .then((res) => toast(res.ok
                            ? `Membership invite sent to ${a.email}.`
                            : `Invite failed: ${res.error ?? 'unknown error'}.`));
                      }}
                    >
                      Invite to purchase membership
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Edit registration modal */}
      {editingAthlete && (
        <Modal
          title={`Edit registration — ${editingAthlete.firstName} ${editingAthlete.lastName}`}
          onClose={() => setEditingAthleteId(null)}
        >
          <RegistrationEditor
            meet={meet}
            athlete={editingAthlete}
            clubId={clubId}
            existing={regsFor(editingAthlete.id)}
            allAthletes={db.people.filter((p) => p.kind === 'athlete')}
            levels={db.levels}
            season={season}
            onSave={(regs) => saveRegs(editingAthlete.id, regs)}
            onCancel={() => setEditingAthleteId(null)}
            changeFeeApplies={changeFeeApplies}
          />
        </Modal>
      )}

      {/* New registration modal */}
      {registerAthlete && (
        <Modal
          title={`Register — ${registerAthlete.firstName} ${registerAthlete.lastName}`}
          onClose={() => setRegisterAthleteId(null)}
        >
          <RegistrationEditor
            meet={meet}
            athlete={registerAthlete}
            clubId={clubId}
            existing={[]}
            allAthletes={db.people.filter((p) => p.kind === 'athlete')}
            levels={db.levels}
            season={season}
            onSave={(regs) => addToCart(registerAthlete.id, regs)}
            onCancel={() => setRegisterAthleteId(null)}
          />
        </Modal>
      )}
    </div>
  );
}

// ---- ClubCart ---------------------------------------------------------------

export function ClubCart() {
  const { clubId } = useParams();
  const db = useDB();
  const toast = useToast();
  const fmtDate = useFmtDate();
  const [coupon, setCoupon] = useState('');
  const club = db.clubs.find((c) => c.id === clubId);
  if (!club) return <p>Club not found.</p>;
  const cart = db.carts[club.id] ?? [];
  const invoices = db.invoices.filter((i) => i.clubId === club.id);
  const couponDef = db.coupons.find((c) => c.code === coupon.toUpperCase());
  const subtotal = cart.reduce((s, i) => s + i.amount, 0);
  const discount = couponDef ? (couponDef.amountOff ?? subtotal * (couponDef.pctOff ?? 0) / 100) : 0;
  const total = Math.max(0, subtotal - discount);

  // Group cart items by meet (detect from label) and by memberships
  const meetNames = Array.from(new Set(
    cart.filter((i) => i.kind === 'meet-entry').map((i) => {
      // Label format: "<meet name> entry — <athlete> (<disc>)"
      const m = i.label.match(/^(.+?) entry —/);
      return m ? m[1] : 'Meet entries';
    }),
  ));
  const membershipItems = cart.filter((i) => i.kind === 'membership');

  // Registration summary per athlete (from the DB)
  const regSummaryForItem = (item: typeof cart[number]): string | null => {
    if (!item.refUserId || item.kind !== 'meet-entry') return null;
    const meetMatch = item.label.match(/^(.+?) entry —/);
    if (!meetMatch) return null;
    const meetName = meetMatch[1];
    const meet = db.meets.find((m) => m.name === meetName);
    if (!meet) return null;
    const regs = db.registrations.filter(
      (r) => r.meetId === meet.id && r.athleteId === item.refUserId && !r.refunded,
    );
    if (regs.length === 0) return null;
    return regs.map((r) => {
      const lvl = db.levels.find((l) => l.id === r.levelId)?.name ?? '—';
      return `${r.discipline === 'TNT' ? 'T&T' : r.discipline} – ${lvl} – ${r.events.join(', ')}`;
    }).join(' / ');
  };

  return (
    <div style={{ maxWidth: 820 }}>
      <h1 className="page-title display">{club.shortName} — Cart &amp; invoices</h1>
      <p className="page-sub">
        Memberships pushed to the club, meet entries, and add-ons.
        Each membership is a separate line item so single refunds stay clean.
      </p>
      <div style={{ marginBottom: 16 }}>
        <Link className="btn ghost small" to={`/club/${club.id}`}>← Back to club page</Link>
      </div>

      {/* Cart grouped by event / memberships */}
      {cart.length > 0 && (
        <>
          {/* Meet entry cards */}
          {meetNames.map((meetName) => {
            const items = cart.filter((i) => i.kind === 'meet-entry' && i.label.startsWith(meetName));
            return (
              <div key={meetName} className="card card-pad" style={{ marginBottom: 18 }}>
                <h3 className="card-title">{meetName}</h3>
                <p style={{ fontSize: 13, color: 'var(--ink-soft)', marginBottom: 10 }}>
                  Meet entries · <Link to={`/club/${club.id}`}>Return to registration →</Link>
                </p>
                <table className="tbl">
                  <tbody>
                    {items.map((i) => {
                      const summary = regSummaryForItem(i);
                      return (
                        <tr key={i.id}>
                          <td>
                            <div>{i.label} <Badge tone="info">{i.kind}</Badge></div>
                            {summary && (
                              <div style={{ fontSize: 12, color: 'var(--ink-soft)', marginTop: 2 }}>
                                {summary}
                              </div>
                            )}
                          </td>
                          <td className="num">{fmtMoney(i.amount)}</td>
                          <td style={{ width: 40 }}>
                            <button className="btn small ghost" data-tip="Remove from cart" onClick={() => mutate((d) => {
                              d.carts[club.id] = (d.carts[club.id] ?? []).filter((x) => x.id !== i.id);
                              pushCart(club.id, d.carts[club.id], true);
                            })}>✕</button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            );
          })}

          {/* Memberships card */}
          {membershipItems.length > 0 && (
            <div className="card card-pad" style={{ marginBottom: 18 }}>
              <h3 className="card-title">Memberships</h3>
              <p style={{ fontSize: 13, color: 'var(--ink-soft)', marginBottom: 10 }}>
                Memberships pushed to the club cart by members.{' '}
                <Link to="/membership">Return to membership purchasing →</Link>
              </p>
              <table className="tbl">
                <tbody>
                  {membershipItems.map((i) => (
                    <tr key={i.id}>
                      <td>{i.label} <Badge tone="info">membership</Badge></td>
                      <td className="num">{fmtMoney(i.amount)}</td>
                      <td style={{ width: 40 }}>
                        <button className="btn small ghost" onClick={() => mutate((d) => {
                          d.carts[club.id] = (d.carts[club.id] ?? []).filter((x) => x.id !== i.id);
                          pushCart(club.id, d.carts[club.id], true);
                        })}>✕</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Other items */}
          {cart.filter((i) => i.kind !== 'meet-entry' && i.kind !== 'membership').length > 0 && (
            <div className="card card-pad" style={{ marginBottom: 18 }}>
              <h3 className="card-title">Other items</h3>
              <table className="tbl">
                <tbody>
                  {cart.filter((i) => i.kind !== 'meet-entry' && i.kind !== 'membership').map((i) => (
                    <tr key={i.id}>
                      <td>{i.label} <Badge tone="info">{i.kind}</Badge></td>
                      <td className="num">{fmtMoney(i.amount)}</td>
                      <td style={{ width: 40 }}>
                        <button className="btn small ghost" onClick={() => mutate((d) => {
                          d.carts[club.id] = (d.carts[club.id] ?? []).filter((x) => x.id !== i.id);
                          pushCart(club.id, d.carts[club.id], true);
                        })}>✕</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* Summary + checkout */}
      <div className="card card-pad" style={{ marginBottom: 18 }}>
        <h3 className="card-title">Club cart ({cart.length})</h3>
        {cart.length === 0 ? <p style={{ color: 'var(--ink-soft)' }}>Cart is empty.</p> : (
          <div style={{ display: 'flex', gap: 14, alignItems: 'end', marginTop: 14, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 180 }}>
              <Field label="Coupon code"><input type="text" value={coupon} onChange={(e) => setCoupon(e.target.value)} placeholder="EARLYBIRD" /></Field>
            </div>
            <div style={{ textAlign: 'right', marginBottom: 14 }}>
              <div style={{ fontSize: 14 }}>{cart.length} item{cart.length !== 1 ? 's' : ''} · Subtotal {fmtMoney(subtotal)}</div>
              {discount > 0 && <div style={{ color: 'var(--green-600)', fontSize: 14 }}>Coupon −{fmtMoney(discount)}</div>}
              <div style={{ fontSize: 20, fontWeight: 700 }}>Total {fmtMoney(total)}</div>
            </div>
            <button
              className="btn primary"
              style={{ marginBottom: 14 }}
              onClick={() => {
                mutate((d) => {
                  const items = d.carts[club.id] ?? [];
                  const invoice = {
                    id: `inv-${Date.now()}`, number: `UCG-2026-${String(d.invoices.length + 1).padStart(4, '0')}`,
                    clubId: club.id, athleteId: null, createdAt: new Date().toISOString(), paidAt: new Date().toISOString(),
                    items: [...items], couponCode: couponDef?.code,
                  };
                  d.invoices.push(invoice);
                  pushInvoice(invoice);
                  for (const item of items) {
                    if (item.kind === 'membership' && item.refUserId) {
                      const person = d.people.find((p) => p.id === item.refUserId);
                      const m = person?.memberships.find((x) => x.status === 'pending-club-payment');
                      if (m) { m.status = 'active'; m.paidVia = 'club'; pushMembership(person!.id, m); }
                    }
                  }
                  d.carts[club.id] = [];
                  pushCart(club.id, [], true);
                });
                toast('Payment processed — memberships activated, confirmations emailed.');
              }}
            >
              Pay {fmtMoney(total)} →
            </button>
          </div>
        )}
      </div>

      {/* Invoices */}
      <div className="card card-pad">
        <h3 className="card-title">Invoices &amp; receipts</h3>
        {invoices.length === 0 ? <p style={{ color: 'var(--ink-soft)' }}>No invoices yet.</p> : (
          <table className="tbl">
            <thead><tr><th>Invoice</th><th>Date</th><th>Items</th><th className="num">Total</th><th /></tr></thead>
            <tbody>
              {invoices.map((inv) => (
                <tr key={inv.id}>
                  <td><strong>{inv.number}</strong></td>
                  <td>{fmtDate(inv.createdAt.slice(0, 10))}</td>
                  <td style={{ fontSize: 13 }}>{inv.items.map((i) => i.label).join('; ')}</td>
                  <td className="num">{fmtMoney(inv.items.reduce((s, i) => s + i.amount, 0))}</td>
                  <td><button className="btn small ghost" onClick={() => window.print()}>PDF</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
