import { Link } from 'react-router-dom';
import { useDB } from '../lib/store';
import { useCapabilities } from '../lib/capabilities';
import { Stat, Badge, useFmtDate } from '../components/ui';
import { fmtMoney } from '../lib/scoring';

// ── helpers ────────────────────────────────────────────────────────────────

/** Return true if the person was under 18 as of today based on their dob. */
function isUnder18(dob: string): boolean {
  const today = new Date();
  const birth = new Date(dob);
  const age = today.getFullYear() - birth.getFullYear()
    - (today < new Date(today.getFullYear(), birth.getMonth(), birth.getDate()) ? 1 : 0);
  return age < 18;
}

// ── shared sub-components ──────────────────────────────────────────────────

export function MeetStatusBadge({ status }: { status: string }) {
  const map: Record<string, { tone: 'ok' | 'warn' | 'err' | 'info' | 'navy'; label: string }> = {
    'draft': { tone: 'info', label: 'Draft' },
    'reg-open': { tone: 'ok', label: 'Reg open' },
    'reg-closed': { tone: 'warn', label: 'Reg closed' },
    'in-progress': { tone: 'err', label: '● Live' },
    'complete': { tone: 'navy', label: 'Final' },
  };
  const m = map[status] ?? map.draft;
  return <Badge tone={m.tone}>{m.label}</Badge>;
}

