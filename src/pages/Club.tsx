import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { useDB, mutate } from '../lib/store';
import { useCapabilities } from '../lib/capabilities';
import { clubHasActiveMembership, seasonForDate, membershipHolds, paidRegistrationClub } from '../lib/capabilities-core';
import { Badge, Combo, Field, Modal } from '../components/ui';
import { useToast } from '../components/ui-hooks';
import { CLUB_ACCESS_LABELS, STATE_REGIONS } from '../lib/types';
import type { Athlete, Club, ClubAccess, Registration, Season } from '../lib/types';
import { fmtMoney } from '../lib/scoring';
import { newRegistrationEntryTotal, reassignPartners, registrationChangeFee, changeIsEligible } from '../lib/pricing';
import type { RegChangeState } from '../lib/pricing';
import {
  deleteRegistration, pushCart, pushClub, pushClubManager,
  pushRegistration, requestManagerAccess, sendClubInvite,
  inviteAccount, pushClubMembership, deleteClubMembership,
} from '../lib/supabase';
import { cleanupCrossClubCart } from '../lib/cart-sync';
import type { ClubMembership } from '../lib/types';
import { ClubForm } from '../components/ClubForm';
import { RegistrationEditor } from '../components/RegistrationEditor';

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
        <Link className="btn ghost small" to="/cart">Club cart & receipts →</Link>
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
// routes to the unified /cart page. The `club_memberships` row is created only
// when that cart line is PAID (the stripe-webhook fulfillment path, via the
// club's section on /cart), so the registration/hosting gate
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
      navigate('/cart');
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
    navigate('/cart');
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
                  ? <Link className="btn small ghost" to="/cart">View in cart →</Link>
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

  // NOT memoized on `db` (M6 fix, 2026-07-02): `mutate()` mutates `db.people`
  // in place for an update rather than reassigning the array/object
  // reference, so a `useMemo` keyed on the whole `db` object never re-runs
  // after an in-place edit (e.g. a roster/role change) — only a full
  // `syncFromSupabase()` reload reassigns `db` and would unstick it. Read
  // directly per render instead (same precedent as Cart.tsx's `cart`);
  // `useDB()`'s subscription already re-renders this component on every
  // store change, so this is correct and cheap.
  const allRoster = db.people.filter((p) => p.mainClubId === clubId);

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

  // NOT memoized on `db` — same M6 in-place-mutation trap as Roster's
  // allRoster above (mutate() never reassigns db.people, so a useMemo keyed
  // on `db` misses in-place edits). Read directly per render.
  const athletes = db.people.filter(
    (p) => p.kind === 'athlete' && p.mainClubId === clubId,
  ).sort((a, b) => a.lastName.localeCompare(b.lastName));

  // Cross-club cart cleanup (3d): also run when a manager opens the registrations
  // view (not only the cart), so the moot pending line + its toast surface here.
  // M6 audit note: `db` never gets a new reference on an in-place mutate()
  // (see allRoster/athletes above), so this effect only re-runs on mount or a
  // `clubId` change, or after a full `syncFromSupabase()` reload — NOT after
  // every same-session local mutation. Judged safe as-is: the staleness this
  // cleans up (an athlete becoming paid-registered elsewhere) is inherently a
  // cross-manager/cross-tab race that only becomes visible here via a resync
  // anyway, and the function is idempotent + no-op when clean, so a missed
  // immediate re-run just means the toast surfaces on the next mount/resync
  // instead of instantly — not a money-correctness gap like H5/H6/H7 above.
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

  // Change-fee label for this event+athlete's club-cart line — also how we
  // detect an already-pending change line to extend in place (M7/H5 fix,
  // mirroring MyRegistrations.tsx's changeFeeLabel/changeFeePending).
  const changeFeeLabel = (athlete: Athlete) => `${event.name} change fee — ${athlete.firstName} ${athlete.lastName}`;
  const changeFeePendingItem = (athleteId: string) => {
    const athlete = db.people.find((p) => p.id === athleteId);
    if (!athlete) return undefined;
    const label = changeFeeLabel(athlete);
    return (db.carts[clubId] ?? []).find((c) => c.kind === 'meet-entry' && c.refLineType === 'change' && c.label === label);
  };

  // Persist registration changes from RegistrationEditor. `opts.skipEntryFeeLine`
  // is set by `addToCart` below, which handles its OWN entry-fee cart line for a
  // brand-new registration — saveRegs must not push a second one for the same
  // regs. The direct Edit-flow caller (RegistrationEditor's onSave) omits it, so
  // a discipline added mid-edit with no prior registration (H7) gets its own
  // entry-fee line here instead of silently landing "Registered" for free.
  const saveRegs = (athleteId: string, newRegs: Registration[], opts?: { skipEntryFeeLine?: boolean }) => {
    if (clubMembershipBlocked()) return;
    // Captured BEFORE the mutate below so it reflects the pre-edit cart state.
    const alreadyPendingItem = changeFeePendingItem(athleteId);
    let addedEntryFee = 0;
    let chargedChangeFee = 0;
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

      // A chargeable edit (change fee applies, editing existing regs, the fee
      // is non-zero — i.e. NOT the host club's own athletes — AND the change
      // is actually eligible per `changeIsEligible`: adding a discipline,
      // changing a level, or switching clubs. A pure apparatus tweak or
      // discipline-removal-only edit is NOT eligible and stays free (B8) —
      // the RegistrationEditor's "Save" (vs. "Add change to cart") label
      // mirrors this same predicate for the button.
      const before: RegChangeState = { clubId, athleteId, disciplines: existingForAthlete };
      const after: RegChangeState = { clubId, athleteId, disciplines: newRegs };
      const eligible = existingForAthlete.length > 0 && changeIsEligible(before, after);
      const changeFee = changeFeeApplies && eligible
        ? registrationChangeFee(event, { competingClubId: clubId })
        : 0;
      chargedChangeFee = changeFee;

      // Brand-new-discipline entry total (H7): regs in newRegs with NO prior
      // row are disciplines being added right now, regardless of whether the
      // athlete already has other disciplines registered (unlike the
      // all-or-nothing !editingExisting check this used to lack entirely).
      // Skipped when the caller (addToCart) already owns the entry-fee line
      // for these exact regs.
      const priorById = new Map(existingForAthlete.map((r) => [r.id, r]));
      const newOnlyRegs = newRegs.filter((r) => !priorById.has(r.id));
      const priorDisciplineCount = existingForAthlete.filter((r) => r.apparatus.length > 0).length;
      const entryTotal = !opts?.skipEntryFeeLine && newOnlyRegs.length > 0
        ? newRegistrationEntryTotal(event, {
            competingClubId: clubId,
            priorDisciplineCount,
            newDisciplineCount: newOnlyRegs.length,
          })
        : 0;

      // Upsert each new reg. A chargeable edit flips a previously-PAID reg back
      // to "Updated pending purchase"; otherwise preserve its payment state.
      // A reg with NO prior (freshly added discipline): paid only when nothing
      // is owed for it (host club, or covered elsewhere e.g. addToCart already
      // stamped it) — never silently "Registered" while a fee is pending.
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
        } else if (!opts?.skipEntryFeeLine) {
          // addToCart pre-stamps paid/updatedPending itself before calling
          // saveRegs with skipEntryFeeLine — don't overwrite that here.
          reg.paid = entryTotal === 0;
          reg.updatedPending = false;
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
      // the affected regs so paying it flips them back to paid. Snapshot the
      // FULL prior registration rows (before this function's edits above) so
      // deleting this cart item later can revert them (unified-cart-b2 Task A).
      // M7/H5: if a change line for this athlete+event is ALREADY pending,
      // EXTEND it in place (append newly-covered reg ids + snapshot entries
      // for regs not already covered) instead of stacking a second line —
      // stacking is what let removal delete/resurrect against a stale
      // snapshot. NEVER overwrite an existing snapshot entry: it must stay the
      // ORIGINAL pre-change state from the FIRST edit, not this edit's.
      if (changeFee > 0 && event.changeFee) {
        const cart = d.carts[clubId] ?? (d.carts[clubId] = []);
        const athlete = d.people.find((p) => p.id === athleteId)!;
        const newSnapshotEntries = newRegs.map((r) => priorById.get(r.id)).filter((r): r is Registration => !!r);
        if (alreadyPendingItem) {
          const line = cart.find((c) => c.id === alreadyPendingItem.id);
          if (line) {
            const covered = new Set(line.refRegIds ?? []);
            line.refRegIds = [...covered, ...newRegs.map((r) => r.id).filter((id) => !covered.has(id))];
            const snapshotCovered = new Set((line.priorRegSnapshot ?? []).map((r) => r.id));
            line.priorRegSnapshot = [
              ...(line.priorRegSnapshot ?? []),
              ...newSnapshotEntries.filter((r) => !snapshotCovered.has(r.id)),
            ];
          }
        } else {
          cart.push({
            id: `ci-change-${Date.now()}-${athleteId}`,
            label: changeFeeLabel(athlete),
            amount: changeFee,
            kind: 'meet-entry',
            refUserId: athleteId,
            refRegIds: newRegs.map((r) => r.id),
            refEventId: event.id,
            refLineType: 'change',
            priorRegSnapshot: newSnapshotEntries,
          });
        }
        pushCart(clubId, cart, true);
      } else if (!changeFeeApplies && entryTotal > 0) {
        // A discipline added via Edit OUTSIDE the change-fee window (or the
        // athlete has no prior regs at all but wasn't routed through
        // addToCart), still owes its entry/second-discipline fee (H7) —
        // queue a line for exactly the newly-added regs. Gated on
        // `!changeFeeApplies` so that WITHIN a change window (even one whose
        // fee is $0) an added discipline is governed by the change fee, not a
        // full entry fee — otherwise a non-host event configured with a $0
        // change fee would over-charge an added discipline. (Matches
        // MyRegistrations.tsx, which likewise only charges outside the window.)
        const cart = d.carts[clubId] ?? (d.carts[clubId] = []);
        const athlete = d.people.find((p) => p.id === athleteId)!;
        addedEntryFee = entryTotal;
        cart.push({
          id: `ci-${Date.now()}-${athleteId}`,
          label: `${event.name} entry — ${athlete.firstName} ${athlete.lastName} (${newOnlyRegs.map((r) => r.discipline).join('+')})`,
          amount: entryTotal,
          kind: 'meet-entry',
          refUserId: athleteId,
          refRegIds: newOnlyRegs.map((r) => r.id),
          refEventId: event.id,
          refLineType: 'entry',
        });
        pushCart(clubId, cart, true);
      }
    });

    setEditingAthleteId(null);
    setRegisterAthleteId(null);
    toast(
      chargedChangeFee > 0
        ? 'Registration updated. Change fee added to club cart.'
        : addedEntryFee > 0
          ? `Registration updated. ${fmtMoney(addedEntryFee)} entry fee added to club cart.`
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

    // skipEntryFeeLine: this function owns the entry-fee cart line below
    // (needs its own refEventId-aware dedupe check, C5) — saveRegs must not
    // also queue one for these same regs.
    saveRegs(athleteId, regs, { skipEntryFeeLine: true });

    // Queue the entry-fee line only when something is owed. C5 fix: dedupe on
    // (athleteId, event.id, entry-only) — NOT athleteId alone across every
    // meet-entry line — so a second event for the same athlete (or an
    // existing change-fee line) never silently suppresses this push and
    // strands the new registration(s) unpayable.
    mutate((d) => {
      if (hostFree) return;
      const cart = d.carts[clubId] ?? (d.carts[clubId] = []);
      const already = new Set(
        cart
          .filter((c) => c.kind === 'meet-entry' && c.refLineType === 'entry' && c.refEventId === event.id)
          .map((c) => c.refUserId),
      );
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
      // Snapshot the FULL prior registration row (before athleteId/paid/
      // updatedPending are mutated below) so deleting the resulting change-fee
      // cart item later can revert the swap (unified-cart-b2 Task A).
      const priorById = new Map<string, Registration>();
      for (const r of d.registrations) {
        if (r.eventId === event.id && r.athleteId === fromId && r.clubId === clubId && !r.refunded) {
          priorById.set(r.id, { ...r });
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
        cart.push({
          id: `ci-change-${Date.now()}-${toId}`,
          label: `${event.name} change fee — swap to ${to.firstName} ${to.lastName}`,
          amount: swapFee, kind: 'meet-entry', refUserId: toId, refRegIds: swappedRegIds,
          refEventId: event.id, refLineType: 'change',
          priorRegSnapshot: swappedRegIds.map((id) => priorById.get(id)).filter((r): r is Registration => !!r),
        });
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
                // H7: undefined-safe. `paid` defaults falsy on a new reg but a
                // strict `=== false` check lets `undefined` slip through and
                // render the green "Registered" badge for a reg nothing has
                // ever stamped paid — treat anything that isn't `true` as unpaid.
                const anyUnpaid = regs.some((r) => r.paid !== true);
                const anyUpdatedPending = regs.some((r) => r.paid !== true && r.updatedPending);
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
