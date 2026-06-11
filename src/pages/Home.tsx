import { Link } from 'react-router-dom';
import { useDB, useRole, PERSONA } from '../lib/store';
import { Stat, Badge, useFmtDate } from '../components/ui';
import { fmtMoney } from '../lib/scoring';

export function Home() {
  const role = useRole();
  const db = useDB();
  const fmtDate = useFmtDate();
  const season = db.seasons.find((s) => s.current)!;
  const activeMembers = db.people.filter((p) => p.memberships.some((m) => m.seasonId === season.id && m.status === 'active'));
  const pendingMembers = db.people.filter((p) => p.memberships.some((m) => m.seasonId === season.id && m.status === 'pending-club-payment'));
  const openMeets = db.meets.filter((m) => m.status === 'reg-open');
  const liveMeets = db.meets.filter((m) => m.status === 'in-progress');

  const hero = (
    <div className="card" style={{ background: 'var(--navy-800)', color: 'var(--white)', border: 'none', overflow: 'hidden', position: 'relative', marginBottom: 24 }}>
      <div className="card-pad" style={{ padding: '34px 28px' }}>
        <div className="display" style={{ fontSize: 'clamp(30px, 5vw, 54px)', maxWidth: 600 }}>
          For the love<br />of the sport<span style={{ color: 'var(--coral-500)' }}>.</span>
        </div>
        <p style={{ color: 'var(--ice-300)', maxWidth: 520, marginTop: 12 }}>
          The UCG registration & scoring platform — membership, meet registration,
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

  return (
    <div>
      {hero}

      {role === 'admin' && (
        <>
          <div className="grid cols-4" style={{ marginBottom: 16 }}>
            <Stat value={activeMembers.length} label={`Active members · ${season.name}`} accent />
            <Stat value={pendingMembers.length} label="Pending club payment" />
            <Stat value={db.clubs.length} label="Clubs" />
            <Stat value={db.meets.length} label="Meets this season" />
          </div>
          <div className="grid cols-2">
            <div className="card card-pad">
              <h3 className="card-title">Needs attention</h3>
              <AttentionList />
            </div>
            <div className="card card-pad">
              <h3 className="card-title">Meets</h3>
              <MeetList />
            </div>
          </div>
        </>
      )}

      {role === 'club-manager' && <ClubManagerHome />}

      {role === 'athlete' && <AthleteHome />}

      {role === 'judge' && (
        <div className="grid cols-2">
          <div className="card card-pad">
            <h3 className="card-title">Your assignment</h3>
            <p style={{ marginTop: 0 }}>
              <strong>{liveMeets[0]?.name ?? 'No live meet'}</strong>
              {liveMeets[0] && <> — panel judge. Open the score entry pad to begin.</>}
            </p>
            <Link className="btn primary" to="/judge">Open score entry →</Link>
          </div>
          <div className="card card-pad">
            <h3 className="card-title">Built-in calculators</h3>
            <p style={{ marginTop: 0, color: 'var(--ink-soft)' }}>
              Score entry uses the UCG start-value calculators (MAG SV, Masters, WAG Open) so SV
              errors get caught at entry time and routine composition is captured for every athlete.
            </p>
          </div>
        </div>
      )}

      {role === 'meet-host' && <HostHome />}

      {role === 'spectator' && (
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
      )}

      {(role === 'admin' || role === 'club-manager') && openMeets.length > 0 && (
        <div className="card card-pad" style={{ marginTop: 16, borderLeft: '4px solid var(--coral-500)' }}>
          <strong>Registration open:</strong> {openMeets.map((m) => (
            <Link key={m.id} to={`/meets/${m.slug}`} style={{ marginLeft: 8 }}>{m.name} (closes {fmtDate(m.regCloses.slice(0, 10))})</Link>
          ))}
        </div>
      )}
    </div>
  );
}

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

function AttentionList() {
  const db = useDB();
  const season = db.seasons.find((s) => s.current)!;
  const items: { msg: string; to: string }[] = [];
  for (const club of db.clubs) {
    const coaches = db.people.filter((p) => p.kind === 'coach' && p.mainClubId === club.id
      && p.memberships.some((m) => m.seasonId === season.id && m.status === 'active'));
    if (coaches.length === 0) items.push({ msg: `${club.shortName} has no coach with an active membership`, to: `/club/${club.id}` });
    const pending = db.people.filter((p) => p.mainClubId === club.id
      && p.memberships.some((m) => m.seasonId === season.id && m.status === 'pending-club-payment'));
    if (pending.length > 0) items.push({ msg: `${club.shortName}: ${pending.length} membership${pending.length > 1 ? 's' : ''} awaiting club payment`, to: `/club/${club.id}/cart` });
  }
  return (
    <div>
      {items.slice(0, 7).map((it, i) => (
        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '7px 0', borderBottom: '1px solid var(--line)', fontSize: 14 }}>
          <span>⚠ {it.msg}</span>
          <Link to={it.to} style={{ whiteSpace: 'nowrap', fontWeight: 600 }}>View →</Link>
        </div>
      ))}
      {items.length === 0 && <p style={{ color: 'var(--ink-soft)' }}>All clear.</p>}
    </div>
  );
}

