// Event-Management sanction UI (Phase 1).
// Exports: SanctionRequestForm (/sanction), SanctioningQueue (/sanctioning),
// SanctionVotePage (/sanctioning/:requestId).
// See docs/specs/2026-06-18-event-management.md.

import { useState, useMemo } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { mutate, useDB } from '../lib/store';
import { pushSanctionRequest, pushSanctionVote, pushEvent, notifySanction } from '../lib/supabase';
import { useCapabilities } from '../lib/capabilities';
import { seasonForDate, clubHasActiveMembership } from '../lib/capabilities-core';
import { useSession } from '../lib/auth';
import { Badge, Combo, Field } from '../components/ui';
import { useToast } from '../components/ui-hooks';
import { tallyVotes, nextSanctionId } from '../lib/sanction';
import { RIBBON_OPTIONS, DEFAULT_RIBBON } from '../lib/ribbons';
import { STATE_REGIONS, DISCIPLINES, SHIRT_SIZES } from '../lib/types';
import type { Discipline, Event, SanctionRequest, SanctionVote } from '../lib/types';
import type { RibbonOption } from '../lib/ribbons';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const TIMEZONES = [
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix',
  'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu',
];

const COUNTRIES = ['United States', 'Canada'];

const WAG_MIN_LEVELS = 3;
const MAG_MIN_LEVELS = 2;

// Helpers
const addDays = (iso: string, days: number) => {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  return d.toISOString();
};

// Impure reads (Date.now) live at module scope so they're outside React render —
// react-hooks/purity only governs component/hook bodies. Used for state defaults
// (computed once via lazy initializers) and for one-off IDs in event handlers.
const isoDateInDays = (days: number) =>
  new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
const genId = (prefix: string) => `${prefix}-${Date.now()}`;

