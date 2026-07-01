import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { useDB, mutate, syncFromSupabase } from '../lib/store';
import { useCapabilities } from '../lib/capabilities';
import { clubHasActiveMembership, seasonForDate, membershipHolds, paidRegistrationClub } from '../lib/capabilities-core';
import { Badge, Combo, Field, Modal } from '../components/ui';
import { useToast, useFmtDate } from '../components/ui-hooks';
import type { ToastOptions } from '../components/ui-hooks';
import { CLUB_ACCESS_LABELS, STATE_REGIONS } from '../lib/types';
import type { Athlete, CartItem, Club, ClubAccess, DB, Invoice, Registration, Season } from '../lib/types';
import { fmtMoney } from '../lib/scoring';
import { downloadReceipt, invoiceTotal } from '../lib/receipt';
import { newRegistrationEntryTotal, reassignPartners, registrationChangeFee } from '../lib/pricing';
import {
  deleteRegistration, pushCart, pushClub, pushClubManager,
  pushRegistration, requestManagerAccess, sendClubInvite,
  inviteAccount, pushClubMembership, deleteClubMembership,
} from '../lib/supabase';
import type { ClubMembership } from '../lib/types';
import { ClubForm } from '../components/ClubForm';
import { RegistrationEditor } from '../components/RegistrationEditor';
import { CartCheckout } from '../components/CartCheckout';

// ---- sort helpers -----------------------------------------------------------

type SortCol = 'firstName' | 'lastName' | 'WAG' | 'MAG' | 'TNT' | 'studentStatus';

/** Event list as text, appending the synchro partner's name when the SY event is
 *  registered and a partner is set (per 2026-06-22 feedback). */
function eventsText(r: Registration, nameOf: (id: string) => string): string {
  const base = r.apparatus.join(', ');
  if (r.apparatus.includes('SY') && r.partnerAthleteId) {
    return `${base} (synchro w/ ${nameOf(r.partnerAthleteId)})`;
  }
  return base;
}

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

type ClubView = 'roster' | 'registrations';