function MeetList() {
  const db = useDB();
  const fmtDate = useFmtDate();
  return (
    <table className="tbl">
      <tbody>
        {db.meets.map((m) => (
          <tr key={m.id}>
            <td><Link to={`/meets/${m.slug}`} style={{ fontWeight: 600 }}>{m.name}</Link><br />
              <span style={{ fontSize: 12.5, color: 'var(--ink-soft)' }}>{m.city}, {m.state} · {fmtDate(m.startDate)}</span></td>
            <td style={{ textAlign: 'right' }}><MeetStatusBadge status={m.status} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ClubManagerHome() {
  const db = useDB();
  const club = db.clubs.find((c) => c.id === PERSONA.clubId)!;
  const season = db.seasons.find((s) => s.current)!;
  const roster = db.people.filter((p) => p.mainClubId === club.id);
  const active = roster.filter((p) => p.memberships.some((m) => m.seasonId === season.id && m.status === 'active'));
  const cart = db.carts[club.id] ?? [];
  const cartTotal = cart.reduce((s, i) => s + i.amount, 0);
  return (
    <>
      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <Stat value={roster.length} label="Roster" />
        <Stat value={active.length} label="Active members" accent />
        <Stat value={roster.length - active.length} label="Without membership" />
        <Stat value={fmtMoney(cartTotal)} label="In club cart" />
      </div>
      <div className="grid cols-2">
        <div className="card card-pad">
          <h3 className="card-title">{club.name}</h3>
          <p style={{ marginTop: 0, color: 'var(--ink-soft)' }}>Manage your roster, register the team for meets, and settle the club cart.</p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Link className="btn primary" to={`/club/${club.id}`}>Roster & meet reg →</Link>
            <Link className="btn ghost" to={`/club/${club.id}/cart`}>Club cart ({cart.length})</Link>
          </div>
        </div>
        <div className="card card-pad">
          <h3 className="card-title">Meets</h3>
          <MeetList />
        </div>
      </div>
    </>
  );
}

function AthleteHome() {
  const db = useDB();
  const fmtDate = useFmtDate();
  const me = db.people.find((p) => p.id === PERSONA.athleteId)!;
  const season = db.seasons.find((s) => s.current)!;
  const membership = me.memberships.find((m) => m.seasonId === season.id);
  const myRegs = db.registrations.filter((r) => r.athleteId === me.id && !r.refunded);
  return (
    <div className="grid cols-2">
      <div className="card card-pad">
        <h3 className="card-title">Hi {me.firstName} 👋</h3>
        {membership?.status === 'active' ? (
          <p style={{ marginTop: 0 }}><Badge tone="ok">✓ {season.name} member</Badge>&nbsp; Waiver signed {membership.waiverSignedAt?.slice(0, 10)}.</p>
        ) : (
          <p style={{ marginTop: 0 }}><Badge tone="err">No membership</Badge>&nbsp; You need a {season.name} membership to register for meets.</p>
        )}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link className="btn primary" to="/membership">{membership?.status === 'active' ? 'View membership' : 'Purchase membership →'}</Link>
          <Link className="btn ghost" to="/me">Edit profile</Link>
        </div>
      </div>
      <div className="card card-pad">
        <h3 className="card-title">My meets</h3>
        {myRegs.length === 0 && <p style={{ color: 'var(--ink-soft)' }}>Not registered for any meets yet.</p>}
        {[...new Set(myRegs.map((r) => r.meetId))].map((mid) => {
          const meet = db.meets.find((m) => m.id === mid)!;
          const regs = myRegs.filter((r) => r.meetId === mid);
          return (
            <div key={mid} style={{ padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
              <Link to={`/meets/${meet.slug}`} style={{ fontWeight: 600 }}>{meet.name}</Link>
              <div style={{ fontSize: 13, color: 'var(--ink-soft)' }}>
                {fmtDate(meet.startDate)} · {regs.map((r) => `${r.discipline} (${r.events.join(', ')})`).join(' + ')}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function HostHome() {
  const db = useDB();
  const meet = db.meets.find((m) => m.id === 'meet-mw26')!;
  const regs = db.registrations.filter((r) => r.meetId === meet.id && !r.refunded);
  const scores = db.scores.filter((s) => s.meetId === meet.id);
  return (
    <>
      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <Stat value={regs.length} label="Registrations" accent />
        <Stat value={[...new Set(regs.map((r) => r.clubId))].length} label="Clubs attending" />
        <Stat value={meet.sessions.length} label="Sessions" />
        <Stat value={scores.length} label="Scores posted" />
      </div>
      <div className="card card-pad">
        <h3 className="card-title">{meet.name} — host dashboard</h3>
        <p style={{ marginTop: 0, color: 'var(--ink-soft)' }}>Host club athletes register free. Manage sessions, squads and the live meet from one place.</p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link className="btn primary" to={`/meets/${meet.slug}/manage`}>Manage meet →</Link>
          <Link className="btn ghost" to={`/results/${meet.slug}`}>Live results</Link>
        </div>
      </div>
    </>
  );
}