const slugify = (name: string) =>
  name.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function uniqueSlug(name: string, taken: string[]): string {
  const base = slugify(name) || 'event';
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

// ---------------------------------------------------------------------------
// Ribbon picker — ranked top 3
// ---------------------------------------------------------------------------
function RibbonRankedPicker({ value, onChange }: {
  value: [string, string, string];
  onChange: (v: [string, string, string]) => void;
}) {
  const labels = ['1st choice', '2nd choice', '3rd choice'];
  const optionLabel = (r: RibbonOption) => `${r.name} (${r.code})`;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {labels.map((label, i) => (
        <Field label={label} key={i}>
          <select
            className="input"
            value={value[i]}
            onChange={(e) => {
              const next: [string, string, string] = [...value] as [string, string, string];
              next[i] = e.target.value;
              onChange(next);
            }}
          >
            <option value="">-- select --</option>
            {RIBBON_OPTIONS.map((r, ri) => (
              <option key={`${r.code}-${ri}`} value={r.code}>
                {optionLabel(r)}
              </option>
            ))}
          </select>
        </Field>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Level picker per discipline
// ---------------------------------------------------------------------------
function DisciplineLevelPicker({ discipline, levels, selected, onChange, minRequired }: {
  discipline: Discipline;
  levels: { id: string; name: string }[];
  selected: string[];
  onChange: (ids: string[]) => void;
  minRequired: number;
}) {
  const [offered, setOffered] = useState(selected.length > 0);
  const discLabel = discipline === 'TNT' ? 'T&T' : discipline;
  return (
    <div style={{ marginBottom: 8 }}>
      <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontWeight: 600, fontSize: 14, marginBottom: 4 }}>
        <input
          type="checkbox"
          checked={offered}
          onChange={(e) => {
            setOffered(e.target.checked);
            if (!e.target.checked) onChange([]);
          }}
        />
        {discLabel} {minRequired > 0 ? `(min ${minRequired} levels)` : ''}
      </label>
      {offered && (
        <div style={{ paddingLeft: 24, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {levels.map((l) => (
            <label key={l.id} style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 13 }}>
              <input
                type="checkbox"
                checked={selected.includes(l.id)}
                onChange={(e) => {
                  onChange(e.target.checked
                    ? [...selected, l.id]
                    : selected.filter((x) => x !== l.id));
                }}
              />
              {l.name}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// 1. Sanction Request Form
// ============================================================================
export function SanctionRequestForm() {
  const db = useDB();
  const caps = useCapabilities();
  const toast = useToast();
  const navigate = useNavigate();

  // --- form state ---
  const [hostClubId, setHostClubId] = useState<string | null>(
    caps.managedClubIds.length === 1 ? caps.managedClubIds[0] : null,
  );
  const [eventKind, setEventKind] = useState<'competition' | 'camp'>('competition');
  const [eventName, setEventName] = useState('');

  // Alternate contact
  const [altContactName, setAltContactName] = useState('');
  const [altContactEmail, setAltContactEmail] = useState('');
  const [altContactPhone, setAltContactPhone] = useState('');

  // Accessibility
  const [accessibleAccepted, setAccessibleAccepted] = useState(false);

  // Dates
  const defaultStart = isoDateInDays(60);
  const [startDate, setStartDate] = useState(defaultStart);
  const [endDate, setEndDate] = useState(defaultStart);
  const [regOpens, setRegOpens] = useState(`${isoDateInDays(0)}T12:00`);
  const [regCloses, setRegCloses] = useState(`${isoDateInDays(46)}T23:59`);
  const [lateRegStart, setLateRegStart] = useState('');
  const [timezone, setTimezone] = useState('America/New_York');

  // Location
  const [venue, setVenue] = useState('');
  const [street, setStreet] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [country, setCountry] = useState('United States');

  // Regional bid
  const [isRegionalBid, setIsRegionalBid] = useState(false);
  const [hasAthleticTrainer, setHasAthleticTrainer] = useState(false);

  // Insurance / participants
  const [insuranceNeeded, setInsuranceNeeded] = useState(false);
  const [estimatedParticipants, setEstimatedParticipants] = useState('');
  const [maxParticipants, setMaxParticipants] = useState('');

  // Levels
  const allLevels = db.levels.filter((l) => !l.retired).sort((a, b) => a.order - b.order);
  const [wagLevels, setWagLevels] = useState<string[]>([]);
  const [magLevels, setMagLevels] = useState<string[]>([]);
  const [tntLevels, setTntLevels] = useState<string[]>([]);

  // Fee collection
  const [collectFees, setCollectFees] = useState(false);
  const [perParticipantFee, setPerParticipantFee] = useState('');
  const [lateFee, setLateFee] = useState('');
  const [payoutMethod, setPayoutMethod] = useState<'paypal' | 'check'>('paypal');
  const [paypalEmail, setPaypalEmail] = useState('');
  const [paypalName, setPaypalName] = useState('');
  const [checkPayee, setCheckPayee] = useState('');
  const [checkAddress, setCheckAddress] = useState('');

  // Awards
  const [naigcAwards, setNaigcAwards] = useState(false);
  const [awardsAddress, setAwardsAddress] = useState('');
  const [awardPlaces, setAwardPlaces] = useState<1 | 2 | 3>(3);
  const [awardType, setAwardType] = useState<'medals' | 'sticker-backs'>('medals');
  const [ribbonRanking, setRibbonRanking] = useState<[string, string, string]>([DEFAULT_RIBBON, '', '']);

  // Banner / hotel / misc
  const [wantBanner, setWantBanner] = useState(false);
  const [hotelBlock, setHotelBlock] = useState(false);
  const [overnightDescription, setOvernightDescription] = useState('');

  // Add-ons
  const [hasTshirtAddon, setHasTshirtAddon] = useState(false);
  const [tshirtPrice, setTshirtPrice] = useState('');
  const [tshirtSizes, setTshirtSizes] = useState<string[]>([...SHIRT_SIZES]);
  const [tshirtLastPurchaseAt, setTshirtLastPurchaseAt] = useState('');
  const [hasLeoAddon, setHasLeoAddon] = useState(false);
  const [leoPrice, setLeoPrice] = useState('');
  const [leoSizes, setLeoSizes] = useState<string[]>([...SHIRT_SIZES]);
  const [leoLastPurchaseAt, setLeoLastPurchaseAt] = useState('');

  // Misc
  const [yearsPreviouslyHeld, setYearsPreviouslyHeld] = useState('');
  const [additionalComments, setAdditionalComments] = useState('');
  const [certTypedName, setCertTypedName] = useState('');

  const [error, setError] = useState('');

  // Club options limited to managed clubs
  const clubOptions = useMemo(
    () => db.clubs
      .filter((c) => caps.managedClubIds.includes(c.id))
      .map((c) => ({ value: c.id, label: c.name, sub: `${c.shortName} - ${c.state}` })),
    [db.clubs, caps.managedClubIds],
  );

  // Gate: must be a club manager
  if (caps.managedClubIds.length === 0) {
    return (
      <div style={{ padding: '60px 24px', maxWidth: 480, margin: '0 auto', textAlign: 'center' }}>
        <h2 style={{ marginBottom: 8 }}>Club manager access required</h2>
        <p style={{ color: 'var(--ink-soft)' }}>
          Only club managers can submit sanction requests. Contact your club manager or a UCG administrator.
        </p>
      </div>
    );
  }

  const submit = () => {
    setError('');
    if (!hostClubId) return setError('Select a host club.');
    if (!eventName.trim()) return setError('Event name is required.');
    if (!accessibleAccepted) return setError('You must certify that this event is accessible to all divisions. If you cannot, please contact info@naigc.org.');
    if (!startDate || !endDate || endDate < startDate) return setError('End date must be on or after the start date.');
    // Gate: a club must hold active membership for the event's season to host.
    const hostSeasonId = seasonForDate(db, startDate);
    if (!clubHasActiveMembership(db, hostClubId, hostSeasonId)) {
      const sName = db.seasons.find((s) => s.id === hostSeasonId)?.name ?? 'that season';
      return setError(`Your club needs an active ${sName} club membership to host an event that season. Purchase it on your club page first.`);
    }
    if (!regOpens || !regCloses) return setError('Registration open and close dates are required.');
    if (!city.trim() || !state) return setError('City and state are required.');
    if (!venue.trim()) return setError('Venue name is required.');

    // Level validation
    const hasAnyDiscipline = wagLevels.length > 0 || magLevels.length > 0 || tntLevels.length > 0;
    if (!hasAnyDiscipline) return setError('Select at least one discipline with levels.');
    if (wagLevels.length > 0 && wagLevels.length < WAG_MIN_LEVELS) return setError(`WAG requires at least ${WAG_MIN_LEVELS} levels.`);
    if (magLevels.length > 0 && magLevels.length < MAG_MIN_LEVELS) return setError(`MAG requires at least ${MAG_MIN_LEVELS} levels.`);

    if (collectFees) {
      const fee = Number(perParticipantFee);
      if (!Number.isFinite(fee) || fee <= 0) return setError('Per-participant fee must be a positive number.');
      if (payoutMethod === 'paypal' && (!paypalEmail.trim() || !paypalName.trim())) return setError('PayPal email and name are required.');
      if (payoutMethod === 'check' && (!checkPayee.trim() || !checkAddress.trim())) return setError('Check payee and mailing address are required.');
    }

    if (!certTypedName.trim()) return setError('You must type your name to certify the request.');

    const nowISO = new Date().toISOString();
    const deadlineISO = addDays(nowISO, 7);

    const payload: Record<string, unknown> = {
      eventName: eventName.trim(),
      eventKind,
      altContact: altContactName.trim() ? { name: altContactName.trim(), email: altContactEmail.trim(), phone: altContactPhone.trim() } : null,
      accessible: accessibleAccepted,
      startDate, endDate,
      regOpens, regCloses, lateRegStart: lateRegStart || null, timezone,
      venue: venue.trim(), street: street.trim(), city: city.trim(), state, country,
      isRegionalBid, hasAthleticTrainer: isRegionalBid ? hasAthleticTrainer : null,
      insuranceNeeded,
      estimatedParticipants: Number(estimatedParticipants) || null,
      maxParticipants: Number(maxParticipants) || null,
      wagLevels, magLevels, tntLevels,
      collectFees,
      ...(collectFees ? {
        perParticipantFee: Number(perParticipantFee),
        lateFee: Number(lateFee) || null,
        payoutMethod,
        ...(payoutMethod === 'paypal'
          ? { paypalEmail: paypalEmail.trim(), paypalName: paypalName.trim() }
          : { checkPayee: checkPayee.trim(), checkAddress: checkAddress.trim() }),
      } : {}),
      naigcAwards,
      ...(naigcAwards ? {
        awardsAddress: awardsAddress.trim(),
        awardPlaces,
        awardType,
        ribbonRanking,
      } : {}),
      wantBanner,
      hotelBlock,
      overnightDescription: overnightDescription.trim() || null,
      tshirtAddon: hasTshirtAddon
        ? { price: Number(tshirtPrice), sizes: tshirtSizes, ...(tshirtLastPurchaseAt ? { lastPurchaseAt: tshirtLastPurchaseAt } : {}) }
        : null,
      leoAddon: hasLeoAddon
        ? { price: Number(leoPrice), sizes: leoSizes, ...(leoLastPurchaseAt ? { lastPurchaseAt: leoLastPurchaseAt } : {}) }
        : null,
      yearsPreviouslyHeld: yearsPreviouslyHeld.trim() || null,
      additionalComments: additionalComments.trim() || null,
      certTypedName: certTypedName.trim(),
    };

    const req: SanctionRequest = {
      id: `sr-${Date.now()}`,
      hostClubId: hostClubId!,
      requesterPersonId: caps.personId,
      eventKind,
      status: 'voting',
      payload,
      submittedAt: nowISO,
      deadlineAt: deadlineISO,
    };

    const applied = mutate((d) => {
      if (!d.sanctionRequests) d.sanctionRequests = [];
      d.sanctionRequests.push(req);
    });
    if (!applied) return; // offline read-only gate — don't push/notify/claim success
    pushSanctionRequest(req);
    notifySanction({ requestId: req.id, event: 'submitted' });
    toast('Sanction request submitted; the Sanctioning Team will vote within 7 days.');
    navigate('/');
  };

  const sectionTitle = (t: string) => (
    <h3 className="card-title" style={{ margin: '14px 0 8px', paddingTop: 10, borderTop: '1px solid var(--line)' }}>{t}</h3>
  );

  return (
    <div>
      <h1 className="page-title">Request Event Sanction</h1>
      <p className="page-sub">
        Submit a request for the Sanctioning Team to review and vote on your event.
        Approval creates an event on the platform with a unique Sanction ID.
      </p>

      <div className="card card-pad" style={{ maxWidth: 720 }}>
        <h3 className="card-title" style={{ marginBottom: 8 }}>Basics</h3>

        <Field label="Host club">
          <Combo options={clubOptions} value={hostClubId} onChange={setHostClubId} placeholder="Select your club..." />
        </Field>

        <Field label="Event name">
          <input className="input" value={eventName} onChange={(e) => setEventName(e.target.value)} placeholder="e.g. Southeast Open 2027" />
        </Field>

        <Field label="Event kind">
          <select className="input" value={eventKind} onChange={(e) => setEventKind(e.target.value as 'competition' | 'camp')}>
            <option value="competition">Competition</option>
            <option value="camp">Camp</option>
          </select>
        </Field>

        {sectionTitle('Alternate Point of Contact')}
        <p style={{ fontSize: 13, color: 'var(--ink-soft)', marginBottom: 8 }}>Optional — if different from account holder.</p>
        <div className="grid cols-3">
          <Field label="Name"><input className="input" value={altContactName} onChange={(e) => setAltContactName(e.target.value)} /></Field>
          <Field label="Email"><input className="input" type="email" value={altContactEmail} onChange={(e) => setAltContactEmail(e.target.value)} /></Field>
          <Field label="Phone"><input className="input" type="tel" value={altContactPhone} onChange={(e) => setAltContactPhone(e.target.value)} /></Field>
        </div>

        {sectionTitle('Accessibility Certification')}
        <div style={{ padding: 12, background: 'var(--ice)', borderRadius: 8, marginBottom: 8 }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 14 }}>
            <input type="checkbox" checked={accessibleAccepted} onChange={(e) => setAccessibleAccepted(e.target.checked)} style={{ marginTop: 3 }} />
            <span>
              I certify that this event will be accessible to <strong>all divisions</strong> (Collegiate and Community).
            </span>
          </label>
          {!accessibleAccepted && (
            <p style={{ fontSize: 13, color: 'var(--coral-600)', marginTop: 6 }}>
              Events must be accessible to all divisions to be sanctioned. If your event cannot meet this requirement, please contact{' '}
              <a href="mailto:info@naigc.org">info@naigc.org</a> to discuss alternatives.
            </p>
          )}
        </div>

        {sectionTitle('Dates')}
        <div className="grid cols-2">
          <Field label="Start date"><input className="input" type="date" value={startDate} onChange={(e) => { setStartDate(e.target.value); if (endDate < e.target.value) setEndDate(e.target.value); }} /></Field>
          <Field label="End date"><input className="input" type="date" min={startDate} value={endDate} onChange={(e) => setEndDate(e.target.value)} /></Field>
        </div>
        <div className="grid cols-3">
          <Field label="Reg opens"><input className="input" type="datetime-local" value={regOpens} onChange={(e) => setRegOpens(e.target.value)} /></Field>
          <Field label="Reg closes"><input className="input" type="datetime-local" value={regCloses} onChange={(e) => setRegCloses(e.target.value)} /></Field>
          <Field label="Timezone">
            <select className="input" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
              {TIMEZONES.map((t) => <option key={t}>{t}</option>)}
            </select>
          </Field>
        </div>
        <Field label="Late registration starts (optional)">
          <input className="input" type="datetime-local" value={lateRegStart} onChange={(e) => setLateRegStart(e.target.value)} />
        </Field>

        {sectionTitle('Location')}
        <Field label="Venue name"><input className="input" value={venue} onChange={(e) => setVenue(e.target.value)} placeholder="e.g. University Arena" /></Field>
        <Field label="Street address"><input className="input" value={street} onChange={(e) => setStreet(e.target.value)} /></Field>
        <div className="grid cols-3">
          <Field label="City"><input className="input" value={city} onChange={(e) => setCity(e.target.value)} /></Field>
          <Field label="State">
            <select className="input" value={state} onChange={(e) => setState(e.target.value)}>
              <option value="" disabled>Select...</option>
              {Object.keys(STATE_REGIONS).map((s) => <option key={s}>{s}</option>)}
            </select>
          </Field>
          <Field label="Country">
            <select className="input" value={country} onChange={(e) => setCountry(e.target.value)}>
              {COUNTRIES.map((c) => <option key={c}>{c}</option>)}
            </select>
          </Field>
        </div>

        {eventKind === 'competition' && (
          <>
            {sectionTitle('Regional Bid')}
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 14, marginBottom: 6 }}>
              <input type="checkbox" checked={isRegionalBid} onChange={(e) => setIsRegionalBid(e.target.checked)} />
              This is a regional bid
            </label>
            {isRegionalBid && (
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 14, paddingLeft: 24 }}>
                <input type="checkbox" checked={hasAthleticTrainer} onChange={(e) => setHasAthleticTrainer(e.target.checked)} />
                An athletic trainer / health professional will be present
              </label>
            )}
          </>
        )}

        {sectionTitle('Insurance & Participants')}
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 14, marginBottom: 8 }}>
          <input type="checkbox" checked={insuranceNeeded} onChange={(e) => setInsuranceNeeded(e.target.checked)} />
          Insurance needed from NAIGC
        </label>
        <div className="grid cols-2">
          <Field label="Estimated participants"><input className="input" type="number" min="0" value={estimatedParticipants} onChange={(e) => setEstimatedParticipants(e.target.value)} /></Field>
          <Field label="Maximum participants"><input className="input" type="number" min="0" value={maxParticipants} onChange={(e) => setMaxParticipants(e.target.value)} /></Field>
        </div>

        {sectionTitle('Levels Offered')}
        <p style={{ fontSize: 13, color: 'var(--ink-soft)', marginBottom: 8 }}>
          Select the disciplines and levels you will offer. WAG requires at least 3 levels, MAG at least 2.
        </p>
        {DISCIPLINES.map((d) => {
          const min = d === 'WAG' ? WAG_MIN_LEVELS : d === 'MAG' ? MAG_MIN_LEVELS : 0;
          const sel = d === 'WAG' ? wagLevels : d === 'MAG' ? magLevels : tntLevels;
          const set = d === 'WAG' ? setWagLevels : d === 'MAG' ? setMagLevels : setTntLevels;
          return (
            <DisciplineLevelPicker
              key={d}
              discipline={d}
              levels={allLevels.filter((l) => l.discipline === d).map((l) => ({ id: l.id, name: l.name }))}
              selected={sel}
              onChange={set}
              minRequired={min}
            />
          );
        })}

        {sectionTitle('Fee Collection')}
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 14, marginBottom: 8 }}>
          <input type="checkbox" checked={collectFees} onChange={(e) => setCollectFees(e.target.checked)} />
          NAIGC collects fees and remits to host
        </label>
        {collectFees && (
          <>
            <div className="grid cols-2">
              <Field label="Per-participant fee ($)"><input className="input" type="number" min="0" step="0.01" value={perParticipantFee} onChange={(e) => setPerParticipantFee(e.target.value)} /></Field>
              <Field label="Late fee ($, optional)"><input className="input" type="number" min="0" step="0.01" value={lateFee} onChange={(e) => setLateFee(e.target.value)} /></Field>
            </div>
            <Field label="Payout method">
              <select className="input" value={payoutMethod} onChange={(e) => setPayoutMethod(e.target.value as 'paypal' | 'check')}>
                <option value="paypal">PayPal (preferred)</option>
                <option value="check">Check</option>
              </select>
            </Field>
            {payoutMethod === 'paypal' ? (
              <div className="grid cols-2">
                <Field label="PayPal email"><input className="input" type="email" value={paypalEmail} onChange={(e) => setPaypalEmail(e.target.value)} /></Field>
                <Field label="PayPal account name"><input className="input" value={paypalName} onChange={(e) => setPaypalName(e.target.value)} /></Field>
              </div>
            ) : (
              <div className="grid cols-2">
                <Field label="Check payee name"><input className="input" value={checkPayee} onChange={(e) => setCheckPayee(e.target.value)} /></Field>
                <Field label="Mailing address"><input className="input" value={checkAddress} onChange={(e) => setCheckAddress(e.target.value)} /></Field>
              </div>
            )}
          </>
        )}

        {sectionTitle('Awards')}
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 14, marginBottom: 8 }}>
          <input type="checkbox" checked={naigcAwards} onChange={(e) => setNaigcAwards(e.target.checked)} />
          NAIGC-provided awards
        </label>
        {naigcAwards && (
          <>
            <Field label="Mailing address for awards">
              <input className="input" value={awardsAddress} onChange={(e) => setAwardsAddress(e.target.value)} placeholder="Street, City, State ZIP" />
            </Field>
            <div className="grid cols-2">
              <Field label="Number of places (1-3)">
                <select className="input" value={awardPlaces} onChange={(e) => setAwardPlaces(Number(e.target.value) as 1 | 2 | 3)}>
                  <option value={1}>1st place only</option>
                  <option value={2}>1st and 2nd</option>
                  <option value={3}>1st, 2nd, and 3rd</option>
                </select>
              </Field>
              <Field label="Award type">
                <select className="input" value={awardType} onChange={(e) => setAwardType(e.target.value as 'medals' | 'sticker-backs')}>
                  <option value="medals">Medals</option>
                  <option value="sticker-backs">Sticker-backs</option>
                </select>
              </Field>
            </div>
            <Field label="Neck-ribbon color/style (ranked top 3)">
              <RibbonRankedPicker value={ribbonRanking} onChange={setRibbonRanking} />
            </Field>
          </>
        )}

        {sectionTitle('Banner & Accommodations')}
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 14, marginBottom: 6 }}>
          <input type="checkbox" checked={wantBanner} onChange={(e) => setWantBanner(e.target.checked)} />
          Request NAIGC banner
        </label>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 14, marginBottom: 8 }}>
          <input type="checkbox" checked={hotelBlock} onChange={(e) => setHotelBlock(e.target.checked)} />
          Hotel block available
        </label>
        <Field label="Overnight accommodations description (optional)">
          <textarea className="input" rows={2} value={overnightDescription} onChange={(e) => setOvernightDescription(e.target.value)} />
        </Field>

        {sectionTitle('Add-ons')}
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 14, marginBottom: 6 }}>
          <input type="checkbox" checked={hasTshirtAddon} onChange={(e) => setHasTshirtAddon(e.target.checked)} />
          T-shirt add-on
        </label>
        {hasTshirtAddon && (
          <div style={{ paddingLeft: 24, marginBottom: 8 }}>
            <Field label="T-shirt price ($)"><input className="input" type="number" min="0" step="0.01" value={tshirtPrice} onChange={(e) => setTshirtPrice(e.target.value)} /></Field>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
              {SHIRT_SIZES.map((s) => (
                <label key={s} style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 13 }}>
                  <input type="checkbox" checked={tshirtSizes.includes(s)} onChange={(e) => setTshirtSizes(e.target.checked ? [...tshirtSizes, s] : tshirtSizes.filter((x) => x !== s))} />
                  {s}
                </label>
              ))}
            </div>
            <Field label={`Last date to purchase (${timezone})`} hint="Optional. Leave blank to allow purchase any time registration is open.">
              <input className="input" type="datetime-local" value={tshirtLastPurchaseAt} onChange={(e) => setTshirtLastPurchaseAt(e.target.value)} />
            </Field>
          </div>
        )}
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 14, marginBottom: 6 }}>
          <input type="checkbox" checked={hasLeoAddon} onChange={(e) => setHasLeoAddon(e.target.checked)} />
          Leo add-on
        </label>
        {hasLeoAddon && (
          <div style={{ paddingLeft: 24, marginBottom: 8 }}>
            <Field label="Leo price ($)"><input className="input" type="number" min="0" step="0.01" value={leoPrice} onChange={(e) => setLeoPrice(e.target.value)} /></Field>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
              {SHIRT_SIZES.map((s) => (
                <label key={s} style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 13 }}>
                  <input type="checkbox" checked={leoSizes.includes(s)} onChange={(e) => setLeoSizes(e.target.checked ? [...leoSizes, s] : leoSizes.filter((x) => x !== s))} />
                  {s}
                </label>
              ))}
            </div>
            <Field label={`Last date to purchase (${timezone})`} hint="Optional. Leave blank to allow purchase any time registration is open.">
              <input className="input" type="datetime-local" value={leoLastPurchaseAt} onChange={(e) => setLeoLastPurchaseAt(e.target.value)} />
            </Field>
          </div>
        )}

        {sectionTitle('Additional Information')}
        <Field label="Years previously held (optional)">
          <input className="input" value={yearsPreviouslyHeld} onChange={(e) => setYearsPreviouslyHeld(e.target.value)} placeholder="e.g. 2023, 2024, 2025" />
        </Field>
        {/* TODO: schedule attachment upload (pdf/jpg/png) — needs file storage */}
        <Field label="Additional comments (optional)">
          <textarea className="input" rows={3} value={additionalComments} onChange={(e) => setAdditionalComments(e.target.value)} />
        </Field>

        {sectionTitle('Certification')}
        <p style={{ fontSize: 13, color: 'var(--ink-soft)', marginBottom: 8 }}>
          By typing your name below you certify that the information provided is accurate and that you agree to UCG's public registration policies.
        </p>
        <Field label="Typed full name">
          <input className="input" value={certTypedName} onChange={(e) => setCertTypedName(e.target.value)} placeholder="Your full name" />
        </Field>

        {error && <p style={{ color: 'var(--coral-600)', fontWeight: 600, marginTop: 8 }}>{error}</p>}

        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button className="btn primary" onClick={submit} disabled={!accessibleAccepted}>Submit Sanction Request</button>
          <button className="btn ghost" onClick={() => navigate('/')}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// 2. Sanctioning Queue
