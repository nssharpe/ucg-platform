import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useDB, mutate } from '../lib/store';
import { useCapabilities } from '../lib/capabilities';
import { Badge, Field } from '../components/ui';
import { useToast } from '../components/ui-hooks';
import { fmtMoney } from '../lib/scoring';
import { pushCartItem, redeemCoupon, pushInvoice, pushMembership, fetchPublishedWaiver, recordWaiverSignature, requestGuardianWaiver, notifyClubCart, sendMembershipWelcome, sendReceipt } from '../lib/supabase';
import type { Athlete, InvoiceItem, Membership, MembershipType, WaiverDocument } from '../lib/types';
import { GENERAL_WAIVER_TYPE } from '../lib/types';
import { isMinorAt } from '../lib/waivers-core';
import { membershipHolds } from '../lib/capabilities-core';
import { sanitizeWaiverHtml } from '../lib/sanitize-html';
import {
  offeredMembershipTypes,
  membershipFee,
  priceForTypes,
  couponValid,
  applyCoupon,
} from '../lib/pricing';

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
  if (!me.state?.trim()) missing.push('Training state');
  if (!me.phone?.trim()) missing.push('Phone number');
  if (!me.shirt?.trim()) missing.push('T-shirt size');
  if (!me.studentStatus?.trim()) missing.push('Student status');
  if (!me.emergency?.contact?.trim()) missing.push('Emergency contact name');
  if (!me.emergency?.phone?.trim()) missing.push('Emergency contact phone');
  return missing;
}

