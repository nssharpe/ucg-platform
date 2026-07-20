import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useDB, mutate } from '../lib/store';
import { useCapabilities } from '../lib/capabilities';
import { Badge, Field } from '../components/ui';
import { useToast } from '../components/ui-hooks';
import { fmtMoney } from '../lib/scoring';
import { pushCartItem, pushInvoice, pushMembership, fetchPublishedWaiver, recordWaiverSignature, requestGuardianWaiver, notifyClubCart, sendMembershipWelcome } from '../lib/supabase';
import type { Athlete, InvoiceItem, Membership, MembershipType, WaiverDocument } from '../lib/types';
import { GENERAL_WAIVER_TYPE } from '../lib/types';
import { isMinorAt, expectedWaiverSignerName, waiverNameMatches } from '../lib/waivers-core';
import { membershipHolds } from '../lib/capabilities-core';
import { purchasableSeasons, isFutureSeason, currentSeason } from '../lib/season-lifecycle';
import { sanitizeWaiverHtml } from '../lib/sanitize-html';
import {
  offeredMembershipTypes,
  membershipFee,
  priceForTypes,
} from '../lib/pricing';

export function Membership() {
  const db = useDB();
  const caps = useCapabilities();
  if (!caps.person) {
    return (
      <div className="card card-pad" style={{ maxWidth: 520 }}>
        <h2 className="display" style={{ fontSize: 22 }}>Finishing sign-in…</h2>
        <p>We're linking your account to your member profile. If this persists, refresh the page.</p>
      </div>
    );
  }
  // No current-by-date season, and no past season to fall back to (see
  // `currentSeason` in season-lifecycle.ts) — nothing is purchasable yet.
  if (!currentSeason(db)) {
    return (
      <div className="card card-pad" style={{ maxWidth: 520 }}>
        <h2 className="display" style={{ fontSize: 22 }}>No active season</h2>
        <p>There's no membership season configured right now. Check back soon.</p>
      </div>
    );
  }
  return <MembershipInner me={caps.person} />;
}