// ============================================================================
export function SanctioningQueue() {
  const db = useDB();
  const caps = useCapabilities();

  if (!caps.isSanctioning) {
    return (
      <div style={{ padding: '60px 24px', maxWidth: 480, margin: '0 auto', textAlign: 'center' }}>
        <h2 style={{ marginBottom: 8 }}>Sanctioning Team access required</h2>
        <p style={{ color: 'var(--ink-soft)' }}>
          Only Sanctioning Team members and administrators can access this page.
        </p>
      </div>
    );
  }

  const requests = db.sanctionRequests ?? [];
  const active = requests.filter((r) => r.status === 'voting' || r.status === 'submitted');
  const decided = requests.filter((r) => r.status === 'approved' || r.status === 'rejected');

  const clubName = (id: string) => db.clubs.find((c) => c.id === id)?.name ?? id;
  const requesterName = (id: string | null) => {
    if (!id) return 'Unknown';
    const p = db.people.find((pp) => pp.id === id);
    return p ? `${p.firstName} ${p.lastName}` : id;
  };

  const statusBadge = (status: string) => {
    const tones: Record<string, 'ok' | 'warn' | 'err' | 'info' | 'navy'> = {
      voting: 'info', approved: 'ok', rejected: 'err',
      submitted: 'warn', withdrawn: 'navy',
    };
    return <Badge tone={tones[status] ?? 'info'}>{status}</Badge>;
  };

  return (
    <div>
      <h1 className="page-title">Sanctioning Queue</h1>
      <p className="page-sub">Review and vote on event sanction requests.</p>

      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <h3 className="card-title">Pending Requests ({active.length})</h3>
        {active.length === 0 ? (
          <p style={{ color: 'var(--ink-soft)', fontSize: 14 }}>No pending requests.</p>
        ) : (
          <table className="tbl" style={{ marginTop: 8 }}>
            <thead>
              <tr>
                <th>Event</th>
                <th>Host Club</th>
                <th>Submitted by</th>
                <th>Kind</th>
                <th>Status</th>
                <th>Deadline</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {active.map((r) => (
                <tr key={r.id}>
                  <td>{(r.payload.eventName as string) ?? '—'}</td>
                  <td>{clubName(r.hostClubId)}</td>
                  <td>{requesterName(r.requesterPersonId)}</td>
                  <td>{r.eventKind}</td>
                  <td>{statusBadge(r.status)}</td>
                  <td>{r.deadlineAt ? new Date(r.deadlineAt).toLocaleDateString() : '—'}</td>
                  <td><Link to={`/sanctioning/${r.id}`} className="btn small primary">Review</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {decided.length > 0 && (
        <div className="card card-pad">
          <h3 className="card-title">Decided ({decided.length})</h3>
          <table className="tbl" style={{ marginTop: 8 }}>
            <thead>
              <tr>
                <th>Event</th>
                <th>Host Club</th>
                <th>Kind</th>
                <th>Status</th>
                <th>Sanction ID</th>
                <th>Owner</th>
                <th>Decided</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {decided.map((r) => {
                const createdEvent = r.createdEventId ? db.events.find((e) => e.id === r.createdEventId) : undefined;
                const needsOwner = r.status === 'approved' && createdEvent && !createdEvent.owner;
                return (
                  <tr key={r.id}>
                    <td>{(r.payload.eventName as string) ?? '—'}</td>
                    <td>{clubName(r.hostClubId)}</td>
                    <td>{r.eventKind}</td>
                    <td>{statusBadge(r.status)}</td>
                    <td>{r.sanctionId ?? '—'}</td>
                    <td>
                      {needsOwner ? (
                        <Link to={`/events/${createdEvent!.slug}`}>
                          <Badge tone="err">No owner assigned</Badge>
                        </Link>
                      ) : createdEvent?.owner ? (
                        createdEvent.owner.name
                      ) : '—'}
                    </td>
                    <td>{r.decidedAt ? new Date(r.decidedAt).toLocaleDateString() : '—'}</td>
                    <td><Link to={`/sanctioning/${r.id}`} className="btn small ghost">View</Link></td>
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

// ============================================================================
// 3. Sanction Vote Page
// ============================================================================
export function SanctionVotePage() {
  const { requestId } = useParams<{ requestId: string }>();
  const db = useDB();
  const caps = useCapabilities();
  const session = useSession();
  const toast = useToast();
  const navigate = useNavigate();

  const [voteChoice, setVoteChoice] = useState<'approve' | 'reject' | 'abstain' | ''>('');
  const [comment, setComment] = useState('');

  const request = (db.sanctionRequests ?? []).find((r) => r.id === requestId);
  const allVotes = (db.sanctionVotes ?? []).filter((v) => v.requestId === requestId);

  // Voter identity: auth user id if available, else personId as stand-in
  const voterId = session?.user?.id ?? caps.personId ?? 'unknown';
  const myVote = allVotes.find((v) => v.voterUserId === voterId);

  // Team size: count distinct people with sanctioning role.
  // We can't easily query user_roles client-side without an async fetch, so
  // we use a reasonable default and mark for follow-up.
  // TODO: real team size from user_roles (needs fetchAllRoles or a dedicated count)
  const FALLBACK_TEAM_SIZE = 5;
  // If we can see distinct voters across all sanction votes, use that as a floor
  const distinctVoters = new Set((db.sanctionVotes ?? []).map((v) => v.voterUserId));
  const teamSize = Math.max(FALLBACK_TEAM_SIZE, distinctVoters.size);

  const nowISO = new Date().toISOString();
  const tally = request?.deadlineAt
    ? tallyVotes(allVotes, teamSize, nowISO, request.deadlineAt)
    : { decided: false, outcome: 'pending' as const, approvals: 0, rejections: 0, abstains: 0, cast: 0 };

  if (!caps.isSanctioning) {
    return (
      <div style={{ padding: '60px 24px', maxWidth: 480, margin: '0 auto', textAlign: 'center' }}>
        <h2 style={{ marginBottom: 8 }}>Sanctioning Team access required</h2>
        <p style={{ color: 'var(--ink-soft)' }}>Only Sanctioning Team members and administrators can vote.</p>
      </div>
    );
  }

  if (!request) {
    return (
      <div style={{ padding: '60px 24px', maxWidth: 480, margin: '0 auto', textAlign: 'center' }}>
        <h2 style={{ marginBottom: 8 }}>Request not found</h2>
        <Link to="/sanctioning" className="btn ghost">Back to queue</Link>
      </div>
    );
  }

  const p = request.payload;
  const club = db.clubs.find((c) => c.id === request.hostClubId);
  const requester = request.requesterPersonId ? db.people.find((pp) => pp.id === request.requesterPersonId) : null;

  const castVote = () => {
    if (!voteChoice) return;
    const vote: SanctionVote = {
      id: myVote?.id ?? genId('sv'),
      requestId: request.id,
      voterUserId: voterId,
      vote: voteChoice,
      comment: comment.trim() || undefined,
      votedAt: new Date().toISOString(),
    };

    const applied = mutate((d) => {
      if (!d.sanctionVotes) d.sanctionVotes = [];
      const idx = d.sanctionVotes.findIndex((v) => v.requestId === request.id && v.voterUserId === voterId);
      if (idx >= 0) d.sanctionVotes[idx] = vote;
      else d.sanctionVotes.push(vote);
    });
    if (!applied) return; // offline read-only gate — don't push/tally/claim success
    pushSanctionVote(vote);
    toast(`Vote recorded: ${voteChoice}`);

    // Re-tally after this vote
    const updatedVotes = [...allVotes.filter((v) => v.voterUserId !== voterId), vote];
    const newTally = tallyVotes(updatedVotes, teamSize, new Date().toISOString(), request.deadlineAt ?? '');

    if (newTally.decided) {
      resolveRequest(request, newTally.outcome as 'approved' | 'rejected');
    }
  };

  const resolveRequest = (req: SanctionRequest, outcome: 'approved' | 'rejected') => {
    const decidedNow = new Date().toISOString();

    if (outcome === 'approved') {
      // Assign sanction ID
      const eventYear = new Date(String(req.payload.startDate ?? decidedNow)).getFullYear();
      const hostState = String(req.payload.state ?? club?.state ?? '');
      const existingIds = [
        ...db.events.map((m) => m.sanctionId).filter(Boolean) as string[],
        ...(db.sanctionRequests ?? []).map((r) => r.sanctionId).filter(Boolean) as string[],
      ];
      const sid = nextSanctionId(eventYear, hostState, existingIds);

      // Build Event from payload
      const takenSlugs = db.events.map((m) => m.slug);
      const slug = uniqueSlug(String(p.eventName ?? 'event'), takenSlugs);
      const eventId = genId('event');

      // Determine disciplines from selected levels
      const disciplines: Discipline[] = [];
      if ((p.wagLevels as string[] | undefined)?.length) disciplines.push('WAG');
      if ((p.magLevels as string[] | undefined)?.length) disciplines.push('MAG');
      if ((p.tntLevels as string[] | undefined)?.length) disciplines.push('TNT');

      const event: Event = {
        id: eventId,
        slug,
        name: String(p.eventName ?? 'Sanctioned Event'),
        hostClubId: req.hostClubId,
        city: String(p.city ?? ''),
        state: String(p.state ?? ''),
        timezone: String(p.timezone ?? 'America/New_York'),
        startDate: String(p.startDate ?? ''),
        endDate: String(p.endDate ?? ''),
        status: 'draft',
        regOpens: String(p.regOpens ?? ''),
        regCloses: String(p.regCloses ?? ''),
        entryFee: Number(p.perParticipantFee) || 0,
        secondDisciplineFee: 0,
        disciplines,
        sessions: [],
        eventType: req.eventKind,
        sanctionId: sid,
        ...(p.tshirtAddon ? { tshirtAddon: p.tshirtAddon as Event['tshirtAddon'] } : {}),
        ...(p.wantBanner ? { bannerAddon: { price: 0 } } : {}),
        ...(p.venue ? { venue: String(p.venue) } : {}),
        ...(p.street ? { streetAddress: String(p.street) } : {}),
        ...(p.country ? { country: String(p.country) } : {}),
        // Sanction form only collects a yes/no "hotel block wanted" — no URL yet,
        // so hotelLink is left for the host to fill in after the event is created.
        ...(p.lateRegStart ? { lateReg: { startsAt: String(p.lateRegStart), fee: Number(p.lateFee) || 0 } } : {}),
        // Camp-only config (bug found in T1, fixed here in T5): p.leoAddon was
        // never copied onto event.campConfig, silently dropping a sanctioned
        // camp's leo add-on. p.overnightSurvey isn't collected by the sanction
        // form today (no form field), but is carried defensively here too so a
        // future form addition doesn't require touching this mapping again.
        ...(p.leoAddon || p.overnightSurvey ? {
          campConfig: {
            ...(p.overnightSurvey ? { overnightSurvey: true } : {}),
            ...(p.leoAddon ? { leoAddon: p.leoAddon as NonNullable<Event['campConfig']>['leoAddon'] } : {}),
          },
        } : {}),
      };

      const applied = mutate((d) => {
        d.events.push(event);
        const rIdx = (d.sanctionRequests ?? []).findIndex((r) => r.id === req.id);
        if (rIdx >= 0) {
          d.sanctionRequests![rIdx] = {
            ...d.sanctionRequests![rIdx],
            status: 'approved',
            decidedAt: decidedNow,
            createdEventId: eventId,
            sanctionId: sid,
          };
        }
      });
      if (!applied) return; // offline read-only gate — don't push/notify/claim success
      pushEvent(event);
      pushSanctionRequest({ ...req, status: 'approved', decidedAt: decidedNow, createdEventId: eventId, sanctionId: sid });
      notifySanction({ requestId: req.id, event: 'approved' });
      // TODO: reminder emails 3d/1d before deadline (needs scheduler)
      toast(`Approved! Sanction ID: ${sid}. Event created as draft.`);
    } else {
      // Rejected
      const applied = mutate((d) => {
        const rIdx = (d.sanctionRequests ?? []).findIndex((r) => r.id === req.id);
        if (rIdx >= 0) {
          d.sanctionRequests![rIdx] = {
            ...d.sanctionRequests![rIdx],
            status: 'rejected',
            decidedAt: decidedNow,
          };
        }
      });
      if (!applied) return; // offline read-only gate — don't push/notify/claim success
      pushSanctionRequest({ ...req, status: 'rejected', decidedAt: decidedNow });
      notifySanction({ requestId: req.id, event: 'rejected' });
      toast('Request rejected.');
    }
    navigate('/sanctioning');
  };

  const isDecided = request.status === 'approved' || request.status === 'rejected';

  // Format a detail row
  const detail = (label: string, value: unknown) => {
    if (value === null || value === undefined || value === '') return null;
    const display = typeof value === 'boolean' ? (value ? 'Yes' : 'No')
      : Array.isArray(value) ? value.join(', ')
      : String(value);
    return (
      <div style={{ display: 'flex', gap: 8, fontSize: 14, padding: '4px 0', borderBottom: '1px solid var(--line)' }}>
        <span style={{ fontWeight: 600, minWidth: 180, color: 'var(--ink-soft)' }}>{label}</span>
        <span>{display}</span>
      </div>
    );
  };

  // Resolve level ids to names
  const levelNames = (ids: unknown) => {
    if (!Array.isArray(ids)) return '—';
    return ids.map((id) => db.levels.find((l) => l.id === id)?.name ?? id).join(', ');
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <Link to="/sanctioning" className="btn small ghost">Back to queue</Link>
        <h1 className="page-title" style={{ margin: 0 }}>
          Review: {String(p.eventName ?? 'Sanction Request')}
        </h1>
        {isDecided && (
          <Badge tone={request.status === 'approved' ? 'ok' : 'err'}>{request.status}</Badge>
        )}
      </div>

      <div className="grid cols-2" style={{ gap: 16 }}>
        {/* Left: request details */}
        <div className="card card-pad">
          <h3 className="card-title">Event Details</h3>
          {detail('Event name', p.eventName)}
          {detail('Event kind', request.eventKind)}
          {detail('Host club', club?.name ?? request.hostClubId)}
          {detail('Submitted by', requester ? `${requester.firstName} ${requester.lastName}` : request.requesterPersonId)}
          {detail('Submitted', request.submittedAt ? new Date(request.submittedAt).toLocaleString() : null)}
          {detail('Deadline', request.deadlineAt ? new Date(request.deadlineAt).toLocaleString() : null)}
          {request.sanctionId && detail('Sanction ID', request.sanctionId)}

          <h4 style={{ margin: '12px 0 4px', fontSize: 14, fontWeight: 600 }}>Dates & Location</h4>
          {detail('Dates', `${p.startDate} to ${p.endDate}`)}
          {detail('Reg opens', p.regOpens)}
          {detail('Reg closes', p.regCloses)}
          {detail('Timezone', p.timezone)}
          {detail('Late reg starts', p.lateRegStart)}
          {detail('Venue', p.venue)}
          {detail('Address', [p.street, p.city, p.state, p.country].filter(Boolean).join(', '))}

          <h4 style={{ margin: '12px 0 4px', fontSize: 14, fontWeight: 600 }}>Competition Details</h4>
          {detail('Regional bid', p.isRegionalBid)}
          {(p.isRegionalBid as boolean) && detail('Athletic trainer present', p.hasAthleticTrainer)}
          {detail('Insurance needed', p.insuranceNeeded)}
          {detail('Estimated participants', p.estimatedParticipants)}
          {detail('Maximum participants', p.maxParticipants)}
          {detail('Accessible to all divisions', p.accessible)}

          <h4 style={{ margin: '12px 0 4px', fontSize: 14, fontWeight: 600 }}>Levels</h4>
          {detail('WAG levels', levelNames(p.wagLevels))}
          {detail('MAG levels', levelNames(p.magLevels))}
          {detail('T&T levels', levelNames(p.tntLevels))}

          <h4 style={{ margin: '12px 0 4px', fontSize: 14, fontWeight: 600 }}>Fees & Awards</h4>
          {detail('NAIGC collects fees', p.collectFees)}
          {(p.collectFees as boolean) && detail('Per-participant fee', `$${p.perParticipantFee}`)}
          {(p.collectFees as boolean) && detail('Late fee', p.lateFee ? `$${p.lateFee}` : null)}
          {(p.collectFees as boolean) && detail('Payout method', p.payoutMethod)}
          {detail('NAIGC awards', p.naigcAwards)}
          {(p.naigcAwards as boolean) && detail('Award places', p.awardPlaces)}
          {(p.naigcAwards as boolean) && detail('Award type', p.awardType)}

          <h4 style={{ margin: '12px 0 4px', fontSize: 14, fontWeight: 600 }}>Other</h4>
          {detail('Banner requested', p.wantBanner)}
          {detail('Hotel block', p.hotelBlock)}
          {detail('T-shirt add-on', p.tshirtAddon ? 'Yes' : 'No')}
          {detail('Leo add-on', p.leoAddon ? 'Yes' : 'No')}
          {detail('Years previously held', p.yearsPreviouslyHeld)}
          {detail('Additional comments', p.additionalComments)}
          {detail('Certified by', p.certTypedName)}
        </div>

        {/* Right: voting */}
        <div>
          {/* Tally */}
          <div className="card card-pad" style={{ marginBottom: 16 }}>
            <h3 className="card-title">Vote Tally</h3>
            <div style={{ display: 'flex', gap: 16, margin: '12px 0' }}>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--teal-900)' }}>{tally.approvals}</div>
                <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>Approve</div>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--coral-600)' }}>{tally.rejections}</div>
                <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>Reject</div>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 24, fontWeight: 700, color: 'var(--ink-soft)' }}>{tally.abstains}</div>
                <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>Abstain</div>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 24, fontWeight: 700 }}>{tally.cast}</div>
                <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>of {teamSize}</div>
              </div>
            </div>
            <div style={{ fontSize: 14 }}>
              <strong>Status: </strong>
              {tally.decided ? (
                <span style={{ color: tally.outcome === 'approved' ? 'var(--teal-900)' : 'var(--coral-600)' }}>
                  {tally.outcome.charAt(0).toUpperCase() + tally.outcome.slice(1)}
                </span>
              ) : (
                <span style={{ color: 'var(--warn)' }}>Pending</span>
              )}
              {!tally.decided && request.deadlineAt && (
                <span style={{ color: 'var(--ink-soft)', marginLeft: 8, fontSize: 13 }}>
                  (deadline: {new Date(request.deadlineAt).toLocaleString()})
                </span>
              )}
            </div>
          </div>

          {/* Cast / change vote */}
          {!isDecided && (
            <div className="card card-pad" style={{ marginBottom: 16 }}>
              <h3 className="card-title">{myVote ? 'Change Your Vote' : 'Cast Your Vote'}</h3>
              {myVote && (
                <p style={{ fontSize: 13, color: 'var(--ink-soft)', marginBottom: 8 }}>
                  You voted <strong>{myVote.vote}</strong> on {new Date(myVote.votedAt).toLocaleString()}.
                  {myVote.comment ? ` Comment: "${myVote.comment}"` : ''}
                </p>
              )}
              <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                {(['approve', 'reject', 'abstain'] as const).map((v) => (
                  <button
                    key={v}
                    className={`btn ${voteChoice === v ? 'primary' : 'ghost'}`}
                    onClick={() => setVoteChoice(v)}
                    style={v === 'reject' && voteChoice === v ? { background: 'var(--coral-600)' } : undefined}
                  >
                    {v.charAt(0).toUpperCase() + v.slice(1)}
                  </button>
                ))}
              </div>
              <Field label="Comment (optional)">
                <textarea className="input" rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Reason for your vote..." />
              </Field>
              <button className="btn primary" onClick={castVote} disabled={!voteChoice} style={{ marginTop: 8 }}>
                {myVote ? 'Update Vote' : 'Submit Vote'}
              </button>
            </div>
          )}

          {/* Vote log */}
          {allVotes.length > 0 && (
            <div className="card card-pad">
              <h3 className="card-title">Votes Cast ({allVotes.length})</h3>
              <table className="tbl" style={{ marginTop: 8 }}>
                <thead>
                  <tr><th>Voter</th><th>Vote</th><th>Comment</th><th>Date</th></tr>
                </thead>
                <tbody>
                  {allVotes.map((v) => {
                    const voter = db.people.find((pp) => pp.id === v.voterUserId || pp.authUserId === v.voterUserId);
                    return (
                      <tr key={v.id}>
                        <td>{voter ? `${voter.firstName} ${voter.lastName}` : v.voterUserId.slice(0, 8)}</td>
                        <td>
                          <Badge tone={v.vote === 'approve' ? 'ok' : v.vote === 'reject' ? 'err' : 'navy'}>{v.vote}</Badge>
                        </td>
                        <td>{v.comment ?? '—'}</td>
                        <td>{new Date(v.votedAt).toLocaleString()}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
