import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useDB, mutate, resetDemo } from '../lib/store';
import { Badge, Field, Tabs, useToast } from '../components/ui';
import { ClubForm } from '../components/ClubForm';
import { PersonForm } from '../components/PersonForm';
import { DISCIPLINES, STATE_REGIONS } from '../lib/types';
import type { Athlete, Club, Region } from '../lib/types';
import { fmtMoney } from '../lib/scoring';
import { isSupabaseConfigured, pushAll, pushSeason } from '../lib/supabase';

// ---------- Members ----------
export function AdminMembers() {
  const db = useDB();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | 'active' | 'pending' | 'none'>('all');
  const [editing, setEditing] = useState<Athlete | 'new' | null>(null);
  const season = db.seasons.find((s) => s.current)!;

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
        <button className="btn primary" style={{ marginLeft: 'auto' }} onClick={() => setEditing('new')}>+ New person</button>
      </div>
      <div className="card" style={{ overflow: 'hidden' }}>
        <table className="tbl">
          <thead><tr><th>Name</th><th>Type</th><th>Club</th><th>Region</th><th>Membership</th><th>Waiver</th><th /></tr></thead>
          <tbody>
            {rows.slice(0, 120).map((p) => {
              const m = p.memberships.find((x) => x.seasonId === season.id);
              const club = db.clubs.find((c) => c.id === p.mainClubId);
              return (
                <tr key={p.id}>
                  <td><Link to={`/admin/members/${p.id}`} style={{ fontWeight: 600 }}>{p.lastName}, {p.firstName}</Link></td>
                  <td>{p.kind === 'coach' ? <Badge tone="navy">Coach</Badge> : 'Athlete'}</td>
                  <td style={{ fontSize: 13.5 }}>{club?.name ?? <em>Independent</em>}</td>
                  <td>{club?.region ?? STATE_REGIONS[p.state] ?? 'Other'}</td>
                  <td>{m?.status === 'active' ? <Badge tone="ok">Active</Badge> : m?.status === 'pending-club-payment' ? <Badge tone="warn">Pending</Badge> : <Badge tone="err">None</Badge>}</td>
                  <td style={{ fontSize: 12.5 }}>{m?.waiverSignedAt ? `✓ ${m.waiverSignedAt.slice(0, 10)} by ${m.waiverSignedBy}` : '—'}</td>
                  <td><button className="btn small ghost" onClick={() => setEditing(p)}>Edit</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {editing && <PersonForm person={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

// ---------- Clubs ----------
export function AdminClubs() {
  const db = useDB();
  const season = db.seasons.find((s) => s.current)!;
  const [editing, setEditing] = useState<Club | 'new' | null>(null);
  return (
    <div>
      <h1 className="page-title display">Clubs</h1>
      <p className="page-sub">Flags show what each club is missing — contact them right from here.</p>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 14 }}>
        <button className="btn primary" onClick={() => setEditing('new')}>+ New club</button>
      </div>
      <div className="card" style={{ overflow: 'hidden' }}>
        <table className="tbl">
          <thead><tr><th>Club</th><th>Region</th><th className="num">Roster</th><th className="num">Active</th><th>Flags</th><th /></tr></thead>
          <tbody>
            {db.clubs.map((c) => {
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
  const [tab, setTab] = useState<'seasons' | 'levels' | 'regions' | 'waivers' | 'demo'>('seasons');
  return (
    <div>
      <h1 className="page-title display">League controls</h1>
      <p className="page-sub">Seasons, fees, levels, waivers, and regions — the knobs that drive everything else.</p>
      <Tabs
        tabs={[
          { id: 'seasons' as const, label: 'Seasons & fees' },
          { id: 'levels' as const, label: 'Levels' },
          { id: 'regions' as const, label: 'Regions' },
          { id: 'waivers' as const, label: 'Waivers' },
          { id: 'demo' as const, label: 'Demo tools' },
        ]}
        active={tab}
        onChange={setTab}
      />
      {tab === 'seasons' && <Seasons />}
      {tab === 'levels' && <Levels />}
      {tab === 'regions' && <Regions />}
      {tab === 'waivers' && <Waivers />}
      {tab === 'demo' && <DemoTools />}
    </div>
  );
}

function Seasons() {
  const db = useDB();
  const toast = useToast();
  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      <table className="tbl">
        <thead><tr><th>Season</th><th>Valid</th><th className="num">Athlete fee</th><th className="num">Coach fee</th><th>Purchasable</th><th>Current</th><th /></tr></thead>
        <tbody>
          {db.seasons.map((s) => (
            <tr key={s.id}>
              <td><strong>{s.name}</strong></td>
              <td style={{ fontSize: 13 }}>{s.startsOn} → {s.endsOn}</td>
              <td className="num">{fmtMoney(s.athleteFee)}</td>
              <td className="num">{fmtMoney(s.coachFee)}</td>
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
              <td>{s.current && <Badge tone="ok">Current</Badge>}</td>
              <td>
                {!db.seasons.some((x) => x.startsOn > s.startsOn) && (
                  <button className="btn small ghost" data-tip="Copy fees, waivers & levels into a new season" onClick={() => {
                    mutate((d) => {
                      const yr = +s.startsOn.slice(0, 4) + 1;
                      const next = { ...s, id: `s${yr - 1999}`, name: `${yr}–${String(yr + 1).slice(2)}`, startsOn: `${yr}-07-01`, endsOn: `${yr + 1}-06-30`, active: false, current: false };
                      d.seasons.push(next);
                      pushSeason(next);
                    });
                    toast('Season copied — update fees & waiver, then mark purchasable.');
                  }}>Copy → next year</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Levels() {
  const db = useDB();
  return (
    <div className="grid cols-3">
      {DISCIPLINES.map((disc) => (
        <div className="card card-pad" key={disc}>
          <h3 className="card-title">{disc}</h3>
          <table className="tbl">
            <thead><tr><th>Level</th><th className="num">SV max</th><th className="num">Vaults</th></tr></thead>
            <tbody>
              {db.levels.filter((l) => l.discipline === disc).sort((a, b) => a.order - b.order).map((l) => (
                <tr key={l.id}>
                  <td>{l.name}</td>
                  <td className="num">{l.svMax?.toFixed(1) ?? 'Open'}</td>
                  <td className="num">{l.vaults}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

function Regions() {
  const regions = [...new Set(Object.values(STATE_REGIONS))] as Region[];
  return (
    <div className="grid cols-4">
      {regions.map((r) => (
        <div className="card card-pad" key={r}>
          <h3 className="card-title">{r}</h3>
          <div style={{ fontSize: 13.5, lineHeight: 1.7 }}>
            {Object.entries(STATE_REGIONS).filter(([, reg]) => reg === r).map(([st]) => st).join(', ')}
          </div>
        </div>
      ))}
      <div className="card card-pad" style={{ borderStyle: 'dashed' }}>
        <h3 className="card-title">Other</h3>
        <p style={{ fontSize: 13.5, color: 'var(--ink-soft)' }}>Athletes training outside the US. Independent athletes are auto-introduced to their region's team based on training state.</p>
      </div>
    </div>
  );
}

function Waivers() {
  const toast = useToast();
  const waivers = ['Athlete', 'Coach', 'Judge', 'Other Floor Access'];
  return (
    <div className="grid cols-2">
      {waivers.map((w) => (
        <div className="card card-pad" key={w}>
          <h3 className="card-title">{w} waiver — 2025–26</h3>
          <p style={{ fontSize: 13.5, color: 'var(--ink-soft)', marginTop: 0 }}>Set per-season. E-signed with timestamp + signer recorded; minors route to a guardian.</p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn small ghost" onClick={() => toast('Waiver PDF upload (post-MVP).')}>Replace file</button>
            <button className="btn small" onClick={() => toast('Standalone waiver link generated — works even without membership, attaches to the account.')}>✉ Email waiver link</button>
          </div>
        </div>
      ))}
    </div>
  );
}

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
export function Communicate() {
  const db = useDB();
  const toast = useToast();
  const season = db.seasons.find((s) => s.current)!;
  const [aud, setAud] = useState({ athletes: true, coaches: false, managers: false, clubEmails: false, withMembership: 'any' as 'any' | 'with' | 'without' });
  const [regions, setRegions] = useState<Region[]>([]);
  const [channel, setChannel] = useState<'email' | 'sms'>('email');
  const allRegions = [...new Set(Object.values(STATE_REGIONS))] as Region[];

  const recipients = useMemo(() => db.people.filter((p) => {
    if (p.kind === 'athlete' && !aud.athletes) return false;
    if (p.kind === 'coach' && !aud.coaches && !aud.managers) return false;
    const has = p.memberships.some((m) => m.seasonId === season.id && m.status === 'active');
    if (aud.withMembership === 'with' && !has) return false;
    if (aud.withMembership === 'without' && has) return false;
    if (regions.length) {
      const club = db.clubs.find((c) => c.id === p.mainClubId);
      const r = club?.region ?? STATE_REGIONS[p.state] ?? 'Other';
      if (!regions.includes(r)) return false;
    }
    return true;
  }), [db, aud, regions, season.id]);

  return (
    <div style={{ maxWidth: 860 }}>
      <h1 className="page-title display">Communicate</h1>
      <p className="page-sub">HTML email and SMS to filtered groups — built to handle 2,000+ recipients, with meet/session targeting.</p>
      <div className="grid cols-2">
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
          <div className="stat-big stat-accent" style={{ fontSize: 26 }}>{recipients.length}</div>
          <div className="stat-label">recipients selected</div>
        </div>
        <div className="card card-pad">
          <h3 className="card-title">Message</h3>
          <Field label="Channel">
            <select className="input" value={channel} onChange={(e) => setChannel(e.target.value as 'email' | 'sms')}>
              <option value="email">Email (HTML supported)</option>
              <option value="sms">Text message</option>
            </select>
          </Field>
          {channel === 'email' && <Field label="Subject"><input type="text" placeholder="Nationals registration closes Friday!" /></Field>}
          <Field label={channel === 'email' ? 'Body (HTML formatting supported)' : 'Message (160 chars)'}>
            <textarea rows={6} placeholder={channel === 'email' ? '<h1>Hi {{first_name}}…</h1>' : 'UCG: Reg closes Friday…'} />
          </Field>
          <button className="btn primary" onClick={() => toast(`${channel === 'email' ? 'Email' : 'SMS'} queued to ${recipients.length} recipients (demo — nothing actually sent).`)}>
            Send to {recipients.length} →
          </button>
        </div>
      </div>
    </div>
  );
}
