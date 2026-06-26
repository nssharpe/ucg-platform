import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useDB, mutate } from '../lib/store';
import { useCapabilities } from '../lib/capabilities';
import { seasonForDate, clubHasActiveMembership, paidRegistrationClub } from '../lib/capabilities-core';
import { Badge, Field, Modal, Tabs } from '../components/ui';
import { useToast, useFmtDate } from '../components/ui-hooks';
import { MeetWizard } from '../components/MeetWizard';
import { RegistrationEditor } from '../components/RegistrationEditor';
import { MeetStatusBadge } from './Home';
import { EVENTS, SHIRT_SIZES } from '../lib/types';
import type { Athlete, CartItem, Meet, MeetSession, Registration } from '../lib/types';
import { deleteRegistration, pushCart, pushInvoice, pushMeet, pushMeetSessions, pushRegistration } from '../lib/supabase';
import { fmtMoney } from '../lib/scoring';
import { newRegistrationEntryTotal, registrationChangeFee } from '../lib/pricing';

export function Meets() {
  const db = useDB();
  const caps = useCapabilities();
  const fmtDate = useFmtDate();
  const [wizardOpen, setWizardOpen] = useState(false);
  return (
    <div>
      <h1 className="page-title display">Meets</h1>
      <p className="page-sub">Every meet gets its own unique URL, sessions, squads, and live results page.</p>
      {caps.isAdmin && (
        <button className="btn primary" style={{ marginBottom: 18 }} onClick={() => setWizardOpen(true)}>+ Sanction new meet</button>
      )}
      {wizardOpen && <MeetWizard onClose={() => setWizardOpen(false)} />}
      <div className="grid cols-3">
        {db.meets.map((m) => {
          const regs = db.registrations.filter((r) => r.meetId === m.id && !r.refunded);
          return (
            <div className="card card-pad" key={m.id} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <h3 style={{ fontSize: 17 }}><Link to={`/meets/${m.slug}`} style={{ textDecoration: 'none' }}>{m.name}</Link></h3>
                <MeetStatusBadge status={m.status} />
              </div>
              <div style={{ fontSize: 13.5, color: 'var(--ink-soft)' }}>
                {m.city}, {m.state} · {fmtDate(m.startDate)}<br />
                {m.disciplines.join(' · ')} · {regs.length} athletes · hosted by {db.clubs.find((c) => c.id === m.hostClubId)?.shortName}
              </div>
              <div style={{ marginTop: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <Link className="btn small" to={`/meets/${m.slug}`}>Details</Link>
                {(m.status === 'in-progress' || m.status === 'complete') && <Link className="btn small primary" to={`/results/${m.slug}`}>Results</Link>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Timezone abbreviation helper
// ---------------------------------------------------------------------------
function tzAbbrev(timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'short' })
      .formatToParts(new Date());
    return parts.find((p) => p.type === 'timeZoneName')?.value ?? timezone;
  } catch {
    return timezone;
  }
}

// ---------------------------------------------------------------------------
// MeetDetail
// ---------------------------------------------------------------------------
export function MeetDetail() {
  const { slug } = useParams();
  const db = useDB();
  const caps = useCapabilities();
  const toast = useToast();
  const fmtDate = useFmtDate();
  const meet = db.meets.find((m) => m.slug === slug);
  const [editWizardOpen, setEditWizardOpen] = useState(false);
  const [selfRegOpen, setSelfRegOpen] = useState(false);

  if (!meet) return <p>Meet not found.</p>;
  const host = db.clubs.find((c) => c.id === meet.hostClubId);
  const regs = db.registrations.filter((r) => r.meetId === meet.id && !r.refunded);
  const canManage = caps.isMeetHost(meet.id);
  const tz = tzAbbrev(meet.timezone);

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 className="page-title display">{meet.name}</h1>
          <p className="page-sub">
            {meet.city}, {meet.state} · {fmtDate(meet.startDate)}–{fmtDate(meet.endDate)} ({meet.timezone}) ·
            hosted by {host?.name} · <code>#/meets/{meet.slug}</code>
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <MeetStatusBadge status={meet.status} />
          {canManage && (
            <button className="btn small ghost" onClick={() => setEditWizardOpen(true)}>Edit meet</button>
          )}
        </div>
      </div>

      {editWizardOpen && <MeetWizard editMeet={meet} onClose={() => setEditWizardOpen(false)} />}

      <div className="grid cols-3" style={{ marginBottom: 18 }}>
        <div className="card card-pad">
          <h3 className="card-title">Registration</h3>
          <p style={{ margin: '0 0 8px', fontSize: 14 }}>
            Opens {fmtDate(meet.regOpens.slice(0, 10))} · closes <strong>{fmtDate(meet.regCloses.slice(0, 10))}</strong> ({tz})<br />
            {fmtMoney(meet.entryFee)} / discipline · {fmtMoney(meet.secondDisciplineFee)} each additional
            {meet.banquet && <><br />{meet.banquet.name}: {fmtMoney(meet.banquet.price)}</>}
            {meet.tshirtAddon && <><br />T-shirt: {fmtMoney(meet.tshirtAddon.price)}</>}
            {meet.bannerAddon && <><br />Club banner: {fmtMoney(meet.bannerAddon.price)}</>}
            {meet.changeFee && (
              <><br /><span style={{ color: 'var(--warn)' }}>Change fee {fmtMoney(meet.changeFee.amount)} after {new Date(meet.changeFee.startsAt).toLocaleDateString()}</span></>
            )}
          </p>
          {meet.status === 'reg-open' ? (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {caps.managedClubIds.length > 0 && (
                <Link className="btn primary small" to={`/club/${caps.managedClubIds[0]}`}>Register your club →</Link>
              )}
              {caps.canRegister && (
                <button className="btn primary small" onClick={() => setSelfRegOpen(true)}>Register yourself →</button>
              )}
              {!caps.canRegister && caps.managedClubIds.length === 0 && (
                <Badge tone="warn">Registration open</Badge>
              )}
            </div>
          ) : (
            <Badge tone="warn">Registration closed{caps.isAdmin ? ' — admin can override below' : ''}</Badge>
          )}
          {caps.isAdmin && meet.status !== 'reg-open' && (
            <div style={{ marginTop: 10, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button className="btn small ghost" onClick={() => { mutate((d) => { const m = d.meets.find((m) => m.id === meet.id)!; m.status = 'reg-open'; pushMeet(m); }); toast('Deadline overridden — registration re-opened.'); }}>Override: reopen reg</button>
              <button className="btn small ghost" data-tip="Generates a private reg link + password for late adds" onClick={() => toast(`Private link: ucg.org/#/meets/${meet.slug}?code=LATE26 (demo)`)}>Private reg link</button>
            </div>
          )}
        </div>
        <div className="card card-pad">
          <h3 className="card-title">Field</h3>
          <div className="stat-big stat-accent">{regs.length}</div>
          <div className="stat-label">registrations · {[...new Set(regs.map((r) => r.athleteId))].length} athletes · {[...new Set(regs.map((r) => r.clubId))].length} clubs</div>
        </div>
        <div className="card card-pad">
          <h3 className="card-title">Quick links</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <Link to={`/results/${meet.slug}`}>→ Live results</Link>
            {canManage && meet.kind === 'nationals' && (
              <Link to={`/meets/${meet.slug}/nationals`} style={{ fontWeight: 700 }}>→ Finals qualification &amp; awards</Link>
            )}
            {canManage && <Link to={`/meets/${meet.slug}/manage`}>→ Manage sessions & squads</Link>}
            {canManage && <Link to={`/judge?meet=${meet.id}`}>→ Score entry</Link>}
            {canManage && <a href="#" onClick={(e) => { e.preventDefault(); exportCsv(db, meet); }}>→ Export registrations (CSV)</a>}
            {canManage && <a href="#" onClick={(e) => { e.preventDefault(); exportScoresCsv(db, meet); }}>→ Export scores incl. calculator detail (CSV)</a>}
          </div>
        </div>
      </div>

      <div className="card" style={{ overflow: 'hidden' }}>
        <table className="tbl">
          <thead><tr><th>Session</th><th>Date</th><th>Levels</th><th className="num">Athletes</th><th className="num">Squads</th></tr></thead>
          <tbody>
            {meet.sessions.map((s) => (
              <tr key={s.id}>
                <td><strong>{s.name}</strong></td>
                <td>{fmtDate(s.date)} {s.time}</td>
                <td style={{ fontSize: 13 }}>{s.levelIds.map((l) => db.levels.find((x) => x.id === l)?.name).join(', ')}</td>
                <td className="num">{regs.filter((r) => r.sessionId === s.id).length}</td>
                <td className="num">{s.squads.filter((q) => !q.holding).length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Self-registration modal */}
      {selfRegOpen && caps.personId && (() => {
        const athlete = db.people.find((p) => p.id === caps.personId);
        if (!athlete) return null;
        return (
          <SelfRegModal
            meet={meet}
            athlete={athlete}
            onClose={() => setSelfRegOpen(false)}
            toast={toast}
          />
        );
      })()}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SelfRegModal — individual self-registration
// ---------------------------------------------------------------------------

interface SelfRegModalProps {
  meet: Meet;
  athlete: Athlete;
  onClose: () => void;
  toast: (msg: string, opts?: { variant?: 'info' | 'error' }) => void;
}

function SelfRegModal({ meet, athlete, onClose, toast }: SelfRegModalProps) {
  const db = useDB();

  // Clubs the athlete is affiliated with (main + alt)
  const myClubs = [
    ...(athlete.mainClubId ? [db.clubs.find((c) => c.id === athlete.mainClubId)] : []),
    ...athlete.altClubIds.map((id) => db.clubs.find((c) => c.id === id)),
  ].filter((c): c is NonNullable<typeof c> => !!c);

  // Cross-club lock (3d): if the athlete already has a PAID, non-refunded reg for
  // this meet under one of their clubs, they're locked to it — they can't compete
  // for a DIFFERENT club. (excludeClubId omitted ⇒ returns ANY paid-reg club.)
  const lockedClubId = paidRegistrationClub(db.registrations, {
    athleteId: athlete.id, meetId: meet.id,
  });
  const lockedClubShort = lockedClubId
    ? db.clubs.find((c) => c.id === lockedClubId)?.shortName ?? 'another club'
    : null;

  // Default to the locked club when one applies, else the athlete's first club.
  const [selectedClubId, setSelectedClubId] = useState(lockedClubId ?? myClubs[0]?.id ?? '');
  const [step, setStep] = useState<'reg' | 'addons'>('reg');
  // Add-on selections
  const [tshirtSize, setTshirtSize] = useState('');
  const [bannerText, setBannerText] = useState('');
  // Saved regs from editor (used in add-on step)
  const [pendingRegs, setPendingRegs] = useState<Registration[] | null>(null);

  const season = db.seasons.find((s) => s.current)!;
  const existingRegs = db.registrations.filter(
    (r) => r.meetId === meet.id && r.athleteId === athlete.id && !r.refunded,
  );

  const changeFeeApplies = !!(
    meet.changeFee && new Date() >= new Date(meet.changeFee.startsAt)
  );

  const hasAddons = !!(meet.tshirtAddon || meet.bannerAddon);

  // Called by RegistrationEditor when the athlete confirms their selections
  const handleRegSave = (regs: Registration[]) => {
    // Cross-club lock (3d): block registering under a DIFFERENT club than the one
    // this athlete is already paid-registered with. (Belt-and-suspenders for the
    // single-club case where the selector — and its disabled options — isn't shown.)
    if (lockedClubId && selectedClubId !== lockedClubId) {
      toast(`You're already registered with ${lockedClubShort} for this meet — you can't register under a different club. Edit your existing registration instead.`, { variant: 'error' });
      return;
    }
    // Gate: the competing club must hold an active membership for the meet's season.
    const seasonId = seasonForDate(db, meet.startDate);
    if (!clubHasActiveMembership(db, selectedClubId, seasonId)) {
      const sName = db.seasons.find((s) => s.id === seasonId)?.name ?? 'this season';
      const club = db.clubs.find((c) => c.id === selectedClubId);
      toast(`${club?.shortName ?? 'Your club'} needs an active ${sName} club membership before anyone can register for this meet. A club manager can purchase it on the club page.`, { variant: 'error' });
      return;
    }
    if (hasAddons) {
      setPendingRegs(regs);
      setStep('addons');
    } else {
      persistRegs(regs, [], []);
    }
  };

  const persistRegs = (regs: Registration[], tshirtItems: CartItem[], bannerItems: CartItem[]) => {
    let hostFree = false;
    mutate((d) => {
      const existingForAthlete = d.registrations.filter(
        (r) => r.meetId === meet.id && r.athleteId === athlete.id && !r.refunded,
      );
      const newDiscSet = new Set(regs.map((r) => r.discipline));
      const alreadyHadRegs = existingForAthlete.length > 0;
      const competingClubId = selectedClubId;

      // Disciplines already registered for that we are KEEPING (count toward
      // "second discipline" pricing for the ones being added now).
      const priorDisciplineCount = existingForAthlete.filter((r) => newDiscSet.has(r.discipline)).length;
      // Brand-new disciplines (not previously registered).
      const addedRegs = regs.filter((r) => !existingForAthlete.some((e) => e.discipline === r.discipline));

      // Entry total for the newly-added disciplines, host-club aware ($0 ⇒ free).
      const entryTotal = newRegistrationEntryTotal(meet, {
        competingClubId,
        priorDisciplineCount,
        newDisciplineCount: addedRegs.length,
      });
      const changeFee = changeFeeApplies && alreadyHadRegs
        ? registrationChangeFee(meet, { competingClubId })
        : 0;
      hostFree = !alreadyHadRegs && entryTotal === 0;

      // Remove dropped disciplines
      for (const old of existingForAthlete) {
        if (!newDiscSet.has(old.discipline)) {
          d.registrations = d.registrations.filter((r) => r.id !== old.id);
          deleteRegistration(old.id);
        }
      }

      // Upsert regs. New regs: paid=true when nothing is owed (host club / $0),
      // else paid=false ("Pending Purchase"). For a chargeable EDIT, flip any
      // previously-paid reg back to a re-pending state ("Updated pending
      // purchase") so paying the change fee restores it.
      const addedIds = new Set(addedRegs.map((r) => r.id));
      for (const reg of regs) {
        const prior = existingForAthlete.find((e) => e.id === reg.id);
        if (addedIds.has(reg.id) || !prior) {
          reg.paid = entryTotal === 0; // host-club / $0 ⇒ immediately registered
          reg.updatedPending = false;
        } else if (changeFee > 0 && prior.paid) {
          reg.paid = false;
          reg.updatedPending = true;
        } else {
          // Preserve prior payment state on a non-chargeable edit.
          reg.paid = prior.paid ?? false;
          reg.updatedPending = prior.updatedPending ?? false;
        }
        const idx = d.registrations.findIndex((r) => r.id === reg.id);
        if (idx >= 0) d.registrations[idx] = reg;
        else d.registrations.push(reg);
        pushRegistration(reg);
      }

      // Cart: entry / change fee for new or re-pending registrations.
      const cart = d.carts[athlete.id] ?? (d.carts[athlete.id] = []);

      if (!alreadyHadRegs && entryTotal > 0) {
        cart.push({
          id: `ci-self-${Date.now()}-${athlete.id}`,
          label: `${meet.name} entry — ${athlete.firstName} ${athlete.lastName} (${addedRegs.map((r) => r.discipline).join('+')})`,
          amount: entryTotal,
          kind: 'meet-entry',
          refUserId: athlete.id,
          refRegIds: addedRegs.map((r) => r.id),
          refMeetId: meet.id,
          refLineType: 'entry',
        });
      }
      if (changeFee > 0) {
        cart.push({
          id: `ci-change-${Date.now()}-${athlete.id}`,
          label: `${meet.name} change fee — ${athlete.firstName} ${athlete.lastName}`,
          amount: changeFee,
          kind: 'meet-entry',
          refUserId: athlete.id,
          refRegIds: regs.map((r) => r.id),
          refMeetId: meet.id,
          refLineType: 'change',
        });
      }

      // Add-on cart items
      for (const item of [...tshirtItems, ...bannerItems]) {
        cart.push(item);
      }

      pushCart(athlete.id, cart, false);

      // Create an unpaid invoice stub if anything is owed (paying individually).
      const allItems = [...cart];
      if (allItems.length > 0) {
        const invoice = {
          id: `inv-self-${Date.now()}`,
          number: `UCG-I-${Date.now()}`,
          clubId: null,
          athleteId: athlete.id,
          createdAt: new Date().toISOString(),
          paidAt: null,
          items: [...allItems],
        };
        d.invoices.push(invoice);
        pushInvoice(invoice);
      }
    });

    toast(
      hostFree
        ? 'Registration complete — no entry fee for your host club.'
        : changeFeeApplies
          ? 'Registration updated. Change fee added to your cart.'
          : 'Registration saved! Check your cart to complete payment.',
    );
    onClose();
  };

  const handleAddons = () => {
    if (!pendingRegs) return;
    const ts = Date.now();
    const tshirtItems: CartItem[] = [];
    const bannerItems: CartItem[] = [];

    if (meet.tshirtAddon && tshirtSize) {
      tshirtItems.push({
        id: `ci-tshirt-${ts}`,
        label: `${meet.name} t-shirt — ${athlete.firstName} ${athlete.lastName} (${tshirtSize})`,
        amount: meet.tshirtAddon.price,
        kind: 'addon',
        refUserId: athlete.id,
        refMeetId: meet.id,
        refLineType: 'tshirt',
      });
    }
    if (meet.bannerAddon && bannerText.trim()) {
      bannerItems.push({
        id: `ci-banner-${ts}`,
        label: `${meet.name} club banner — "${bannerText.trim()}"`,
        amount: meet.bannerAddon.price,
        kind: 'addon',
        refUserId: athlete.id,
        refMeetId: meet.id,
        refLineType: 'banner',
      });
    }

    persistRegs(pendingRegs, tshirtItems, bannerItems);
  };

  const title = step === 'reg'
    ? `Register for ${meet.name}`
    : `Add-ons — ${meet.name}`;

  return (
    <Modal title={title} onClose={onClose}>
      {/* Club selector (only if athlete has >1 affiliated club) */}
      {step === 'reg' && myClubs.length > 1 && (
        <Field label="Compete for" hint="Choose which club you will compete under at this meet.">
          <select
            className="input"
            value={selectedClubId}
            onChange={(e) => setSelectedClubId(e.target.value)}
          >
            {myClubs.map((c) => (
              <option key={c.id} value={c.id} disabled={!!lockedClubId && c.id !== lockedClubId}>
                {c.name}{!!lockedClubId && c.id !== lockedClubId ? ' — unavailable' : ''}
              </option>
            ))}
          </select>
          {lockedClubShort && (
            <p style={{ fontSize: 13, color: 'var(--warn)', marginTop: 6 }}>
              Already registered with {lockedClubShort} for this meet — you can only edit that registration.
            </p>
          )}
        </Field>
      )}

      {step === 'reg' && (
        <RegistrationEditor
          meet={meet}
          athlete={athlete}
          clubId={selectedClubId}
          existing={existingRegs}
          allAthletes={db.people.filter((p) => p.kind === 'athlete')}
          levels={db.levels}
          season={season}
          onSave={handleRegSave}
          onCancel={onClose}
          changeFeeApplies={changeFeeApplies}
          incomingPartnerId={db.registrations.find((r) => r.meetId === meet.id && !r.refunded && r.events.includes('SY') && r.partnerAthleteId === athlete.id)?.athleteId ?? null}
        />
      )}

      {step === 'addons' && (
        <div>
          <p style={{ fontSize: 14, color: 'var(--ink-soft)', marginBottom: 14 }}>
            Optional add-ons are available for this meet. Skip any you don&apos;t want.
          </p>

          {meet.tshirtAddon && (
            <div className="card card-pad" style={{ marginBottom: 14 }}>
              <h3 className="card-title">T-shirt — {fmtMoney(meet.tshirtAddon.price)}</h3>
              <Field label="Size (leave blank to skip)">
                <select className="input" value={tshirtSize} onChange={(e) => setTshirtSize(e.target.value)}>
                  <option value="">— no t-shirt —</option>
                  {(meet.tshirtAddon.sizes.length > 0 ? meet.tshirtAddon.sizes : SHIRT_SIZES).map((sz) => (
                    <option key={sz} value={sz}>{sz}</option>
                  ))}
                </select>
              </Field>
            </div>
          )}

          {meet.bannerAddon && (
            <div className="card card-pad" style={{ marginBottom: 14 }}>
              <h3 className="card-title">Club banner — {fmtMoney(meet.bannerAddon.price)}</h3>
              <Field label="Banner text (leave blank to skip)" hint="Text to print on the banner.">
                <input
                  className="input"
                  value={bannerText}
                  onChange={(e) => setBannerText(e.target.value)}
                  placeholder="e.g. Springfield Gymnastics Club"
                />
              </Field>
            </div>
          )}

          <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
            <button className="btn primary" onClick={handleAddons}>Continue to cart</button>
            <button className="btn ghost" onClick={() => persistRegs(pendingRegs!, [], [])}>Skip add-ons</button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// exportCsv helpers (unchanged from original)
// ---------------------------------------------------------------------------

function exportCsv(db: ReturnType<typeof useDB>, meet: Meet) {
  // Spec: "just export all the things and let the user trim"
  const rows = [['Athlete', 'Club', 'Discipline', 'Level', 'Session', 'Events', 'Shirt', 'Dietary', 'Email', 'Phone', 'Emergency contact', 'Student', 'Region']];
  for (const r of db.registrations.filter((x) => x.meetId === meet.id && !x.refunded)) {
    const a = db.people.find((p) => p.id === r.athleteId)!;
    const club = db.clubs.find((c) => c.id === r.clubId)!;
    rows.push([
      `${a.firstName} ${a.lastName}`, club.name, r.discipline,
      db.levels.find((l) => l.id === r.levelId)?.name ?? '',
      meet.sessions.find((s) => s.id === r.sessionId)?.name ?? '',
      r.events.join('|'), a.shirt, a.dietary.join('|'), a.email, a.phone,
      `${a.emergency.contact} ${a.emergency.phone}`, a.studentStatus, club.region,
    ]);
  }
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  downloadCsv(csv, `${meet.slug}-export.csv`);
}

/** Scores export — includes the captured calculator state so verification has
 *  the full breakdown of how every score was built. */
function exportScoresCsv(db: ReturnType<typeof useDB>, meet: Meet) {
  const rows = [['Athlete', 'Club', 'Session', 'Event', 'Level', 'D/SV', 'Deductions', 'E-score', 'Final', 'Source', 'Calculator', 'Entered by', 'Entered at', 'Adjusted at', 'Adjust note', 'Calculator state (JSON)']];
  for (const s of db.scores.filter((x) => x.meetId === meet.id)) {
    const reg = db.registrations.find((r) => r.id === s.regId);
    const a = reg && db.people.find((p) => p.id === reg.athleteId);
    const club = reg && db.clubs.find((c) => c.id === reg.clubId);
    const session = meet.sessions.find((x) => x.id === s.sessionId);
    rows.push([
      a ? `${a.firstName} ${a.lastName}` : s.regId, club?.name ?? '', session?.name ?? '', s.event,
      db.levels.find((l) => l.id === reg?.levelId)?.name ?? '',
      s.sv ?? '', s.deductions ?? '', s.eScore ?? '', s.final ?? '',
      s.source ?? 'manual', s.calc ?? '', s.enteredBy, s.enteredAt,
      s.adjustedAt ?? '', s.adjustNote ?? '',
      s.calcState ? JSON.stringify(s.calcState) : '',
    ].map(String));
  }
  const csv = rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(',')).join('\n');
  downloadCsv(csv, `${meet.slug}-scores.csv`);
}

function downloadCsv(csv: string, filename: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = filename;
  a.click();
}

// ---------------------------------------------------------------------------
// MeetManage: sessions & squads (unchanged logic, updated imports)
// ---------------------------------------------------------------------------
export function MeetManage() {
  const { slug } = useParams();
  const db = useDB();
  const caps = useCapabilities();
  const meet = db.meets.find((m) => m.slug === slug);
  const [sessionId, setSessionId] = useState(meet?.sessions[0]?.id ?? '');
  if (!meet) return <p>Meet not found.</p>;
  const session = meet.sessions.find((s) => s.id === sessionId) ?? meet.sessions[0];
  const canScore = caps.isMeetHost(meet.id);

  return (
    <div>
      <h1 className="page-title display">Manage — {meet.name}</h1>
      <p className="page-sub">Build squads per session, copy a squad setup to other sessions, and save everything at once. New athletes land in the Holding squad until placed.</p>
      {canScore && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
          <Link className="btn primary" to={`/judge?meet=${meet.id}`}>Score entry →</Link>
          <Link className="btn ghost" to={`/results/${meet.slug}`}>Live results</Link>
        </div>
      )}
      <Tabs
        tabs={meet.sessions.map((s) => ({ id: s.id, label: s.name.split('—')[0].trim() }))}
        active={session.id}
        onChange={setSessionId}
      />
      <SquadBuilder meet={meet} session={session} />
    </div>
  );
}

function SquadBuilder({ meet, session }: { meet: Meet; session: MeetSession }) {
  const db = useDB();
  const toast = useToast();
  const regs = db.registrations.filter((r) => r.meetId === meet.id && r.sessionId === session.id && !r.refunded);
  const events = EVENTS[session.discipline];
  const placed = new Set(session.squads.flatMap((q) => q.athleteRegIds));
  const holding = regs.filter((r) => !placed.has(r.id));
  const name = (regId: string) => {
    const reg = regs.find((r) => r.id === regId);
    const a = db.people.find((p) => p.id === reg?.athleteId);
    return a ? `${a.firstName} ${a.lastName}` : regId;
  };
  const clubShort = (regId: string) => {
    const reg = regs.find((r) => r.id === regId);
    return db.clubs.find((c) => c.id === reg?.clubId)?.shortName ?? '';
  };

  const applyDefault = (n: number) => {
    mutate((d) => {
      const m = d.meets.find((x) => x.id === meet.id)!;
      const s = m.sessions.find((x) => x.id === session.id)!;
      const sregs = d.registrations.filter((r) => r.meetId === meet.id && r.sessionId === session.id && !r.refunded);
      s.squads = Array.from({ length: n }, (_, i) => ({
        id: `${s.id}-q${i + 1}`, name: `Squad ${String.fromCharCode(65 + i)}`,
        startEvent: Math.floor((i * events.length) / n) % events.length,
        athleteRegIds: [],
      }));
      sregs.forEach((r, i) => s.squads[i % n].athleteRegIds.push(r.id));
      pushMeetSessions(m, d.registrations);
    });
    toast(`Split ${regs.length} athletes into ${n} squads. Adjust then Save.`);
  };

  const copyToOthers = () => {
    mutate((d) => {
      const m = d.meets.find((x) => x.id === meet.id)!;
      for (const s of m.sessions) {
        if (s.id === session.id || s.discipline !== session.discipline) continue;
        const sregs = d.registrations.filter((r) => r.meetId === meet.id && r.sessionId === s.id && !r.refunded);
        const n = Math.max(1, session.squads.filter((q) => !q.holding).length);
        s.squads = Array.from({ length: n }, (_, i) => ({
          id: `${s.id}-q${i + 1}`, name: `Squad ${String.fromCharCode(65 + i)}`,
          startEvent: session.squads[i]?.startEvent ?? 0,
          athleteRegIds: [],
        }));
        sregs.forEach((r, i) => s.squads[i % n].athleteRegIds.push(r.id));
      }
      pushMeetSessions(m, d.registrations);
    });
    toast('Squad setup copied to other ' + session.discipline + ' sessions.');
  };

  const move = (regId: string, toSquadId: string | 'holding') => {
    mutate((d) => {
      const m = d.meets.find((x) => x.id === meet.id)!;
      const s = m.sessions.find((x) => x.id === session.id)!;
      for (const q of s.squads) q.athleteRegIds = q.athleteRegIds.filter((id) => id !== regId);
      if (toSquadId !== 'holding') s.squads.find((q) => q.id === toSquadId)!.athleteRegIds.push(regId);
      pushMeetSessions(m, d.registrations);
    });
  };

  const defaults = session.discipline === 'MAG' ? [2, 3, 6] : session.discipline === 'WAG' ? [4, 8] : [2, 3];

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink-soft)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Default rotations:</span>
        {defaults.map((n) => (
          <button key={n} className="btn small ghost" onClick={() => applyDefault(n)}>{n} squads</button>
        ))}
        <div style={{ flex: 1 }} />
        <button className="btn small" onClick={copyToOthers} data-tip="Replicate this squad count & rotation starts to other sessions of this discipline">Copy setup to other sessions</button>
        <button className="btn small primary" onClick={() => toast('Squads saved & published to the schedule.')}>Save all squads</button>
      </div>

      <div className="grid cols-3">
        <div className="card card-pad" style={{ borderStyle: 'dashed', background: 'var(--ice-100)' }}>
          <h3 className="card-title">Holding squad ({holding.length})</h3>
          <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', marginTop: 0 }}>Unplaced athletes — the holding squad can&apos;t compete.</p>
          {holding.map((r) => (
            <div key={r.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 6, padding: '5px 0', borderBottom: '1px solid var(--line)', fontSize: 13.5 }}>
              <span>{name(r.id)} <span style={{ color: 'var(--ink-soft)' }}>({clubShort(r.id)})</span></span>
              <select className="input" style={{ width: 'auto', padding: '2px 6px', fontSize: 12 }} value="" onChange={(e) => move(r.id, e.target.value)}>
                <option value="" disabled>→</option>
                {session.squads.filter((q) => !q.holding).map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}
              </select>
            </div>
          ))}
          {holding.length === 0 && <p style={{ color: 'var(--green-600)', fontWeight: 600, fontSize: 13.5 }}>✓ Everyone placed</p>}
        </div>

        {session.squads.filter((q) => !q.holding).map((q) => (
          <div className="card card-pad" key={q.id}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <h3 className="card-title" style={{ marginBottom: 4 }}>{q.name} ({q.athleteRegIds.length})</h3>
              <span style={{ fontSize: 12, color: 'var(--coral-600)', fontWeight: 700 }}>starts on {events[q.startEvent]?.name ?? events[0].name}</span>
            </div>
            {q.athleteRegIds.map((regId) => (
              <div key={regId} style={{ display: 'flex', justifyContent: 'space-between', gap: 6, padding: '5px 0', borderBottom: '1px solid var(--line)', fontSize: 13.5 }}>
                <span>{name(regId)} <span style={{ color: 'var(--ink-soft)' }}>({clubShort(regId)})</span></span>
                <button className="btn small ghost" style={{ padding: '1px 8px' }} data-tip="Back to holding" onClick={() => move(regId, 'holding')}>↩</button>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
