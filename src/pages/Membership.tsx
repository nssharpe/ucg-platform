import { useState } from 'react';
import { useDB, mutate } from '../lib/store';
import { useCapabilities } from '../lib/capabilities';
import { Badge, Field, useToast } from '../components/ui';
import { fmtMoney } from '../lib/scoring';
import { pushCart, pushInvoice, pushMembership } from '../lib/supabase';
import type { Athlete, Membership } from '../lib/types';

export function Membership() {
  const caps = useCapabilities();
  if (!caps.person) {
    return (
      <div className="card card-pad" style={{ maxWidth: 520 }}>
        <h2 className="display" style={{ fontSize: 22 }}>Finishing sign-in…</h2>
        <p>We're linking your account to your member profile. If this persists, refresh the page.</p>
      </div>
    );
  }
  return <MembershipInner me={caps.person} />;
}

// Returns a human-readable label for each required field that is missing.
function missingProfileFields(me: Athlete): string[] {
  const missing: string[] = [];
  if (!me.firstName?.trim()) missing.push('First name');
  if (!me.lastName?.trim()) missing.push('Last name');
  if (!me.dob?.trim()) missing.push('Date of birth');
  if (!me.phone?.trim()) missing.push('Phone number');
  if (!me.shirt?.trim()) missing.push('T-shirt size');
  if (!me.studentStatus?.trim()) missing.push('Student status');
  if (!me.emergency?.contact?.trim()) missing.push('Emergency contact name');
  if (!me.emergency?.phone?.trim()) missing.push('Emergency contact phone');
  return missing;
}

