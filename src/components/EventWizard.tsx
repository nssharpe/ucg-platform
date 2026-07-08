import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { mutate, useDB } from '../lib/store';
import { pushEvent } from '../lib/supabase';
import { useCapabilities } from '../lib/capabilities';
import { scaffoldNationalsConfig } from '../lib/nationals-adapter';
import { Combo, Field, Modal } from './ui';
import { useToast } from './ui-hooks';
import { DISCIPLINES, SHIRT_SIZES, STATE_REGIONS } from '../lib/types';
import type { Discipline, Level, Event, EventSession, EventStatus } from '../lib/types';

const TIMEZONES = [
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix',
  'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu',
];

const slugify = (name: string) => name.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function uniqueSlug(name: string, taken: string[]): string {
  const base = slugify(name) || 'event';
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

const addDays = (iso: string, days: number) => {
  const d = new Date(iso + 'T12:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};

// Session row being edited; numbered "Session N — {label}" on save (seed convention).
interface SessionDraft {
  key: number;
  discipline: Discipline;
  label: string;
  date: string;
  time: string;
  levelIds: string[];
  phase: 'prelim' | 'final';
}

const discLabel = (d: Discipline) => (d === 'TNT' ? 'T&T' : d);

function sessionLabel(d: Discipline, group: Level[], totalLevels: number): string {
  if (group.length === totalLevels) return d === 'TNT' ? 'T&T All Flights' : `${discLabel(d)} All Levels`;
  const names = group.map((l) => l.name);
  return `${discLabel(d)} ${names.length <= 2 ? names.join(' & ') : names.join(' / ')}`;
}

// Default templates mirror the seed: WAG splits lower levels (AM) from upper (PM); MAG/TNT run combined.
function defaultSessions(allLevels: Level[], d: Discipline, date: string, nextKey: () => number): SessionDraft[] {
  const ls = allLevels.filter((l) => l.discipline === d && !l.retired).sort((a, b) => a.order - b.order);
  const groups = d === 'WAG' && ls.length > 2 ? [ls.slice(0, 2), ls.slice(2)] : [ls];
  return groups.map((g, i) => ({
    key: nextKey(), discipline: d, label: sessionLabel(d, g, ls.length),
    date, time: i === 0 ? '09:00' : '14:00', levelIds: g.map((l) => l.id), phase: 'prelim' as const,
  }));
}

/**
 * Derive SessionDraft[] from existing EventSession[] for editing. Keys are
 * assigned by index (1..N) rather than from the component's keyRef, so this can
 * run as initial state without reading a ref during render; the caller seeds the
 * key counter to N+1 so later nextKey() calls don't collide.
 */
function sessionsTodrafts(sessions: EventSession[]): SessionDraft[] {
  return sessions.map((s, i) => {
    // Strip the "Session N — " prefix from the stored name
    const label = s.name.replace(/^Session \d+ — /, '');
    return {
      key: i + 1,
      discipline: s.discipline,
      label,
      date: s.date,
      time: s.time,
      levelIds: s.levelIds,
      phase: (s.phase ?? 'prelim') as 'prelim' | 'final',
    };
  });
}

interface EventWizardProps {
  onClose: () => void;
  /** When provided, the wizard edits this event rather than creating a new one. */
  editEvent?: Event;
}

export function EventWizard({ onClose, editEvent }: EventWizardProps) {
  const db = useDB();
  const caps = useCapabilities();
  const toast = useToast();
  const navigate = useNavigate();
  // Initial sessions get keys 1..N (no ref read during render); the key counter
  // starts at N+1 so subsequently-added sessions get fresh, non-colliding keys.
  const initialSessions = editEvent ? sessionsTodrafts(editEvent.sessions) : [];
  const keyRef = useRef(initialSessions.length + 1);
  const nextKey = () => keyRef.current++;

  const isEdit = !!editEvent;

  // Nationals (admin only): adds prelim/finals phases + qualification config.
  const [kind, setKind] = useState<'standard' | 'nationals'>(editEvent?.kind ?? 'standard');
  const [finalsLevelIds, setFinalsLevelIds] = useState<string[]>(editEvent?.nationalsConfig?.finalsLevelIds ?? []);

  // Basics
  const [name, setName] = useState(editEvent?.name ?? '');
  const [hostClubId, setHostClubId] = useState<string | null>(editEvent?.hostClubId ?? null);
  const [city, setCity] = useState(editEvent?.city ?? '');
  const [state, setState] = useState(editEvent?.state ?? '');
  const [timezone, setTimezone] = useState(editEvent?.timezone ?? 'America/New_York');
  // Location detail (event-mgmt v2 §A)
  const [venue, setVenue] = useState(editEvent?.venue ?? '');
  const [streetAddress, setStreetAddress] = useState(editEvent?.streetAddress ?? '');
  const [country, setCountry] = useState(editEvent?.country ?? 'United States');
  const [hotelLink, setHotelLink] = useState(editEvent?.hotelLink ?? '');
  // Dates
  const defaultStart = addDays(new Date().toISOString().slice(0, 10), 60);
  const [startDate, setStartDate] = useState(editEvent?.startDate ?? defaultStart);
  const [endDate, setEndDate] = useState(editEvent?.endDate ?? defaultStart);
  const [regOpens, setRegOpens] = useState(editEvent?.regOpens ?? `${new Date().toISOString().slice(0, 10)}T12:00`);
  const [regCloses, setRegCloses] = useState(editEvent?.regCloses ?? `${addDays(defaultStart, -14)}T23:59`);
  const regClosesDirty = useRef(isEdit);
  // Last date to edit (B4): optional edit-lockout, past which only an admin
  // or the event's host club may still edit a registration.
  const [hasEditLockout, setHasEditLockout] = useState(!!editEvent?.lastDateToEdit);
  const [lastDateToEdit, setLastDateToEdit] = useState(editEvent?.lastDateToEdit ?? `${addDays(defaultStart, -7)}T23:59`);
  // Age-calculation date (event-mgmt v2 §A): applies to all events, not just camps.
  const [hasAgeCalcAt, setHasAgeCalcAt] = useState(!!editEvent?.ageCalcAt);
  const [ageCalcAt, setAgeCalcAt] = useState(editEvent?.ageCalcAt ?? `${defaultStart}T00:00`);
  // Fees
  const [entryFee, setEntryFee] = useState(String(editEvent?.entryFee ?? 60));
  const [secondFee, setSecondFee] = useState(String(editEvent?.secondDisciplineFee ?? 30));
  // Banquet
  const [hasBanquet, setHasBanquet] = useState(!!editEvent?.banquet);
  const [banquetName, setBanquetName] = useState(editEvent?.banquet?.name ?? 'Banquet');
  const [banquetPrice, setBanquetPrice] = useState(String(editEvent?.banquet?.price ?? 45));
  // T-shirt add-on
  const [hasTshirt, setHasTshirt] = useState(!!editEvent?.tshirtAddon);
  const [tshirtPrice, setTshirtPrice] = useState(String(editEvent?.tshirtAddon?.price ?? 25));
  const [tshirtSizes, setTshirtSizes] = useState<string[]>(editEvent?.tshirtAddon?.sizes ?? [...SHIRT_SIZES]);
  // Banner add-on
  const [hasBanner, setHasBanner] = useState(!!editEvent?.bannerAddon);
  const [bannerPrice, setBannerPrice] = useState(String(editEvent?.bannerAddon?.price ?? 30));
  // Change fee
  const [hasChangeFee, setHasChangeFee] = useState(!!editEvent?.changeFee);
  const [changeFeeAmount, setChangeFeeAmount] = useState(String(editEvent?.changeFee?.amount ?? 15));
  const [changeFeeStartsAt, setChangeFeeStartsAt] = useState(
    editEvent?.changeFee?.startsAt ?? `${addDays(defaultStart, -21)}T00:00`,
  );
  // Late registration (event-mgmt v2 §A): fee is added ON TOP of the entry fee.
  const [hasLateReg, setHasLateReg] = useState(!!editEvent?.lateReg);
  const [lateRegStartsAt, setLateRegStartsAt] = useState(
    editEvent?.lateReg?.startsAt ?? `${addDays(defaultStart, -14)}T00:00`,
  );
  const [lateRegFee, setLateRegFee] = useState(String(editEvent?.lateReg?.fee ?? 20));
  // Director contact (event-mgmt v2 §A): general to competitions + camps.
  const [directorName, setDirectorName] = useState(editEvent?.director?.name ?? '');
  const [directorEmail, setDirectorEmail] = useState(editEvent?.director?.email ?? '');
  const [directorCc, setDirectorCc] = useState(editEvent?.director?.ccOnConfirmation ?? false);
  // Capacity (event-mgmt v2 §A): stored only, NOT enforced yet.
  const [capacityTotal, setCapacityTotal] = useState(String(editEvent?.capacity?.total ?? ''));
  const [capacityPerDiscipline, setCapacityPerDiscipline] = useState<Partial<Record<Discipline, string>>>(
    () => Object.fromEntries(
      DISCIPLINES.map((d) => [d, editEvent?.capacity?.perDiscipline?.[d] != null ? String(editEvent.capacity.perDiscipline[d]) : '']),
    ) as Partial<Record<Discipline, string>>,
  );
  const [capacityPerLevel, setCapacityPerLevel] = useState<Record<string, string>>(
    () => Object.fromEntries(
      Object.entries(editEvent?.capacity?.perLevel ?? {}).map(([id, n]) => [id, String(n)]),
    ),
  );
  // Confirmation email override (event-mgmt v2 §A)
  const [hasConfirmationEmail, setHasConfirmationEmail] = useState(!!editEvent?.confirmationEmail);
  const [confirmationBodyHtml, setConfirmationBodyHtml] = useState(editEvent?.confirmationEmail?.bodyHtml ?? '');
  const [confirmationFromAlias, setConfirmationFromAlias] = useState(editEvent?.confirmationEmail?.fromAlias ?? '');
  const [confirmationReplyTo, setConfirmationReplyTo] = useState(editEvent?.confirmationEmail?.replyTo ?? '');
  const [confirmationPreview, setConfirmationPreview] = useState(false);
  // Disciplines & sessions
  const [disciplines, setDisciplines] = useState<Discipline[]>(editEvent?.disciplines ?? []);
  const [sessions, setSessions] = useState<SessionDraft[]>(initialSessions);
  // Publication state (B4: Draft/Live only — the real-time phase is derived
  // from regOpens/regCloses/startDate/endDate, not manually set).
  const [status, setStatus] = useState<EventStatus>(editEvent?.status ?? 'live');
  const [error, setError] = useState('');

  const takenSlugs = db.events.filter((m) => m.id !== editEvent?.id).map((m) => m.slug);
  const slug = useMemo(
    () => isEdit ? editEvent!.slug : uniqueSlug(name, takenSlugs),
    [name, takenSlugs, isEdit, editEvent],
  );

  const allCompetingLevelIds = useMemo(() => [...new Set(sessions.flatMap((s) => s.levelIds))], [sessions]);
  // Finals apply to artistic (WAG/MAG) levels; TNT awards from prelims only.
  const finalsEligibleLevels = useMemo(
    () => db.levels
      .filter((l) => (l.discipline === 'WAG' || l.discipline === 'MAG') && allCompetingLevelIds.includes(l.id))
      .sort((a, b) => a.discipline.localeCompare(b.discipline) || a.order - b.order),
    [db.levels, allCompetingLevelIds],
  );

  const changeStart = (v: string) => {
    if (!v) return;
    // Sessions & end date that tracked the old start date follow it; user edits are kept.
    setSessions((rows) => rows.map((r) => (r.date === startDate ? { ...r, date: v } : r)));
    if (endDate === startDate || endDate < v) setEndDate(v);
    if (!regClosesDirty.current) setRegCloses(`${addDays(v, -14)}T23:59`);
    setStartDate(v);
  };

  const toggleDiscipline = (d: Discipline) => {
    if (disciplines.includes(d)) {
      setDisciplines(disciplines.filter((x) => x !== d));
      setSessions(sessions.filter((s) => s.discipline !== d));
    } else {
      setDisciplines([...disciplines, d]);
      setSessions([...sessions, ...defaultSessions(db.levels, d, startDate, nextKey)]);
    }
  };

  const toggleTshirtSize = (size: string) => {
    setTshirtSizes((prev) =>
      prev.includes(size) ? prev.filter((s) => s !== size) : [...prev, size],
    );
  };

  const updateSession = (key: number, patch: Partial<SessionDraft>) =>
    setSessions(sessions.map((s) => (s.key === key ? { ...s, ...patch } : s)));

  const submit = () => {
    if (!name.trim()) return setError('Event name is required.');
    if (!hostClubId) return setError('Pick a host club.');
    if (!city.trim() || !state) return setError('City and state are required.');
    if (!startDate || !endDate || endDate < startDate) return setError('End date must be on or after the start date.');
    if (!regOpens || !regCloses || regCloses.slice(0, 10) > startDate) return setError('Registration must close on or before the event start date.');
    if (regOpens >= regCloses) return setError('Registration must open before it closes.');
    if (disciplines.length === 0) return setError('Select at least one discipline.');
    if (sessions.length === 0) return setError('Add at least one session.');
    const bad = sessions.find((s) => !s.label.trim() || !s.date || !s.time || s.levelIds.length === 0);
    if (bad) return setError('Every session needs a name, date, time, and at least one level.');
    const fee = Number(entryFee), fee2 = Number(secondFee), bPrice = Number(banquetPrice);
    if (!Number.isFinite(fee) || fee < 0 || !Number.isFinite(fee2) || fee2 < 0) return setError('Fees must be valid dollar amounts.');
    if (hasBanquet && (!banquetName.trim() || !Number.isFinite(bPrice) || bPrice < 0)) return setError('Banquet needs a name and a valid price.');
    if (hasTshirt) {
      const p = Number(tshirtPrice);
      if (!Number.isFinite(p) || p < 0) return setError('T-shirt price must be a valid dollar amount.');
      if (tshirtSizes.length === 0) return setError('Select at least one t-shirt size.');
    }
    if (hasBanner) {
      const p = Number(bannerPrice);
      if (!Number.isFinite(p) || p < 0) return setError('Banner price must be a valid dollar amount.');
    }
    if (hasChangeFee) {
      const a = Number(changeFeeAmount);
      if (!Number.isFinite(a) || a < 0) return setError('Change fee must be a valid dollar amount.');
      if (!changeFeeStartsAt) return setError('Change fee needs a start date/time.');
    }
    if (hasEditLockout && !lastDateToEdit) return setError('Last date to edit needs a date/time, or turn the toggle off.');
    if (hasAgeCalcAt && !ageCalcAt) return setError('Age-calculation date needs a date/time, or turn the toggle off.');
    if (hasLateReg) {
      const f = Number(lateRegFee);
      if (!Number.isFinite(f) || f < 0) return setError('Late registration fee must be a valid dollar amount.');
      if (!lateRegStartsAt) return setError('Late registration needs a start date/time.');
    }
    if (directorEmail.trim() && !directorName.trim()) return setError('Director name is required if a director email is set.');
    if (capacityTotal.trim()) {
      const t = Number(capacityTotal);
      if (!Number.isFinite(t) || t < 0) return setError('Max total participants must be a valid number.');
    }
    for (const d of disciplines) {
      const v = capacityPerDiscipline[d];
      if (v && v.trim()) {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0) return setError(`${discLabel(d)} capacity must be a valid number.`);
      }
    }
    for (const levelId of allCompetingLevelIds) {
      const v = capacityPerLevel[levelId];
      if (v && v.trim()) {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0) return setError('Per-level capacity must be a valid number.');
      }
    }
    if (hasConfirmationEmail && !confirmationBodyHtml.trim()) return setError('Confirmation email needs a body, or turn the toggle off.');

    const nationals = kind === 'nationals';
    if (nationals && !sessions.some((s) => s.phase === 'prelim')) return setError('A Nationals event needs at least one prelim session.');

    const eventId = editEvent?.id ?? `meet-${Date.now()}`;
    const eventSessions: EventSession[] = sessions.map((s, i) => ({
      id: editEvent?.sessions[i]?.id ?? `${eventId}-s${i + 1}`,
      name: `Session ${i + 1} — ${s.label.trim()}`,
      discipline: s.discipline, date: s.date, time: s.time, levelIds: s.levelIds,
      squads: editEvent?.sessions[i]?.squads ?? [],
      ...(nationals ? { phase: s.phase } : {}),
    }));
    const orderedDisciplines = DISCIPLINES.filter((d) => disciplines.includes(d));
    const event: Event = {
      ...(editEvent ?? {}),
      id: eventId,
      slug: editEvent?.slug ?? slug,
      name: name.trim(),
      hostClubId: hostClubId!,
      city: city.trim(), state, timezone,
      startDate, endDate, status, regOpens, regCloses,
      entryFee: fee, secondDisciplineFee: fee2,
      disciplines: orderedDisciplines,
      sessions: eventSessions,
      ...(hasBanquet ? { banquet: { name: banquetName.trim(), price: bPrice } } : { banquet: undefined }),
      ...(hasTshirt ? { tshirtAddon: { price: Number(tshirtPrice), sizes: tshirtSizes } } : { tshirtAddon: undefined }),
      ...(hasBanner ? { bannerAddon: { price: Number(bannerPrice) } } : { bannerAddon: undefined }),
      ...(hasChangeFee ? { changeFee: { amount: Number(changeFeeAmount), startsAt: changeFeeStartsAt } } : { changeFee: undefined }),
      lastDateToEdit: hasEditLockout ? lastDateToEdit : null,
      venue: venue.trim() || undefined,
      streetAddress: streetAddress.trim() || undefined,
      country: country.trim() || undefined,
      hotelLink: hotelLink.trim() || undefined,
      ageCalcAt: hasAgeCalcAt ? ageCalcAt : undefined,
      ...(hasLateReg ? { lateReg: { startsAt: lateRegStartsAt, fee: Number(lateRegFee) } } : { lateReg: undefined }),
      ...(directorName.trim()
        ? { director: { name: directorName.trim(), email: directorEmail.trim(), ccOnConfirmation: directorCc } }
        : { director: undefined }),
      ...((capacityTotal.trim() || disciplines.some((d) => capacityPerDiscipline[d]?.trim()) || allCompetingLevelIds.some((id) => capacityPerLevel[id]?.trim()))
        ? {
            capacity: {
              ...(capacityTotal.trim() ? { total: Number(capacityTotal) } : {}),
              ...(disciplines.some((d) => capacityPerDiscipline[d]?.trim())
                ? {
                    perDiscipline: Object.fromEntries(
                      disciplines.filter((d) => capacityPerDiscipline[d]?.trim()).map((d) => [d, Number(capacityPerDiscipline[d])]),
                    ) as Partial<Record<Discipline, number>>,
                  }
                : {}),
              ...(allCompetingLevelIds.some((id) => capacityPerLevel[id]?.trim())
                ? {
                    perLevel: Object.fromEntries(
                      allCompetingLevelIds.filter((id) => capacityPerLevel[id]?.trim()).map((id) => [id, Number(capacityPerLevel[id])]),
                    ),
                  }
                : {}),
            },
          }
        : { capacity: undefined }),
      ...(hasConfirmationEmail
        ? {
            confirmationEmail: {
              bodyHtml: confirmationBodyHtml,
              ...(confirmationFromAlias.trim() ? { fromAlias: confirmationFromAlias.trim() } : {}),
              ...(confirmationReplyTo.trim() ? { replyTo: confirmationReplyTo.trim() } : {}),
            },
          }
        : { confirmationEmail: undefined }),
      ...(nationals
        ? {
            kind: 'nationals' as const,
            nationalsConfig: scaffoldNationalsConfig(db.levels, orderedDisciplines, finalsLevelIds.filter((id) => allCompetingLevelIds.includes(id))),
          }
        : { kind: 'standard' as const }),
    };
    if (isEdit) {
      mutate((d) => { const idx = d.events.findIndex((m) => m.id === event.id); if (idx >= 0) d.events[idx] = event; pushEvent(event); });
      toast(`${event.name} updated.`);
    } else {
      mutate((d) => { d.events.push(event); pushEvent(event); });
      toast(`${event.name} sanctioned — #/events/${slug}`);
    }
    onClose();
    navigate(`/events/${event.slug}`);
  };

  const sectionTitle = (t: string) => (
    <h3 className="card-title" style={{ margin: '14px 0 8px', paddingTop: 10, borderTop: '1px solid var(--line)' }}>{t}</h3>
  );

  return (
    <Modal title={isEdit ? `Edit event — ${editEvent!.name}` : 'Sanction a new event'} onClose={onClose}>
      {caps.isAdmin && (
        <div className="card card-pad" style={{ marginBottom: 12, background: 'var(--ice)', borderColor: 'var(--line)' }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14, fontWeight: 600 }}>
            <input type="checkbox" checked={kind === 'nationals'} onChange={(e) => setKind(e.target.checked ? 'nationals' : 'standard')} />
            Nationals event
          </label>
          <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', margin: '6px 0 0' }}>
            Unlocks prelim/finals sessions and automatic finals qualification &amp; awards. UCG-admin only.
          </p>
        </div>
      )}
      <h3 className="card-title" style={{ marginBottom: 8 }}>Basics</h3>
      <Field label="Event name" hint={name.trim() ? `URL: ucg.org/#/events/${slug}` : 'The URL slug is derived automatically.'}>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Southeast Open 2027" autoFocus />
      </Field>
      <Field label="Host club">
        <Combo
          options={db.clubs.map((c) => ({ value: c.id, label: c.name, sub: `${c.state} · ${c.region}` }))}
          value={hostClubId} onChange={setHostClubId} placeholder="Type to search clubs…"
        />
      </Field>
      <div className="grid cols-3">
        <Field label="City"><input className="input" value={city} onChange={(e) => setCity(e.target.value)} /></Field>
        <Field label="State">
          <select className="input" value={state} onChange={(e) => setState(e.target.value)}>
            <option value="" disabled>Select…</option>
            {Object.keys(STATE_REGIONS).map((s) => <option key={s}>{s}</option>)}
          </select>
        </Field>
        <Field label="Timezone" hint="All reg open/close times are in this timezone.">
          <select className="input" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
            {TIMEZONES.map((t) => <option key={t}>{t}</option>)}
          </select>
        </Field>
      </div>
      <Field label="Venue name"><input className="input" value={venue} onChange={(e) => setVenue(e.target.value)} placeholder="e.g. University Arena" /></Field>
      <div className="grid cols-3">
        <Field label="Street address"><input className="input" value={streetAddress} onChange={(e) => setStreetAddress(e.target.value)} /></Field>
        <Field label="Country"><input className="input" value={country} onChange={(e) => setCountry(e.target.value)} placeholder="United States" /></Field>
        <Field label="Hotel block link" hint="URL to the room-block booking page.">
          <input className="input" type="url" value={hotelLink} onChange={(e) => setHotelLink(e.target.value)} placeholder="https://…" />
        </Field>
      </div>

      {sectionTitle('Dates')}
      <div className="grid cols-3">
        <Field label="Start date"><input className="input" type="date" value={startDate} onChange={(e) => changeStart(e.target.value)} /></Field>
        <Field label="End date"><input className="input" type="date" min={startDate} value={endDate} onChange={(e) => setEndDate(e.target.value)} /></Field>
      </div>
      <div className="grid cols-3">
        <Field label={`Registration opens (${timezone})`}><input className="input" type="datetime-local" value={regOpens} onChange={(e) => setRegOpens(e.target.value)} /></Field>
        <Field label={`Registration closes (${timezone})`} hint="Must be on or before the start date.">
          <input className="input" type="datetime-local" value={regCloses} onChange={(e) => { regClosesDirty.current = true; setRegCloses(e.target.value); }} />
        </Field>
      </div>

      {/* Age-calculation date (event-mgmt v2 §A) */}
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14, marginTop: 8, marginBottom: hasAgeCalcAt ? 8 : 0 }}>
        <input type="checkbox" checked={hasAgeCalcAt} onChange={(e) => setHasAgeCalcAt(e.target.checked)} /> Set an age-calculation date
      </label>
      {hasAgeCalcAt && (
        <div className="grid cols-3" style={{ marginBottom: 8 }}>
          <Field label={`Age calculated as of (${timezone})`} hint="Used for age-based level eligibility.">
            <input className="input" type="datetime-local" value={ageCalcAt} onChange={(e) => setAgeCalcAt(e.target.value)} />
          </Field>
        </div>
      )}

      {sectionTitle('Fees')}
      <div className="grid cols-3">
        <Field label="Entry fee ($)"><input className="input" type="number" min={0} step={5} value={entryFee} onChange={(e) => setEntryFee(e.target.value)} /></Field>
        <Field label="2nd discipline ($)"><input className="input" type="number" min={0} step={5} value={secondFee} onChange={(e) => setSecondFee(e.target.value)} /></Field>
      </div>

      {/* Late registration (event-mgmt v2 §A) */}
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14, marginBottom: hasLateReg ? 8 : 0 }}>
        <input type="checkbox" checked={hasLateReg} onChange={(e) => setHasLateReg(e.target.checked)} /> Charge a late registration fee
      </label>
      {hasLateReg && (
        <div className="grid cols-3" style={{ marginBottom: 8 }}>
          <Field label={`Late reg starts (${timezone})`}><input className="input" type="datetime-local" value={lateRegStartsAt} onChange={(e) => setLateRegStartsAt(e.target.value)} /></Field>
          <Field label="Late fee ($)" hint="Added on top of the entry fee.">
            <input className="input" type="number" min={0} step={5} value={lateRegFee} onChange={(e) => setLateRegFee(e.target.value)} />
          </Field>
        </div>
      )}

      {/* Banquet */}
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14, marginBottom: hasBanquet ? 8 : 0 }}>
        <input type="checkbox" checked={hasBanquet} onChange={(e) => setHasBanquet(e.target.checked)} /> Offer a banquet add-on
      </label>
      {hasBanquet && (
        <div className="grid cols-3">
          <Field label="Banquet name"><input className="input" value={banquetName} onChange={(e) => setBanquetName(e.target.value)} /></Field>
          <Field label="Banquet price ($)"><input className="input" type="number" min={0} step={5} value={banquetPrice} onChange={(e) => setBanquetPrice(e.target.value)} /></Field>
        </div>
      )}

      {/* T-shirt add-on */}
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14, marginTop: 8, marginBottom: hasTshirt ? 8 : 0 }}>
        <input type="checkbox" checked={hasTshirt} onChange={(e) => setHasTshirt(e.target.checked)} /> Offer a t-shirt add-on
      </label>
      {hasTshirt && (
        <div className="card card-pad" style={{ marginBottom: 8 }}>
          <div className="grid cols-3" style={{ marginBottom: 10 }}>
            <Field label="T-shirt price ($)"><input className="input" type="number" min={0} step={1} value={tshirtPrice} onChange={(e) => setTshirtPrice(e.target.value)} /></Field>
          </div>
          <div style={{ fontSize: 13, color: 'var(--ink-soft)', marginBottom: 6 }}>Available sizes</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px' }}>
            {SHIRT_SIZES.map((sz) => (
              <label key={sz} style={{ display: 'flex', gap: 5, alignItems: 'center', fontSize: 13.5 }}>
                <input type="checkbox" checked={tshirtSizes.includes(sz)} onChange={() => toggleTshirtSize(sz)} /> {sz}
              </label>
            ))}
          </div>
        </div>
      )}

      {/* Club banner add-on */}
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14, marginTop: hasTshirt ? 0 : 8, marginBottom: hasBanner ? 8 : 0 }}>
        <input type="checkbox" checked={hasBanner} onChange={(e) => setHasBanner(e.target.checked)} /> Offer a club banner add-on
      </label>
      {hasBanner && (
        <div className="grid cols-3" style={{ marginBottom: 8 }}>
          <Field label="Banner price ($)" hint="Clubs enter their banner text at registration.">
            <input className="input" type="number" min={0} step={5} value={bannerPrice} onChange={(e) => setBannerPrice(e.target.value)} />
          </Field>
        </div>
      )}

      {/* Change fee */}
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14, marginTop: 8, marginBottom: hasChangeFee ? 8 : 0 }}>
        <input type="checkbox" checked={hasChangeFee} onChange={(e) => setHasChangeFee(e.target.checked)} /> Charge a registration change fee (late changes)
      </label>
      {hasChangeFee && (
        <div className="grid cols-3" style={{ marginBottom: 8 }}>
          <Field label="Change fee ($)"><input className="input" type="number" min={0} step={5} value={changeFeeAmount} onChange={(e) => setChangeFeeAmount(e.target.value)} /></Field>
          <Field label={`Applies after (${timezone})`} hint="Changes made after this date/time incur the fee.">
            <input className="input" type="datetime-local" value={changeFeeStartsAt} onChange={(e) => setChangeFeeStartsAt(e.target.value)} />
          </Field>
        </div>
      )}

      {/* Last date to edit (B4) */}
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14, marginTop: 8, marginBottom: hasEditLockout ? 8 : 0 }}>
        <input type="checkbox" checked={hasEditLockout} onChange={(e) => setHasEditLockout(e.target.checked)} /> Lock out editing after a date
      </label>
      {hasEditLockout && (
        <div className="grid cols-3" style={{ marginBottom: 8 }}>
          <Field label={`Last date to edit (${timezone})`} hint="Past this, only an admin or this event's host club can still edit a registration.">
            <input className="input" type="datetime-local" value={lastDateToEdit} onChange={(e) => setLastDateToEdit(e.target.value)} />
          </Field>
        </div>
      )}

      {sectionTitle('Event director')}
      <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', margin: '0 0 8px' }}>
        Applies to both competitions and camps.
      </p>
      <div className="grid cols-3">
        <Field label="Director name"><input className="input" value={directorName} onChange={(e) => setDirectorName(e.target.value)} /></Field>
        <Field label="Director email"><input className="input" type="email" value={directorEmail} onChange={(e) => setDirectorEmail(e.target.value)} /></Field>
      </div>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14, marginTop: 4 }}>
        <input type="checkbox" checked={directorCc} onChange={(e) => setDirectorCc(e.target.checked)} /> CC director on confirmation emails
      </label>

      {sectionTitle('Disciplines & sessions')}
      <div style={{ display: 'flex', gap: 16, marginBottom: 10 }}>
        {DISCIPLINES.map((d) => (
          <label key={d} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 14, fontWeight: 600 }}>
            <input type="checkbox" checked={disciplines.includes(d)} onChange={() => toggleDiscipline(d)} /> {discLabel(d)}
          </label>
        ))}
      </div>
      {sessions.length === 0 && <p style={{ fontSize: 13, color: 'var(--ink-soft)', margin: '4px 0' }}>Pick a discipline to load its default session templates — then add, remove, or edit sessions.</p>}
      {sessions.map((s, i) => {
        // Exclude retired levels from the session level pickers
        const discLevels = db.levels.filter((l) => l.discipline === s.discipline && !l.retired).sort((a, b) => a.order - b.order);
        return (
          <div key={s.key} className="card card-pad" style={{ marginBottom: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
              <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--ink-soft)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Session {i + 1} · {discLabel(s.discipline)}</span>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {kind === 'nationals' && (
                  <select className="input" style={{ width: 'auto', padding: '2px 8px', fontSize: 12.5 }} value={s.phase} onChange={(e) => updateSession(s.key, { phase: e.target.value as 'prelim' | 'final' })}>
                    <option value="prelim">Prelims</option>
                    <option value="final">Finals</option>
                  </select>
                )}
                <button className="btn small ghost" onClick={() => setSessions(sessions.filter((x) => x.key !== s.key))}>Remove</button>
              </div>
            </div>
            <Field label="Name" hint={`Saved as "Session ${i + 1} — ${s.label.trim() || '…'}"`}>
              <input className="input" value={s.label} onChange={(e) => updateSession(s.key, { label: e.target.value })} />
            </Field>
            <div className="grid cols-3">
              <Field label="Date"><input className="input" type="date" min={startDate} max={endDate} value={s.date} onChange={(e) => updateSession(s.key, { date: e.target.value })} /></Field>
              <Field label="Time"><input className="input" type="time" value={s.time} onChange={(e) => updateSession(s.key, { time: e.target.value })} /></Field>
            </div>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {discLevels.map((l) => (
                <label key={l.id} style={{ display: 'flex', gap: 5, alignItems: 'center', fontSize: 13.5 }}>
                  <input
                    type="checkbox"
                    checked={s.levelIds.includes(l.id)}
                    onChange={(e) => updateSession(s.key, {
                      levelIds: e.target.checked
                        ? discLevels.map((x) => x.id).filter((id) => s.levelIds.includes(id) || id === l.id) // keep level order
                        : s.levelIds.filter((id) => id !== l.id),
                    })}
                  /> {l.name}
                </label>
              ))}
            </div>
          </div>
        );
      })}
      {disciplines.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 4 }}>
          {disciplines.map((d) => (
            <button key={d} className="btn small ghost" onClick={() => setSessions([...sessions, { key: nextKey(), discipline: d, label: `${discLabel(d)} `, date: startDate, time: '09:00', levelIds: [], phase: 'prelim' }])}>
              + Add {discLabel(d)} session
            </button>
          ))}
        </div>
      )}

      {sectionTitle('Capacity (caps are not enforced yet)')}
      <div className="grid cols-3">
        <Field label="Max total participants">
          <input className="input" type="number" min={0} step={1} value={capacityTotal} onChange={(e) => setCapacityTotal(e.target.value)} />
        </Field>
      </div>
      {disciplines.length > 0 && (
        <>
          <div style={{ fontSize: 13, color: 'var(--ink-soft)', margin: '4px 0 6px' }}>Per-discipline caps (optional)</div>
          <div className="grid cols-3" style={{ marginBottom: 8 }}>
            {disciplines.map((d) => (
              <Field key={d} label={`${discLabel(d)} cap`}>
                <input
                  className="input" type="number" min={0} step={1}
                  value={capacityPerDiscipline[d] ?? ''}
                  onChange={(e) => setCapacityPerDiscipline((prev) => ({ ...prev, [d]: e.target.value }))}
                />
              </Field>
            ))}
          </div>
        </>
      )}
      {allCompetingLevelIds.length > 0 && (
        <>
          <div style={{ fontSize: 13, color: 'var(--ink-soft)', margin: '4px 0 6px' }}>Per-level caps (optional)</div>
          <div className="grid cols-3" style={{ marginBottom: 8 }}>
            {db.levels
              .filter((l) => allCompetingLevelIds.includes(l.id))
              .sort((a, b) => a.discipline.localeCompare(b.discipline) || a.order - b.order)
              .map((l) => (
                <Field key={l.id} label={`${discLabel(l.discipline)} ${l.name}`}>
                  <input
                    className="input" type="number" min={0} step={1}
                    value={capacityPerLevel[l.id] ?? ''}
                    onChange={(e) => setCapacityPerLevel((prev) => ({ ...prev, [l.id]: e.target.value }))}
                  />
                </Field>
              ))}
          </div>
        </>
      )}

      {kind === 'nationals' && (
        <>
          {sectionTitle('Finals & qualification')}
          <p style={{ fontSize: 13, color: 'var(--ink-soft)', margin: '0 0 8px' }}>
            Pick the levels that hold finals (awards come from finals results); every other level awards
            straight from prelims. Set the qualification cutoffs (&ldquo;blue numbers&rdquo;) on the event
            page after creating it.
          </p>
          {finalsEligibleLevels.length === 0 && <p style={{ fontSize: 13, color: 'var(--ink-soft)' }}>Add WAG/MAG sessions with levels first.</p>}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {finalsEligibleLevels.map((l) => (
              <label key={l.id} style={{ display: 'flex', gap: 5, alignItems: 'center', fontSize: 13.5 }}>
                <input
                  type="checkbox"
                  checked={finalsLevelIds.includes(l.id)}
                  onChange={(e) => setFinalsLevelIds(e.target.checked ? [...finalsLevelIds, l.id] : finalsLevelIds.filter((id) => id !== l.id))}
                /> {discLabel(l.discipline)} {l.name}
              </label>
            ))}
          </div>
        </>
      )}

      {sectionTitle('Confirmation email')}
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14, marginBottom: hasConfirmationEmail ? 8 : 0 }}>
        <input type="checkbox" checked={hasConfirmationEmail} onChange={(e) => setHasConfirmationEmail(e.target.checked)} /> Customize the registration confirmation email
      </label>
      {hasConfirmationEmail && (
        <div className="card card-pad" style={{ marginBottom: 8 }}>
          <div className="grid cols-3" style={{ marginBottom: 10 }}>
            <Field label="From alias" hint="Display name shown to recipients.">
              <input className="input" value={confirmationFromAlias} onChange={(e) => setConfirmationFromAlias(e.target.value)} placeholder="e.g. Southeast Open 2027" />
            </Field>
            <Field label="Reply-to email"><input className="input" type="email" value={confirmationReplyTo} onChange={(e) => setConfirmationReplyTo(e.target.value)} /></Field>
          </div>
          <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', margin: '0 0 8px' }}>
            Sent from the UCG address; the alias is the display name and replies go to the reply-to address.
          </p>

          <div style={{ display: 'flex', gap: 8, marginBottom: 6, alignItems: 'center' }}>
            <span style={{ fontSize: 12.5, color: 'var(--ink-soft)' }}>Body HTML:</span>
            <button
              className={`btn small ${confirmationPreview ? 'primary' : 'ghost'}`}
              style={{ marginLeft: 'auto' }}
              onClick={() => setConfirmationPreview((v) => !v)}
              type="button"
            >{confirmationPreview ? 'Edit HTML' : 'Preview'}</button>
          </div>
          {confirmationPreview ? (
            <div
              style={{
                minHeight: 160, maxHeight: 340, overflowY: 'auto',
                border: '1px solid var(--line)', borderRadius: 6,
                padding: '10px 14px', background: '#fff', color: '#111',
                fontSize: 14, lineHeight: 1.6,
              }}
              // Admin-authored HTML, mirrors Communicate.tsx's preview pane.
              dangerouslySetInnerHTML={{ __html: confirmationBodyHtml }}
            />
          ) : (
            <textarea
              className="input"
              rows={8}
              style={{ fontFamily: 'monospace', fontSize: 12.5, resize: 'vertical' }}
              placeholder={'<h1>You\'re registered!</h1>\n<p>…</p>'}
              value={confirmationBodyHtml}
              onChange={(e) => setConfirmationBodyHtml(e.target.value)}
            />
          )}
        </div>
      )}

      {sectionTitle('Status')}
      <div style={{ display: 'flex', gap: 16, marginBottom: 6 }}>
        {(['live', 'draft'] as const).map((s) => (
          <label key={s} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 14 }}>
            <input type="radio" name="meet-status" checked={status === s} onChange={() => setStatus(s)} />
            {s === 'live' ? 'Live (published)' : 'Draft (hidden)'}
          </label>
        ))}
      </div>
      <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', margin: '0 0 6px' }}>
        A Live event is visible and follows the registration-open/close dates below automatically —
        it doesn't need to be manually reopened or closed. A Draft event is hidden from everyone but admins.
      </p>

      {error && <p style={{ color: 'var(--coral-600)', fontSize: 13.5, fontWeight: 600, margin: '8px 0 0' }}>{error}</p>}
      <div style={{ display: 'flex', justifyContent: 'end', gap: 8, marginTop: 16 }}>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" onClick={submit}>{isEdit ? 'Save changes' : 'Sanction event'}</button>
      </div>
    </Modal>
  );
}
