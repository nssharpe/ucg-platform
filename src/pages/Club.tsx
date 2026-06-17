import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useDB, mutate } from '../lib/store';
import { useCapabilities } from '../lib/capabilities';
import { Badge, Combo, Field, Tabs, useToast, useFmtDate } from '../components/ui';
import { EVENTS } from '../lib/types';
import type { Athlete, Club, Discipline } from '../lib/types';
import { fmtMoney } from '../lib/scoring';
import { deleteRegistration, pushCart, pushClubManager, pushInvoice, pushMembership, pushPerson, pushRegistration } from '../lib/supabase';
import { ClubForm } from '../components/ClubForm';

export function ClubPage() {
  const { clubId } = useParams();
  const db = useDB();
  const caps = useCapabilities();
  const toast = useToast();
  const club = db.clubs.find((c) => c.id === clubId);
  const [tab, setTab] = useState<'roster' | 'meetreg'>('roster');
  const [editingClub, setEditingClub] = useState(false);
  if (!club) return <p>Club not found.</p>;

  // Gate edit powers on actingAsAdmin (not impersonating) OR being a club manager.
  const canManage = caps.actingAsAdmin || caps.managedClubIds.includes(club.id);

  // Is the signed-in user a member of this club but not a manager?
  const isMember = caps.personId
    ? (() => {
        const p = db.people.find((x) => x.id === caps.personId);
        return !!p && (p.mainClubId === club.id || p.altClubIds.includes(club.id));
      })()
    : false;
  const isManager = canManage;

  const rosterSize = db.people.filter((p) => p.mainClubId === club.id).length;

  const copyInviteLink = () => {
    const url = `${location.origin}${location.pathname}#/join?club=${club.id}`;
    navigator.clipboard.writeText(url).then(
      () => toast('Invite link copied to clipboard'),
      () => toast('Could not copy — your browser may require HTTPS or user gesture'),
    );
  };

  // Public manager display (everyone can see who manages the club)
  const managerNames = club.managerIds
    .map((id) => db.people.find((p) => p.id === id))
    .filter((p): p is Athlete => !!p)
    .map((p) => `${p.firstName} ${p.lastName}`);

  return (
    <div>
      <h1 className="page-title display">{club.name}</h1>
      <p className="page-sub">
        {club.shortName && club.shortName !== club.name && <><strong>{club.shortName}</strong> · </>}
        {club.state} · {club.region} region · <a href={`mailto:${club.email}`}>{club.email}</a> ·
        {rosterSize} member{rosterSize !== 1 ? 's' : ''}
        {caps.actingAsAdmin && <> · <Link to="/admin/clubs">all clubs</Link></>}
      </p>

      {/* Public read-only managers display */}
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
            <button className="btn ghost small" data-tip="Email your members a link to join UCG under this club" onClick={copyInviteLink}>Invite members</button>
          </>
        )}
        {/* Request manager access: shown to signed-in members who are not managers */}
        {!isManager && isMember && caps.personId && (
          <button
            className="btn ghost small"
            onClick={() => toast("Request sent — the club's managers and league admin have been notified.")}
          >
            Request manager access
          </button>
        )}
      </div>

      {canManage && <ClubManagers club={club} />}

      <Tabs
        tabs={[{ id: 'roster' as const, label: `Roster (${rosterSize})` }, { id: 'meetreg' as const, label: 'Meet registration' }]}
        active={tab}
        onChange={setTab}
      />
      {tab === 'roster' ? <Roster clubId={club.id} /> : <MeetRegGrid clubId={club.id} />}

      {editingClub && <ClubForm club={club} onClose={() => setEditingClub(false)} />}
    </div>
  );
}