function MembershipInner({ me }: { me: Athlete }) {
  const db = useDB();
  const caps = useCapabilities();
  const toast = useToast();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const purchasable = db.seasons.filter((s) => s.active);
  const currentSeason = db.seasons.find((s) => s.current)!;

  // Honor ?season= param when returning from Profile (task 3)
  const seasonParam = searchParams.get('season');
  const initialSeasonId = (seasonParam && db.seasons.find((s) => s.id === seasonParam))
    ? seasonParam
    : currentSeason.id;

  const [seasonId, setSeasonId] = useState(initialSeasonId);
  const season = db.seasons.find((s) => s.id === seasonId)!;
  const club = db.clubs.find((c) => c.id === me.mainClubId);

  // Which membership types can this person purchase?
  const roles = me.roles ?? { athlete: me.kind !== 'coach', coach: me.kind === 'coach' };
  const offeredTypes = offeredMembershipTypes(roles);

  // Determine existing memberships for this season
  const existingForSeason = me.memberships.filter((m) => m.seasonId === seasonId);

  // Which types are still purchasable (not already active)?
  const purchasableTypes = offeredTypes.filter(
    (t) => !existingForSeason.some((m) => m.type === t && m.status === 'active'),
  );

  // Default type selection: if both offered & both purchasable, default to both;
  // if only one type offered, pre-select it.
  const defaultSelectedTypes = (): MembershipType[] => {
    if (purchasableTypes.length === 0) return [];
    return purchasableTypes; // default: select all purchasable
  };
  const [selectedTypes, setSelectedTypes] = useState<MembershipType[]>(defaultSelectedTypes);

  // Check whether everything is already owned
  const allOwned = purchasableTypes.length === 0 && existingForSeason.length > 0;

  const [step, setStep] = useState<'info' | 'waiver' | 'pay' | 'done'>(allOwned ? 'done' : 'info');
  const [confirmed, setConfirmed] = useState(false);
  const [waiverSig, setWaiverSig] = useState('');
  const [coupon, setCoupon] = useState('');
  const [payMethod, setPayMethod] = useState<'card' | 'club'>('card');
  // Task 6: save card on file (disabled/coming-soon)
  const [saveCard] = useState(false);

  // Waiver signing state — a single waiver covers all members regardless of type.
  const [consent, setConsent] = useState(false);
  const [waiverDoc, setWaiverDoc] = useState<WaiverDocument | null>(null);
  const [signing, setSigning] = useState(false);
  const [guardianName, setGuardianName] = useState('');
  const [guardianEmail, setGuardianEmail] = useState('');
  const [sentGuardian, setSentGuardian] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchPublishedWaiver(season.id, GENERAL_WAIVER_TYPE).then((d) => { if (!cancelled) setWaiverDoc(d); });
    return () => { cancelled = true; };
  }, [season.id]);

  const missingFields = missingProfileFields(me);
  const profileComplete = missingFields.length === 0;

  const isMinor = isMinorAt(me.dob ?? '', new Date());

  const expectedSig = `${me.firstName ?? ''} ${me.lastName ?? ''}`.replace(/\s+/g, ' ').trim();
  const normalise = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const sigMatchesName = normalise(waiverSig) === normalise(expectedSig);
  const waiverValid = !!waiverDoc && consent && !isMinor && sigMatchesName;

  // Task 7: coupon validation via pricing helpers
  const nowISO = new Date().toISOString();
  const couponDef = db.coupons.find(
    (c) =>
      c.code === coupon.toUpperCase() &&
      (c.appliesTo === 'membership' || c.appliesTo === 'any') &&
      (!c.restrictedToPersonId || c.restrictedToPersonId === me.id) &&
      couponValid(c, nowISO),
  );

  // Combined price for the whole selection — "both" costs the higher single fee
  // (athlete), not the sum (per 2026-06-22 feedback). Price for any subset.
  const selPrice = (types: MembershipType[]) => priceForTypes(season, types, me.memberships);

  // The newly-added types (those not already active this season).
  const newTypes = selectedTypes.filter(
    (t) => !existingForSeason.some((m) => m.type === t && m.status === 'active'),
  );
  // The dearest newly-added type carries the whole combined charge; any other
  // new type is then $0 (included). Owned/re-selected types are $0 too. This
  // keeps the per-line display summing exactly to the combined subtotal.
  const topNewType = newTypes
    .slice()
    .sort((a, b) => membershipFee(season, b) - membershipFee(season, a))[0];
  const pricePerType = (t: MembershipType) => (t === topNewType ? selPrice(selectedTypes) : 0);

  // Total for selected types (coupon applied to the combined subtotal)
  const subtotal = selPrice(selectedTypes);
  const discounted = couponDef ? applyCoupon(subtotal, couponDef) : subtotal;
  const discount = subtotal - discounted;

  // Profile return URL — include season so we resume the right one (task 3)
  const profileReturnUrl = `#/me?return=membership${seasonId !== currentSeason.id ? `&season=${seasonId}` : ''}`;

  // Navigate back helpers (task 2)
  const goBack = () => {
    if (step === 'pay') setStep('waiver');
    else if (step === 'waiver') setStep('info');
    else navigate(-1);
  };

  // Reset type selection and steps when season changes
  const onSeasonChange = (newId: string) => {
    setSeasonId(newId);
    setStep('info');
    setConfirmed(false);
    setWaiverSig('');
    setCoupon('');
    // Re-derive purchasable types for new season
    const newSeason = db.seasons.find((s) => s.id === newId)!;
    const newExisting = me.memberships.filter((m) => m.seasonId === newId);
    const newPurchasable = offeredTypes.filter(
      (t) => !newExisting.some((m) => m.type === t && m.status === 'active'),
    );
    setSelectedTypes(newPurchasable);
    if (newPurchasable.length === 0 && newExisting.length > 0) setStep('done');
    else if (newSeason) { /* step stays 'info' */ }
  };

  const complete = (via: 'card' | 'club' | 'comp') => {
    // "First membership" signal — computed from the PRE-purchase membership list.
    // Welcome fires once: only when the member held no prior active/paid (or
    // club-payment-pending) membership before this purchase. Pending-waiver-only
    // rows don't count as a completed purchase. (Server re-checks no-club +
    // Outside-US; this guard is the once-only gate.)
    const hadPriorMembership = me.memberships.some(
      (m) => m.status === 'active' || m.status === 'pending-club-payment' || m.clubCartPending || m.paidVia != null,
    );

    // Direct-pay (card/comp) invoice, captured so we can email the receipt after
    // the mutate. Null for the club-cart push (no personal invoice is created).
    type DirectInvoice = { number: string; items: InvoiceItem[]; couponCode?: string };
    let directInvoice: DirectInvoice | null = null;

    mutate((d) => {
      const p = d.people.find((x) => x.id === me.id)!;

      for (const t of selectedTypes) {
        // Remove any stale same-type entry for this season
        p.memberships = p.memberships.filter((m) => !(m.seasonId === seasonId && m.type === t));

        const membership: Membership = {
          seasonId,
          type: t,
          status: isMinor ? 'pending-waiver' : (via === 'club' ? 'pending-club-payment' : 'active'),
          waiverSignedAt: isMinor ? null : new Date().toISOString(),
          waiverSignedBy: isMinor ? null : waiverSig,
          paidVia: via === 'comp' ? 'comp' : via === 'card' ? 'card' : 'club',
          // Payment hold is independent of the waiver hold: a club-pushed fee is
          // pending until the club pays, even while a minor's waiver is still open.
          ...(via === 'club' ? { clubCartPending: true } : {}),
          ...(via === 'comp' ? { activatedByAdmin: true } : {}),
        };
        p.memberships.push(membership);
        pushMembership(p.id, membership);
      }

      // Build invoice items at full price; the coupon becomes its own negative
      // "discount" line so the receipt can show each item's real value, a
      // subtotal, the promo applied, and the final total.
      const invoiceItems: InvoiceItem[] = selectedTypes.map((t, i) => {
        const labelType = t === 'coach' ? 'Coach' : 'Athlete';
        return {
          id: `ii-${Date.now()}-${i}`,
          label: `${labelType} membership ${season.name}`,
          amount: via === 'comp' ? 0 : pricePerType(t),
          kind: 'membership' as const,
          refUserId: me.id,
        };
      });
      if (via !== 'comp' && couponDef && discount > 0) {
        invoiceItems.push({
          id: `ii-${Date.now()}-disc`,
          label: `Promo code ${couponDef.code}`,
          amount: -discount,
          kind: 'discount',
          refUserId: me.id,
        });
      }

      if (via === 'club' && club) {
        const adderName = `${me.firstName} ${me.lastName}`;
        const cart = d.carts[club.id] ?? (d.carts[club.id] = []);
        const addedItems: { label: string; amount: number }[] = [];
        for (const t of selectedTypes) {
          const labelType = t === 'coach' ? 'Coach' : 'Athlete';
          const label = `${labelType} Membership ${season.name} — ${adderName} (added by ${adderName})`;
          const item = {
            id: `ci-${Date.now()}-${t}`,
            label,
            amount: pricePerType(t),
            kind: 'membership' as const,
            refUserId: me.id,
            refSeasonId: seasonId,
            refType: t,
          };
          cart.push(item);
          // Append only this member's own row — a member can't replace the whole
          // club cart under RLS (that's a manager-only operation).
          pushCartItem(club.id, item, true);
          addedItems.push({ label, amount: pricePerType(t) });
        }
        // Email the club's managers (best-effort; cart item already shows on their dashboard).
        void notifyClubCart({ clubId: club.id, items: addedItems, addedByName: adderName });
      } else {
        const invoice = {
          id: `inv-${Date.now()}`,
          number: `UCG-2026-${String(d.invoices.length + 1).padStart(4, '0')}`,
          clubId: null,
          athleteId: me.id,
          createdAt: new Date().toISOString(),
          paidAt: new Date().toISOString(),
          items: invoiceItems,
          ...(couponDef ? { couponCode: couponDef.code } : {}),
        };
        d.invoices.push(invoice);
        pushInvoice(invoice);
        directInvoice = { number: invoice.number, items: invoice.items, couponCode: invoice.couponCode };
      }

      // Increment coupon usedCount. The remote write goes through a security-
      // definer RPC (members have no direct UPDATE on coupons); locally we mirror
      // the bump for immediate UI feedback.
      if (couponDef && via !== 'club') {
        const ci = d.coupons.findIndex((c) => c.code === couponDef.code);
        if (ci >= 0) {
          d.coupons[ci] = { ...d.coupons[ci], usedCount: (d.coupons[ci].usedCount ?? 0) + 1 };
          void redeemCoupon(couponDef.code);
        }
      }
    });

    setStep('done');

    if (via === 'comp') {
      toast(`Membership granted by admin override. Activated at $0.`);
    } else if (via === 'club') {
      toast(`Sent to ${club?.name} club cart — your membership activates once the club pays.`);
    } else if (directInvoice) {
      // Real send: email the account owner their confirmation + HTML receipt
      // (service-role `send-receipt`, works for a non-admin member). Best-effort;
      // the toast only claims "emailed" when the send actually succeeds.
      const inv: DirectInvoice = directInvoice;
      void sendReceipt({
        items: inv.items.map((i) => ({ label: i.label, amount: i.amount, kind: i.kind })),
        total: inv.items.reduce((s, i) => s + i.amount, 0),
        invoiceNumber: inv.number,
        couponCode: inv.couponCode,
      })
        .then((r) => {
          if (r.ok && r.sent) toast(`Membership active! Confirmation emailed to ${me.email}.`);
          else toast('Membership active! Your receipt is saved in Purchase History.');
        })
        .catch(() => toast('Membership active! Your receipt is saved in Purchase History.'));
    } else {
      toast('Membership active!');
    }

    // "Welcome to UCG" email for a no-club member's FIRST membership-only
    // purchase (card/comp — NOT the club-cart push). Best-effort; never blocks
    // the UX. Conditions checked here: no-club + not Outside US + first
    // membership. The server re-validates no-club + Outside-US before sending.
    if (via !== 'club' && me.mainClubId == null && !me.outsideUs && !hadPriorMembership) {
      void sendMembershipWelcome(me.id).catch(() => { /* non-fatal */ });
    }
  };

  // Type label helper
  const typeLabel = (t: MembershipType) => t === 'coach' ? 'Coach' : 'Athlete';

  // Adult self-sign via Edge Function — one signature covers all memberships.
  const signSelf = async () => {
    if (!waiverDoc) return;
    setSigning(true);
    const res = await recordWaiverSignature({
      personId: me.id, seasonId: season.id, waiverType: waiverDoc.waiverType,
      membershipType: 'all', waiverDocumentId: waiverDoc.id, contentHash: waiverDoc.contentHash,
      signerName: waiverSig.trim(), signerEmail: me.email, signerRole: 'self', consent,
    });
    setSigning(false);
    if (!res.ok) { toast(res.error ?? 'Could not record signature.'); return; }
    setStep('pay');
  };

  // Guardian waiver request — one link covers all of the minor's memberships.
  const sendGuardian = async () => {
    if (!waiverDoc) return;
    if (guardianName.trim().length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guardianEmail)) {
      toast('Enter the guardian name and a valid email.'); return;
    }
    setSigning(true);
    const res = await requestGuardianWaiver({
      personId: me.id, seasonId: season.id, waiverType: waiverDoc.waiverType,
      membershipType: 'all', guardianName: guardianName.trim(), guardianEmail: guardianEmail.trim(),
    });
    setSigning(false);
    if (!res.ok) { toast(res.error ?? 'Could not send the guardian link.'); return; }
    setSentGuardian(true);
    toast('Signing link sent to the guardian.');
  };

  return (
    <div style={{ maxWidth: 660 }}>
      {/* Page-level back (leaves the membership flow). The in-flow "previous
          step" back lives in each step-box header (upper-right) so it reads as
          a step-back, not a leave-the-page action. */}
      {step === 'info' && (
        <button
          className="btn ghost small"
          style={{ marginBottom: 12 }}
          onClick={() => navigate(-1)}
        >
          ← Back
        </button>
      )}

      <h1 className="page-title display">Membership</h1>
      <p className="page-sub">
        UCG membership is required for all meet registration. Valid July 1 – June 30 of the membership season.
      </p>

      {/* Season selector */}
      <Field label="Season">
        <select className="input" value={seasonId} onChange={(e) => onSeasonChange(e.target.value)}>
          {purchasable.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}{s.current ? ' (current season)' : ''}
              {offeredTypes.length <= 1
                ? ` — ${fmtMoney(s.athleteFee)}`
                : ` — Athlete ${fmtMoney(s.athleteFee)} / Coach ${fmtMoney(s.coachFee)}`}
            </option>
          ))}
        </select>
      </Field>

      {/* Task 8: non-current season warning */}
      {!season.current && (
        <div className="card card-pad" style={{ borderLeft: '4px solid var(--amber-600)', marginBottom: 16 }}>
          ⚠ You are purchasing for <strong>{season.name}</strong>, which is <em>not</em> the current season.
          It is valid {season.startsOn} through {season.endsOn}.
        </div>
      )}

      {/* "Done" state — all active memberships for this season */}
      {step === 'done' && existingForSeason.length > 0 ? (
        <div className="card card-pad">
          {existingForSeason.map((m) => {
            // The two holds are INDEPENDENT and can apply at once (e.g. a minor
            // who pushed their fee to the club cart awaits BOTH a guardian waiver
            // AND the club's payment). Derive each from the membership's own
            // fields rather than the single status enum.
            const { waiverHold, paymentHold, active } = membershipHolds(m);
            return (
              <div key={m.type} style={{ marginBottom: 10 }}>
                {active ? (
                  <>
                    <Badge tone="ok">✓ {typeLabel(m.type)} Active</Badge>
                    <p style={{ margin: '4px 0 0' }}>
                      Your {season.name} {m.type} membership is active.
                      Waiver signed by {m.waiverSignedBy} on {m.waiverSignedAt?.slice(0, 10)}.
                      {m.activatedByAdmin && <span style={{ color: 'var(--ink-soft)', fontSize: 13 }}> (Admin override)</span>}
                    </p>
                  </>
                ) : (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {waiverHold && (
                      <Badge tone="warn">
                        {isMinor ? 'Pending guardian waiver' : 'Pending waiver'} ({typeLabel(m.type)})
                      </Badge>
                    )}
                    {paymentHold && (
                      <Badge tone="warn">
                        Pending Payment by {club?.name ?? 'your club'} ({typeLabel(m.type)})
                      </Badge>
                    )}
                  </div>
                )}
                {!active && (
                  <p style={{ margin: '4px 0 0' }}>
                    {waiverHold && (isMinor
                      ? 'A guardian signing link has been sent. '
                      : 'Sign your waiver to continue. ')}
                    {paymentHold && `Your ${m.type} membership activates once ${club?.name ?? 'your club'} pays the fee from their club cart.`}
                    {waiverHold && !paymentHold && `Your ${m.type} membership activates once the waiver is signed.`}
                  </p>
                )}
              </div>
            );
          })}

          {/* Allow purchasing additional type if one is still missing */}
          {purchasableTypes.length > 0 && (
            <div style={{ marginTop: 12, borderTop: '1px solid var(--line)', paddingTop: 12 }}>
              <p style={{ margin: '0 0 8px', fontSize: 14 }}>
                You can also add a {purchasableTypes.map(typeLabel).join(' or ')} membership for {season.name}.
              </p>
              <button className="btn ghost small" onClick={() => {
                setSelectedTypes(purchasableTypes);
                setStep('info');
              }}>
                Add {purchasableTypes.map(typeLabel).join(' / ')} membership →
              </button>
            </div>
          )}
        </div>
      ) : step !== 'done' && (
        <>
          {/* STEP 1 — Info */}
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
                  <a className="btn primary" href={profileReturnUrl}>Edit profile to continue →</a>
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

                  {/* Membership type selection — single dropdown (athlete / coach /
                      both). "Both" is charged the higher single fee, not the sum. */}
                  {offeredTypes.length > 1 && purchasableTypes.length > 0 && (
                    <div style={{ marginBottom: 14 }}>
                      <Field label="Membership type to purchase">
                        <select
                          className="input"
                          value={selectedTypes.length > 1 ? 'both' : (selectedTypes[0] ?? '')}
                          onChange={(e) => {
                            const v = e.target.value;
                            setSelectedTypes(
                              v === 'both'
                                ? purchasableTypes.filter((t) => t === 'athlete' || t === 'coach')
                                : [v as MembershipType],
                            );
                          }}
                        >
                          {purchasableTypes.includes('athlete') && (
                            <option value="athlete">Athlete — {fmtMoney(selPrice(['athlete']))}</option>
                          )}
                          {purchasableTypes.includes('coach') && (
                            <option value="coach">Coach — {fmtMoney(selPrice(['coach']))}</option>
                          )}
                          {purchasableTypes.includes('athlete') && purchasableTypes.includes('coach') && (
                            <option value="both">Both (Athlete + Coach) — {fmtMoney(selPrice(['athlete', 'coach']))}</option>
                          )}
                        </select>
                      </Field>
                      {existingForSeason.some((m) => m.status === 'active') && (
                        <p style={{ color: 'var(--green-600)', fontSize: 13, margin: '4px 0 0' }}>
                          Your existing {season.name} membership is credited toward this price.
                        </p>
                      )}
                    </div>
                  )}

                  <label className="checkrow">
                    <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
                    I confirm this information is current and correct.
                  </label>
                  <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                    <button
                      className="btn primary"
                      disabled={!confirmed || selectedTypes.length === 0}
                      onClick={() => setStep('waiver')}
                    >
                      Continue →
                    </button>
                    <a className="btn ghost" href={profileReturnUrl}>Edit profile first</a>
                  </div>
                </>
              )}
            </div>
          )}

          {/* STEP 2 — Waiver */}
          {step === 'waiver' && (
            <div className="card card-pad">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 8 }}>
                <h3 className="card-title" style={{ marginBottom: 0 }}>Step 2 of 3 — Sign the {season.name} waiver</h3>
                <button className="btn ghost small" onClick={goBack}>← Back</button>
              </div>
              {offeredTypes.length > 1 && selectedTypes.length > 0 && (
                <p style={{ fontSize: 14, color: 'var(--ink-soft)', marginTop: 0 }}>
                  Purchasing: {selectedTypes.map(typeLabel).join(' + ')} membership
                  {selectedTypes.length > 1 ? 's' : ''} for {season.name}
                </p>
              )}

              {waiverDoc ? (
                <div style={{ background: 'var(--ice-100)', border: '1px solid var(--line)', borderRadius: 8,
                  padding: 14, fontSize: 13, maxHeight: 280, overflowY: 'auto', marginBottom: 14 }}
                  dangerouslySetInnerHTML={{ __html: sanitizeWaiverHtml(waiverDoc.body) }} />
              ) : (
                <div style={{ background: 'var(--ice-100)', border: '1px solid var(--line)', borderRadius: 8,
                  padding: 14, fontSize: 13, marginBottom: 14, color: 'var(--ink-soft)' }}>
                  Loading the current waiver…
                </div>
              )}

              {!isMinor && (
                <>
                  <Field label="Type your full legal name to sign"
                    hint="This is a legal electronic signature; timestamp and IP are recorded.">
                    <input type="text" value={waiverSig} onChange={(e) => setWaiverSig(e.target.value)} placeholder={expectedSig} />
                  </Field>
                  {waiverSig.trim().length > 0 && !sigMatchesName && (
                    <p style={{ color: 'var(--coral-600)', fontSize: 13, marginTop: -8, marginBottom: 10 }}>
                      Your signature must match your name on file: <strong>{expectedSig}</strong>.
                    </p>
                  )}
                  <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13.5, marginBottom: 12 }}>
                    <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                    <span>I have read the waiver(s) above and agree to sign them electronically.</span>
                  </label>
                  <button className="btn primary" disabled={!waiverValid || signing} onClick={signSelf}>
                    {signing ? 'Signing…' : 'Sign & continue →'}
                  </button>
                </>
              )}

              {isMinor && (
                <>
                  <Badge tone="warn">Under 18</Badge>
                  <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13.5, margin: '8px 0 12px' }}>
                    <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                    <span>I confirm a parent/guardian will sign this waiver electronically on the athlete's behalf.</span>
                  </label>
                  {sentGuardian ? (
                    <>
                      <p style={{ fontSize: 14 }}>Signing link sent to {guardianEmail}. The membership activates once the guardian signs.</p>
                      <button className="btn primary" onClick={() => setStep('pay')}>Continue to payment →</button>
                    </>
                  ) : (
                    <>
                      <Field label="Guardian name"><input type="text" value={guardianName} onChange={(e) => setGuardianName(e.target.value)} /></Field>
                      <Field label="Guardian email"><input type="email" placeholder="guardian@example.com" value={guardianEmail} onChange={(e) => setGuardianEmail(e.target.value)} /></Field>
                      <button className="btn primary" disabled={!waiverDoc || !consent || signing} onClick={sendGuardian}>
                        {signing ? 'Sending…' : 'Email guardian a signing link'}
                      </button>
                    </>
                  )}
                </>
              )}
            </div>
          )}

          {/* STEP 3 — Payment */}
          {step === 'pay' && (
            <div className="card card-pad">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 8 }}>
                <h3 className="card-title" style={{ marginBottom: 0 }}>Step 3 of 3 — Payment</h3>
                <button className="btn ghost small" onClick={goBack}>← Back</button>
              </div>

              {/* Line items per type */}
              {selectedTypes.map((t) => (
                <div key={t} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15, marginBottom: 4 }}>
                  <span>{typeLabel(t)} membership · {season.name}</span>
                  <strong>{fmtMoney(pricePerType(t))}</strong>
                </div>
              ))}

              {/* Coupon discount */}
              {couponDef && discount > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--green-600)', fontSize: 14, marginBottom: 4 }}>
                  <span>Coupon {couponDef.code}</span><span>−{fmtMoney(discount)}</span>
                </div>
              )}
              {couponDef && discount === 0 && (
                <div style={{ fontSize: 13, color: 'var(--ink-soft)', marginBottom: 4 }}>
                  Coupon {couponDef.code} applied (no additional discount — price already reduced by existing membership).
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 17, fontWeight: 700, borderTop: '2px solid var(--navy-800)', paddingTop: 8, marginBottom: 14 }}>
                <span>Total</span><span>{fmtMoney(discounted)}</span>
              </div>

              {/* Coupon input */}
              <Field label="Coupon code">
                <input
                  type="text"
                  value={coupon}
                  onChange={(e) => setCoupon(e.target.value)}
                  placeholder="e.g. NEWCLUB26"
                />
              </Field>
              {coupon.trim().length > 0 && !couponDef && (
                <p style={{ color: 'var(--coral-600)', fontSize: 13, marginTop: -8, marginBottom: 10 }}>
                  {(() => {
                    const raw = db.coupons.find(
                      (c) => c.code === coupon.toUpperCase() && (c.appliesTo === 'membership' || c.appliesTo === 'any'),
                    );
                    if (!raw) return 'Coupon code not found.';
                    return 'This coupon is expired or has reached its usage limit.';
                  })()}
                </p>
              )}

              <div className="card card-pad" style={{ background: 'var(--coral-100)', border: 'none', marginBottom: 14, padding: 12, fontSize: 13.5 }}>
                <strong>Membership fees are non-refundable.</strong> Refunds are only issued for genuine
                mistakes (e.g. duplicate purchase) and require league admin approval.
              </div>

              {/* Payment method */}
              <Field label="Payment method">
                <select className="input" value={payMethod} onChange={(e) => setPayMethod(e.target.value as 'card' | 'club')}>
                  <option value="card">Pay now — credit / debit card</option>
                </select>
              </Field>

              <div className="grid cols-2">
                <Field label="Card number"><input type="text" placeholder="4242 4242 4242 4242" /></Field>
                <div className="grid cols-2">
                  <Field label="Exp"><input type="text" placeholder="MM/YY" /></Field>
                  <Field label="CVC"><input type="text" placeholder="123" /></Field>
                </div>
              </div>
              {/* Task 6: Save card on file — disabled/coming soon */}
              <label className="checkrow" style={{ opacity: 0.55, cursor: 'not-allowed', marginBottom: 12 }}>
                <input
                  type="checkbox"
                  checked={saveCard}
                  disabled
                  style={{ cursor: 'not-allowed' }}
                  readOnly
                />
                Save this card for future use <span style={{ fontSize: 12, color: 'var(--ink-soft)', marginLeft: 4 }}>(coming soon)</span>
              </label>

              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn primary" onClick={() => complete('card')}>
                  Pay {fmtMoney(discounted)}
                </button>

                {/* Task 4: Admin Payment Override */}
                {(caps.isAdmin || caps.actingAsAdmin) && (
                  <button
                    className="btn ghost"
                    style={{ borderColor: 'var(--amber-600)', color: 'var(--amber-700)' }}
                    onClick={() => complete('comp')}
                    title="Admin override: grant membership at $0 (comp). Creates $0 invoice, sets paidVia: comp."
                  >
                    Admin Payment Override ($0)
                  </button>
                )}

                {/* Send to club cart — only when the club allows members to push fees to its cart */}
                {club?.allowClubPay && (
                  <button
                    className="btn ghost"
                    style={{ borderColor: 'var(--coral-400)', color: 'var(--coral-600)' }}
                    onClick={() => complete('club')}
                    title={`Add this membership fee to ${club.name}'s club cart instead of paying now. Your membership stays pending until a club manager pays.`}
                  >
                    Send to Club Cart
                  </button>
                )}
              </div>

              {club?.allowClubPay && (
                <p style={{ fontSize: 13, color: 'var(--ink-soft)', marginTop: 10, marginBottom: 0 }}>
                  <strong>Send to Club Cart</strong> adds this {fmtMoney(discounted)} fee to {club.name}'s
                  cart instead of paying now. Your membership stays <strong>pending</strong> until a club
                  manager settles the cart — they'll see the item on their dashboard with your name on it.
                </p>
              )}

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