function MeetList() {
  const db = useDB();
  const fmtDate = useFmtDate();
  return (
    <table className="tbl">
      <tbody>
        {db.meets.map((m) => (
          <tr key={m.id}>
            <td>
              <Link to={`/meets/${m.slug}`} style={{ fontWeight: 600 }}>{m.name}</Link><br />
              <span style={{ fontSize: 12.5, color: 'var(--ink-soft)' }}>{m.city}, {m.state} · {fmtDate(m.startDate)}</span>
            </td>
            <td style={{ textAlign: 'right' }}><MeetStatusBadge status={m.status} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Meets currently open for registration, shown as a highlight strip. */
function OpenMeetsStrip() {
  const db = useDB();
  const fmtDate = useFmtDate();
  const openMeets = db.meets.filter((m) => m.status === 'reg-open');
  if (openMeets.length === 0) return null;
  return (
    <div className="card card-pad" style={{ marginTop: 16, borderLeft: '4px solid var(--coral-500)' }}>
      <strong>Registration open:</strong>{' '}
      {openMeets.map((m, i) => (
        <span key={m.id}>
          {i > 0 && <span style={{ color: 'var(--ink-soft)' }}> · </span>}
          <Link to={`/meets/${m.slug}`}>{m.name}</Link>
          <span style={{ color: 'var(--ink-soft)', fontSize: 13 }}> (closes {fmtDate(m.regCloses.slice(0, 10))})</span>
        </span>
      ))}
    </div>
  );
}

// ── hero banner ────────────────────────────────────────────────────────────

function Hero() {
  const db = useDB();
  const liveMeets = db.meets.filter((m) => m.status === 'in-progress');
  return (
    <div className="card" style={{ background: 'var(--navy-800)', color: 'var(--white)', border: 'none', overflow: 'hidden', position: 'relative', marginBottom: 24 }}>
      <div className="card-pad" style={{ padding: '34px 28px' }}>
        <div className="display" style={{ fontSize: 'clamp(30px, 5vw, 54px)', maxWidth: 600 }}>
          For the love<br />of the sport<span style={{ color: 'var(--coral-500)' }}>.</span>
        </div>
        <p style={{ color: 'var(--ice-300)', maxWidth: 520, marginTop: 12 }}>
          The UCG registration &amp; scoring platform — membership, meet registration,
          live scoring, and results in one place. This is a working prototype seeded with demo data.
        </p>
        {liveMeets.length > 0 && (
          <Link to="/results" className="btn primary" style={{ marginTop: 8 }}>
            <span className="pulse" /> {liveMeets[0].name} is live — watch results
          </Link>
        )}
      </div>
      <div className="display" aria-hidden style={{ position: 'absolute', right: -30, bottom: -42, fontSize: 190, color: 'rgba(244,105,73,0.14)', pointerEvents: 'none' }}>UCG</div>
    </div>
  );
}

// ── admin dashboard ────────────────────────────────────────────────────────

function AdminAttentionList() {
  const db = useDB();
  const season = db.seasons.find((s) => s.current)!;

  // Under-18 athletes with a current-season membership but no waiver
  const pendingWaivers = db.people.filter((p) => {
    if (!isUnder18(p.dob)) return false;
    const mem = p.memberships.find((m) => m.seasonId === season.id && m.status === 'active');
    return mem && !mem.waiverSignedAt;
  });

  // Clubs with pending cart items
  const clubsWithCart = db.clubs.filter((c) => {
    const cart = db.carts[c.id] ?? [];
    return cart.length > 0;
  });

  // Clubs with no coach with active membership
  const clubsNoCoach = db.clubs.filter((club) => {
    const coaches = db.people.filter((p) => p.kind === 'coach' && p.mainClubId === club.id
      && p.memberships.some((m) => m.seasonId === season.id && m.status === 'active'));
    return coaches.length === 0;
  });

  // Pending club payment memberships
  const pendingPayment = db.people.filter((p) =>
    p.memberships.some((m) => m.seasonId === season.id && m.status === 'pending-club-payment')
  );

  const items: { msg: string; to: string }[] = [
    ...pendingWaivers.map((p) => ({
      msg: `Under-18 waiver needed: ${p.firstName} ${p.lastName}`,
      to: `/people/${p.id}`,
    })),
    ...clubsNoCoach.map((c) => ({
      msg: `${c.shortName} has no coach with an active membership`,
      to: `/club/${c.id}`,
    })),
    ...pendingPayment.length > 0 ? [{
      msg: `${pendingPayment.length} membership${pendingPayment.length > 1 ? 's' : ''} awaiting club payment`,
      to: '/admin/memberships',
    }] : [],
    ...clubsWithCart.map((c) => {
      const cart = db.carts[c.id] ?? [];
      return {
        msg: `${c.shortName}: ${cart.length} item${cart.length > 1 ? 's' : ''} in club cart`,
        to: `/club/${c.id}/cart`,
      };
    }),
  ];

  return (
    <div>
      {items.slice(0, 10).map((it, i) => (
        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '7px 0', borderBottom: '1px solid var(--line)', fontSize: 14 }}>
          <span>⚠ {it.msg}</span>
          <Link to={it.to} style={{ whiteSpace: 'nowrap', fontWeight: 600 }}>View →</Link>
        </div>
      ))}
      {items.length === 0 && <p style={{ color: 'var(--ink-soft)' }}>All clear.</p>}
      {items.length > 10 && (
        <p style={{ fontSize: 13, color: 'var(--ink-soft)', marginTop: 8 }}>
          +{items.length - 10} more — <Link to="/admin/memberships">view all</Link>
        </p>
      )}
    </div>
  );
}

function AdminDashboard() {
  const db = useDB();
  const season = db.seasons.find((s) => s.current)!;

  const activeMembers = db.people.filter((p) =>
    p.memberships.some((m) => m.seasonId === season.id && m.status === 'active')
  );
  const clubsWithMembership = db.clubs.filter((c) =>
    db.people.some((p) => p.mainClubId === c.id && p.memberships.some((m) => m.seasonId === season.id && m.status === 'active'))
  );
  const meetsThisSeason = db.meets.length;

  return (
    <>
      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <Stat value={activeMembers.length} label={`Active members · ${season.name}`} accent />
        <Stat value={db.clubs.length} label="Clubs" />
        <Stat value={clubsWithMembership.length} label="Clubs with members" />
        <Stat value={meetsThisSeason} label="Meets this season" />
      </div>
      <div className="grid cols-2">
        <div className="card card-pad">
          <h3 className="card-title">Needs attention</h3>
          <AdminAttentionList />
        </div>
        <div className="card card-pad">
          <h3 className="card-title">Meets</h3>
          <MeetList />
        </div>
      </div>
      <OpenMeetsStrip />
    </>
  );
}

// ── club manager dashboard ─────────────────────────────────────────────────

function ClubManagerCard({ clubId }: { clubId: string }) {
  const db = useDB();
  const fmtDate = useFmtDate();
  const season = db.seasons.find((s) => s.current)!;
  const club = db.clubs.find((c) => c.id === clubId);
  if (!club) return null;

  const roster = db.people.filter((p) => p.mainClubId === clubId);
  const active = roster.filter((p) => p.memberships.some((m) => m.seasonId === season.id && m.status === 'active'));
  const cart = db.carts[clubId] ?? [];
  const cartTotal = cart.reduce((s, i) => s + i.amount, 0);

  // Under-18 with active membership but no waiver
  const pendingWaivers = roster.filter((p) => {
    if (!isUnder18(p.dob)) return false;
    const mem = p.memberships.find((m) => m.seasonId === season.id && m.status === 'active');
    return mem && !mem.waiverSignedAt;
  });

  // Meets this club is registered for (at least one athlete reg from this club)
  const clubMeetIds = [...new Set(
    db.registrations.filter((r) => r.clubId === clubId && !r.refunded).map((r) => r.meetId)
  )];
  const clubMeets = db.meets.filter((m) => clubMeetIds.includes(m.id));

  return (
    <div className="card card-pad">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <h3 className="card-title" style={{ margin: 0 }}>{club.name}</h3>
        <Badge tone="navy">Club admin</Badge>
      </div>
      <div className="grid cols-4" style={{ margin: '12px 0' }}>
        <Stat value={roster.length} label="Roster" />
        <Stat value={active.length} label="Active members" accent />
        <Stat value={roster.length - active.length} label="No membership" />
        <Stat value={fmtMoney(cartTotal)} label="In cart" />
      </div>

      {(pendingWaivers.length > 0 || cart.length > 0) && (
        <div style={{ marginBottom: 12, padding: '10px 12px', background: 'var(--warn-50, #fff8f0)', borderRadius: 6, border: '1px solid var(--warn-200, #f9d87a)' }}>
          <strong style={{ fontSize: 13 }}>Needs attention</strong>
          {pendingWaivers.map((p) => (
            <div key={p.id} style={{ fontSize: 13, marginTop: 4 }}>
              ⚠ Under-18 waiver needed: <Link to={`/people/${p.id}`}>{p.firstName} {p.lastName}</Link>
            </div>
          ))}
          {cart.length > 0 && (
            <div style={{ fontSize: 13, marginTop: 4 }}>
              ⚠ {cart.length} item{cart.length > 1 ? 's' : ''} in club cart ({fmtMoney(cartTotal)}) —{' '}
              <Link to={`/club/${clubId}/cart`}>settle cart</Link>
            </div>
          )}
        </div>
      )}

      {clubMeets.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--ink-soft)', marginBottom: 6 }}>Registered meets</div>
          {clubMeets.map((m) => (
            <div key={m.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0', borderBottom: '1px solid var(--line)', fontSize: 14 }}>
              <span>
                <Link to={`/meets/${m.slug}`} style={{ fontWeight: 600 }}>{m.name}</Link>
                <span style={{ color: 'var(--ink-soft)', marginLeft: 8 }}>{fmtDate(m.startDate)}</span>
              </span>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <MeetStatusBadge status={m.status} />
                <Link to={`/meets/${m.slug}`} className="btn small ghost">Edit reg →</Link>
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Link className="btn primary" to={`/club/${clubId}`}>Roster &amp; meet reg →</Link>
        <Link className="btn ghost" to={`/club/${clubId}/cart`}>Club cart ({cart.length})</Link>
      </div>
    </div>
  );
}

function ClubManagerDashboard() {
  const caps = useCapabilities();
  const db = useDB();
  const season = db.seasons.find((s) => s.current)!;
  const me = caps.person;
  if (!me) return null;

  const membership = me.memberships.find((m) => m.seasonId === season.id);

  return (
    <>
      {/* Personal membership status */}
      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', justifyContent: 'space-between' }}>
          <div>
            <span style={{ fontWeight: 600 }}>Hi {me.firstName}</span>
            {membership?.status === 'active' ? (
              <span style={{ marginLeft: 10 }}><Badge tone="ok">✓ {season.name} member</Badge></span>
            ) : (
              <span style={{ marginLeft: 10 }}><Badge tone="err">No {season.name} membership</Badge></span>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Link className="btn small" to="/membership">
              {membership?.status === 'active' ? 'View membership' : 'Get membership →'}
            </Link>
            <Link className="btn small ghost" to="/me">Profile</Link>
          </div>
        </div>
      </div>

      {/* Per-club cards */}
      <div className={caps.managedClubIds.length > 1 ? 'grid cols-2' : ''} style={{ marginBottom: 16 }}>
        {caps.managedClubIds.map((cid) => (
          <ClubManagerCard key={cid} clubId={cid} />
        ))}
      </div>

      <OpenMeetsStrip />
    </>
  );
}

// ── athlete (general user) dashboard ──────────────────────────────────────

function AthleteDashboard() {
  const db = useDB();
  const fmtDate = useFmtDate();
  const caps = useCapabilities();
  const me = caps.person;
  const season = db.seasons.find((s) => s.current)!;
  if (!me) return null;

  const membership = me.memberships.find((m) => m.seasonId === season.id);
  const myRegs = db.registrations.filter((r) => r.athleteId === me.id && !r.refunded);
  const openMeets = db.meets.filter((m) => m.status === 'reg-open');

  // Clubs the athlete is associated with
  const mainClub = me.mainClubId ? db.clubs.find((c) => c.id === me.mainClubId) : null;
  const altClubs = me.altClubIds.map((id) => db.clubs.find((c) => c.id === id)).filter(Boolean);

  return (
    <>
      {/* Membership CTA — prominent if no membership */}
      {(!membership || membership.status !== 'active') && (
        <div className="card card-pad" style={{ marginBottom: 16, borderLeft: '4px solid var(--coral-500)' }}>
          <h3 className="card-title">Get your {season.name} membership</h3>
          <p style={{ marginTop: 0, color: 'var(--ink-soft)' }}>
            You need an active membership to register for meets and compete.
          </p>
          <Link className="btn primary" to="/membership">Register for membership →</Link>
        </div>
      )}

      <div className="grid cols-2">
        {/* Profile card */}
        <div className="card card-pad">
          <h3 className="card-title">Hi {me.firstName}</h3>
          {membership?.status === 'active' ? (
            <p style={{ marginTop: 0 }}>
              <Badge tone="ok">✓ {season.name} member</Badge>
              {membership.waiverSignedAt && (
                <span style={{ color: 'var(--ink-soft)', fontSize: 13, marginLeft: 8 }}>
                  Waiver signed {membership.waiverSignedAt.slice(0, 10)}
                </span>
              )}
            </p>
          ) : (
            <p style={{ marginTop: 0 }}>
              <Badge tone={membership?.status === 'pending-club-payment' ? 'warn' : 'err'}>
                {membership?.status === 'pending-club-payment' ? 'Pending club payment' : 'No membership'}
              </Badge>
            </p>
          )}

          {(mainClub || altClubs.length > 0) && (
            <div style={{ marginBottom: 12 }}>
              {mainClub && (
                <div style={{ fontSize: 14, marginBottom: 4 }}>
                  Club: <Link to={`/club/${mainClub.id}`}>{mainClub.name}</Link>
                </div>
              )}
              {altClubs.map((c) => c && (
                <div key={c.id} style={{ fontSize: 14, marginBottom: 4 }}>
                  Alt club: <Link to={`/club/${c.id}`}>{c.name}</Link>
                </div>
              ))}
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Link className="btn primary" to="/membership">
              {membership?.status === 'active' ? 'View membership' : 'Purchase membership →'}
            </Link>
            <Link className="btn ghost" to="/me">View profile</Link>
          </div>
        </div>

        {/* My meets & scores */}
        <div className="card card-pad">
          <h3 className="card-title">My meets &amp; scores</h3>
          {myRegs.length === 0 && (
            <p style={{ color: 'var(--ink-soft)' }}>Not registered for any meets yet.</p>
          )}
          {[...new Set(myRegs.map((r) => r.meetId))].map((mid) => {
            const meet = db.meets.find((m) => m.id === mid)!;
            const regs = myRegs.filter((r) => r.meetId === mid);
            const myScores = db.scores.filter((s) => regs.some((r) => r.id === s.regId));
            return (
              <div key={mid} style={{ padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Link to={`/meets/${meet.slug}`} style={{ fontWeight: 600 }}>{meet.name}</Link>
                  <MeetStatusBadge status={meet.status} />
                </div>
                <div style={{ fontSize: 13, color: 'var(--ink-soft)' }}>
                  {fmtDate(meet.startDate)} · {regs.map((r) => `${r.discipline} (${r.events.join(', ')})`).join(' + ')}
                </div>
                {myScores.length > 0 && (
                  <div style={{ fontSize: 13, marginTop: 4, display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    {myScores.map((s) => (
                      <Link key={s.id} to={`/scores/${encodeURIComponent(s.id)}`}>
                        {s.event}: <strong>{s.final?.toFixed(3)}</strong>
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Open meets available to register for */}
      {openMeets.length > 0 && (
        <div className="card card-pad" style={{ marginTop: 16 }}>
          <h3 className="card-title">Open for registration</h3>
          <div className="grid cols-2">
            {openMeets.map((m) => (
              <div key={m.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--line)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
                  <Link to={`/meets/${m.slug}`} style={{ fontWeight: 600 }}>{m.name}</Link>
                  <MeetStatusBadge status={m.status} />
                </div>
                <p style={{ color: 'var(--ink-soft)', margin: '4px 0 8px', fontSize: 13 }}>
                  {m.city}, {m.state} · {fmtDate(m.startDate)}
                </p>
                {caps.canRegister ? (
                  <Link className="btn small primary" to={`/meets/${m.slug}`}>Register →</Link>
                ) : (
                  <span style={{ fontSize: 13, color: 'var(--ink-soft)' }}>Membership required to register</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

// ── guest view ─────────────────────────────────────────────────────────────

function GuestView() {
  const db = useDB();
  const fmtDate = useFmtDate();
  return (
    <>
      <div className="grid cols-2" style={{ marginBottom: 16 }}>
        <div className="card card-pad">
          <h3 className="card-title">Get started</h3>
          <p style={{ color: 'var(--ink-soft)', marginTop: 0 }}>
            Sign in or create an account to purchase a membership and register for meets.
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Link className="btn primary" to="/login">Sign in</Link>
            <Link className="btn ghost" to="/membership">Learn about membership</Link>
          </div>
        </div>
        <div className="card card-pad">
          <h3 className="card-title">Upcoming meets</h3>
          {db.meets.filter((m) => m.status !== 'complete').slice(0, 4).map((m) => (
            <div key={m.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--line)', fontSize: 14 }}>
              <span>
                <Link to={`/results/${m.slug}`} style={{ fontWeight: 600 }}>{m.name}</Link>
                <span style={{ color: 'var(--ink-soft)', marginLeft: 8 }}>{m.city}, {m.state} · {fmtDate(m.startDate)}</span>
              </span>
              <MeetStatusBadge status={m.status} />
            </div>
          ))}
        </div>
      </div>
      <div className="grid cols-2">
        {db.meets.map((m) => (
          <div className="card card-pad" key={m.id}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
              <h3 style={{ fontSize: 18 }}>{m.name}</h3>
              <MeetStatusBadge status={m.status} />
            </div>
            <p style={{ color: 'var(--ink-soft)', margin: '6px 0 14px' }}>
              {m.city}, {m.state} · {fmtDate(m.startDate)}
            </p>
            <Link className="btn small" to={`/results/${m.slug}`}>View results</Link>
          </div>
        ))}
      </div>
    </>
  );
}

// ── main export ────────────────────────────────────────────────────────────

export function Home() {
  const caps = useCapabilities();

  return (
    <div>
      <Hero />

      {/* Admin (real admin, not impersonating) */}
      {caps.actingAsAdmin && <AdminDashboard />}

      {/* Club manager (not acting as admin — includes admin-impersonating-manager) */}
      {!caps.actingAsAdmin && caps.managedClubIds.length > 0 && <ClubManagerDashboard />}

      {/* General athlete (signed in, no managed clubs, not acting-admin) */}
      {!caps.actingAsAdmin && caps.managedClubIds.length === 0 && caps.person && <AthleteDashboard />}

      {/* Guest */}
      {!caps.signedIn && <GuestView />}
    </div>
  );
}