/** Co-manage a club's managers — admins and the club's existing managers. */
// TODO: import coaches from Score Flippers (SF) — wires to a future SF importer endpoint
function ClubManagers({ club }: { club: Club }) {
  const db = useDB();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const managers = club.managerIds
    .map((id) => db.people.find((p) => p.id === id))
    .filter((p): p is Athlete => !!p);
  // Restrict to people who actually belong to this club (main or alt), excluding existing managers
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
      id, kind: 'coach', firstName: local, lastName: '(invited)', email: addr,
      dob: '', gender: 'Other', gradYear: 1900, studentStatus: 'Non-Student', shirt: '',
      country: 'USA', state: club.state ?? '', phone: '', mainClubId: club.id, altClubIds: [],
      levels: {}, emergency: { contact: '', relation: '', phone: '' }, dietary: [], dietaryNotes: '',
      memberships: [], achievements: [],
    };
    mutate((d) => { d.people.push(person); pushPerson(person); });
    addManager(id);
    setEmail('');
    toast('Invited coach added as a manager — they can claim the account by signing up with this email.');
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

function Roster({ clubId }: { clubId: string }) {
  const db = useDB();
  const caps = useCapabilities();
  const [search, setSearch] = useState('');
  const season = db.seasons.find((s) => s.current)!;
  const allRoster = db.people.filter((p) => p.mainClubId === clubId)
    .sort((a, b) => (a.kind + a.lastName).localeCompare(b.kind + b.lastName));
  const roster = search.trim()
    ? allRoster.filter((p) =>
        `${p.firstName} ${p.lastName}`.toLowerCase().includes(search.trim().toLowerCase()),
      )
    : allRoster;
  const lvlName = (id?: string) => db.levels.find((l) => l.id === id)?.name ?? '—';

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
            <th>Name</th><th>Type</th><th>Membership</th><th>WAG</th><th>MAG</th><th>T&T</th><th>Student</th>
          </tr>
        </thead>
        <tbody>
          {roster.map((p) => {
            const m = p.memberships.find((x) => x.seasonId === season.id);
            return (
              <tr key={p.id}>
                <td>
                  {caps.isAdmin
                    ? <Link to={`/admin/members/${p.id}`} style={{ fontWeight: 600 }}>{p.firstName} {p.lastName}</Link>
                    : <strong>{p.firstName} {p.lastName}</strong>}
                </td>
                <td>{p.kind === 'coach' ? <Badge tone="navy">Coach</Badge> : 'Athlete'}</td>
                <td>
                  {m?.status === 'active' ? <Badge tone="ok">✓ {season.name}</Badge>
                    : m?.status === 'pending-club-payment' ? <Badge tone="warn">Pending club $</Badge>
                    : <Badge tone="err">None</Badge>}
                </td>
                <td>{lvlName(p.levels.WAG)}</td>
                <td>{lvlName(p.levels.MAG)}</td>
                <td>{lvlName(p.levels.TNT)}</td>
                <td>{p.studentStatus === 'Student' ? '🎓' : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
    </div>
  );
}

/** Spec: "Meet reg shows full list of athletes with dropdown for level and checkboxes for events" */
function MeetRegGrid({ clubId }: { clubId: string }) {
  const db = useDB();
  const toast = useToast();
  const openMeets = db.meets.filter((m) => m.status === 'reg-open' || m.status === 'reg-closed');
  const [meetId, setMeetId] = useState(openMeets.find((m) => m.status === 'reg-open')?.id ?? openMeets[0]?.id);
  const meet = db.meets.find((m) => m.id === meetId);
  const [disc, setDisc] = useState<Discipline>('WAG');
  const season = db.seasons.find((s) => s.current)!;

  const athletes = useMemo(() => db.people.filter(
    (p) => p.kind === 'athlete' && p.mainClubId === clubId,
  ).sort((a, b) => a.lastName.localeCompare(b.lastName)), [db, clubId]);

  if (!meet) return <p>No meets accepting registration.</p>;
  const regClosed = meet.status !== 'reg-open';
  const events = EVENTS[disc];
  const levels = db.levels.filter((l) => l.discipline === disc);
  const regs = db.registrations.filter((r) => r.meetId === meet.id && r.clubId === clubId && r.discipline === disc && !r.refunded);
  const regFor = (athleteId: string) => regs.find((r) => r.athleteId === athleteId);
  const totals = events.map((ev) => regs.filter((r) => r.events.includes(ev.code)).length);

  const toggleEvent = (athleteId: string, ev: string) => {
    const reg = regFor(athleteId);
    const athlete = athletes.find((a) => a.id === athleteId)!;
    mutate((d) => {
      if (!reg) {
        const levelId = athlete.levels[disc] ?? levels[0].id;
        const session = meet.sessions.find((s) => s.discipline === disc && s.levelIds.includes(levelId))
          ?? meet.sessions.find((s) => s.discipline === disc);
        const created = {
          id: `reg-${Date.now()}-${athleteId}`, meetId: meet.id, athleteId, clubId,
          discipline: disc, levelId, events: [ev], sessionId: session?.id ?? null,
        };
        d.registrations.push(created);
        pushRegistration(created);
      } else {
        const r = d.registrations.find((x) => x.id === reg.id)!;
        r.events = r.events.includes(ev) ? r.events.filter((e) => e !== ev) : [...r.events, ev];
        if (r.events.length === 0) {
          d.registrations = d.registrations.filter((x) => x.id !== r.id);
          deleteRegistration(r.id);
        } else {
          pushRegistration(r);
        }
      }
    });
  };

  const setLevel = (athleteId: string, levelId: string) => {
    const reg = regFor(athleteId);
    mutate((d) => {
      if (reg) {
        const r = d.registrations.find((x) => x.id === reg.id)!;
        r.levelId = levelId;
        const session = meet.sessions.find((s) => s.discipline === disc && s.levelIds.includes(levelId));
        if (session) r.sessionId = session.id;
        pushRegistration(r);
      } else {
        const p = d.people.find((x) => x.id === athleteId)!;
        p.levels[disc] = levelId;
        pushPerson(p);
      }
    });
  };

  return (
    <div>
      <div className="grid cols-3" style={{ marginBottom: 14 }}>
        <Field label="Meet">
          <select className="input" value={meetId} onChange={(e) => setMeetId(e.target.value)}>
            {openMeets.map((m) => <option key={m.id} value={m.id}>{m.name}{m.status !== 'reg-open' ? ' (closed)' : ''}</option>)}
          </select>
        </Field>
        <Field label="Discipline">
          <select className="input" value={disc} onChange={(e) => setDisc(e.target.value as Discipline)}>
            {meet.disciplines.map((d) => <option key={d}>{d}</option>)}
          </select>
        </Field>
        <Field label="Entry fees">
          <div style={{ paddingTop: 8, fontSize: 14 }}>{fmtMoney(meet.entryFee)} first discipline · {fmtMoney(meet.secondDisciplineFee)} additional</div>
        </Field>
      </div>

      {regClosed && (
        <div className="card card-pad" style={{ borderLeft: '4px solid var(--coral-500)', marginBottom: 14 }}>
          Registration is closed for this meet. Changes require a league admin override (swaps, level changes, refund requests still route through admin approval).
        </div>
      )}

      <div className="card reg-grid-wrap">
        <table className="tbl reg-grid">
          <thead>
            <tr>
              <th>Athlete</th>
              <th>Membership</th>
              <th style={{ minWidth: 150 }}>Level</th>
              {events.map((ev) => <th key={ev.code} className="evt" data-tip={ev.name}>{ev.code}</th>)}
              <th className="evt">AA?</th>
            </tr>
          </thead>
          <tbody>
            {athletes.map((a) => {
              const m = a.memberships.find((x) => x.seasonId === season.id && x.status === 'active');
              const reg = regFor(a.id);
              const eligible = !!m;
              return (
                <tr key={a.id} style={!eligible ? { opacity: 0.55 } : undefined}>
                  <td><strong>{a.firstName} {a.lastName}</strong></td>
                  <td>{m ? <Badge tone="ok">✓</Badge> : <Badge tone="err">No membership</Badge>}</td>
                  <td>
                    <select
                      className="input"
                      style={{ padding: '5px 8px', fontSize: 13 }}
                      disabled={!eligible || regClosed}
                      value={reg?.levelId ?? a.levels[disc] ?? ''}
                      onChange={(e) => setLevel(a.id, e.target.value)}
                    >
                      <option value="" disabled>—</option>
                      {levels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                    </select>
                  </td>
                  {events.map((ev) => (
                    <td className="evt" key={ev.code}>
                      <input
                        type="checkbox"
                        disabled={!eligible || regClosed || (!reg && !(a.levels[disc] ?? levels[0]))}
                        checked={reg?.events.includes(ev.code) ?? false}
                        onChange={() => toggleEvent(a.id, ev.code)}
                      />
                    </td>
                  ))}
                  <td className="evt">{reg && reg.events.length === events.length ? '🏆' : ''}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={3} style={{ fontWeight: 700 }}>Team totals — {regs.length} athletes in {disc}</td>
              {totals.map((t, i) => <td key={i} className="evt" style={{ fontWeight: 700 }}>{t}</td>)}
              <td />
            </tr>
          </tfoot>
        </table>
      </div>

      <div style={{ display: 'flex', gap: 10, marginTop: 14, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          className="btn primary"
          disabled={regClosed || regs.length === 0}
          onClick={() => {
            mutate((d) => {
              const cart = d.carts[clubId] ?? (d.carts[clubId] = []);
              const already = new Set(cart.filter((c) => c.kind === 'meet-entry').map((c) => c.refUserId));
              for (const r of regs) {
                if (already.has(r.athleteId)) continue;
                const a = d.people.find((x) => x.id === r.athleteId)!;
                const otherDisc = d.registrations.some((x) => x.meetId === meet.id && x.athleteId === r.athleteId && x.discipline !== disc && !x.refunded);
                cart.push({
                  id: `ci-${Date.now()}-${r.athleteId}`,
                  label: `${meet.name} entry — ${a.firstName} ${a.lastName} (${disc})`,
                  amount: otherDisc ? meet.secondDisciplineFee : meet.entryFee,
                  kind: 'meet-entry', refUserId: r.athleteId,
                });
              }
              pushCart(clubId, cart, true);
            });
            toast(`Added ${regs.length} ${disc} entries to the club cart. Selections are saved locally as you click — no postbacks.`);
          }}
        >
          Add entries to club cart →
        </button>
        <button className="btn ghost" onClick={() => toast('Refund request sent to league admin for approval.')} data-tip="Refunds need admin approval; processing is automatic after that">Request refund…</button>
        <span style={{ fontSize: 13, color: 'var(--ink-soft)' }}>Every change autosaves. Swaps & level changes stay editable until reg closes.</span>
      </div>
    </div>
  );
}

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

  return (
    <div style={{ maxWidth: 820 }}>
      <h1 className="page-title display">{club.shortName} — Cart & invoices</h1>
      <p className="page-sub">Memberships pushed to the club, meet entries, and add-ons. Each membership is a separate line item so single refunds stay clean.</p>

      <div className="card card-pad" style={{ marginBottom: 18 }}>
        <h3 className="card-title">Club cart ({cart.length})</h3>
        {cart.length === 0 ? <p style={{ color: 'var(--ink-soft)' }}>Cart is empty.</p> : (
          <>
            <table className="tbl">
              <tbody>
                {cart.map((i) => (
                  <tr key={i.id}>
                    <td>{i.label} <Badge tone="info">{i.kind}</Badge></td>
                    <td className="num">{fmtMoney(i.amount)}</td>
                    <td style={{ width: 40 }}>
                      <button className="btn small ghost" data-tip="Remove from cart" onClick={() => mutate((d) => {
                        d.carts[club.id] = (d.carts[club.id] ?? []).filter((x) => x.id !== i.id);
                        pushCart(club.id, d.carts[club.id], true);
                      })}>✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div style={{ display: 'flex', gap: 14, alignItems: 'end', marginTop: 14, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 180 }}>
                <Field label="Coupon code"><input type="text" value={coupon} onChange={(e) => setCoupon(e.target.value)} placeholder="EARLYBIRD" /></Field>
              </div>
              <div style={{ textAlign: 'right', marginBottom: 14 }}>
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
                    // Activate any pending memberships paid by this checkout
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
          </>
        )}
      </div>

      <div className="card card-pad">
        <h3 className="card-title">Invoices & receipts</h3>
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
