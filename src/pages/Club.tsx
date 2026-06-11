import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useDB, mutate, useRole } from '../lib/store';
import { Badge, Field, Tabs, useToast, useFmtDate } from '../components/ui';
import { EVENTS } from '../lib/types';
import type { Discipline } from '../lib/types';
import { fmtMoney } from '../lib/scoring';

export function ClubPage() {
  const { clubId } = useParams();
  const db = useDB();
  const role = useRole();
  const club = db.clubs.find((c) => c.id === clubId);
  const [tab, setTab] = useState<'roster' | 'meetreg'>('roster');
  if (!club) return <p>Club not found.</p>;

  return (
    <div>
      <h1 className="page-title display">{club.name}</h1>
      <p className="page-sub">
        {club.state} · {club.region} region · <a href={`mailto:${club.email}`}>{club.email}</a> ·
        Unique club URL: <code>#/club/{club.id}</code>
        {role === 'admin' && <> · <Link to="/admin/clubs">all clubs</Link></>}
      </p>
      <div style={{ display: 'flex', gap: 8, marginBottom: 18, flexWrap: 'wrap' }}>
        <Link className="btn ghost small" to={`/club/${club.id}/cart`}>Club cart & invoices →</Link>
        <button className="btn ghost small" data-tip="Ask UCG to sanction a meet hosted by your club" onClick={() => alert('Sanction request form — wires to league admin approval queue (post-MVP).')}>Request meet sanction</button>
        <button className="btn ghost small" data-tip="Email your members a link to join UCG under this club" onClick={() => alert('Invite link copied! (demo)')}>Invite members</button>
      </div>
      <Tabs
        tabs={[{ id: 'roster' as const, label: `Roster (${db.people.filter((p) => p.mainClubId === club.id).length})` }, { id: 'meetreg' as const, label: 'Meet registration' }]}
        active={tab}
        onChange={setTab}
      />
      {tab === 'roster' ? <Roster clubId={club.id} /> : <MeetRegGrid clubId={club.id} />}
    </div>
  );
}

function Roster({ clubId }: { clubId: string }) {
  const db = useDB();
  const role = useRole();
  const season = db.seasons.find((s) => s.current)!;
  const roster = db.people.filter((p) => p.mainClubId === clubId)
    .sort((a, b) => (a.kind + a.lastName).localeCompare(b.kind + b.lastName));
  const lvlName = (id?: string) => db.levels.find((l) => l.id === id)?.name ?? '—';

  return (
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
                  {role === 'admin'
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
        d.registrations.push({
          id: `reg-${Date.now()}-${athleteId}`, meetId: meet.id, athleteId, clubId,
          discipline: disc, levelId, events: [ev], sessionId: session?.id ?? null,
        });
      } else {
        const r = d.registrations.find((x) => x.id === reg.id)!;
        r.events = r.events.includes(ev) ? r.events.filter((e) => e !== ev) : [...r.events, ev];
        if (r.events.length === 0) d.registrations = d.registrations.filter((x) => x.id !== r.id);
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
      } else {
        const p = d.people.find((x) => x.id === athleteId)!;
        p.levels[disc] = levelId;
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
                      <button className="btn small ghost" data-tip="Remove from cart" onClick={() => mutate((d) => { d.carts[club.id] = (d.carts[club.id] ?? []).filter((x) => x.id !== i.id); })}>✕</button>
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
                    d.invoices.push({
                      id: `inv-${Date.now()}`, number: `UCG-2026-${String(d.invoices.length + 1).padStart(4, '0')}`,
                      clubId: club.id, athleteId: null, createdAt: new Date().toISOString(), paidAt: new Date().toISOString(),
                      items: [...items], couponCode: couponDef?.code,
                    });
                    // Activate any pending memberships paid by this checkout
                    for (const item of items) {
                      if (item.kind === 'membership' && item.refUserId) {
                        const person = d.people.find((p) => p.id === item.refUserId);
                        const m = person?.memberships.find((x) => x.status === 'pending-club-payment');
                        if (m) { m.status = 'active'; m.paidVia = 'club'; }
                      }
                    }
                    d.carts[club.id] = [];
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