export function ClubPage({ view }: { view: ClubView }) {
  const { clubId } = useParams();
  const db = useDB();
  const caps = useCapabilities();
  const toast = useToast();
  const navigate = useNavigate();
  const club = db.clubs.find((c) => c.id === clubId);
  const [editingClub, setEditingClub] = useState(false);
  const [addingAthlete, setAddingAthlete] = useState(false);
  const [addingCoach, setAddingCoach] = useState(false);
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
              onChange={(v) => { if (v && v !== club.id) navigate(`/club/${v}/${view}`); }}
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
        <Link className="btn ghost small" to={`/club/${club.id}/cart`}>Club cart & receipts →</Link>
        {canManage && (
          <>
            <button className="btn ghost small" onClick={() => setEditingClub(true)}>Edit club details</button>
            <button className="btn ghost small" data-tip="Ask UCG to sanction an event hosted by your club" onClick={() => alert('Sanction request form — wires to league admin approval queue (post-MVP).')}>Request event sanction</button>
            <button className="btn ghost small" data-tip="Create an account for an athlete and email them a set-password link" onClick={() => setAddingAthlete(true)}>Add athlete</button>
            <button className="btn ghost small" data-tip="Create an account for a coach and email them a set-password link" onClick={() => setAddingCoach(true)}>Add coach</button>
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

      {view === 'roster' ? (
        <>
          <ClubMembershipCard club={club} />
          {canManage && <ClubManagers club={club} />}
          {canManage && <ClubSettings club={club} />}
          <h2 className="card-title" style={{ marginBottom: 10 }}>Roster ({rosterSize})</h2>
          <Roster clubId={club.id} canManage={canManage} />
        </>
      ) : (
        <EventRegGrid clubId={club.id} canManage={canManage} />
      )}

      {editingClub && <ClubForm club={club} onClose={() => setEditingClub(false)} />}
      {addingAthlete && <AddPersonModal clubId={club.id} clubName={club.name} kind="athlete" onClose={() => setAddingAthlete(false)} />}
      {addingCoach && <AddPersonModal clubId={club.id} clubName={club.name} kind="coach" onClose={() => setAddingCoach(false)} />}
    </div>
  );
}

// ---- AddPersonModal ---------------------------------------------------------
// Creates a real account for an athlete OR coach (first/last/email) with this
// club as their main club, and emails them a set-password link (invite-account
// fn). After signing in they land on the membership page; a coach's profile
// arrives with the coach role pre-checked.
function AddPersonModal({ clubId, clubName, kind, onClose }: { clubId: string; clubName: string; kind: 'athlete' | 'coach'; onClose: () => void }) {
  const toast = useToast();
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const valid = first.trim() && last.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  const submit = async () => {
    if (!valid) { toast('Enter a first name, last name, and a valid email.'); return; }
    setBusy(true);
    const res = await inviteAccount({ clubId, email: email.trim(), firstName: first.trim(), lastName: last.trim(), kind });
    setBusy(false);
    if (res.ok) { toast(`Account created — a set-password link was emailed to ${email.trim()}.`); onClose(); }
    else { toast(res.error ?? 'Could not create the account.', { variant: 'error' }); }
  };

  return (
    <Modal title={`Add ${kind} to ${clubName}`} onClose={onClose}>
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

// ---- ClubMembershipCard -----------------------------------------------------
// Shows the club's membership status per season. Managers PURCHASE by first
// reviewing/editing club info on a dedicated screen, then confirming — which
// adds a club-membership line to the club cart (NOT an instant active row) and
// routes to the cart. The `club_memberships` row is created only when that cart
// line is PAID (ClubCart pay handler), so the registration/hosting gate
// (clubHasActiveMembership) stays false until payment. League admins may still
// grant/revoke an active row directly for any season (an admin override).
function ClubMembershipCard({ club }: { club: Club }) {
  const db = useDB();
  const caps = useCapabilities();
  const toast = useToast();
  const navigate = useNavigate();
  const [reviewSeason, setReviewSeason] = useState<string | null>(null);

  const isAdmin = caps.actingAsAdmin;
  const canManage = isAdmin || caps.managedClubIds.includes(club.id);
  const currentSeason = db.seasons.find((s) => s.current);
  const seasons = db.seasons.filter((s) => s.active).slice().sort((a, b) => a.startsOn.localeCompare(b.startsOn));
  const seasonName = (id: string) => db.seasons.find((s) => s.id === id)?.name ?? id;

  // A club-membership line for this season is already waiting in the club cart.
  const cartHasSeason = (seasonId: string) =>
    (db.carts[club.id] ?? []).some((i) => i.kind === 'membership' && i.refType === 'club' && i.refSeasonId === seasonId);

  const grant = (seasonId: string, byAdmin: boolean) => {
    const cm: ClubMembership = { id: crypto.randomUUID(), clubId: club.id, seasonId, status: 'active', grantedByAdmin: byAdmin, createdAt: new Date().toISOString() };
    mutate((d) => { (d.clubMemberships ??= []).push(cm); pushClubMembership(cm); });
    toast(`Club membership ${byAdmin ? 'granted' : 'purchased'} for ${seasonName(seasonId)}.`);
  };
  const revoke = (seasonId: string) => {
    const cm = (db.clubMemberships ?? []).find((x) => x.clubId === club.id && x.seasonId === seasonId);
    if (!cm) return;
    mutate((d) => { d.clubMemberships = (d.clubMemberships ?? []).filter((x) => x.id !== cm.id); deleteClubMembership(cm.id); });
    toast(`Club membership revoked for ${seasonName(seasonId)}.`);
  };

  // Confirm step: persist any club-info edits, add the club-membership line to
  // the club cart, then route to the cart. No active row is created here.
  const addToCart = (seasonId: string) => {
    const season = db.seasons.find((s) => s.id === seasonId);
    if (!season) return;
    if (cartHasSeason(seasonId)) {
      toast(`A ${seasonName(seasonId)} club membership is already in the cart.`);
      navigate(`/club/${club.id}/cart`);
      setReviewSeason(null);
      return;
    }
    mutate((d) => {
      const cart = d.carts[club.id] ?? (d.carts[club.id] = []);
      cart.push({
        id: `ci-clubmem-${Date.now()}-${seasonId}`,
        label: `${club.shortName} club membership — ${season.name}`,
        amount: season.clubFee,
        kind: 'membership',
        refSeasonId: seasonId,
        refType: 'club',
      });
      pushCart(club.id, cart, true);
    });
    toast(`${seasonName(seasonId)} club membership added to the cart. Pay to activate it.`);
    setReviewSeason(null);
    navigate(`/club/${club.id}/cart`);
  };

  const currentActive = currentSeason ? clubHasActiveMembership(db, club.id, currentSeason.id) : false;

  return (
    <div className="card card-pad" style={{ marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <h3 className="card-title" style={{ margin: 0 }}>Club membership</h3>
        {currentSeason && (currentActive
          ? <Badge tone="ok">✓ Active · {currentSeason.name}</Badge>
          : <Badge tone="err">Not active · {currentSeason?.name}</Badge>)}
      </div>
      <p style={{ fontSize: 13, color: 'var(--ink-soft)', marginTop: 0 }}>
        A club must hold an active membership for a season before its athletes can register or it can host that season.
        Membership runs July 1 – June 30. Membership is not active until payment is made.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {seasons.map((s) => {
          const active = clubHasActiveMembership(db, club.id, s.id);
          const inCart = cartHasSeason(s.id);
          return (
            <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 14, padding: '4px 0', borderBottom: '1px solid var(--line)' }}>
              <span style={{ minWidth: 150 }}>
                {s.name}{s.current ? ' (current season)' : ' (upcoming season)'}
              </span>
              {active ? <Badge tone="ok">Active</Badge> : inCart ? <Badge tone="info">In cart</Badge> : <Badge tone="warn">None</Badge>}
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                {!active && canManage && (inCart
                  ? <Link className="btn small ghost" to={`/club/${club.id}/cart`}>View in cart →</Link>
                  : <button className="btn small primary" onClick={() => setReviewSeason(s.id)}>
                      Purchase
                    </button>)}
                {isAdmin && (active
                  ? <button className="btn small ghost" onClick={() => revoke(s.id)}>Revoke</button>
                  : <button className="btn small ghost" onClick={() => grant(s.id, true)}>Grant (admin)</button>)}
              </span>
            </div>
          );
        })}
      </div>

      {reviewSeason && (
        <ClubMembershipReview
          club={club}
          season={db.seasons.find((s) => s.id === reviewSeason)!}
          isCurrent={!!db.seasons.find((s) => s.id === reviewSeason)?.current}
          onConfirm={() => addToCart(reviewSeason)}
          onClose={() => setReviewSeason(null)}
        />
      )}
    </div>
  );
}

// ---- ClubMembershipReview ---------------------------------------------------
// The review/edit-club-info step shown before a club membership is added to the
// cart. Reuses ClubForm's field subset (name, short name, state→region, email)
// so the manager can correct details and SAVE them to the club, then confirm
// "everything's correct" to add the membership to the cart. Saving persists via
// the same pushClub path ClubForm uses.
function ClubMembershipReview({ club, season, isCurrent, onConfirm, onClose }: {
  club: Club; season: Season; isCurrent: boolean; onConfirm: () => void; onClose: () => void;
}) {
  const toast = useToast();
  const [draft, setDraft] = useState({ name: club.name, shortName: club.shortName, state: club.state, email: club.email });
  const set = (patch: Partial<typeof draft>) => setDraft({ ...draft, ...patch });
  const region = STATE_REGIONS[draft.state] ?? 'Other';
  const states = Object.keys(STATE_REGIONS);
  const valid = draft.name.trim() && draft.shortName.trim() && draft.state;

  // True when the draft differs from the saved club (so we know to persist).
  const dirty = draft.name !== club.name || draft.shortName !== club.shortName
    || draft.state !== club.state || draft.email !== club.email;

  const persistEdits = () => {
    if (!dirty) return;
    mutate((d) => {
      const c = d.clubs.find((x) => x.id === club.id);
      if (!c) return;
      c.name = draft.name.trim();
      c.shortName = draft.shortName.trim();
      c.state = draft.state;
      c.region = region;
      c.email = draft.email;
      pushClub(c);
    });
  };

  const saveOnly = () => {
    if (!valid) { toast('Name, short name, and state are required.'); return; }
    persistEdits();
    toast('Club details saved.');
  };

  const confirm = () => {
    if (!valid) { toast('Name, short name, and state are required.'); return; }
    persistEdits();
    onConfirm();
  };

  return (
    <Modal title={`Review club info — ${season.name} membership`} onClose={onClose}>
      {!isCurrent && (
        <div className="card card-pad" style={{ borderLeft: '4px solid var(--amber-600)', marginBottom: 12 }}>
          ⚠ You are purchasing for <strong>{season.name}</strong>, which is not the current season.
        </div>
      )}
      <p style={{ fontSize: 14, marginTop: 0 }}>
        Review and correct your club’s details — they must be right for the season. Edits save to the club.
        Confirming adds a <strong>{fmtMoney(season.clubFee)}</strong> club membership to your cart;
        it activates once the cart is paid.
      </p>
      <div className="grid cols-2">
        <Field label="Club name"><input type="text" value={draft.name} onChange={(e) => set({ name: e.target.value })} /></Field>
        <Field label="Short name"><input type="text" value={draft.shortName} onChange={(e) => set({ shortName: e.target.value })} /></Field>
        <Field label="State">
          <Combo options={states.map((s) => ({ value: s, label: s, sub: STATE_REGIONS[s] }))} value={draft.state || null} onChange={(v) => set({ state: v })} />
        </Field>
        <Field label="Region" hint="Derived from state."><input type="text" disabled value={draft.state ? region : '—'} /></Field>
        <Field label="Club email"><input type="email" value={draft.email} onChange={(e) => set({ email: e.target.value })} /></Field>
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
        <button className="btn primary" disabled={!valid} onClick={confirm}>Everything’s correct — add to cart</button>
        <button className="btn ghost" disabled={!valid || !dirty} onClick={saveOnly}>Save edits</button>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

// ---- ClubManagers -----------------------------------------------------------

function ClubManagers({ club }: { club: Club }) {
  const db = useDB();
  const toast = useToast();
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
      <Field label="Add an existing member as manager" hint="To bring on a brand-new coach, use “Add coach” at the top of the page — once they appear on the roster you can add them here.">
        <Combo options={candidates} value={null} onChange={addManager} placeholder="Search people…" />
      </Field>
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

  const sorted = useMemo(
    () => sortRoster(filtered, sortCol, sortDir, lvlName),
    [filtered, sortCol, sortDir, db.levels],
  );

  // A person appears under Athletes if they hold the athlete role, and under
  // Coaches if they hold the coach role — a dual-role person shows in BOTH
  // sections (each row reflects the same membership status). `roles` is the
  // canonical signal; fall back to the legacy `kind` only if roles is unset.
  const athletes = useMemo(
    () => sorted.filter((p) => (p.roles ? p.roles.athlete : p.kind === 'athlete')),
    [sorted],
  );
  const coaches = useMemo(
    () => sorted.filter((p) => (p.roles ? p.roles.coach : p.kind === 'coach')),
    [sorted],
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
      <RosterTable
        heading={`Athletes (${athletes.length})`}
        people={athletes}
        emptyText="No athletes on the roster yet."
        season={season}
        canManage={canManage}
        isAdmin={caps.isAdmin}
        inviting={inviting}
        onInvite={invite}
        lvlName={lvlName}
        handleSort={handleSort}
        sortIcon={sortIcon}
      />
      <RosterTable
        heading={`Coaches (${coaches.length})`}
        people={coaches}
        emptyText="No coaches on the roster yet. Use “Add coach” above to invite one."
        season={season}
        canManage={canManage}
        isAdmin={caps.isAdmin}
        inviting={inviting}
        onInvite={invite}
        lvlName={lvlName}
        handleSort={handleSort}
        sortIcon={sortIcon}
      />
    </div>
  );
}

// ---- RosterTable (shared by the Athletes + Coaches sections) ----------------
// One sortable table of people with a membership-status line and (for managers)
// an "invite to purchase membership" action — used identically for athletes and
// coaches so coaches list with the same affordances regardless of membership.
function RosterTable({
  heading, people, emptyText, season, canManage, isAdmin, inviting, onInvite,
  lvlName, handleSort, sortIcon,
}: {
  heading: string;
  people: Athlete[];
  emptyText: string;
  season: Season | undefined;
  canManage: boolean;
  isAdmin: boolean;
  inviting: string | null;
  onInvite: (p: Athlete) => void;
  lvlName: (id?: string) => string;
  handleSort: (col: SortCol) => void;
  sortIcon: (col: SortCol) => string;
}) {
  return (
    <div style={{ marginBottom: 18 }}>
      <h3 className="card-title" style={{ marginBottom: 8 }}>{heading}</h3>
      {people.length === 0 ? (
        <p style={{ color: 'var(--ink-soft)', fontSize: 14, marginTop: 0 }}>{emptyText}</p>
      ) : (
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
              {people.map((p) => {
                const m = p.memberships.find((x) => x.seasonId === season?.id);
                const isCoach = p.roles ? p.roles.coach : p.kind === 'coach';
                const isAthlete = p.roles ? p.roles.athlete : p.kind === 'athlete';
                return (
                  <tr key={p.id}>
                    <td>
                      {isAdmin
                        ? <Link to={`/admin/members/${p.id}`}>{p.firstName}</Link>
                        : p.firstName}
                    </td>
                    <td>
                      {isAdmin
                        ? <Link to={`/admin/members/${p.id}`} style={{ fontWeight: 600 }}>{p.lastName}</Link>
                        : <strong>{p.lastName}</strong>}
                    </td>
                    <td>
                      {isCoach && <Badge tone="navy">Coach</Badge>}
                      {isCoach && isAthlete && ' '}
                      {isAthlete && (isCoach ? <Badge tone="info">Athlete</Badge> : 'Athlete')}
                    </td>
                    <td>
                      {(() => {
                        if (!m) return <Badge tone="err">None</Badge>;
                        const h = membershipHolds(m);
                        if (h.active) return <Badge tone="ok">✓ {season?.name}</Badge>;
                        // The two holds are independent and can both be active at once
                        // (e.g. a minor whose fee was pushed to the club cart is
                        // awaiting BOTH the guardian waiver AND the club's payment) —
                        // render each as its own badge rather than picking just one.
                        if (h.waiverHold || h.paymentHold) {
                          return (
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                              {h.waiverHold && <Badge tone="warn">Pending waiver</Badge>}
                              {h.paymentHold && <Badge tone="warn">Pending club $</Badge>}
                            </div>
                          );
                        }
                        return <Badge tone="err">None</Badge>;
                      })()}
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
                            onClick={() => onInvite(p)}
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
      )}
    </div>
  );
}

// ---- Cross-club cart cleanup (3d) -------------------------------------------

/** Resolve the eventId a club-cart meet-entry line is for: prefer the linked
 *  registration(s) (`refRegIds`), else fall back to the "<event name> entry —"
 *  label parse. */
function cartItemEventId(db: DB, item: CartItem): string | null {
  if (item.refRegIds && item.refRegIds.length > 0) {
    const reg = db.registrations.find((r) => item.refRegIds!.includes(r.id));
    if (reg) return reg.eventId;
  }
  const m = item.label.match(/^(.+?) entry —/);
  if (m) return db.events.find((mt) => mt.name === m[1])?.id ?? null;
  return null;
}

/** The club-cart meet-entry lines for `clubId` whose athlete has SINCE become
 *  PAID-registered under a DIFFERENT club for that event (pending line is moot).
 *  Excludes THIS club so a legitimate same-club pending line is never flagged. */
function staleCrossClubCartItems(db: DB, clubId: string): CartItem[] {
  const cart = db.carts[clubId] ?? [];
  return cart.filter((i) => {
    if (i.kind !== 'meet-entry' || !i.refUserId) return false;
    const eventId = cartItemEventId(db, i);
    if (!eventId) return false;
    return paidRegistrationClub(db.registrations, {
      athleteId: i.refUserId, eventId, excludeClubId: clubId,
    }) !== null;
  });
}

/** Remove the stale cross-club cart lines for `clubId` and toast the manager
 *  once per removed athlete. Idempotent: after removal the next pass finds
 *  nothing, so it never re-toasts. Call from a mount effect. No-op when clean. */
function cleanupCrossClubCart(
  db: DB,
  clubId: string,
  toast: (msg: string, opts?: ToastOptions) => void,
): void {
  const removable = staleCrossClubCartItems(db, clubId);
  if (removable.length === 0) return;
  const removeIds = new Set(removable.map((i) => i.id));
  mutate((d) => {
    d.carts[clubId] = (d.carts[clubId] ?? []).filter((x) => !removeIds.has(x.id));
    pushCart(clubId, d.carts[clubId], true);
  });
  for (const i of removable) {
    const athlete = db.people.find((p) => p.id === i.refUserId);
    const name = athlete ? `${athlete.firstName} ${athlete.lastName}` : 'An athlete';
    const eventId = cartItemEventId(db, i);
    const otherClubId = eventId && i.refUserId
      ? paidRegistrationClub(db.registrations, { athleteId: i.refUserId, eventId, excludeClubId: clubId })
      : null;
    const otherShort = otherClubId
      ? db.clubs.find((c) => c.id === otherClubId)?.shortName ?? 'another club'
      : 'another club';
    toast(`${name} was removed from the cart — they're now registered with ${otherShort}.`, { variant: 'info' });
  }
}

// ---- EventRegGrid (three-card layout) ----------------------------------------

function EventRegGrid({ clubId, canManage }: { clubId: string; canManage: boolean }) {
  const db = useDB();
  const toast = useToast();
  const openEvents = db.events.filter((m) => m.status === 'reg-open' || m.status === 'reg-closed');
  const [eventId, setEventId] = useState(openEvents.find((m) => m.status === 'reg-open')?.id ?? openEvents[0]?.id);
  const event = db.events.find((m) => m.id === eventId);
  const season = db.seasons.find((s) => s.current)!;

  // Modal state for RegistrationEditor
  const [editingAthleteId, setEditingAthleteId] = useState<string | null>(null);
  const [registerAthleteId, setRegisterAthleteId] = useState<string | null>(null);

  const athletes = useMemo(() => db.people.filter(
    (p) => p.kind === 'athlete' && p.mainClubId === clubId,
  ).sort((a, b) => a.lastName.localeCompare(b.lastName)), [db, clubId]);

  // Cross-club cart cleanup (3d): also run when a manager opens the registrations
  // view (not only the cart), so the moot pending line + its toast surface here.
  useEffect(() => {
    cleanupCrossClubCart(db, clubId, toast);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, clubId]);

  if (!event) return <p>No events accepting registration.</p>;

  const regClosed = event.status !== 'reg-open';

  // Gate: the club must hold an active membership for the event's season before
  // registering any athlete. Returns true (and toasts) when blocked.
  const clubMembershipBlocked = (): boolean => {
    const seasonId = seasonForDate(db, event.startDate);
    if (!clubHasActiveMembership(db, clubId, seasonId)) {
      const sName = db.seasons.find((s) => s.id === seasonId)?.name ?? 'this season';
      const club = db.clubs.find((c) => c.id === clubId);
      toast(`${club?.shortName ?? 'This club'} needs an active ${sName} club membership before registering athletes for this event. Purchase it on the club page.`, { variant: 'error' });
      return true;
    }
    return false;
  };

  // changeFee applies if the fee is defined and we're past the startsAt date
  const changeFeeApplies = !!(
    event.changeFee &&
    new Date() >= new Date(event.changeFee.startsAt)
  );

  // All non-refunded regs for this event + club
  const allRegs = db.registrations.filter(
    (r) => r.eventId === event.id && r.clubId === clubId && !r.refunded,
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

  const nameOf = (id: string) => {
    const p = db.people.find((x) => x.id === id);
    return p ? `${p.firstName} ${p.lastName}` : 'partner';
  };

  // Summarize registrations for a given athlete as "WAG – Silver – VT, BB, FX"
  const regSummary = (athleteId: string) => {
    const regs = regsFor(athleteId);
    if (regs.length === 0) return null;
    return regs.map((r) => `${r.discipline === 'TNT' ? 'T&T' : r.discipline} – ${lvlName(r.levelId)} – ${eventsText(r, nameOf)}`).join(' / ');
  };

  // Cross-club lock (3d): the OTHER club this athlete is already PAID-registered
  // with for this event. Non-null ⇒ not selectable here. shortName for the note.
  const lockedToClubShortName = (athleteId: string): string | null => {
    const otherClubId = paidRegistrationClub(db.registrations, {
      athleteId, eventId: event.id, excludeClubId: clubId,
    });
    if (!otherClubId) return null;
    return db.clubs.find((c) => c.id === otherClubId)?.shortName ?? 'another club';
  };

  // Persist registration changes from RegistrationEditor
  const saveRegs = (athleteId: string, newRegs: Registration[]) => {
    if (clubMembershipBlocked()) return;
    mutate((d) => {
      const existingForAthlete = d.registrations.filter(
        (r) => r.eventId === event.id && r.athleteId === athleteId && r.clubId === clubId && !r.refunded,
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

      // A chargeable edit (change fee applies, editing existing regs, and the
      // fee is non-zero — i.e. NOT the host club's own athletes).
      const changeFee = changeFeeApplies && existingForAthlete.length > 0
        ? registrationChangeFee(event, { competingClubId: clubId })
        : 0;

      // Upsert each new reg. A chargeable edit flips a previously-PAID reg back
      // to "Updated pending purchase"; otherwise preserve its payment state
      // (new regs created here get their paid flag set in addToCart's pass).
      const priorById = new Map(existingForAthlete.map((r) => [r.id, r]));
      for (const reg of newRegs) {
        const prior = priorById.get(reg.id);
        if (prior) {
          if (changeFee > 0 && prior.paid) {
            reg.paid = false;
            reg.updatedPending = true;
          } else {
            reg.paid = prior.paid ?? false;
            reg.updatedPending = prior.updatedPending ?? false;
          }
        }
        const idx = d.registrations.findIndex((r) => r.id === reg.id);
        if (idx >= 0) {
          d.registrations[idx] = reg;
        } else {
          d.registrations.push(reg);
        }
        pushRegistration(reg);
      }

      // If a (non-host) change fee applies on an edit, add a fee line linked to
      // the affected regs so paying it flips them back to paid.
      if (changeFee > 0 && event.changeFee) {
        const cart = d.carts[clubId] ?? (d.carts[clubId] = []);
        const athlete = d.people.find((p) => p.id === athleteId)!;
        cart.push({
          id: `ci-change-${Date.now()}-${athleteId}`,
          label: `${event.name} change fee — ${athlete.firstName} ${athlete.lastName}`,
          amount: changeFee,
          kind: 'meet-entry',
          refUserId: athleteId,
          refRegIds: newRegs.map((r) => r.id),
          refEventId: event.id,
          refLineType: 'change',
        });
        pushCart(clubId, cart, true);
      }
    });

    setEditingAthleteId(null);
    setRegisterAthleteId(null);
    const editedHostFree = changeFeeApplies && registrationChangeFee(event, { competingClubId: clubId }) === 0;
    toast(
      changeFeeApplies && !editedHostFree
        ? 'Registration updated. Change fee added to club cart.'
        : 'Registration saved.',
    );
  };

  // Add entries to club cart (for unregistered athletes after editor saves).
  // Host-club athletes pay $0 for all entry fees (3g): no cart line, and the
  // registration is created already paid ("Registered"). Otherwise the entry
  // total is queued and the regs stay "Pending Purchase" (paid:false) until
  // the club pays the cart line.
  const addToCart = (athleteId: string, regs: Registration[]) => {
    if (clubMembershipBlocked()) return;
    let hostFree = false;
    mutate((d) => {
      const existingForAthlete = d.registrations.filter(
        (r) => r.eventId === event.id && r.athleteId === athleteId && r.clubId === clubId && !r.refunded,
      );
      const priorDisciplineCount = existingForAthlete.length;
      const entryTotal = newRegistrationEntryTotal(event, {
        competingClubId: clubId,
        priorDisciplineCount,
        newDisciplineCount: regs.length,
      });
      hostFree = entryTotal === 0;
      // Stamp paid status on the new regs (saveRegs upserts them below).
      for (const reg of regs) {
        reg.paid = hostFree;
        reg.updatedPending = false;
      }
    });

    saveRegs(athleteId, regs);

    // Queue the entry-fee line only when something is owed.
    mutate((d) => {
      if (hostFree) return;
      const cart = d.carts[clubId] ?? (d.carts[clubId] = []);
      const already = new Set(cart.filter((c) => c.kind === 'meet-entry').map((c) => c.refUserId));
      const athlete = d.people.find((p) => p.id === athleteId)!;
      if (!already.has(athleteId)) {
        cart.push({
          id: `ci-${Date.now()}-${athleteId}`,
          label: `${event.name} entry — ${athlete.firstName} ${athlete.lastName} (${regs.map((r) => r.discipline).join('+')})`,
          amount: newRegistrationEntryTotal(event, {
            competingClubId: clubId,
            priorDisciplineCount: d.registrations.filter(
              (r) => r.eventId === event.id && r.athleteId === athleteId && r.clubId === clubId && !r.refunded
                && !regs.some((nr) => nr.id === r.id),
            ).length,
            newDisciplineCount: regs.length,
          }),
          kind: 'meet-entry',
          refUserId: athleteId,
          refRegIds: regs.map((r) => r.id),
          refEventId: event.id,
          refLineType: 'entry',
        });
        pushCart(clubId, cart, true);
      }
    });
  };

  const requestRefund = (athleteId: string) => {
    mutate((d) => {
      for (const r of d.registrations.filter((x) => x.eventId === event.id && x.athleteId === athleteId && x.clubId === clubId && !x.refunded)) {
        r.refundRequested = true;
        pushRegistration(r);
      }
    });
    toast('Refund requested — pending league admin approval.');
  };

  // Swap a registration to another club athlete (who has membership). Applies the
  // change fee when within the change-fee window (e.g. after reg close).
  const swapAthlete = (fromId: string, toId: string) => {
    const to = db.people.find((p) => p.id === toId);
    if (!to) return;
    const swapFee = changeFeeApplies ? registrationChangeFee(event, { competingClubId: clubId }) : 0;
    mutate((d) => {
      const swappedRegIds: string[] = [];
      for (const r of d.registrations) {
        if (r.eventId === event.id && r.athleteId === fromId && r.clubId === clubId && !r.refunded) {
          r.athleteId = toId;
          // A chargeable swap re-pends a previously-paid registration.
          if (swapFee > 0 && r.paid) {
            r.paid = false;
            r.updatedPending = true;
          }
          swappedRegIds.push(r.id);
          pushRegistration(r, r.sessionId);
        }
      }
      // 3e: any OTHER (event-scoped, non-refunded) registration that named the
      // swapped-OUT athlete as its synchro partner must now point at the
      // swapped-IN athlete. Scope mirrors the partner model (same event, not
      // refunded). reassignPartners skips the swapped athletes' own rows.
      const eventRegs = d.registrations.filter((r) => r.eventId === event.id && !r.refunded);
      const repointed = reassignPartners(
        eventRegs.map((r) => ({ id: r.id, athleteId: r.athleteId, partnerAthleteId: r.partnerAthleteId ?? null })),
        fromId,
        toId,
      );
      for (const rp of repointed) {
        const reg = d.registrations.find((r) => r.id === rp.id);
        if (reg) {
          reg.partnerAthleteId = rp.partnerAthleteId;
          pushRegistration(reg, reg.sessionId);
        }
      }

      if (swapFee > 0 && event.changeFee) {
        const cart = d.carts[clubId] ?? (d.carts[clubId] = []);
        cart.push({ id: `ci-change-${Date.now()}-${toId}`, label: `${event.name} change fee — swap to ${to.firstName} ${to.lastName}`, amount: swapFee, kind: 'meet-entry', refUserId: toId, refRegIds: swappedRegIds, refEventId: event.id, refLineType: 'change' });
        pushCart(clubId, cart, true);
      }
    });
    toast(`Registration swapped to ${to.firstName} ${to.lastName}.${swapFee > 0 ? ` Change fee ${fmtMoney(swapFee)} added to club cart.` : ''}`);
    setEditingAthleteId(null);
  };

  const editingAthlete = editingAthleteId ? db.people.find((p) => p.id === editingAthleteId) : null;
  const registerAthlete = registerAthleteId ? db.people.find((p) => p.id === registerAthleteId) : null;

  return (
    <div>
      {/* Event selector */}
      <div className="grid cols-3" style={{ marginBottom: 14, alignItems: 'end' }}>
        <Field label="Event">
          <select className="input" value={eventId} onChange={(e) => setEventId(e.target.value)}>
            {openEvents.map((m) => <option key={m.id} value={m.id}>{m.name}{m.status !== 'reg-open' ? ' (closed)' : ''}</option>)}
          </select>
        </Field>
        <Field label="Entry fees">
          <div style={{ paddingTop: 8, fontSize: 14 }}>
            {fmtMoney(event.entryFee)} first discipline · {fmtMoney(event.secondDisciplineFee)} additional
            {event.changeFee && (
              <span style={{ color: 'var(--warn)', marginLeft: 8 }}>
                · Change fee {fmtMoney(event.changeFee.amount)} after {new Date(event.changeFee.startsAt).toLocaleDateString()}
              </span>
            )}
          </div>
        </Field>
        <Field label="Disciplines">
          <div style={{ paddingTop: 8, fontSize: 14 }}>
            {event.disciplines.join(', ')}
          </div>
        </Field>
      </div>

      {regClosed && (
        <div className="card card-pad" style={{ borderLeft: '4px solid var(--coral-500)', marginBottom: 14 }}>
          Registration is closed for this event. Changes require a league admin override.
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
                const anyUnpaid = regs.some((r) => r.paid === false);
                const anyUpdatedPending = regs.some((r) => r.paid === false && r.updatedPending);
                const summary = regSummary(a.id);
                return (
                  <tr key={a.id}>
                    <td><strong>{a.firstName} {a.lastName}</strong></td>
                    <td style={{ fontSize: 13 }}>{summary}</td>
                    <td>
                      {anyRefundReq
                        ? <Badge tone="warn">Refund requested</Badge>
                        : anyUpdatedPending
                          ? <Badge tone="warn">Updated pending purchase</Badge>
                          : anyUnpaid
                            ? <Badge tone="warn">Pending purchase</Badge>
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
            Active members not yet registered for this event.
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
                {unregisteredWithMembership.map((a) => {
                  const lockedTo = lockedToClubShortName(a.id);
                  return (
                    <tr key={a.id}>
                      <td><strong>{a.firstName} {a.lastName}</strong></td>
                      <td style={{ fontSize: 13, color: 'var(--ink-soft)' }}>
                        {lockedTo
                          ? <span style={{ color: 'var(--warn)' }}>Already registered with {lockedTo}</span>
                          : event.disciplines.map((d) => (d === 'TNT' ? 'T&T' : d)).join(', ')}
                      </td>
                      <td>
                        <button
                          className="btn small primary"
                          disabled={regClosed || !!lockedTo}
                          title={lockedTo ? `Already registered with ${lockedTo} for this event` : undefined}
                          onClick={() => setRegisterAthleteId(a.id)}
                        >
                          Register
                        </button>
                      </td>
                    </tr>
                  );
                })}
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
            These athletes need an active membership before they can register for an event.{' '}
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
          {unregisteredWithMembership.length > 0 && (
            <div style={{ marginBottom: 14, paddingBottom: 14, borderBottom: '1px solid var(--line)' }}>
              <Field label="Swap this registration to another athlete"
                hint={changeFeeApplies && event.changeFee ? `A ${fmtMoney(event.changeFee.amount)} change fee will be added to the club cart.` : 'Moves all of this athlete’s entries for this event to a club member who has membership.'}>
                <Combo
                  options={unregisteredWithMembership.map((a) => ({ value: a.id, label: `${a.firstName} ${a.lastName}`, sub: a.email }))}
                  value={null}
                  placeholder="Search a club member with membership…"
                  onChange={(toId) => {
                    const to = db.people.find((p) => p.id === toId);
                    if (to && window.confirm(`Swap ${editingAthlete.firstName} ${editingAthlete.lastName}'s registration to ${to.firstName} ${to.lastName}?${changeFeeApplies && event.changeFee ? ` A ${fmtMoney(event.changeFee.amount)} change fee applies.` : ''}`)) {
                      swapAthlete(editingAthlete.id, toId);
                    }
                  }}
                />
              </Field>
            </div>
          )}
          <RegistrationEditor
            event={event}
            athlete={editingAthlete}
            clubId={clubId}
            existing={regsFor(editingAthlete.id)}
            allAthletes={db.people.filter((p) => p.kind === 'athlete')}
            levels={db.levels}
            season={season}
            onSave={(regs) => saveRegs(editingAthlete.id, regs)}
            onCancel={() => setEditingAthleteId(null)}
            changeFeeApplies={changeFeeApplies}
            incomingPartnerId={db.registrations.find((r) => r.eventId === event.id && !r.refunded && r.apparatus.includes('SY') && r.partnerAthleteId === editingAthlete.id)?.athleteId ?? null}
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
            event={event}
            athlete={registerAthlete}
            clubId={clubId}
            existing={[]}
            allAthletes={db.people.filter((p) => p.kind === 'athlete')}
            levels={db.levels}
            season={season}
            onSave={(regs) => addToCart(registerAthlete.id, regs)}
            onCancel={() => setRegisterAthleteId(null)}
            incomingPartnerId={db.registrations.find((r) => r.eventId === event.id && !r.refunded && r.apparatus.includes('SY') && r.partnerAthleteId === registerAthlete.id)?.athleteId ?? null}
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
  const [checkout, setCheckout] = useState<{ items: CartItem[]; title: string } | null>(null);
  const [detail, setDetail] = useState<Invoice | null>(null);
  const [receiptSearch, setReceiptSearch] = useState('');
  const [receiptFrom, setReceiptFrom] = useState('');
  const [receiptTo, setReceiptTo] = useState('');
  const club = db.clubs.find((c) => c.id === clubId);

  // The webhook bills the club, activates every membership/registration, clears
  // the club cart, and emails the paying manager a receipt — the FE only re-syncs.
  const onPaid = () => {
    void syncFromSupabase().finally(() => {
      setCheckout(null);
      toast('Payment complete — memberships/registrations activated. Receipt emailed to you.');
    });
  };
  const onError = (msg: string) => toast(msg, { variant: 'error' });

  // Cross-club cart cleanup (3d): when this cart loads, drop any pending meet-entry
  // line for an athlete who has SINCE become PAID-registered under a DIFFERENT club
  // for that event, and notify the manager. Idempotent (see cleanupCrossClubCart).
  const allInvoices = useMemo(() =>
    db.invoices
      .filter((i) => i.clubId === (club?.id ?? ''))
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [db.invoices, club?.id],
  );
  const invoices = useMemo(() => {
    const q = receiptSearch.trim().toLowerCase();
    return allInvoices.filter((inv) => {
      if (receiptFrom && inv.createdAt.slice(0, 10) < receiptFrom) return false;
      if (receiptTo && inv.createdAt.slice(0, 10) > receiptTo) return false;
      if (!q) return true;
      if (inv.number.toLowerCase().includes(q)) return true;
      const totalStr = fmtMoney(invoiceTotal(inv));
      if (totalStr.includes(q)) return true;
      return inv.items.some((it) => it.label.toLowerCase().includes(q));
    });
  }, [allInvoices, receiptSearch, receiptFrom, receiptTo]);

  useEffect(() => {
    if (club) cleanupCrossClubCart(db, club.id, toast);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, club?.id]);

  if (!club) return <p>Club not found.</p>;
  const cart = db.carts[club.id] ?? [];
  const couponDef = db.coupons.find((c) => c.code === coupon.toUpperCase());
  const subtotal = cart.reduce((s, i) => s + i.amount, 0);
  const discount = couponDef ? (couponDef.amountOff ?? subtotal * (couponDef.pctOff ?? 0) / 100) : 0;
  const total = Math.max(0, subtotal - discount);

  // Group cart items by event (detect from label) and by memberships
  const eventNames = Array.from(new Set(
    cart.filter((i) => i.kind === 'meet-entry').map((i) => {
      // Label format: "<event name> entry — <athlete> (<disc>)"
      const m = i.label.match(/^(.+?) entry —/);
      return m ? m[1] : 'Event entries';
    }),
  ));
  const membershipItems = cart.filter((i) => i.kind === 'membership');

  // Registration summary per athlete (from the DB)
  const regSummaryForItem = (item: typeof cart[number]): string | null => {
    if (!item.refUserId || item.kind !== 'meet-entry') return null;
    const eventMatch = item.label.match(/^(.+?) entry —/);
    if (!eventMatch) return null;
    const eventName = eventMatch[1];
    const event = db.events.find((m) => m.name === eventName);
    if (!event) return null;
    const regs = db.registrations.filter(
      (r) => r.eventId === event.id && r.athleteId === item.refUserId && !r.refunded,
    );
    if (regs.length === 0) return null;
    const nameOf = (id: string) => {
      const p = db.people.find((x) => x.id === id);
      return p ? `${p.firstName} ${p.lastName}` : 'partner';
    };
    return regs.map((r) => {
      const lvl = db.levels.find((l) => l.id === r.levelId)?.name ?? '—';
      return `${r.discipline === 'TNT' ? 'T&T' : r.discipline} – ${lvl} – ${eventsText(r, nameOf)}`;
    }).join(' / ');
  };

  if (checkout) {
    return (
      <div style={{ maxWidth: 620 }}>
        <h1 className="page-title display">Checkout — {checkout.title}</h1>
        <p className="page-sub">Billed to {club.shortName}.</p>
        <div style={{ marginBottom: 14 }}>
          <button className="btn ghost small" onClick={() => setCheckout(null)}>← Back to cart</button>
        </div>
        <CartCheckout
          items={checkout.items}
          title={checkout.title}
          onPaid={onPaid}
          onError={onError}
        />
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 820 }}>
      <h1 className="page-title display">{club.shortName} — Cart &amp; Receipts</h1>
      <p className="page-sub">
        Memberships pushed to the club, event entries, and add-ons.
        Each membership is a separate line item so single refunds stay clean.
      </p>
      <div style={{ marginBottom: 16 }}>
        <Link className="btn ghost small" to={`/club/${club.id}`}>← Back to club page</Link>
      </div>

      {/* Cart grouped by event / memberships */}
      {cart.length > 0 && (
        <>
          {/* Event entry cards */}
          {eventNames.map((eventName) => {
            const items = cart.filter((i) => i.kind === 'meet-entry' && i.label.startsWith(eventName));
            return (
              <div key={eventName} className="card card-pad" style={{ marginBottom: 18 }}>
                <h3 className="card-title">{eventName}</h3>
                <p style={{ fontSize: 13, color: 'var(--ink-soft)', marginBottom: 10 }}>
                  Event entries · <Link to={`/club/${club.id}/registrations`}>Return to registration →</Link>
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
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                <h3 className="card-title" style={{ margin: 0 }}>Memberships</h3>
                <button
                  className="btn primary small"
                  style={{ marginLeft: 'auto' }}
                  onClick={() => setCheckout({ items: membershipItems, title: 'Memberships' })}
                >
                  Checkout Memberships →
                </button>
              </div>
              <p style={{ fontSize: 13, color: 'var(--ink-soft)', margin: '6px 0 10px' }}>
                The club’s own seasonal membership and any member fees pushed to the cart.
              </p>
              <table className="tbl">
                <tbody>
                  {membershipItems.map((i) => (
                    <tr key={i.id}>
                      <td>{i.label} <Badge tone="info">{i.refType === 'club' ? 'club membership' : 'membership'}</Badge></td>
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
              {coupon.trim() !== '' && (
                <div style={{ fontSize: 12, color: 'var(--ink-soft)', marginTop: 4 }}>
                  Coupon codes aren’t applied to card checkout yet.
                </div>
              )}
            </div>
            <div style={{ textAlign: 'right', marginBottom: 14 }}>
              <div style={{ fontSize: 14 }}>{cart.length} item{cart.length !== 1 ? 's' : ''} · Subtotal {fmtMoney(subtotal)}</div>
              {discount > 0 && <div style={{ color: 'var(--green-600)', fontSize: 14 }}>Coupon −{fmtMoney(discount)}</div>}
              <div style={{ fontSize: 20, fontWeight: 700 }}>Total {fmtMoney(total)}</div>
            </div>
            <button
              className="btn primary"
              style={{ marginBottom: 14 }}
              onClick={() => setCheckout({ items: cart, title: `${club.shortName} cart` })}
            >
              Pay {fmtMoney(total)} →
            </button>
          </div>
        )}
      </div>

      {/* Receipts */}
      <div style={{ marginTop: 4 }}>
        <h3 className="card-title" style={{ marginBottom: 10 }}>Receipts</h3>
        {allInvoices.length > 0 && (
          <div style={{ display: 'flex', gap: 10, marginBottom: 12, flexWrap: 'wrap', alignItems: 'end' }}>
            <div style={{ flex: '1 1 180px', minWidth: 140 }}>
              <label style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.04em', color: 'var(--navy-700)', display: 'block', marginBottom: 5 }}>Search</label>
              <input className="input" type="text" value={receiptSearch} onChange={(e) => setReceiptSearch(e.target.value)}
                placeholder="Name, item, amount…" />
            </div>
            <div style={{ minWidth: 120 }}>
              <label style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.04em', color: 'var(--navy-700)', display: 'block', marginBottom: 5 }}>From</label>
              <input className="input" type="date" value={receiptFrom} onChange={(e) => setReceiptFrom(e.target.value)} />
            </div>
            <div style={{ minWidth: 120 }}>
              <label style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.04em', color: 'var(--navy-700)', display: 'block', marginBottom: 5 }}>To</label>
              <input className="input" type="date" value={receiptTo} onChange={(e) => setReceiptTo(e.target.value)} />
            </div>
            {(receiptSearch || receiptFrom || receiptTo) && (
              <button className="btn small ghost" style={{ marginBottom: 2 }}
                onClick={() => { setReceiptSearch(''); setReceiptFrom(''); setReceiptTo(''); }}>Clear</button>
            )}
          </div>
        )}
        {allInvoices.length === 0 ? <p style={{ color: 'var(--ink-soft)' }}>No receipts yet.</p>
        : invoices.length === 0 ? <p style={{ color: 'var(--ink-soft)' }}>No receipts match your filters.</p>
        : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {invoices.map((inv) => (
              <div key={inv.id} className="card card-pad">
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
                  <strong>{inv.number}</strong>
                  <span style={{ color: 'var(--ink-soft)', fontSize: 13 }}>{fmtDate(inv.createdAt.slice(0, 10))}</span>
                  {inv.paidAt ? <Badge tone="ok">Paid</Badge> : <Badge tone="warn">Unpaid</Badge>}
                  <strong style={{ marginLeft: 'auto' }}>{fmtMoney(invoiceTotal(inv))}</strong>
                </div>
                <p style={{ margin: '8px 0 10px', fontSize: 14, color: 'var(--ink-soft)' }}>
                  {inv.items.filter((i) => i.kind !== 'discount').map((i) => i.label).join('; ')}
                </p>
                <button className="btn small ghost" onClick={() => setDetail(inv)}>Click for details →</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {detail && (
        <Modal title={`Receipt ${detail.number}`} onClose={() => setDetail(null)}>
          <div style={{ fontSize: 13.5, color: 'var(--ink-soft)', marginBottom: 12 }}>
            {fmtDate(detail.createdAt.slice(0, 10))} · {detail.paidAt ? 'Paid' : 'Unpaid'} · Billed to {club.shortName}
          </div>
          {(() => {
            const lineItems = detail.items.filter((i) => i.kind !== 'discount');
            const subtotal = lineItems.reduce((s, i) => s + (i.refunded ? 0 : i.amount), 0);
            const discount = -detail.items.filter((i) => i.kind === 'discount').reduce((s, i) => s + (i.refunded ? 0 : i.amount), 0);
            const total = subtotal - discount;
            return (
              <table className="tbl" style={{ marginBottom: 12 }}>
                <tbody>
                  {lineItems.map((i) => (
                    <tr key={i.id}>
                      <td>{i.label}{i.refunded ? ' (refunded)' : ''}</td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{fmtMoney(i.refunded ? 0 : i.amount)}</td>
                    </tr>
                  ))}
                  {discount > 0 && (
                    <>
                      <tr style={{ borderTop: '1px solid var(--line)' }}>
                        <td style={{ color: 'var(--ink-soft)' }}>Subtotal</td>
                        <td style={{ textAlign: 'right', color: 'var(--ink-soft)' }}>{fmtMoney(subtotal)}</td>
                      </tr>
                      <tr>
                        <td style={{ color: 'var(--ink-soft)' }}>Promo code{detail.couponCode ? ` (${detail.couponCode})` : ''}</td>
                        <td style={{ textAlign: 'right', color: 'var(--ink-soft)' }}>−{fmtMoney(discount)}</td>
                      </tr>
                    </>
                  )}
                  <tr style={{ borderTop: '2px solid var(--navy-800)', fontWeight: 700 }}>
                    <td>Total{discount > 0 ? ' paid' : ''}</td>
                    <td style={{ textAlign: 'right' }}>{fmtMoney(total)}</td>
                  </tr>
                </tbody>
              </table>
            );
          })()}
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn primary" onClick={() => downloadReceipt(detail, club.shortName)}>Download receipt (PDF)</button>
            <button className="btn ghost" onClick={() => setDetail(null)}>Close</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