// Returns a human-readable label for each required field that is missing.
function missingProfileFields(me: Athlete): string[] {
  const missing: string[] = [];
  const roles = me.roles ?? { athlete: me.kind !== 'coach', coach: me.kind === 'coach' };
  const isAthlete = roles.athlete;
  const coachOnly = roles.coach && !roles.athlete;

  if (!me.firstName?.trim()) missing.push('First name');
  if (!me.lastName?.trim()) missing.push('Last name');
  if (!me.dob?.trim()) missing.push('Date of birth');
  if (!me.outsideUs && !me.state?.trim()) missing.push(coachOnly ? 'Coaching state' : 'Training state');
  if (!me.phone?.trim()) missing.push('Phone number');
  if (!me.shirt?.trim()) missing.push('T-shirt size');
  if (isAthlete && !me.studentStatus?.trim()) missing.push('Student status');
  if (isAthlete && !me.gradYear) missing.push('Undergrad graduation year');
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

  // P3 (2026-07-20): purchasable = current-by-date season, plus any FUTURE
  // season an admin has flipped `active` — a past season is never
  // purchasable. `Membership()` (the wrapper above) already guarantees a
  // current season exists before this component renders.
  const purchasable = purchasableSeasons(db);
  const activeSeason = currentSeason(db)!;

  // Honor ?season= param when returning from Profile (task 3)
  const seasonParam = searchParams.get('season');
  const initialSeasonId = (seasonParam && db.seasons.find((s) => s.id === seasonParam))
    ? seasonParam
    : activeSeason.id;

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

  // Check whether every offered type has ALREADY been submitted this season —
  // active, or already sent off and awaiting the club's payment or a guardian
  // waiver. Broader than `purchasableTypes` (which only excludes ACTIVE, since
  // it also drives default type-selection/pricing for a NEW purchase): without
  // this, a refresh right after pushing a fee to the club cart (or sending a
  // guardian waiver) re-initialized `step` to 'info' instead of 'done',
  // restarting the purchase flow at "Step 1 of 3 — Confirm your info" and
  // letting the member click "Send to Club Cart" again for the same
  // membership (B8 — duplicate club-cart line; the underlying membership row
  // itself upserts safely, but each push creates a NEW cart_items row).
  const alreadySubmittedTypes = new Set(
    existingForSeason.filter((m) => m.status !== 'none').map((m) => m.type),
  );
  const allOwned = offeredTypes.length > 0
    && offeredTypes.every((t) => alreadySubmittedTypes.has(t))
    && existingForSeason.length > 0;

  const [step, setStep] = useState<'info' | 'waiver' | 'pay' | 'done'>(allOwned ? 'done' : 'info');
  const [confirmed, setConfirmed] = useState(false);
  const [waiverSig, setWaiverSig] = useState('');

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

  const expectedSig = expectedWaiverSignerName(me.firstName, me.lastName);
  const sigMatchesName = waiverNameMatches(waiverSig, me.firstName, me.lastName);
  const waiverValid = !!waiverDoc && consent && !isMinor && sigMatchesName;

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

  // Total for selected types.
  const subtotal = selPrice(selectedTypes);

  // Profile return URL — include season so we resume the right one (task 3)
  const profileReturnUrl = `#/me?return=membership${seasonId !== activeSeason.id ? `&season=${seasonId}` : ''}`;

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
    // Re-derive purchasable types for new season
    const newSeason = db.seasons.find((s) => s.id === newId)!;
    const newExisting = me.memberships.filter((m) => m.seasonId === newId);
    const newPurchasable = offeredTypes.filter(
      (t) => !newExisting.some((m) => m.type === t && m.status === 'active'),
    );
    setSelectedTypes(newPurchasable);
    // Same broadened check as `allOwned` above (B8): a type already sent off
    // and awaiting the club's payment or a guardian waiver also counts as
    // "done" here, not just active.
    const newAlreadySubmitted = new Set(newExisting.filter((m) => m.status !== 'none').map((m) => m.type));
    if (offeredTypes.length > 0 && offeredTypes.every((t) => newAlreadySubmitted.has(t)) && newExisting.length > 0) {
      setStep('done');
    } else if (newSeason) { /* step stays 'info' */ }
  };

  // 'card' is intentionally NOT an option here — that path used to complete a
  // membership client-side with a decorative, unwired card form (no real
  // charge). Real card payment goes through addToCartAndCheckout below (the
  // Stripe-backed /cart/memberships flow). Only the two non-card admin/club
  // paths remain: 'comp' (admin override, real $0 invoice) and 'club' (push
  // the fee to the club cart, pending until a manager pays).
  const complete = (via: 'club' | 'comp') => {
    // "First membership" signal — computed from the PRE-purchase membership list.
    // Welcome fires once: only when the member held no prior active/paid (or
    // club-payment-pending) membership before this purchase. Pending-waiver-only
    // rows don't count as a completed purchase. (Server re-checks no-club +
    // Outside-US; this guard is the once-only gate.)
    const hadPriorMembership = me.memberships.some(
      (m) => m.status === 'active' || m.status === 'pending-club-payment' || m.clubCartPending || m.paidVia != null,
    );

    const applied = mutate((d) => {
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
          paidVia: via === 'comp' ? 'comp' : 'club',
          // Payment hold is independent of the waiver hold: a club-pushed fee is
          // pending until the club pays, even while a minor's waiver is still open.
          ...(via === 'club' ? { clubCartPending: true } : {}),
          ...(via === 'comp' ? { activatedByAdmin: true } : {}),
        };
        p.memberships.push(membership);
        pushMembership(p.id, membership);
      }

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

      if (via === 'club' && club) {
        const adderName = `${me.firstName} ${me.lastName}`;
        const cart = d.carts[club.id] ?? (d.carts[club.id] = []);
        const addedItems: { label: string; amount: number }[] = [];
        for (const t of selectedTypes) {
          const labelType = t === 'coach' ? 'Coach' : 'Athlete';
          const label = `${labelType} Membership ${season.name} — ${adderName} (added by ${adderName})`;
          // Deterministic id (person+season+type, not Date.now()) so a repeat
          // submit — e.g. the member double-clicking, or a stale page reaching
          // this action again before the `allOwned` fix above kicks in — is a
          // safe upsert onto the SAME cart line instead of adding a second one
          // (B8 double-submit guard).
          const item = {
            id: `ci-membership-${club.id}-${me.id}-${seasonId}-${t}`,
            label,
            amount: pricePerType(t),
            kind: 'membership' as const,
            refUserId: me.id,
            refSeasonId: seasonId,
            refType: t,
          };
          const existingIdx = cart.findIndex((c) => c.id === item.id);
          if (existingIdx >= 0) cart[existingIdx] = item;
          else cart.push(item);
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
        };
        d.invoices.push(invoice);
        pushInvoice(invoice);
      }
    });
    if (!applied) return; // offline read-only gate — no false success step/toast

    setStep('done');

    if (via === 'comp') {
      toast(`Membership granted by admin override. Activated at $0.`);
    } else {
      toast(`Sent to ${club?.name} club cart — your membership activates once the club pays.`);
    }

    // "Welcome to UCG" email for a no-club member's FIRST membership-only
    // purchase via admin comp (NOT the club-cart push, and NOT a real card
    // payment — that now goes through addToCartAndCheckout below, which does
    // not yet trigger this welcome email; see its comment). Best-effort; never
    // blocks the UX. Conditions checked here: no-club + not Outside US + first
    // membership. The server re-validates no-club + Outside-US before sending.
    if (via === 'comp' && me.mainClubId == null && !me.outsideUs && !hadPriorMembership) {
      if (!isMinor) {
        void sendMembershipWelcome(me.id).catch(() => { /* non-fatal */ });
      }
    }
  };

  // Real card payment: push the selected membership(s) to the member's OWN
  // cart (mirrors the existing club-cart item shape) and hand off to the
  // Stripe-backed checkout at /cart/memberships — the same flow Cart.tsx uses.
  // Replaces the old direct-pay card step, which was a decorative, never-wired
  // "Card number"/"Exp"/"CVC" form that granted the membership immediately with
  // NO real charge (its own copy said "Demo prototype — no real payment is
  // processed"). Amounts here are display-only; create-checkout-session
  // recomputes everything server-side. The "first membership" welcome email
  // for THIS path fires from stripe-webhook's fulfillment (once the payment
  // actually clears), not from here — it checks each target's prior
  // memberships itself, mirroring the once-only guard above.
  const addToCartAndCheckout = () => {
    const applied = mutate((d) => {
      const cart = d.carts[me.id] ?? (d.carts[me.id] = []);
      for (const t of selectedTypes) {
        const labelType = t === 'coach' ? 'Coach' : 'Athlete';
        const item = {
          id: `ci-${Date.now()}-${t}`,
          label: `${labelType} membership ${season.name} — ${me.firstName} ${me.lastName}`,
          amount: pricePerType(t),
          kind: 'membership' as const,
          refUserId: me.id,
          refSeasonId: seasonId,
          refType: t,
        };
        cart.push(item);
        pushCartItem(me.id, item, false);
      }
    });
    if (!applied) return; // offline read-only gate — don't route to checkout
    navigate('/cart/memberships');
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
        UCG membership is required for all event registration. Valid July 1 – June 30 of the membership season.
      </p>

      {/* Season selector */}
      <Field label="Season">
        <select className="input" value={seasonId} onChange={(e) => onSeasonChange(e.target.value)}>
          {purchasable.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}{s.id === activeSeason.id ? ' (current season)' : ''}
              {offeredTypes.length <= 1
                ? ` — ${fmtMoney(s.athleteFee)}`
                : ` — Athlete ${fmtMoney(s.athleteFee)} / Coach ${fmtMoney(s.coachFee)}`}
            </option>
          ))}
        </select>
      </Field>

      {/* Task 8: non-current season warning. An `active` FUTURE season gets
          the sharper "next season" wording the spec calls for (unmissable —
          it's easy to not notice the season dropdown changed); a past-but-
          still-`active` season keeps the original generic wording. */}
      {season.id !== activeSeason.id && isFutureSeason(db, season) && (
        <div className="card card-pad" style={{ borderLeft: '4px solid var(--gold)', background: 'var(--gold-100)', marginBottom: 16 }}>
          ⚠ <strong>Please be aware that you are purchasing a membership for next season</strong> ({season.name}, starts {season.startsOn}) — not the current one.
        </div>
      )}
      {season.id !== activeSeason.id && !isFutureSeason(db, season) && (
        <div className="card card-pad" style={{ borderLeft: '4px solid var(--gold)', marginBottom: 16 }}>
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
                    Autofilled from your profile. Please actually read it — wrong info here follows you to every event.
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
                        <p style={{ color: 'var(--teal-900)', fontSize: 13, margin: '4px 0 0' }}>
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

              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 17, fontWeight: 700, borderTop: '2px solid var(--navy-800)', paddingTop: 8, marginBottom: 14 }}>
                <span>Total</span><span>{fmtMoney(subtotal)}</span>
              </div>

              <div className="card card-pad" style={{ background: 'var(--coral-100)', border: 'none', marginBottom: 14, padding: 12, fontSize: 13.5 }}>
                <strong>Membership fees are non-refundable.</strong> Refunds are only issued for genuine
                mistakes (e.g. duplicate purchase) and require league admin approval.
              </div>

              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn primary" onClick={addToCartAndCheckout}>
                  Continue to secure checkout →
                </button>

                {/* Task 4: Admin Payment Override */}
                {caps.isAdmin && (
                  <button
                    className="btn ghost"
                    style={{ borderColor: 'var(--gold)', color: 'var(--warn)' }}
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

              <p style={{ fontSize: 13, color: 'var(--ink-soft)', marginTop: 10, marginBottom: 0 }}>
                <strong>Continue to secure checkout</strong> takes you to a Stripe-hosted payment form
                (card details, any promo code, and the processing fee shown there) — nothing is charged
                on this page.
                {club?.allowClubPay && <> Or, <strong>Send to Club Cart</strong> adds this {fmtMoney(subtotal)} fee to {club.name}'s
                cart instead of paying now — your membership stays <strong>pending</strong> until a club
                manager settles the cart; they'll see the item on their dashboard with your name on it.</>}
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