function MembershipInner({ me }: { me: Athlete }) {
  const db = useDB();
  const toast = useToast();
  const purchasable = db.seasons.filter((s) => s.active);
  const [seasonId, setSeasonId] = useState(db.seasons.find((s) => s.current)!.id);
  const season = db.seasons.find((s) => s.id === seasonId)!;
  const existing = me.memberships.find((m) => m.seasonId === seasonId);
  const club = db.clubs.find((c) => c.id === me.mainClubId);

  const [step, setStep] = useState<'info' | 'waiver' | 'pay' | 'done'>(existing ? 'done' : 'info');
  const [confirmed, setConfirmed] = useState(false);
  const [waiverSig, setWaiverSig] = useState('');
  const [coupon, setCoupon] = useState('');
  const [payMethod, setPayMethod] = useState<'card' | 'club'>('card');

  const missingFields = missingProfileFields(me);
  const profileComplete = missingFields.length === 0;

  const isMinor = (() => {
    if (!me.dob) return false;
    const age = (Date.now() - new Date(me.dob).getTime()) / (365.25 * 24 * 3600 * 1000);
    return age < 18;
  })();

  // For adult path: signature must match member's legal name (case-insensitive, whitespace-collapsed).
  const expectedSig = `${me.firstName ?? ''} ${me.lastName ?? ''}`.replace(/\s+/g, ' ').trim();
  const normalise = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const sigMatchesName = normalise(waiverSig) === normalise(expectedSig);
  const waiverValid = isMinor ? waiverSig.trim().length >= 2 : sigMatchesName;

  const couponDef = db.coupons.find((c) => c.code === coupon.toUpperCase() && (c.appliesTo === 'membership' || c.appliesTo === 'any'));
  const fee = season.athleteFee;
  const discounted = couponDef ? Math.max(0, couponDef.amountOff ? fee - couponDef.amountOff : fee * (1 - (couponDef.pctOff ?? 0) / 100)) : fee;

  const complete = (via: 'card' | 'club') => {
    mutate((d) => {
      const p = d.people.find((x) => x.id === me.id)!;
      p.memberships = p.memberships.filter((m) => m.seasonId !== seasonId);
      const membership: Membership = {
        seasonId,
        status: via === 'card' ? 'active' : 'pending-club-payment',
        waiverSignedAt: new Date().toISOString(),
        waiverSignedBy: waiverSig,
        paidVia: via === 'card' ? 'card' : null,
      };
      p.memberships.push(membership);
      pushMembership(p.id, membership);
      if (via === 'club' && club) {
        const cart = d.carts[club.id] ?? (d.carts[club.id] = []);
        cart.push({ id: `ci-${Date.now()}`, label: `Athlete membership ${season.name} — ${me.firstName} ${me.lastName}`, amount: discounted, kind: 'membership', refUserId: me.id });
        pushCart(club.id, cart, true);
      } else {
        const invoice = {
          id: `inv-${Date.now()}`, number: `UCG-2026-${String(d.invoices.length + 1).padStart(4, '0')}`,
          clubId: null, athleteId: me.id, createdAt: new Date().toISOString(), paidAt: new Date().toISOString(),
          items: [{ id: `ii-${Date.now()}`, label: `Athlete membership ${season.name}`, amount: discounted, kind: 'membership' as const, refUserId: me.id }],
          couponCode: couponDef?.code,
        };
        d.invoices.push(invoice);
        pushInvoice(invoice);
      }
    });
    setStep('done');
    toast(via === 'card'
      ? `Membership active! Confirmation emailed to ${me.email} and ${club?.name ?? 'your club'}.`
      : `Sent to ${club?.name} club cart — your membership activates once the club pays.`);
  };

  return (
    <div style={{ maxWidth: 660 }}>
      <h1 className="page-title display">Membership</h1>
      <p className="page-sub">
        UCG membership is required for all meet registration. Valid July 1 – June 30 of the membership season.
      </p>

      <Field label="Season">
        <select className="input" value={seasonId} onChange={(e) => { setSeasonId(e.target.value); setStep('info'); setConfirmed(false); }}>
          {purchasable.map((s) => (
            <option key={s.id} value={s.id}>{s.name}{s.current ? ' (current season)' : ''} — {fmtMoney(s.athleteFee)}</option>
          ))}
        </select>
      </Field>
      {!season.current && (
        <div className="card card-pad" style={{ borderLeft: '4px solid var(--amber-600)', marginBottom: 16 }}>
          ⚠ You are purchasing for <strong>{season.name}</strong>, which is <em>not</em> the current season.
          It is valid {season.startsOn} through {season.endsOn}.
        </div>
      )}

      {existing && step === 'done' ? (
        <div className="card card-pad">
          {existing.status === 'active'
            ? <><Badge tone="ok">✓ Active</Badge><p>Your {season.name} membership is active. Waiver signed by {existing.waiverSignedBy} on {existing.waiverSignedAt?.slice(0, 10)}.</p></>
            : <><Badge tone="warn">Pending club payment</Badge><p>Waiver signed. Your membership activates once {club?.name} pays the fee from their club cart.</p></>}
        </div>
      ) : (
        <>
          {step === 'info' && (
            <div className="card card-pad">
              <h3 className="card-title">Step 1 of 3 — Confirm your info</h3>
              {!profileComplete ? (
                <>
                  <div style={{ background: 'var(--coral-100)', border: '1px solid var(--coral-400)', borderRadius: 8, padding: 14, marginBottom: 14 }}>
                    <strong style={{ display: 'block', marginBottom: 6 }}>Your profile is missing required information.</strong>
                    <p style={{ margin: '0 0 8px', fontSize: 14 }}>
                      You must complete your profile before purchasing a membership. The following fields are missing:
                    </p>
                    <ul style={{ margin: 0, paddingLeft: 20, fontSize: 14 }}>
                      {missingFields.map((f) => <li key={f}>{f}</li>)}
                    </ul>
                  </div>
                  <a className="btn primary" href="#/me?return=membership">Edit profile to continue →</a>
                </>
              ) : (
                <>
                  <p style={{ color: 'var(--ink-soft)', marginTop: 0 }}>
                    Autofilled from your profile. Please actually read it — wrong info here follows you to every meet.
                  </p>
                  <table className="tbl" style={{ marginBottom: 14 }}>
                    <tbody>
                      <tr><td>Name</td><td><strong>{me.firstName} {me.lastName}</strong></td></tr>
                      <tr><td>DoB</td><td>{me.dob}</td></tr>
                      <tr><td>Phone</td><td>{me.phone}</td></tr>
                      <tr><td>Student status</td><td>{me.studentStatus}</td></tr>
                      <tr><td>Main club</td><td>{club?.name ?? '—'}</td></tr>
                      <tr><td>T-shirt</td><td>{me.shirt}</td></tr>
                      <tr><td>Emergency contact</td><td>{me.emergency.contact} ({me.emergency.relation}) {me.emergency.phone}</td></tr>
                    </tbody>
                  </table>
                  <label className="checkrow">
                    <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                    I confirm this information is current and correct.
                  </label>
                  <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                    <button className="btn primary" disabled={!confirmed} onClick={() => setStep('waiver')}>Continue →</button>
                    <a className="btn ghost" href="#/me?return=membership">Edit profile first</a>
                  </div>
                </>
              )}
            </div>
          )}

          {step === 'waiver' && (
            <div className="card card-pad">
              <h3 className="card-title">Step 2 of 3 — Sign the {season.name} waiver</h3>
              <div style={{ background: 'var(--ice-100)', border: '1px solid var(--line)', borderRadius: 8, padding: 14, fontSize: 13, maxHeight: 160, overflowY: 'auto', marginBottom: 14 }}>
                <strong>UCG ASSUMPTION OF RISK, WAIVER & RELEASE — {season.name}</strong>
                <p>I acknowledge that gymnastics carries inherent risk of serious injury. In consideration of being
                permitted to participate in United Club Gymnastics events, I release UCG, host clubs, venues, and their
                officers from liability to the fullest extent permitted by law… (waiver text is set per-season in League Controls).</p>
              </div>
              {isMinor ? (
                <>
                  <Badge tone="warn">Under 18</Badge>
                  <p style={{ fontSize: 14 }}>A parent or guardian must sign. We'll email them a signing link; your membership completes once they sign.</p>
                  <Field label="Guardian name"><input type="text" value={waiverSig} onChange={(e) => setWaiverSig(e.target.value)} /></Field>
                  <Field label="Guardian email"><input type="email" placeholder="guardian@example.com" /></Field>
                </>
              ) : (
                <>
                  <Field label="Type your full legal name to sign" hint="This constitutes a legal electronic signature with timestamp and IP recorded.">
                    <input type="text" value={waiverSig} onChange={(e) => setWaiverSig(e.target.value)} placeholder={expectedSig} />
                  </Field>
                  {waiverSig.trim().length > 0 && !sigMatchesName && (
                    <p style={{ color: 'var(--coral-600)', fontSize: 13, marginTop: -8, marginBottom: 10 }}>
                      Your signature must match your name on file: <strong>{expectedSig}</strong>.
                    </p>
                  )}
                </>
              )}
              <button className="btn primary" disabled={!waiverValid} onClick={() => setStep('pay')}>Sign & continue →</button>
            </div>
          )}

          {step === 'pay' && (
            <div className="card card-pad">
              <h3 className="card-title">Step 3 of 3 — Payment</h3>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15, marginBottom: 4 }}>
                <span>Athlete membership · {season.name}</span><strong>{fmtMoney(fee)}</strong>
              </div>
              {couponDef && (
                <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--green-600)', fontSize: 14, marginBottom: 4 }}>
                  <span>Coupon {couponDef.code}</span><span>−{fmtMoney(fee - discounted)}</span>
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 17, fontWeight: 700, borderTop: '2px solid var(--navy-800)', paddingTop: 8, marginBottom: 14 }}>
                <span>Total</span><span>{fmtMoney(discounted)}</span>
              </div>
              <Field label="Coupon code"><input type="text" value={coupon} onChange={(e) => setCoupon(e.target.value)} placeholder="e.g. NEWCLUB26" /></Field>
              <div className="card card-pad" style={{ background: 'var(--coral-100)', border: 'none', marginBottom: 14, padding: 12, fontSize: 13.5 }}>
                <strong>Membership fees are non-refundable.</strong> Refunds are only issued for genuine
                mistakes (e.g. duplicate purchase) and require league admin approval.
              </div>
              <Field label="Payment method">
                <select className="input" value={payMethod} onChange={(e) => setPayMethod(e.target.value as 'card' | 'club')}>
                  <option value="card">Pay now — credit / debit card</option>
                  {club?.allowClubPay && <option value="club">Send to {club.shortName} club cart (club pays later)</option>}
                </select>
              </Field>
              {payMethod === 'card' && (
                <div className="grid cols-2">
                  <Field label="Card number"><input type="text" placeholder="4242 4242 4242 4242" /></Field>
                  <div className="grid cols-2">
                    <Field label="Exp"><input type="text" placeholder="MM/YY" /></Field>
                    <Field label="CVC"><input type="text" placeholder="123" /></Field>
                  </div>
                </div>
              )}
              <button className="btn primary" onClick={() => complete(payMethod)}>
                {payMethod === 'card' ? `Pay ${fmtMoney(discounted)}` : 'Send to club cart →'}
              </button>
              <p style={{ fontSize: 12, color: 'var(--ink-soft)', marginTop: 10 }}>
                Demo prototype — no real payment is processed. Production will use a PCI-compliant processor (Stripe).
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
