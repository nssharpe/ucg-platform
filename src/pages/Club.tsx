import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { useDB, mutate } from '../lib/store';
import { useCapabilities } from '../lib/capabilities';
import { clubHasActiveMembership, clubHasActiveMembershipForEvent, seasonForDate, membershipHolds, membershipTypeOf, paidRegistrationClub } from '../lib/capabilities-core';
import { purchasableSeasons, isFutureSeason, currentSeason } from '../lib/season-lifecycle';
import { eventIsInPhase, canStillEditRegistration, eventIsRefundEligible } from '../lib/events-core';
import { Badge, Combo, Field, Modal } from '../components/ui';
import { RefundRequestDialog, type RefundRequestItem } from '../components/RefundRequestDialog';
import { useToast, useFmtDate } from '../components/ui-hooks';
import { STATE_REGIONS, SHIRT_SIZES } from '../lib/types';
import type { Athlete, CartItem, Club, Event, Membership, Registration, Season, WaitlistGroup } from '../lib/types';
import { fmtMoney } from '../lib/scoring';
import {
  newRegistrationEntryTotal, reassignPartners, registrationChangeFee, changeIsEligible,
  addedDisciplineChangeTotal, syncSynchroPartnerLevel, findIncomingSynchroPartner, lateFeeApplies, lateFeeAnchor,
  addonPurchaseOpen, initialClubAddonDraft, buildClubAddonCartItems,
} from '../lib/pricing';
import type { RegChangeState, ClubAddonDraft } from '../lib/pricing';
import { holdStamp, waitlistPosition } from '../lib/capacity';
import { SizedAddonPicker } from '../components/AddonPickers';
import {
  deleteRegistration, pushCart, pushClub, pushClubManager,
  pushRegistration, requestManagerAccess, sendClubInvite,
  inviteAccount, pushClubMembership, deleteClubMembership,
  syncSynchroPartnerLevelRemote, cancelWaitlistGroup,
} from '../lib/supabase';
import { cleanupCrossClubCart } from '../lib/cart-sync';
import { useEventRegistrations, useClubRegistrations, applyLocalRegistrationUpsert, applyLocalRegistrationRemove, mergeUpsertedRegs } from '../lib/registrations-slice';
import { useClubRosterMemberships, groupAdminMembershipsByPerson } from '../lib/memberships-admin-slice';
import { usePeopleForClub } from '../lib/people-admin-slice';
import { usePeopleNames } from '../lib/people-slice';
import type { ClubMembership } from '../lib/types';
import { ClubForm } from '../components/ClubForm';
import { RegistrationEditor } from '../components/RegistrationEditor';
import { SessionRequestSurveyCard } from '../components/SessionRequestSurvey';
import { requiredSessionRequests } from '../lib/pricing';
import { CompetitionOrderCard } from '../components/CompetitionOrderCard';
import { NationalsDashboard } from '../components/NationalsDashboard';
import { EventCheckinCard } from '../components/EventCheckinCard';

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
  // Phase 4 (data-layer-scale.md): `db.people` at boot is now scoped to self +
  // managed-club rosters, so a viewer who ISN'T this club's own manager (any
  // signed-in member browsing another club's page, or an admin, whose
  // `canManage` is true everywhere but whose boot scope only covers clubs
  // THEY manage) needs an on-demand fetch for rosterSize/managerNames, which
  // are shown to every viewer, not just managers. Falls back to the
  // boot-scoped `db.people` while loading (correct instantly for the common
  // case — a manager on their own club's page — and self-corrects once the
  // fetch resolves for everyone else, rather than flashing a blank/zero
  // count). Called unconditionally, ABOVE the `if (!club) return` below
  // (Rules of Hooks) — `club?.id`/`club?.managerIds` are safe when club is
  // still undefined (the hooks treat a null/empty key as "nothing to fetch").
  const { rows: clubPeopleRows, status: clubPeopleStatus } = usePeopleForClub(club?.id ?? null);
  const { rows: managerRefs, status: managerNamesStatus } = usePeopleNames(club?.managerIds ?? []);
  if (!club) return <p>Club not found.</p>;

  const canManage = caps.isAdmin || caps.managedClubIds.includes(club.id);

  const isMember = caps.personId
    ? (() => {
        const p = db.people.find((x) => x.id === caps.personId);
        return !!p && (p.mainClubId === club.id || p.altClubIds.includes(club.id));
      })()
    : false;
  const isManager = canManage;

  const clubPeopleReady = clubPeopleStatus === 'ready';
  const rosterSize = (clubPeopleReady ? clubPeopleRows : db.people).filter((p) => p.mainClubId === club.id).length;

  const managerNameOf = (id: string): string | null => {
    if (managerNamesStatus === 'ready') {
      const r = managerRefs.find((x) => x.id === id);
      if (r) return `${r.firstName} ${r.lastName}`;
    }
    const p = db.people.find((x) => x.id === id);
    return p ? `${p.firstName} ${p.lastName}` : null;
  };
  const managerNames = club.managerIds.map(managerNameOf).filter((n): n is string => !!n);

  // Clubs the user can switch between from here: league admins see all clubs,
  // managers see the clubs they manage. Only shown when there's a real choice.
  const switchableClubs = (caps.isAdmin
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
        {caps.isAdmin && <> · <Link to="/admin/clubs">all clubs</Link></>}
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

  const isAdmin = caps.isAdmin;
  const canManage = isAdmin || caps.managedClubIds.includes(club.id);
  const activeSeason = currentSeason(db);
  // P3: only the current-by-date season and `active` future seasons are
  // purchasable here.
  const seasons = purchasableSeasons(db).slice().sort((a, b) => a.startsOn.localeCompare(b.startsOn));
  const seasonName = (id: string) => db.seasons.find((s) => s.id === id)?.name ?? id;

  // A club-membership line for this season is already waiting in the club cart.
  const cartHasSeason = (seasonId: string) =>
    (db.carts[club.id] ?? []).some((i) => i.kind === 'membership' && i.refType === 'club' && i.refSeasonId === seasonId);

  const grant = (seasonId: string, byAdmin: boolean) => {
    const cm: ClubMembership = { id: crypto.randomUUID(), clubId: club.id, seasonId, status: 'active', grantedByAdmin: byAdmin, createdAt: new Date().toISOString() };
    if (!mutate((d) => { (d.clubMemberships ??= []).push(cm); pushClubMembership(cm); })) return; // offline read-only gate
    toast(`Club membership ${byAdmin ? 'granted' : 'purchased'} for ${seasonName(seasonId)}.`);
  };
  const revoke = (seasonId: string) => {
    const cm = (db.clubMemberships ?? []).find((x) => x.clubId === club.id && x.seasonId === seasonId);
    if (!cm) return;
    if (!mutate((d) => { d.clubMemberships = (d.clubMemberships ?? []).filter((x) => x.id !== cm.id); deleteClubMembership(cm.id); })) return; // offline read-only gate
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
    const applied = mutate((d) => {
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
    if (!applied) return; // offline read-only gate — no false success toast
    toast(`${seasonName(seasonId)} club membership added to the cart. Pay to activate it.`);
    setReviewSeason(null);
    navigate('/cart');
  };

  const currentActive = activeSeason ? clubHasActiveMembership(db, club.id, activeSeason.id) : false;

  return (
    <div className="card card-pad" style={{ marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <h3 className="card-title" style={{ margin: 0 }}>Club membership</h3>
        {activeSeason && (currentActive
          ? <Badge tone="ok">✓ Active · {activeSeason.name}</Badge>
          : <Badge tone="err">Not active · {activeSeason?.name}</Badge>)}
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
                {s.name}{activeSeason?.id === s.id ? ' (current season)' : isFutureSeason(db, s) ? ' (next season)' : ' (upcoming season)'}
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
          isCurrent={activeSeason?.id === reviewSeason}
          isFuture={isFutureSeason(db, db.seasons.find((s) => s.id === reviewSeason)!)}
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
function ClubMembershipReview({ club, season, isCurrent, isFuture, onConfirm, onClose }: {
  club: Club; season: Season; isCurrent: boolean; isFuture: boolean; onConfirm: () => void; onClose: () => void;
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

  /** Returns false only when the offline read-only gate refused the write. */
  const persistEdits = (): boolean => {
    if (!dirty) return true;
    return mutate((d) => {
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
    if (!persistEdits()) return; // offline read-only gate — no false success toast
    toast('Club details saved.');
  };

  const confirm = () => {
    if (!valid) { toast('Name, short name, and state are required.'); return; }
    if (!persistEdits()) return; // offline read-only gate — don't continue to the cart
    onConfirm();
  };

  return (
    <Modal title={`Review club info — ${season.name} membership`} onClose={onClose}>
      {!isCurrent && isFuture && (
        <div className="card card-pad" style={{ borderLeft: '4px solid var(--gold)', background: 'var(--gold-100)', marginBottom: 12 }}>
          ⚠ <strong>Please be aware that you are purchasing a membership for next season</strong> ({season.name}, starts {season.startsOn}) — not the current one.
        </div>
      )}
      {!isCurrent && !isFuture && (
        <div className="card card-pad" style={{ borderLeft: '4px solid var(--gold)', marginBottom: 12 }}>
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
  // Only ever mounted when canManage is already true (ClubPage gates it) —
  // fetch this club's full roster (mainClubId OR alt-club affiliation,
  // matching the old candidates filter below exactly) on demand, falling
  // back to boot-scoped db.people while loading (correct instantly for a
  // real manager's own club; self-corrects for an admin viewing a club they
  // don't personally manage).
  const { rows: clubPeopleRows, status: clubPeopleStatus } = usePeopleForClub(club.id);
  const effectivePeople = clubPeopleStatus === 'ready' ? clubPeopleRows : db.people;
  const managers = club.managerIds
    .map((id) => effectivePeople.find((p) => p.id === id) ?? db.people.find((p) => p.id === id))
    .filter((p): p is Athlete => !!p);
  const candidates = effectivePeople
    .filter((p) =>
      !club.managerIds.includes(p.id) &&
      (p.mainClubId === club.id || p.altClubIds.includes(club.id)),
    )
    .map((p) => ({ value: p.id, label: `${p.firstName} ${p.lastName}`, sub: `${p.kind} · ${p.email}` }));

  const addManager = (personId: string) => {
    const applied = mutate((d) => {
      const c = d.clubs.find((x) => x.id === club.id)!;
      if (!c.managerIds.includes(personId)) c.managerIds.push(personId);
      pushClubManager(club.id, personId, true);
    });
    if (!applied) return; // offline read-only gate — no false success toast
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

  // memberships are Tier 2 boot-scoped to the caller's own + managed-club
  // rows (whats-next.md §7). That's already correct for a real manager's OWN
  // club, but this page is reachable (RequireAccount) for ANY club, and an
  // admin's `canManage` is true everywhere — so whenever management UI is
  // shown, fetch this club's roster memberships on demand too (a harmless,
  // cheap redundant refetch for the "it's already in Tier 2 scope" case,
  // and the actual fix for "admin viewing a club they don't manage").
  const { rows: clubMembershipRows, status: clubMembershipsStatus } = useClubRosterMemberships(canManage ? clubId : null);
  const membershipsByPerson = useMemo(() => groupAdminMembershipsByPerson(clubMembershipRows), [clubMembershipRows]);
  const membershipsOverrideReady = canManage && clubMembershipsStatus === 'ready';
  // Phase 4 (data-layer-scale.md): same override pattern as the memberships
  // hook right above — db.people at boot only carries a real manager's OWN
  // club roster, so an admin viewing a club they don't personally manage
  // needs this on-demand fetch too.
  const { rows: clubPeopleRows, status: clubPeopleStatus } = usePeopleForClub(canManage ? clubId : null);
  const peopleOverrideReady = canManage && clubPeopleStatus === 'ready';

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
  const season = currentSeason(db)!;

  // useCallback (not a plain inline function) so it has a stable reference
  // across renders and can be honestly included in `sorted`'s useMemo deps
  // below, instead of a new closure on every render defeating the memo.
  const lvlName = useCallback((id?: string) => db.levels.find((l) => l.id === id)?.name ?? '—', [db.levels]);

  // NOT memoized on `db` (M6 fix, 2026-07-02): `mutate()` mutates `db.people`
  // in place for an update rather than reassigning the array/object
  // reference, so a `useMemo` keyed on the whole `db` object never re-runs
  // after an in-place edit (e.g. a roster/role change) — only a full
  // `syncFromSupabase()` reload reassigns `db` and would unstick it. Read
  // directly per render instead (same precedent as Cart.tsx's `cart`);
  // `useDB()`'s subscription already re-renders this component on every
  // store change, so this is correct and cheap.
  const allRoster = (peopleOverrideReady ? clubPeopleRows : db.people).filter((p) => p.mainClubId === clubId);

  const filtered = search.trim()
    ? allRoster.filter((p) =>
        `${p.firstName} ${p.lastName}`.toLowerCase().includes(search.trim().toLowerCase()),
      )
    : allRoster;

  const sorted = useMemo(
    () => sortRoster(filtered, sortCol, sortDir, lvlName),
    [filtered, sortCol, sortDir, lvlName],
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
        membershipsByPerson={membershipsOverrideReady ? membershipsByPerson : null}
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
        membershipsByPerson={membershipsOverrideReady ? membershipsByPerson : null}
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
  lvlName, handleSort, sortIcon, membershipsByPerson,
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
  /** Overrides `p.memberships` per row when set — Tier 2's boot scope only
   *  guarantees `p.memberships` is correct for the caller's OWN managed
   *  clubs, so an admin viewing a club they don't manage needs this
   *  on-demand override (null while it's still loading or not needed). */
  membershipsByPerson: Map<string, Membership[]> | null;
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
                const pMemberships = membershipsByPerson?.get(p.id) ?? p.memberships;
                const m = pMemberships.find((x) => x.seasonId === season?.id);
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

// ---- Club-manager Add-ons card (event-mgmt v2 Phase 2 T4) -------------------
// Reuses SizedAddonPicker (src/components/AddonPickers.tsx) for the t-shirt
// quantity+size picker. Banquet tickets need a roster-wide assignee dropdown
// per ticket (not the athlete-self-or-extra model of Events.tsx's
// BanquetPicker), so that's its own picker below. Both are MODULE scope, not
// nested in ClubAddonsCard's render, per the ESLint rule against components
// defined inside another component's render.

/** One banquet ticket per unit, each assigned via a dropdown of the club's
 *  affiliated people (athletes + coaches) or "Extra ticket". `personTaken(id,
 *  unitIndex)` greys out a person already holding a ticket elsewhere (another
 *  unit in this draft, the club cart, or a purchased invoice line) — the
 *  currently-selected person for THIS unit is never greyed out for itself. */
function ClubBanquetPicker({
  name, price, deadline, roster, personTaken, units, onChange, fmtDate,
}: {
  name: string;
  price: number;
  deadline?: string;
  roster: Athlete[];
  personTaken: (personId: string, unitIndex: number) => boolean;
  units: string[];
  onChange: (units: string[]) => void;
  fmtDate: (iso: string) => string;
}) {
  const priceLabel = price === 0 ? 'Free' : fmtMoney(price);
  const addUnit = () => onChange([...units, 'extra']);
  const removeUnit = () => onChange(units.slice(0, -1));
  const setUnit = (i: number, val: string) => onChange(units.map((u, idx) => (idx === i ? val : u)));

  return (
    <div className="card card-pad" style={{ marginBottom: 14 }}>
      <h3 className="card-title">{name} — {priceLabel}</h3>
      {deadline && (
        <p style={{ fontSize: 12, color: 'var(--ink-soft)', margin: '0 0 8px' }}>
          Purchase by {fmtDate(deadline.slice(0, 10))}
        </p>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: units.length > 0 ? 10 : 0 }}>
        <span style={{ fontSize: 14 }}>Tickets</span>
        <button type="button" className="btn small ghost" onClick={removeUnit} disabled={units.length === 0} aria-label="Remove a ticket">−</button>
        <span style={{ minWidth: 18, textAlign: 'center' }}>{units.length}</span>
        <button type="button" className="btn small ghost" onClick={addUnit} aria-label="Add a ticket">+</button>
      </div>
      {units.map((u, i) => (
        <Field key={i} label={`Ticket #${i + 1}`}>
          <select className="input" value={u} onChange={(e) => setUnit(i, e.target.value)}>
            <option value="extra">Extra ticket</option>
            {roster.map((p) => {
              const taken = u !== p.id && personTaken(p.id, i);
              return (
                <option key={p.id} value={p.id} disabled={taken}>
                  {p.firstName} {p.lastName}{taken ? ' (already has a ticket)' : ''}
                </option>
              );
            })}
          </select>
        </Field>
      ))}
    </div>
  );
}

/** §E3: the Add-ons card on the club-manager event-registration page. Shows
 *  each configured add-on type whose purchase window is open — remains
 *  visible after regCloses while any type's `lastPurchaseAt` extends it,
 *  independent of whether registration itself is still open. Pushes one cart
 *  line PER UNIT to the CLUB cart (club_id set, person_id null — same
 *  pushCart(clubId, cart, true) path the rest of this page uses). */
function ClubAddonsCard({ event, clubId, canManage }: { event: Event; clubId: string; canManage: boolean }) {
  const db = useDB();
  const toast = useToast();
  const fmtDate = useFmtDate();
  const now = new Date();

  // Caller keys this component on `event.id` (see EventRegGrid's render), so
  // a fresh draft is mounted whenever the manager switches events — no
  // synchronous setState-in-effect needed to reset it.
  const [draft, setDraft] = useState<ClubAddonDraft>(() => initialClubAddonDraft());
  const [addonRefundTarget, setAddonRefundTarget] = useState<RefundRequestItem | null>(null);
  // Phase 4 (data-layer-scale.md): called unconditionally (Rules of Hooks)
  // before the canManage early-return below — falls back to boot-scoped
  // db.people while loading (correct instantly for a real manager's own
  // club; self-corrects for an admin viewing a club they don't personally
  // manage).
  const { rows: clubPeopleRows, status: clubPeopleStatus } = usePeopleForClub(clubId);
  const effectivePeople = clubPeopleStatus === 'ready' ? clubPeopleRows : db.people;

  const tshirtOpen = !!event.tshirtAddon && addonPurchaseOpen(event.tshirtAddon, event.regCloses, now);
  const banquetOpen = !!event.banquet && addonPurchaseOpen(event.banquet, event.regCloses, now);
  const bannerOpen = !!event.bannerAddon && addonPurchaseOpen(event.bannerAddon, event.regCloses, now);

  if (!canManage || (!tshirtOpen && !banquetOpen && !bannerOpen)) return null;

  const roster = effectivePeople.filter(
    (p) => p.mainClubId === clubId && (p.roles ? (p.roles.athlete || p.roles.coach) : (p.kind === 'athlete' || p.kind === 'coach')),
  ).sort((a, b) => a.lastName.localeCompare(b.lastName));

  const nameOf = (id: string) => {
    const p = effectivePeople.find((x) => x.id === id);
    return p ? `${p.firstName} ${p.lastName}` : 'Unknown';
  };

  const clubCart: CartItem[] = db.carts[clubId] ?? [];
  const cartAddonsForEvent = clubCart.filter((c) => c.kind === 'addon' && c.refEventId === event.id);

  // Purchased (non-refunded) add-on invoice lines for this club+event — cheap
  // to derive client-side since RLS already restricts db.invoices to invoices
  // this manager can see (their own club's).
  const purchasedItems: CartItem[] = db.invoices
    .filter((inv) => inv.clubId === clubId)
    .flatMap((inv) => inv.items.filter((it) => it.kind === 'addon' && it.refEventId === event.id && !it.refunded));

  // event-mgmt v2 Phase 3 (§H): per-item refund requests on purchased add-ons.
  // Refunds are only offered for events hosted by the league's own club, and
  // only for one already pending/approved request per item at a time.
  const addonRefundEligible = eventIsRefundEligible(event, db.clubs);
  const addonRefundRequestedIds = new Set(
    (db.refundRequests ?? [])
      .filter((r) => r.kind === 'addon' && r.eventId === event.id && (r.status === 'pending' || r.status === 'approved'))
      .map((r) => r.invoiceItemId),
  );

  const cartAssigned = new Set(
    cartAddonsForEvent
      .filter((c) => c.refLineType === 'banquet' && c.addonAssigneeId && c.addonAssigneeId !== 'extra')
      .map((c) => c.addonAssigneeId as string),
  );
  const purchasedAssigned = new Set(
    purchasedItems
      .filter((c) => c.refLineType === 'banquet' && c.addonAssigneeId && c.addonAssigneeId !== 'extra')
      .map((c) => c.addonAssigneeId as string),
  );
  // Max-1-assigned-per-person, across (a) other units in this draft, (b) the
  // club cart, and (c) already-purchased non-refunded invoice lines.
  const personTaken = (personId: string, unitIndex: number) =>
    draft.banquetUnits.some((u, i) => i !== unitIndex && u === personId) ||
    cartAssigned.has(personId) ||
    purchasedAssigned.has(personId);

  const bannerInCart = cartAddonsForEvent.some((c) => c.refLineType === 'banner');
  const bannerPurchased = purchasedItems.some((c) => c.refLineType === 'banner');
  const bannerLocked = bannerInCart || bannerPurchased;

  const hasSelection =
    draft.shirtUnits.some((u) => !!u) ||
    draft.banquetUnits.length > 0 ||
    (!bannerLocked && draft.bannerText.trim().length > 0);

  const handleAddToCart = () => {
    const items = buildClubAddonCartItems(
      event,
      { ...draft, bannerText: bannerLocked ? '' : draft.bannerText },
      nameOf,
      Date.now(),
    );
    if (items.length === 0) {
      toast('Choose at least one add-on to add to the cart.', { variant: 'error' });
      return;
    }
    const applied = mutate((d) => {
      const cart = d.carts[clubId] ?? (d.carts[clubId] = []);
      for (const item of items) cart.push(item);
      pushCart(clubId, cart, true);
    });
    if (!applied) return; // offline read-only gate — no false success toast
    toast('Add-ons added to the club cart.');
    setDraft(initialClubAddonDraft());
  };

  const addonLabel = (it: CartItem) => {
    if (it.refLineType === 'tshirt') return `T-shirt (size ${it.addonSize ?? '—'})`;
    if (it.refLineType === 'banner') {
      const match = it.label.match(/"([^"]*)"\s*$/);
      return `Club banner — "${match ? match[1] : it.label}"`;
    }
    if (it.refLineType === 'banquet') {
      return it.addonAssigneeId && it.addonAssigneeId !== 'extra'
        ? `${event.banquet?.name ?? 'Banquet ticket'} — ${nameOf(it.addonAssigneeId)}`
        : `${event.banquet?.name ?? 'Banquet ticket'} — Extra ticket`;
    }
    return it.label;
  };

  return (
    <div className="card card-pad" style={{ marginBottom: 18 }}>
      <h3 className="card-title">Add-ons</h3>
      <p style={{ fontSize: 13, color: 'var(--ink-soft)', marginBottom: 12 }}>
        Purchase t-shirts, banquet tickets, and a club banner for this event.
      </p>

      {tshirtOpen && event.tshirtAddon && (
        <SizedAddonPicker
          title="T-shirt"
          price={event.tshirtAddon.price}
          sizes={event.tshirtAddon.sizes.length > 0 ? event.tshirtAddon.sizes : SHIRT_SIZES}
          deadline={event.tshirtAddon.lastPurchaseAt}
          forceSingle={false}
          noneLabel="No shirt"
          units={draft.shirtUnits}
          onChange={(units) => setDraft((d) => ({ ...d, shirtUnits: units }))}
          fmtDate={fmtDate}
        />
      )}

      {banquetOpen && event.banquet && (
        roster.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--ink-soft)' }}>
            No athletes or coaches on this club's roster yet — add roster members before purchasing banquet tickets.
          </p>
        ) : (
          <ClubBanquetPicker
            name={event.banquet.name}
            price={event.banquet.price}
            deadline={event.banquet.lastPurchaseAt}
            roster={roster}
            personTaken={personTaken}
            units={draft.banquetUnits}
            onChange={(units) => setDraft((d) => ({ ...d, banquetUnits: units }))}
            fmtDate={fmtDate}
          />
        )
      )}

      {bannerOpen && event.bannerAddon && (
        <div className="card card-pad" style={{ marginBottom: 14 }}>
          <h3 className="card-title">Club banner — {event.bannerAddon.price === 0 ? 'Free' : fmtMoney(event.bannerAddon.price)}</h3>
          {event.bannerAddon.lastPurchaseAt && (
            <p style={{ fontSize: 12, color: 'var(--ink-soft)', margin: '0 0 8px' }}>
              Purchase by {fmtDate(event.bannerAddon.lastPurchaseAt.slice(0, 10))}
            </p>
          )}
          {bannerLocked ? (
            <p style={{ fontSize: 13, color: 'var(--ink-soft)' }}>
              {bannerPurchased ? 'A banner has already been purchased for this event.' : 'A banner is already in the club cart for this event — remove it there to change the text.'}
            </p>
          ) : (
            <Field label="Banner text (exact name)" hint="Text to print on the club banner. Leave blank to skip.">
              <input
                className="input"
                value={draft.bannerText}
                onChange={(e) => setDraft((d) => ({ ...d, bannerText: e.target.value }))}
                placeholder="e.g. Springfield Gymnastics Club"
              />
            </Field>
          )}
        </div>
      )}

      <button className="btn primary" disabled={!hasSelection} onClick={handleAddToCart}>
        Add to cart
      </button>

      {purchasedItems.length > 0 && (
        <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--line)' }}>
          <h4 style={{ margin: '0 0 6px', fontSize: 14 }}>Purchased add-ons ({purchasedItems.length})</h4>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, color: 'var(--ink-soft)' }}>
            {purchasedItems.map((it) => {
              const requested = addonRefundRequestedIds.has(it.id);
              return (
                <li key={it.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
                  <span>{addonLabel(it)}</span>
                  {requested ? (
                    <Badge tone="warn">Refund requested</Badge>
                  ) : addonRefundEligible ? (
                    <button
                      className="btn ghost small"
                      style={{ color: 'var(--coral-500)', padding: '2px 10px' }}
                      onClick={() => setAddonRefundTarget({ kind: 'addon', invoiceItemId: it.id, label: addonLabel(it) })}
                    >
                      Request refund
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {addonRefundTarget && (
        <RefundRequestDialog
          items={[addonRefundTarget]}
          event={event}
          clubId={clubId}
          onClose={() => setAddonRefundTarget(null)}
          onSubmitted={() => { /* store refresh happens inside the dialog via syncFromSupabase() */ }}
        />
      )}
    </div>
  );
}

// ---- EventRegGrid (three-card layout) ----------------------------------------

function EventRegGrid({ clubId, canManage }: { clubId: string; canManage: boolean }) {
  const db = useDB();
  const caps = useCapabilities();
  const toast = useToast();
  const navigate = useNavigate();
  // Camps are individual self-registration ONLY (spec §G; Julia confirmed
  // 2026-08-19 "block it outright") — managers cannot register athletes for
  // them, so they never appear in this picker. Competitions unchanged.
  const openEvents = db.events.filter((m) =>
    m.eventType !== 'camp' && (eventIsInPhase(m, 'reg-open') || eventIsInPhase(m, 'reg-closed')));
  const [eventId, setEventId] = useState(openEvents.find((m) => eventIsInPhase(m, 'reg-open'))?.id ?? openEvents[0]?.id);
  const event = db.events.find((m) => m.id === eventId);
  // Phase 3 (data-layer-scale): the by-event slice, replacing db.registrations
  // throughout this component. Called unconditionally (Rules of Hooks) before
  // any early return below — event?.id is undefined-safe. regsStatus gates
  // the whole roster render further down: this file's `hasActiveReg`
  // classification is the highest-risk read in the refactor (CLAUDE.md) — a
  // partial slice makes a registered athlete look unregistered, inviting a
  // manager to re-register and RE-CHARGE them, with no visible error.
  const { rows: eventRegs, status: regsStatus } = useEventRegistrations(event?.id);
  // memberships are Tier 2 boot-scoped to the caller's own + managed-club
  // rows (whats-next.md §7) — correct already for a real manager's OWN club,
  // but an admin viewing a club they don't manage needs this on-demand
  // override too (see the same reasoning + hook on Roster's `canManage`
  // gate above), or `hasMembership` below would wrongly classify every
  // athlete as having no membership.
  const { rows: clubMembershipRows, status: clubMembershipsStatus } = useClubRosterMemberships(canManage ? clubId : null);
  const clubMembershipsByPerson = useMemo(() => groupAdminMembershipsByPerson(clubMembershipRows), [clubMembershipRows]);
  const membershipsOverrideReady = canManage && clubMembershipsStatus === 'ready';
  // Phase 4 (data-layer-scale.md): same override pattern as clubMembershipRows
  // above — db.people at boot only carries a real manager's OWN club roster,
  // so an admin viewing a club they don't personally manage needs this
  // on-demand fetch too. `effectivePeople` replaces every db.people
  // find/filter below that's scoped to this club's roster (the roster
  // itself, synchro-partner candidates, swap-athlete targets, the
  // edit/register modals' subject athlete).
  const { rows: clubPeopleRows, status: clubPeopleStatus } = usePeopleForClub(canManage ? clubId : null);
  const peopleOverrideReady = canManage && clubPeopleStatus === 'ready';
  const effectivePeople = peopleOverrideReady ? clubPeopleRows : db.people;
  const season = currentSeason(db)!;
  // B4.2: past the event's last-date-to-edit, only an admin or the event's
  // HOST club may still edit (client-side UX only — registrations_edit_lockout
  // enforces this server-side regardless).
  const canStillEdit = event ? canStillEditRegistration(event, caps.isEventHost(event.id)) : false;

  // Modal state for RegistrationEditor
  const [editingAthleteId, setEditingAthleteId] = useState<string | null>(null);
  const [registerAthleteId, setRegisterAthleteId] = useState<string | null>(null);
  const [refundTarget, setRefundTarget] = useState<RefundRequestItem[] | null>(null);

  // NOT memoized on `db` — same M6 in-place-mutation trap as Roster's
  // allRoster above (mutate() never reassigns db.people, so a useMemo keyed
  // on `db` misses in-place edits). Read directly per render.
  //
  // B4.3: this club's roster (mainClubId) UNION anyone with an actual
  // registration.clubId === this club for this event, even if their home
  // roster is elsewhere. Without the union, an athlete who switches which
  // club they compete for at THIS event (MyRegistrations.tsx's self-service
  // club-only registration switch — only the athlete/an admin can do this,
  // never a manager) becomes invisible here in BOTH directions: their old
  // club's roster still lists them as "not yet registered" (registration.
  // clubId moved away), and their new club can't see the registration at all
  // (roster filter never included them, since mainClubId never changes).
  const eventRegAthleteIds = new Set(
    eventRegs.filter((r) => r.clubId === clubId && !r.refunded).map((r) => r.athleteId),
  );
  const athletes = effectivePeople.filter(
    (p) => p.kind === 'athlete' && (p.mainClubId === clubId || eventRegAthleteIds.has(p.id)),
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
  //
  // Phase 3: cleanupCrossClubCart needs this CLUB's cross-event registrations
  // (CONTRACT shape #5) — the club cart can hold pending lines for events
  // other than the one currently selected above (eventRegs, by-event, isn't
  // enough here). Gated on 'ready' so a loading slice can't cause a stale
  // line to be missed this pass (idempotent — it'll be caught next time).
  const clubRegsAllEvents = useClubRegistrations(clubId);
  useEffect(() => {
    if (clubRegsAllEvents.status !== 'ready') return;
    cleanupCrossClubCart(db, clubRegsAllEvents.rows, clubId, toast);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, clubId, clubRegsAllEvents.status]);

  if (!event) return <p>No events accepting registration.</p>;
  // MUST gate before computing hasActiveReg/registered/etc below (CONTRACT
  // completeness rule) — a loading slice must never be treated as "this
  // athlete has no registrations". Same reasoning extends to the
  // club-roster-memberships/-people overrides (canManage-gated, above) —
  // while either is still loading, `hasMembership`/`athletes` must not be
  // evaluated as "no one has one"/"the roster is empty".
  if (regsStatus === 'loading' || (canManage && (clubMembershipsStatus === 'loading' || clubPeopleStatus === 'loading'))) return <p>Loading…</p>;

  const regClosed = !eventIsInPhase(event, 'reg-open');
  // event-mgmt v2 Phase 3 (§H): refunds only offered for events hosted by the
  // league's own club — gates the per-athlete "Request refund" action below.
  const refundEligible = eventIsRefundEligible(event, db.clubs);

  // Gate: the club must hold an active membership for the event's season before
  // registering any athlete. Returns true (and toasts) when blocked. Waived for
  // camps (event-mgmt v2 §G) — a camp registrant's club needn't be a member,
  // though camps are individual self-reg only, so this path shouldn't normally
  // apply to one; the carve-out is applied here too as a belt-and-suspenders.
  const clubMembershipBlocked = (): boolean => {
    const seasonId = seasonForDate(db, event.startDate);
    if (!clubHasActiveMembershipForEvent(db, clubId, seasonId, event.eventType)) {
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

  // Late-registration fee attachment (emv2 P0 Task 3, corrected): the
  // surcharge attaches ONLY to the line containing the athlete's
  // earliest-created reg for this event+club — `lateFeeAnchor` (pricing.ts)
  // returns that line's anchor timestamp or null (⇒ no surcharge on this
  // line; it was, or will be, carried by the first line). This is what makes
  // the fee once-per-athlete across repeat purchases and multi-save carts.
  const lateAnchorFor = (lineRegs: Registration[], outsideRegs: Registration[]) =>
    lateFeeAnchor(lineRegs, outsideRegs, new Date().toISOString());
  /** " (incl. late fee)" suffix for an entry-line label when the surcharge applied. */
  const lateFeeSuffix = (anchor: string | null) =>
    anchor !== null && lateFeeApplies(event, anchor) ? ' (incl. late fee)' : '';

  // Regs for this event + club shown in the registered-athletes table below:
  // active (non-refunded) regs, PLUS refunded-but-kept ones (`keepListed`,
  // event-mgmt v2 Phase 3 spec §H: "name still appears in event materials"
  // for a post-edit-deadline refund) — but NOT a refunded row whose refund
  // deleted it outright (pre-deadline refunds have no row left at all).
  const allRegs = eventRegs.filter(
    (r) => r.clubId === clubId && (!r.refunded || r.keepListed),
  );

  const regsFor = (athleteId: string) => allRegs.filter((r) => r.athleteId === athleteId);
  const hasActiveReg = (athleteId: string) => regsFor(athleteId).length > 0;
  // Registering to compete requires an ACTIVE ATHLETE-type membership — a
  // coach-only membership does not qualify (typed-membership residuals, T1).
  const hasMembership = (athlete: Athlete) => {
    const memberships = membershipsOverrideReady ? (clubMembershipsByPerson.get(athlete.id) ?? []) : athlete.memberships;
    return !!memberships.find(
      (m) => m.seasonId === season?.id && m.status === 'active' && membershipTypeOf(m) === 'athlete',
    );
  };

  // Split athletes into three groups
  const registered = athletes.filter((a) => hasActiveReg(a.id));
  const unregisteredWithMembership = athletes.filter((a) => !hasActiveReg(a.id) && hasMembership(a));
  const withoutMembership = athletes.filter((a) => !hasActiveReg(a.id) && !hasMembership(a));

  const lvlName = (id?: string) => db.levels.find((l) => l.id === id)?.name ?? '—';

  const nameOf = (id: string) => {
    const p = effectivePeople.find((x) => x.id === id);
    return p ? `${p.firstName} ${p.lastName}` : 'partner';
  };

  // Summarize registrations for a given athlete as "WAG – Silver – VT, BB, FX"
  const regSummary = (athleteId: string) => {
    const regs = regsFor(athleteId);
    if (regs.length === 0) return null;
    // Camp regs carry no level/apparatus (they're on/off per discipline) —
    // drop those blank segments instead of rendering trailing " – " dashes.
    return regs.map((r) => {
      const parts = [r.discipline === 'TNT' ? 'T&T' : r.discipline];
      if (r.levelId) parts.push(lvlName(r.levelId));
      const events = eventsText(r, nameOf);
      if (events) parts.push(events);
      return parts.join(' – ');
    }).join(' / ');
  };

  // Leave waitlist (event-mgmt v2 P4 T6, club-manager side): cancels every
  // waitlist group this athlete's waitlisted regs at THIS event belong to
  // (status → 'cancelled', the only client-writable transition — there is no
  // client DELETE policy on waitlist_groups by design) and hard-deletes the
  // never-paid waitlisted regs. A waitlisted reg is normally a placeholder
  // with no cart line, so deleting it is the correct undo, same as
  // `removeCartItemWithSync`'s 'delete-registration' action for a brand-new
  // unpaid entry — EXCEPT any reg with paid history (see guard below).
  const leaveWaitlist = (athleteId: string) => {
    const allWl = regsFor(athleteId).filter((r) => r.waitlisted);
    if (allWl.length === 0) return;
    if (!window.confirm(`Remove ${nameOf(athleteId)} from the waitlist for ${event.name}?`)) return;
    // Belt-and-braces money guard (fable review of T6): NEVER hard-delete a
    // reg with paid history (`updatedPending:true` — the paid→change-pending
    // state). The dialog's `isWaitlistable` gate should make this
    // unreachable, but if any other/historical path waitlisted such a reg,
    // deleting it here would destroy a purchased registration — deletion of
    // a paid reg is a refund action only. Cancel the group but keep those
    // regs (waitlisted flag cleared so they stop reading as placeholders).
    const deletable = allWl.filter((r) => r.updatedPending !== true);
    const kept = allWl.filter((r) => r.updatedPending === true);
    const groupIds = [...new Set(allWl.map((r) => r.waitlistGroupId).filter((id): id is string => !!id))];
    const applied = mutate((d) => {
      for (const gid of groupIds) {
        const idx = (d.waitlistGroups ?? []).findIndex((g) => g.id === gid);
        if (idx >= 0 && d.waitlistGroups) {
          d.waitlistGroups[idx] = { ...d.waitlistGroups[idx], status: 'cancelled' as const };
          cancelWaitlistGroup(gid);
        }
      }
      const ids = new Set(deletable.map((r) => r.id));
      d.registrations = d.registrations.filter((r) => !ids.has(r.id));
      for (const reg of deletable) {
        deleteRegistration(reg.id);
        applyLocalRegistrationRemove(reg);
      }
      for (const reg of kept) {
        const idx = d.registrations.findIndex((r) => r.id === reg.id);
        const base = idx >= 0 ? d.registrations[idx] : reg;
        const next = { ...base, waitlisted: false, waitlistGroupId: null };
        if (idx >= 0) d.registrations[idx] = next;
        pushRegistration(next);
        applyLocalRegistrationUpsert(next);
      }
    });
    if (!applied) return; // offline read-only gate — no false success toast
    if (kept.length > 0) {
      toast(
        'Left the waitlist, but a previously-purchased registration was kept (it was an update to a paid '
        + 'registration, not a new one). To undo the update, remove its change line from the cart; to cancel '
        + 'the registration entirely, request a refund.',
        { variant: 'error' },
      );
    } else {
      toast('Removed from the waitlist.');
    }
  };

  // Complete checkout for a promoted ('notified') waitlist group (event-mgmt
  // v2 P4 T7): flips the group's regs off the waitlist placeholder state
  // (waitlisted:false; waitlistGroupId KEPT for audit — the sweep's pass 1
  // marks the group 'promoted' once no reg is still waitlisted), stamps a
  // fresh 30-min cart hold, and queues the normal ENTRY-fee cart line(s) —
  // one per athlete, exactly the addToCart idiom (same label/refRegIds
  // shape). Never a change fee: promotion is claiming the original entry,
  // not an edit, so it deliberately never passes through changeIsEligible.
  const completeWaitlistCheckout = (group: WaitlistGroup) => {
    if (clubMembershipBlocked()) return;
    const groupRegs = eventRegs.filter((r) => r.waitlistGroupId === group.id && r.waitlisted);
    if (groupRegs.length === 0) return;
    const byAthlete = new Map<string, Registration[]>();
    for (const r of groupRegs) {
      const arr = byAthlete.get(r.athleteId) ?? [];
      arr.push(r);
      byAthlete.set(r.athleteId, arr);
    }
    const applied = mutate((d) => {
      const cart = d.carts[clubId] ?? (d.carts[clubId] = []);
      for (const [athleteId, regs] of byAthlete) {
        // Prior (non-waitlisted, non-refunded) regs the athlete already holds
        // at this event+club — drives second-discipline pricing + late anchor,
        // mirroring addToCart's own computation. Read from the pre-write
        // eventRegs snapshot (Phase 3), not d.registrations (empty once
        // Stage 4 lands) — safe here since `regs` (this group's own rows,
        // excluded below) are the only rows this mutate() call writes.
        const priorRegs = eventRegs.filter(
          (r) => r.eventId === event.id && r.athleteId === athleteId && r.clubId === clubId
            && !r.refunded && !regs.some((g) => g.id === r.id) && !r.waitlisted,
        );
        const lineAnchor = lateAnchorFor(regs, priorRegs);
        const entryTotal = newRegistrationEntryTotal(event, {
          competingClubId: clubId,
          priorDisciplineCount: priorRegs.length,
          newDisciplineCount: regs.length,
          late: lineAnchor ? { earliestCreatedAtISO: lineAnchor } : undefined,
        });
        for (const reg of regs) {
          const idx = d.registrations.findIndex((r) => r.id === reg.id);
          const base = idx >= 0 ? d.registrations[idx] : reg;
          const next: Registration = {
            ...base,
            waitlisted: false, // waitlistGroupId kept — audit trail + sweep pass-1 signal
            paid: entryTotal === 0, // host-club $0 (shouldn't normally be waitlisted, but stay consistent)
            updatedPending: false,
            holdExpiresAt: entryTotal > 0 ? holdStamp(event, event.sessions, Date.now()) : undefined,
          };
          if (idx >= 0) d.registrations[idx] = next;
          pushRegistration(next);
          applyLocalRegistrationUpsert(next);
        }
        if (entryTotal > 0) {
          const athlete = d.people.find((p) => p.id === athleteId);
          // Camps ask nothing discipline-related — omit the parenthetical
          // (PM feedback 2026-07-23).
          const discParen = event.eventType === 'camp' ? '' : ` (${regs.map((r) => r.discipline).join('+')})`;
          cart.push({
            id: `ci-${Date.now()}-${athleteId}`,
            label: `${event.name} entry — ${athlete?.firstName ?? ''} ${athlete?.lastName ?? ''}${discParen}${lateFeeSuffix(lineAnchor)}`,
            amount: entryTotal,
            kind: 'meet-entry',
            refUserId: athleteId,
            refRegIds: regs.map((r) => r.id),
            refEventId: event.id,
            refLineType: 'entry',
          });
        }
      }
      pushCart(clubId, cart, true);
    });
    if (!applied) return; // offline read-only gate — no false success toast
    toast('Entry added to the club cart — complete checkout before the hold expires.');
    navigate('/cart');
  };

  // Cross-club lock (3d): the OTHER club this athlete is already PAID-registered
  // with for this event. Non-null ⇒ not selectable here. shortName for the note.
  const lockedToClubShortName = (athleteId: string): string | null => {
    const otherClubId = paidRegistrationClub(eventRegs, {
      athleteId, eventId: event.id, excludeClubId: clubId,
    });
    if (!otherClubId) return null;
    return db.clubs.find((c) => c.id === otherClubId)?.shortName ?? 'another club';
  };

  // Change-fee label for this event+athlete's club-cart line — also how we
  // detect an already-pending change line to extend in place (M7/H5 fix,
  // mirroring MyRegistrations.tsx's changeFeeLabel/changeFeePending). UAT
  // M-10-01: a mixed line (a discipline added alongside the chargeable edit)
  // keeps this SAME label rather than a distinct one — changing the label
  // text would have required switching this lookup off exact-match, which
  // risks silently un-recognizing an already-pending line (reintroducing the
  // M7/H5 cart-line-stacking bug this lookup exists to prevent). The line's
  // AMOUNT reflects the combined total; only the label stays the plain
  // "change fee" text.
  const changeFeeLabel = (athlete: Athlete) => `${event.name} change fee — ${athlete.firstName} ${athlete.lastName}`;
  const changeFeePendingItem = (athleteId: string) => {
    const athlete = effectivePeople.find((p) => p.id === athleteId);
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
    const applied = mutate((d) => {
      // Read from the pre-write eventRegs snapshot (Phase 3) — this is the
      // FIRST read of registration state in this call, so it can't have gone
      // stale relative to d.registrations (which is about to become
      // perpetually empty in Supabase-configured mode once Stage 4 lands).
      const existingForAthlete = eventRegs.filter(
        (r) => r.eventId === event.id && r.athleteId === athleteId && r.clubId === clubId && !r.refunded,
      );

      // Disciplines covered by new regs
      const newDiscSet = new Set(newRegs.map((r) => r.discipline));

      // Remove regs for disciplines no longer covered (athlete deselected them)
      for (const old of existingForAthlete) {
        if (!newDiscSet.has(old.discipline)) {
          d.registrations = d.registrations.filter((r) => r.id !== old.id);
          deleteRegistration(old.id);
          applyLocalRegistrationRemove(old);
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
      const editLateAnchor = lateAnchorFor(newOnlyRegs, existingForAthlete);
      const entryTotal = !opts?.skipEntryFeeLine && newOnlyRegs.length > 0
        ? newRegistrationEntryTotal(event, {
            competingClubId: clubId,
            priorDisciplineCount,
            newDisciplineCount: newOnlyRegs.length,
            late: editLateAnchor ? { earliestCreatedAtISO: editLateAnchor } : undefined,
          })
        : 0;

      // Which regs get a cart-add capacity hold stamped (event-mgmt v2 P4):
      // exactly the regs that end up referenced by a cart line pushed below —
      // mirrors the change-fee/entry-fee branch conditions further down so
      // the two stay in lockstep. A free edit (no cart line) never stamps.
      const cartLinkedIds = new Set<string>();
      if (changeFee > 0 && event.changeFee) {
        for (const r of newRegs) cartLinkedIds.add(r.id);
      } else if (!changeFeeApplies && entryTotal > 0) {
        for (const r of newOnlyRegs) cartLinkedIds.add(r.id);
      }

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
        if (cartLinkedIds.has(reg.id)) {
          reg.holdExpiresAt = holdStamp(event, event.sessions, Date.now());
        }
        const idx = d.registrations.findIndex((r) => r.id === reg.id);
        if (idx >= 0) {
          d.registrations[idx] = reg;
        } else {
          d.registrations.push(reg);
        }
        pushRegistration(reg);
        applyLocalRegistrationUpsert(reg);
      }

      // Synchro same-level auto-sync (B4.4): whoever actively saves a partner
      // selection sets the SY level for BOTH — not a validation, an active
      // sync. Update the local snapshot optimistically; the actual remote
      // write goes through sync_synchro_partner_level (an RPC, NOT a plain
      // upsert) because the caller typically lacks RLS write access to the
      // PARTNER's own registration row (a different athlete, often a
      // different club) — the RPC re-derives + authorizes it server-side
      // from the caller's OWN just-saved registration.
      //
      // Phase 3: this needs the POST-upsert view (newRegs were just written
      // above) — the pre-write eventRegs snapshot alone would miss them, so
      // merge it with newRegs via mergeUpsertedRegs rather than re-reading
      // d.registrations (which reflects the write only in demo mode).
      const eventRegsForSync = mergeUpsertedRegs(eventRegs, newRegs).filter((r) => r.eventId === event.id && !r.refunded);
      for (const reg of newRegs) {
        const partnerUpdate = syncSynchroPartnerLevel(eventRegsForSync, reg);
        const mySyLevel = reg.apparatusLevels?.SY;
        if (partnerUpdate && mySyLevel) {
          const idx = d.registrations.findIndex((r) => r.id === partnerUpdate.id);
          if (idx >= 0) d.registrations[idx] = partnerUpdate;
          syncSynchroPartnerLevelRemote(reg.id, mySyLevel);
          applyLocalRegistrationUpsert(partnerUpdate);
        }
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
        // UAT M-10-01: a discipline ADDED alongside this chargeable edit owes
        // its own extra-discipline entry fee ON TOP of the change fee, as one
        // combined line amount — never the change fee alone (that's the
        // under-price this fixes; C4 anti-smuggling: an added reg is always
        // priced by the entry-total logic, on top of, never instead of, the
        // change fee). `addedDisciplineChangeTotal` = the added disciplines'
        // entry-total (over `newOnlyRegs`, at `priorDisciplineCount` including
        // the already-registered ones) + the flat change fee, matching the
        // server's mixed-line pricing exactly. Gated on `!opts?.skipEntryFeeLine`
        // like `entryTotal` above — when addToCart already owns a SEPARATE
        // entry-fee line for these exact newOnlyRegs, folding their total in
        // here too would double-charge them across both lines.
        const isMixed = !opts?.skipEntryFeeLine && newOnlyRegs.length > 0;
        const combinedTotal = isMixed
          ? addedDisciplineChangeTotal(event, {
              competingClubId: clubId,
              priorDisciplineCount,
              newDisciplineCount: newOnlyRegs.length,
              late: editLateAnchor ? { earliestCreatedAtISO: editLateAnchor } : undefined,
            })
          : changeFee;
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
            if (isMixed) {
              // The change fee itself is flat and already baked into
              // line.amount from when the line was first created — only the
              // newly added discipline's entry-total portion (combinedTotal
              // minus this edit's own changeFee) is incremental per edit.
              line.amount = (line.amount ?? 0) + (combinedTotal - changeFee);
            }
          }
        } else {
          cart.push({
            id: `ci-change-${Date.now()}-${athleteId}`,
            label: changeFeeLabel(athlete),
            amount: combinedTotal,
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
        // Camps ask nothing discipline-related — omit the parenthetical
        // (PM feedback 2026-07-23).
        const discParen = event.eventType === 'camp' ? '' : ` (${newOnlyRegs.map((r) => r.discipline).join('+')})`;
        cart.push({
          id: `ci-${Date.now()}-${athleteId}`,
          label: `${event.name} entry — ${athlete.firstName} ${athlete.lastName}${discParen}${lateFeeSuffix(editLateAnchor)}`,
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
    if (!applied) return; // offline read-only gate — no false success toast

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
    // Offline-gated via mutate() even though this step doesn't touch `d` —
    // it stamps paid/holdExpiresAt on `regs` (a parameter), and must not run
    // at all while offline (the same guarantee mutate()'s single choke point
    // gives every other write).
    const applied = mutate((_d) => {
      const existingForAthlete = eventRegs.filter(
        (r) => r.eventId === event.id && r.athleteId === athleteId && r.clubId === clubId && !r.refunded,
      );
      const priorDisciplineCount = existingForAthlete.length;
      const addAnchor = lateAnchorFor(regs, existingForAthlete);
      const entryTotal = newRegistrationEntryTotal(event, {
        competingClubId: clubId,
        priorDisciplineCount,
        newDisciplineCount: regs.length,
        late: addAnchor ? { earliestCreatedAtISO: addAnchor } : undefined,
      });
      hostFree = entryTotal === 0;
      // Stamp paid status on the new regs (saveRegs upserts them below). A
      // non-host entry always gets its own cart line below, so stamp a fresh
      // capacity hold too (event-mgmt v2 P4) — saveRegs is called with
      // skipEntryFeeLine below and won't touch holdExpiresAt itself, so this
      // is the ONE place that must do it for this path.
      for (const reg of regs) {
        reg.paid = hostFree;
        reg.updatedPending = false;
        if (!hostFree) reg.holdExpiresAt = holdStamp(event, event.sessions, Date.now());
      }
    });
    if (!applied) return; // offline read-only gate — don't continue the register flow

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
        // eventRegs (pre-write snapshot) is equivalent to d.registrations
        // here: `regs` are explicitly excluded either way, and eventRegs
        // never had them in the first place.
        const priorRegsForLine = eventRegs.filter(
          (r) => r.eventId === event.id && r.athleteId === athleteId && r.clubId === clubId && !r.refunded
            && !regs.some((nr) => nr.id === r.id),
        );
        const lineAnchor = lateAnchorFor(regs, priorRegsForLine);
        // Camps ask nothing discipline-related — omit the parenthetical
        // (PM feedback 2026-07-23).
        const discParen = event.eventType === 'camp' ? '' : ` (${regs.map((r) => r.discipline).join('+')})`;
        cart.push({
          id: `ci-${Date.now()}-${athleteId}`,
          label: `${event.name} entry — ${athlete.firstName} ${athlete.lastName}${discParen}${lateFeeSuffix(lineAnchor)}`,
          amount: newRegistrationEntryTotal(event, {
            competingClubId: clubId,
            priorDisciplineCount: priorRegsForLine.length,
            newDisciplineCount: regs.length,
            late: lineAnchor ? { earliestCreatedAtISO: lineAnchor } : undefined,
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

  // Opens the shared RefundRequestDialog (event-mgmt v2 Phase 3, spec §H) with
  // one item per PAID, not-yet-refund-requested registration this athlete
  // holds at this event/club — a manager may hold several (one per
  // discipline). Replaces the old direct `r.refundRequested = true` write:
  // the dialog now collects a reason and goes through the request-refund edge
  // function (eligibility/authorization/audit row/emails), matching the
  // self-serve flow in MyRegistrations.tsx.
  const openRefundDialog = (athleteId: string) => {
    const regs = eventRegs.filter(
      (x) => x.eventId === event.id && x.athleteId === athleteId && x.clubId === clubId
        && !x.refunded && !x.refundRequested && x.paid === true,
    );
    if (regs.length === 0) return;
    setRefundTarget(regs.map((r) => ({
      kind: 'registration' as const,
      regId: r.id,
      label: `${r.discipline === 'TNT' ? 'T&T' : r.discipline} – ${db.levels.find((l) => l.id === r.levelId)?.name ?? '—'}`,
    })));
  };

  // Swap a registration to another club athlete (who has membership). Applies the
  // change fee when within the change-fee window (e.g. after reg close).
  //
  // Phase 3 (data-layer-scale): the transformation is computed as a pure step
  // over the pre-write eventRegs snapshot BEFORE calling mutate(), rather than
  // mutating d.registrations rows in place and re-reading d.registrations for
  // the synchro-partner repoint pass — d.registrations will be perpetually
  // empty in Supabase-configured mode once Stage 4 removes registrations from
  // loadAll, so an in-place-mutate-then-reread pattern would silently no-op
  // every part of this function. mutate() below only applies the precomputed
  // rows to d.registrations for demo-mode's sake and fans out to the slice.
  const swapAthlete = (fromId: string, toId: string) => {
    const to = effectivePeople.find((p) => p.id === toId);
    if (!to) return;
    const swapFee = changeFeeApplies ? registrationChangeFee(event, { competingClubId: clubId }) : 0;

    const toSwap = eventRegs.filter((r) => r.eventId === event.id && r.athleteId === fromId && r.clubId === clubId && !r.refunded);
    // Snapshot the FULL prior registration row (before athleteId/paid/
    // updatedPending are transformed below) so deleting the resulting
    // change-fee cart item later can revert the swap (unified-cart-b2 Task A).
    const priorById = new Map(toSwap.map((r) => [r.id, r]));
    const swapped: Registration[] = toSwap.map((r) => {
      const next: Registration = { ...r, athleteId: toId };
      // A chargeable swap re-pends a previously-paid registration.
      if (swapFee > 0 && r.paid) { next.paid = false; next.updatedPending = true; }
      // A chargeable swap adds a change-fee cart line below referencing every
      // swapped reg — stamp a fresh capacity hold on all of them (event-mgmt
      // v2 P4), matching that line's condition exactly.
      if (swapFee > 0 && event.changeFee) { next.holdExpiresAt = holdStamp(event, event.sessions, Date.now()); }
      return next;
    });
    const swappedRegIds = swapped.map((r) => r.id);

    // 3e: any OTHER (event-scoped, non-refunded) registration that named the
    // swapped-OUT athlete as its synchro partner must now point at the
    // swapped-IN athlete. Scope mirrors the partner model (same event, not
    // refunded). reassignPartners skips the swapped athletes' own rows.
    // Computed over the POST-swap view (eventRegs merged with `swapped`) so a
    // partner's own row reflects the just-applied swap even within this same
    // synchronous call.
    const postSwapEventRegs = mergeUpsertedRegs(eventRegs.filter((r) => r.eventId === event.id && !r.refunded), swapped);
    const repointed = reassignPartners(postSwapEventRegs, fromId, toId);

    const applied = mutate((d) => {
      for (const sw of swapped) {
        const idx = d.registrations.findIndex((r) => r.id === sw.id);
        if (idx >= 0) d.registrations[idx] = sw;
        pushRegistration(sw, sw.sessionId);
        applyLocalRegistrationUpsert(sw);
      }
      for (const reg of repointed) {
        const idx = d.registrations.findIndex((r) => r.id === reg.id);
        if (idx >= 0) d.registrations[idx] = reg;
        pushRegistration(reg, reg.sessionId);
        applyLocalRegistrationUpsert(reg);
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
    if (!applied) return; // offline read-only gate — no false success toast
    toast(`Registration swapped to ${to.firstName} ${to.lastName}.${swapFee > 0 ? ` Change fee ${fmtMoney(swapFee)} added to club cart.` : ''}`);
    setEditingAthleteId(null);
  };

  const editingAthlete = editingAthleteId ? effectivePeople.find((p) => p.id === editingAthleteId) : null;
  const registerAthlete = registerAthleteId ? effectivePeople.find((p) => p.id === registerAthleteId) : null;

  return (
    <div>
      {/* Event selector */}
      <div className="grid cols-3" style={{ marginBottom: 14, alignItems: 'end' }}>
        <Field label="Event">
          <select className="input" value={eventId} onChange={(e) => setEventId(e.target.value)}>
            {openEvents.map((m) => <option key={m.id} value={m.id}>{m.name}{!eventIsInPhase(m, 'reg-open') ? ' (closed)' : ''}</option>)}
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

      <ClubAddonsCard key={event.id} event={event} clubId={clubId} canManage={canManage} />

      {/* Nationals session-planning survey (event-mgmt v2 Phase 5, A2): one
          card per required WAG-level/combined-MAG/combined-T&T key, derived
          from this club's non-refunded regs at this event. Read db.sessionRequests
          directly each render (M6 in-place-mutation trap — mutate() never
          reassigns the array on an update). Editable until the event's edit
          deadline; read-only after (mirrors canStillEdit above). */}
      {event.kind === 'nationals' && (
        <SessionRequestSurveyCard
          eventId={event.id}
          sessions={event.sessions}
          keys={requiredSessionRequests(event, allRegs, 'club')}
          existing={(db.sessionRequests ?? []).filter((r) => r.eventId === event.id && r.clubId === clubId)}
          owner={{ clubId }}
          editable={canStillEdit}
          showSeparateGyms
          labelFor={(key) => (key.levelId ? `WAG — ${lvlName(key.levelId)}` : (key.discipline === 'TNT' ? 'T&T' : key.discipline))}
        />
      )}

      {/* Set Competition Order (event-mgmt v2 Phase 5 B2, spec §E6): MAG/WAG
          drag-and-drop competing order per apparatus/level, gated view-only
          once locked (unless the viewer is an admin). Internal early-return
          handles the "nothing to show" cases (no MAG/WAG regs, not a
          manager) — mirrors ClubAddonsCard's gating convention above. */}
      <CompetitionOrderCard event={event} clubId={clubId} canManage={canManage} isAdmin={caps.isAdmin} />

      {/* Nationals summary dashboard (event-mgmt v2 Phase 5 D1, spec §L.3):
          read-only planning aggregation (eligible teams, decathlon/omnithon,
          coaches, banquet gap, assigned sessions) scoped to this club. */}
      {canManage && event.kind === 'nationals' && (
        <NationalsDashboard eventId={event.id} scope={{ clubId }} />
      )}

      {/* Nationals check-in (event-mgmt v2 Phase 5 E1, spec §L.4): gated on
          event.kind === 'nationals' to keep check-in scoped to P5, though
          the underlying feature isn't nationals-specific per spec. */}
      {canManage && event.kind === 'nationals' && (
        <EventCheckinCard eventId={event.id} scope={{ clubId }} />
      )}

      {/* Card 1: Already registered */}
      {/* Promoted waitlist groups (event-mgmt v2 P4 T7): a 'notified' group
          holds reserved spots until its deadline — surface it prominently
          with the Complete-checkout action. */}
      {canManage && (db.waitlistGroups ?? [])
        .filter((g) => g.eventId === event.id && g.clubId === clubId && g.status === 'notified')
        .map((g) => {
          const groupRegs = eventRegs.filter((r) => r.waitlistGroupId === g.id && r.waitlisted);
          if (groupRegs.length === 0) return null;
          const names = [...new Set(groupRegs.map((r) => nameOf(r.athleteId)))].join(', ');
          return (
            <div key={g.id} className="card card-pad" style={{ marginBottom: 18, borderLeft: '4px solid var(--coral-500)' }}>
              <h3 className="card-title">Waitlist spots opened!</h3>
              <p style={{ margin: '0 0 10px', fontSize: 14 }}>
                Spots are being held for <strong>{names}</strong>
                {g.holdExpiresAt && <> until <strong>{new Date(g.holdExpiresAt).toLocaleString()}</strong></>}.
                Complete checkout before then or the group returns to the end of the waitlist.
              </p>
              <button className="btn primary small" onClick={() => completeWaitlistCheckout(g)}>
                Complete checkout →
              </button>
            </div>
          );
        })}

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
                const anyRefunded = regs.some((r) => r.refunded);
                const allRefunded = regs.length > 0 && regs.every((r) => r.refunded);
                const anyPaidRefundable = refundEligible && regs.some((r) => r.paid === true && !r.refunded && !r.refundRequested);
                // H7: undefined-safe. `paid` defaults falsy on a new reg but a
                // strict `=== false` check lets `undefined` slip through and
                // render the green "Registered" badge for a reg nothing has
                // ever stamped paid — treat anything that isn't `true` as unpaid.
                const anyUnpaid = regs.some((r) => r.paid !== true);
                const anyUpdatedPending = regs.some((r) => r.paid !== true && r.updatedPending);
                // Waitlisted regs (event-mgmt v2 P4 T6): no cart line, not yet
                // occupying a spot — distinct from "Pending purchase" (which
                // implies a cart line is waiting to be paid).
                const anyWaitlisted = regs.some((r) => r.waitlisted);
                const allWaitlisted = regs.length > 0 && regs.every((r) => r.waitlisted || r.refunded);
                // Queue position (T7): 1-based rank among this event's
                // 'waiting' groups — undefined once notified/promoted.
                const wlGroupId = regs.find((r) => r.waitlisted)?.waitlistGroupId ?? undefined;
                const wlPos = wlGroupId ? waitlistPosition(wlGroupId, db.waitlistGroups ?? []) : undefined;
                const summary = regSummary(a.id);
                return (
                  <tr key={a.id}>
                    <td><strong>{a.firstName} {a.lastName}</strong></td>
                    <td style={{ fontSize: 13 }}>{summary}</td>
                    <td style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {anyRefundReq
                        ? <Badge tone="warn">Refund requested</Badge>
                        : allRefunded
                          ? null
                          : allWaitlisted
                            ? <Badge tone="info">Waitlisted</Badge>
                            : anyUpdatedPending
                              ? <Badge tone="warn">Updated pending purchase</Badge>
                              : anyUnpaid
                                ? <Badge tone="warn">Pending purchase</Badge>
                                : <Badge tone="ok">Registered</Badge>}
                      {!allWaitlisted && anyWaitlisted && <Badge tone="info">Partly waitlisted</Badge>}
                      {anyWaitlisted && wlPos !== undefined && (
                        <span style={{ fontSize: 12, color: 'var(--ink-soft)', alignSelf: 'center' }}>#{wlPos} in line</span>
                      )}
                      {anyRefunded && <Badge tone="info">Refunded</Badge>}
                    </td>
                    {canManage && (
                      <td style={{ whiteSpace: 'nowrap', display: 'flex', gap: 6 }}>
                        {!regClosed && canStillEdit && (
                          <button
                            className="btn small ghost"
                            onClick={() => setEditingAthleteId(a.id)}
                          >
                            Edit
                          </button>
                        )}
                        {!regClosed && !canStillEdit && (
                          <span
                            style={{ fontSize: 12, color: 'var(--ink-soft)' }}
                            data-tip="This event's edit deadline has passed; only an admin or the host club can still edit."
                          >
                            Edit locked
                          </span>
                        )}
                        {anyPaidRefundable && (
                          <button
                            className="btn small ghost"
                            style={{ color: 'var(--coral-500)' }}
                            onClick={() => openRefundDialog(a.id)}
                          >
                            Request refund
                          </button>
                        )}
                        {anyWaitlisted && (
                          <button
                            className="btn small ghost"
                            style={{ color: 'var(--coral-500)' }}
                            onClick={() => leaveWaitlist(a.id)}
                          >
                            Leave waitlist
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
          <h3 className="card-title">No athlete membership ({withoutMembership.length})</h3>
          <p style={{ fontSize: 13, color: 'var(--ink-soft)', marginBottom: 12 }}>
            These athletes need an active ATHLETE membership before they can register for an event — a coach
            membership alone doesn't qualify.{' '}
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
                    const to = effectivePeople.find((p) => p.id === toId);
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
            allAthletes={effectivePeople.filter((p) => p.kind === 'athlete')}
            levels={db.levels}
            season={season}
            onSave={(regs) => saveRegs(editingAthlete.id, regs)}
            onCancel={() => setEditingAthleteId(null)}
            changeFeeApplies={changeFeeApplies}
            incomingPartnerId={findIncomingSynchroPartner(eventRegs, event.id, editingAthlete.id)?.athleteId ?? null}
            incomingPartnerSyLevel={(() => {
              const r = findIncomingSynchroPartner(eventRegs, event.id, editingAthlete.id);
              return r ? (r.apparatusLevels?.SY ?? r.levelId) : null;
            })()}
            isAdmin={caps.isAdmin}
            allEventRegs={eventRegs.filter((r) => !r.refunded)}
            waitlistGroups={db.waitlistGroups?.filter((g) => g.eventId === event.id) ?? []}
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
            allAthletes={effectivePeople.filter((p) => p.kind === 'athlete')}
            levels={db.levels}
            season={season}
            onSave={(regs) => addToCart(registerAthlete.id, regs)}
            onCancel={() => setRegisterAthleteId(null)}
            incomingPartnerId={findIncomingSynchroPartner(eventRegs, event.id, registerAthlete.id)?.athleteId ?? null}
            incomingPartnerSyLevel={(() => {
              const r = findIncomingSynchroPartner(eventRegs, event.id, registerAthlete.id);
              return r ? (r.apparatusLevels?.SY ?? r.levelId) : null;
            })()}
            allEventRegs={eventRegs.filter((r) => !r.refunded)}
            waitlistGroups={db.waitlistGroups?.filter((g) => g.eventId === event.id) ?? []}
          />
        </Modal>
      )}

      {refundTarget && (
        <RefundRequestDialog
          items={refundTarget}
          event={event}
          clubId={clubId}
          onClose={() => setRefundTarget(null)}
          onSubmitted={() => { /* store refresh happens inside the dialog via syncFromSupabase() */ }}
        />
      )}
    </div>
  );
}
