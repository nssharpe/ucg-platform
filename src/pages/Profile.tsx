import { useState, useMemo, type CSSProperties } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { useDB, mutate } from '../lib/store';
import { useCapabilities } from '../lib/capabilities';
import { Combo, Field, Modal, Badge } from '../components/ui';
import { useToast } from '../components/ui-hooks';
import { SHIRT_SIZES, DIETARY_OPTIONS, STATE_REGIONS, DISCIPLINES } from '../lib/types';
import type { Athlete, ClubRequest, Gender, Region } from '../lib/types';
import { pushClubRequest, pushMembership, pushPerson, deleteRegistration, sendEmail } from '../lib/supabase';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format raw digits as (555) 123-4567 */
function formatPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 10);
  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function phoneValid(raw: string): boolean {
  return raw.replace(/\D/g, '').length === 10;
}

/** Return age in whole years given a dob string like "YYYY-MM-DD" */
function ageFromDob(dob: string): number {
  if (!dob) return 0;
  const today = new Date();
  const birth = new Date(dob);
  let age = today.getFullYear() - birth.getFullYear();
  const m = today.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
  return age;
}

// ---------------------------------------------------------------------------
// Required-field validation
// ---------------------------------------------------------------------------
type ValidationErrors = { field: string; label: string }[];

function validateProfile(p: Athlete): ValidationErrors {
  const errs: ValidationErrors = [];
  if (!p.firstName.trim()) errs.push({ field: 'firstName', label: 'First name' });
  if (!p.lastName.trim()) errs.push({ field: 'lastName', label: 'Last name' });
  if (!p.dob) errs.push({ field: 'dob', label: 'Date of birth' });
  if (!p.phone) errs.push({ field: 'phone', label: 'Phone' });
  if (!p.shirt) errs.push({ field: 'shirt', label: 'T-shirt size' });
  if (!p.studentStatus) errs.push({ field: 'studentStatus', label: 'Student status' });
  if (!p.emergency.contact) errs.push({ field: 'emergency.contact', label: 'Emergency contact' });
  if (!p.emergency.phone) errs.push({ field: 'emergency.phone', label: 'Emergency phone' });
  return errs;
}

// ---------------------------------------------------------------------------
// Derive effective roles, falling back to kind for back-compat
// ---------------------------------------------------------------------------
function effectiveRoles(p: Athlete): { athlete: boolean; coach: boolean } {
  if (p.roles) return p.roles;
  return { athlete: p.kind !== 'coach', coach: p.kind === 'coach' };
}

// ---------------------------------------------------------------------------
// Main Profile component
// ---------------------------------------------------------------------------

export function Profile({ adminView = false }: { adminView?: boolean }) {
  const db = useDB();
  const params = useParams();
  const toast = useToast();
  const caps = useCapabilities();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const personId = adminView ? params.personId! : caps.personId;
  const person = db.people.find((p) => p.id === personId);

  // Determine if we should auto-open edit mode and return to membership after save
  const returnParam = searchParams.get('return');
  const returnToMembership = returnParam === 'membership';
  // Preserve any season param when returning
  const seasonParam = searchParams.get('season');

  const [draft, setDraft] = useState<Athlete | null>(null);
  const [editMode, setEditMode] = useState<boolean>(() => {
    if (!person) return false;
    if (returnToMembership) return true;
    const errs = validateProfile(person);
    return errs.length > 0;
  });
  // When arriving from membership, track which fields were empty on arrival so we can highlight them
  const [highlightMissing] = useState<boolean>(() => returnToMembership);
  const [clubReqOpen, setClubReqOpen] = useState(false);
  const [revokeSeasonId, setRevokeSeasonId] = useState<string | null>(null);

  // Hooks must run unconditionally, so derive these before the early return below.
  // `current` is null only when `person` is missing (the not-found path).
  const current = draft ?? person ?? null;
  const validationErrors = useMemo(() => (current ? validateProfile(current) : []), [current]);

  // When arriving from membership, highlight still-empty required fields in red
  const missingFieldKeys = useMemo(
    () => highlightMissing ? new Set(validationErrors.map((e) => e.field)) : new Set<string>(),
    [highlightMissing, validationErrors]
  );

  if (!person) return <p>Person not found.</p>;
  const pid: string = person.id;
  const p = draft ?? person;
  const set = (patch: Partial<Athlete>) => setDraft({ ...p, ...patch });
  const clubOptions = db.clubs.map((c) => ({ value: c.id, label: c.name, sub: `${c.state} · ${c.region}` }));
  const states = Object.keys(STATE_REGIONS);

  const roles = effectiveRoles(p);
  const isAthlete = roles.athlete;
  const isCoach = roles.coach;

  /** Returns inline border style if this field is currently missing and we're highlighting */
  const missingStyle = (field: string): CSSProperties =>
    missingFieldKeys.has(field) ? { outline: '2px solid var(--coral-600)', borderRadius: 4 } : {};

  // Phone validation (main)
  const mainPhoneInvalid = p.phone && !phoneValid(p.phone);
  const emergPhoneInvalid = p.emergency.phone && !phoneValid(p.emergency.phone);

  // Age validation — use minimum age based on roles
  const age = p.dob ? ageFromDob(p.dob) : null;
  const minAge = isAthlete ? 15 : 18; // coaches-only must be 18
  const ageError = age !== null && p.dob ? (age < minAge ? `${isAthlete ? 'Athletes' : 'Coaches'} must be ${minAge}+.` : null) : null;

  const canSave = draft !== null
    && validationErrors.length === 0
    && !mainPhoneInvalid
    && !ageError;

  const enterEdit = () => {
    setDraft({ ...person });
    setEditMode(true);
  };
  const discardEdit = () => {
    setDraft(null);
    setEditMode(false);
  };

  const save = () => {
    if (!canSave) return;
    mutate((d) => {
      const i = d.people.findIndex((x) => x.id === pid);
      d.people[i] = { ...p };
      pushPerson(d.people[i]);
    });
    setDraft(null);
    setEditMode(false);
    toast('Profile saved.');
    if (returnToMembership) {
      const dest = seasonParam ? `/membership?season=${seasonParam}` : '/membership';
      navigate(dest);
    }
  };

  /** Update roles and keep legacy `kind` consistent */
  const setRoles = (newRoles: { athlete: boolean; coach: boolean }) => {
    // Ensure at least one role is selected — keep previous if both would be false
    const safe = (newRoles.athlete || newRoles.coach) ? newRoles : roles;
    const kind = (safe.coach && !safe.athlete) ? 'coach' : 'athlete';
    set({ roles: safe, kind });
  };

  // Waivers: collect all memberships that have a signed waiver
  const waivers = person.memberships.filter((m) => m.waiverSignedAt);

  return (
    <div style={{ maxWidth: 760 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', marginBottom: 4 }}>
        <h1 className="page-title display" style={{ margin: 0 }}>
          {adminView ? `${p.firstName} ${p.lastName}` : 'Profile'}
        </h1>
        {!editMode && (
          <button className="btn primary small" onClick={enterEdit}>Edit profile</button>
        )}
      </div>
      <p className="page-sub">
        {adminView
          ? <><code>#/admin/members/{p.id}</code> · {p.kind} · {p.email}</>
          : 'Your competition levels, contact info, and meet-day details.'}
      </p>

      {adminView && (
        <div className="card card-pad" style={{ marginBottom: 16, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <AdminMembershipControls
            personId={pid}
            revokeSeasonId={revokeSeasonId}
            setRevokeSeasonId={setRevokeSeasonId}
          />
        </div>
      )}

      {editMode ? (
        // ----------------------------------------------------------------
        // EDIT MODE
        // ----------------------------------------------------------------
        <>
          {highlightMissing && missingFieldKeys.size > 0 && (
            <div className="badge err" style={{ display: 'block', marginBottom: 12, padding: '8px 12px', borderRadius: 6 }}>
              Complete the highlighted fields below to continue to membership.
            </div>
          )}
          <div className="card card-pad" style={{ marginBottom: 16 }}>
            <h3 className="card-title">Identity</h3>

            {/* Role selector */}
            <div style={{ marginBottom: 12 }}>
              <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink-soft)', marginBottom: 6, marginTop: 0 }}>Role</p>
              <div style={{ display: 'flex', gap: 16 }}>
                <label className="checkrow">
                  <input
                    type="checkbox"
                    checked={roles.athlete}
                    onChange={(e) => setRoles({ ...roles, athlete: e.target.checked })}
                  />
                  Athlete
                </label>
                <label className="checkrow">
                  <input
                    type="checkbox"
                    checked={roles.coach}
                    onChange={(e) => setRoles({ ...roles, coach: e.target.checked })}
                  />
                  Coach
                </label>
              </div>
              {isAthlete && isCoach && (
                <p style={{ fontSize: 12, color: 'var(--ink-soft)', marginTop: 4 }}>
                  Both roles — you'll be offered athlete and coach memberships.
                </p>
              )}
            </div>

            <div className="grid cols-2">
              <Field label="First name"><input type="text" value={p.firstName} onChange={(e) => set({ firstName: e.target.value })} style={missingStyle('firstName')} /></Field>
              <Field label="Last name"><input type="text" value={p.lastName} onChange={(e) => set({ lastName: e.target.value })} style={missingStyle('lastName')} /></Field>
              <Field label="Date of birth" hint={isAthlete ? 'Athletes must be 15+, coaches 18+.' : 'Coaches must be 18+.'}>
                <input type="date" value={p.dob} onChange={(e) => set({ dob: e.target.value })} style={missingStyle('dob')} />
                {ageError && <div style={{ fontSize: 12, color: 'var(--coral-600)', marginTop: 4 }}>{ageError}</div>}
                {missingFieldKeys.has('dob') && !p.dob && <div style={{ fontSize: 12, color: 'var(--coral-600)', marginTop: 4 }}>Required</div>}
              </Field>
              <Field label="Gender">
                <select className="input" value={p.gender} onChange={(e) => set({ gender: e.target.value as Gender })}>
                  {['Male', 'Female', 'Non-binary', 'Genderfluid', 'Agender', 'Other'].map((g) => <option key={g}>{g}</option>)}
                </select>
              </Field>
              {isAthlete && p.gender !== 'Male' && p.gender !== 'Female' && (
                <>
                  {DISCIPLINES.map((d) => (
                    <Field key={d} label={`${d} placement category`} tip="Determines which division you place in for this discipline">
                      <select className="input" value={p.placement?.[d] ?? 'women+'} onChange={(e) => set({ placement: { ...p.placement, [d]: e.target.value as 'men+' | 'women+' } })}>
                        <option value="women+">women+</option>
                        <option value="men+">men+</option>
                      </select>
                    </Field>
                  ))}
                </>
              )}
              <Field label="Undergrad graduation year" hint="Enter 1900 if you do not have a past or future undergraduate graduation year.">
                <input type="number" value={p.gradYear} onChange={(e) => set({ gradYear: +e.target.value })} />
              </Field>
              <Field label="Student status" hint="Full-time student for ≥1 semester this season (Jul–Jun)? Grad students may pick either.">
                <select className="input" value={p.studentStatus} onChange={(e) => set({ studentStatus: e.target.value as 'Student' | 'Non-Student' })} style={missingStyle('studentStatus')}>
                  <option>Student</option><option>Non-Student</option>
                </select>
              </Field>
              <Field label="T-shirt size">
                <select className="input" value={p.shirt} onChange={(e) => set({ shirt: e.target.value })} style={missingStyle('shirt')}>
                  <option value="">Select a size…</option>
                  {SHIRT_SIZES.map((s) => <option key={s}>{s}</option>)}
                </select>
                {missingFieldKeys.has('shirt') && !p.shirt && <div style={{ fontSize: 12, color: 'var(--coral-600)', marginTop: 4 }}>Required</div>}
              </Field>
              <Field label="Training state">
                <Combo options={states.map((s) => ({ value: s, label: s, sub: STATE_REGIONS[s] }))} value={p.state} onChange={(v) => set({ state: v })} />
              </Field>
              <Field label="Phone">
                <input
                  type="tel"
                  value={p.phone}
                  onChange={(e) => set({ phone: formatPhone(e.target.value) })}
                  placeholder="(555) 123-4567"
                  style={missingStyle('phone')}
                />
                {mainPhoneInvalid && <div style={{ fontSize: 12, color: 'var(--coral-600)', marginTop: 4 }}>Must be a 10-digit US phone number.</div>}
                {missingFieldKeys.has('phone') && !p.phone && <div style={{ fontSize: 12, color: 'var(--coral-600)', marginTop: 4 }}>Required</div>}
              </Field>
            </div>
          </div>

          <div className="card card-pad" style={{ marginBottom: 16 }}>
            <h3 className="card-title">
              {isAthlete && isCoach ? 'Competition & Coaching' : isCoach ? 'Coaching' : 'Competition'}
            </h3>
            <div className="grid cols-2">
              <Field
                label={isCoach ? 'Primary club' : 'Main club'}
                hint={isCoach ? 'The club you primarily coach for.' : 'The only club that can pay your membership fee.'}
              >
                <Combo options={clubOptions} value={p.mainClubId} onChange={(v) => set({ mainClubId: v })} />
              </Field>
              <Field label="Region" hint="Derived from training state.">
                <input type="text" disabled value={STATE_REGIONS[p.state] ?? 'Other'} />
              </Field>
              <Field
                label={isCoach ? 'Other clubs you coach for' : 'Other clubs'}
                hint={isCoach ? 'Additional clubs you coach or affiliate with.' : 'Clubs you also belong to — choose which one you compete for per meet at registration.'}
              >
                <Combo
                  options={clubOptions.filter((c) => c.value !== p.mainClubId && !p.altClubIds.includes(c.value))}
                  value={null}
                  onChange={(v) => set({ altClubIds: [...p.altClubIds, v] })}
                  placeholder="Add another club…"
                />
                {p.altClubIds.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                    {p.altClubIds.map((cid) => (
                      <span key={cid} className="badge info" style={{ gap: 8 }}>
                        {db.clubs.find((c) => c.id === cid)?.name ?? cid}
                        <button type="button" title="Remove club"
                          onClick={() => set({ altClubIds: p.altClubIds.filter((x) => x !== cid) })}
                          style={{ background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: 0 }}>✕</button>
                      </span>
                    ))}
                  </div>
                )}
                {!adminView && (
                  <button type="button" className="btn ghost small" style={{ marginTop: 8 }} onClick={() => setClubReqOpen(true)}>
                    Don't see your club? Request a new one
                  </button>
                )}
              </Field>
            </div>
            {isAthlete && (
              <div style={{ marginTop: 12 }}>
                <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink-soft)', marginBottom: 6, marginTop: 0 }}>Competition levels</p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {DISCIPLINES.map((d) => (
                    <Field key={d} label={`${d} level`}>
                      <select className="input" value={p.levels[d] ?? ''} onChange={(e) => set({ levels: { ...p.levels, [d]: e.target.value || undefined } })}>
                        <option value="">Not competing {d}</option>
                        {db.levels.filter((l) => l.discipline === d).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                      </select>
                    </Field>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="card card-pad" style={{ marginBottom: 16 }}>
            <h3 className="card-title">Meet-day</h3>
            <div className="grid cols-2">
              <Field label="Emergency contact"><input type="text" value={p.emergency.contact} onChange={(e) => set({ emergency: { ...p.emergency, contact: e.target.value } })} style={missingStyle('emergency.contact')} /></Field>
              <Field label="Relation"><input type="text" value={p.emergency.relation} onChange={(e) => set({ emergency: { ...p.emergency, relation: e.target.value } })} /></Field>
              <Field label="Emergency phone">
                <input
                  type="tel"
                  value={p.emergency.phone}
                  onChange={(e) => set({ emergency: { ...p.emergency, phone: formatPhone(e.target.value) } })}
                  placeholder="(555) 123-4567"
                  style={missingStyle('emergency.phone')}
                />
                {emergPhoneInvalid && <div style={{ fontSize: 12, color: 'var(--coral-600)', marginTop: 4 }}>Must be a 10-digit US phone number.</div>}
                {missingFieldKeys.has('emergency.phone') && !p.emergency.phone && <div style={{ fontSize: 12, color: 'var(--coral-600)', marginTop: 4 }}>Required</div>}
              </Field>
            </div>
            <Field label="Dietary restrictions">
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2px 18px' }}>
                {DIETARY_OPTIONS.map((opt) => (
                  <label className="checkrow" key={opt}>
                    <input
                      type="checkbox"
                      checked={p.dietary.includes(opt)}
                      onChange={(e) => set({ dietary: e.target.checked ? [...p.dietary, opt] : p.dietary.filter((x) => x !== opt) })}
                    />
                    {opt}
                  </label>
                ))}
              </div>
            </Field>
            <Field label="Dietary notes"><textarea rows={2} value={p.dietaryNotes} onChange={(e) => set({ dietaryNotes: e.target.value })} /></Field>
          </div>

          {/* Sticky save bar */}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', position: 'sticky', bottom: 16 }}>
            <button className="btn primary" disabled={!canSave} onClick={save}>Save changes</button>
            <button className="btn ghost" onClick={discardEdit}>Discard</button>
            <span style={{ alignSelf: 'center', fontSize: 13, color: 'var(--coral-600)', fontWeight: 600 }}>Unsaved changes</span>
            {validationErrors.length > 0 && (
              <span style={{ fontSize: 12, color: 'var(--coral-600)' }}>
                Required: {validationErrors.map((e) => e.label).join(', ')}
              </span>
            )}
          </div>
        </>
      ) : (
        // ----------------------------------------------------------------
        // VIEW MODE
        // ----------------------------------------------------------------
        <>
          <div className="card card-pad" style={{ marginBottom: 16 }}>
            <h3 className="card-title">Identity</h3>
            <div style={{ marginBottom: 10 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-soft)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Role</span>
              <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                {isAthlete && <Badge tone="navy">Athlete</Badge>}
                {isCoach && <Badge tone="info">Coach</Badge>}
              </div>
            </div>
            <div className="grid cols-2">
              <ViewRow label="First name" value={person.firstName} />
              <ViewRow label="Last name" value={person.lastName} />
              <ViewRow label="Date of birth" value={person.dob} />
              <ViewRow label="Gender" value={person.gender} />
              {isAthlete && person.gender !== 'Male' && person.gender !== 'Female' && DISCIPLINES.map((d) => (
                <ViewRow key={d} label={`${d} placement`} value={person.placement?.[d] ?? 'women+'} />
              ))}
              <ViewRow label="Grad year" value={person.gradYear === 1900 ? 'N/A' : String(person.gradYear)} />
              <ViewRow label="Student status" value={person.studentStatus} />
              <ViewRow label="T-shirt size" value={person.shirt} />
              <ViewRow label="Training state" value={`${person.state}${STATE_REGIONS[person.state] ? ` (${STATE_REGIONS[person.state]})` : ''}`} />
              <ViewRow label="Phone" value={person.phone} />
            </div>
          </div>

          <div className="card card-pad" style={{ marginBottom: 16 }}>
            <h3 className="card-title">
              {isAthlete && isCoach ? 'Competition & Coaching' : isCoach ? 'Coaching' : 'Competition'}
            </h3>
            <div className="grid cols-2">
              <ViewRow label={isCoach ? 'Primary club' : 'Main club'} value={db.clubs.find((c) => c.id === person.mainClubId)?.name ?? '—'} />
              <ViewRow label="Region" value={STATE_REGIONS[person.state] ?? 'Other'} />
              <div style={{ gridColumn: '1 / -1' }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink-soft)' }}>
                  {isCoach ? 'Other clubs coached' : 'Other clubs'}
                </span>
                <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {person.altClubIds.length > 0
                    ? person.altClubIds.map((cid) => (
                        <Badge key={cid} tone="info">{db.clubs.find((c) => c.id === cid)?.name ?? cid}</Badge>
                      ))
                    : <span style={{ fontSize: 13, color: 'var(--ink-soft)' }}>None</span>}
                </div>
              </div>
            </div>
            {isAthlete && (
              <div style={{ marginTop: 12 }}>
                <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink-soft)', marginBottom: 6, marginTop: 0 }}>Competition levels</p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {DISCIPLINES.map((d) => {
                    const lvl = db.levels.find((l) => l.id === person.levels[d]);
                    return (
                      <div key={d} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <span style={{ fontSize: 13, fontWeight: 500, minWidth: 60 }}>{d}:</span>
                        {lvl ? <Badge tone="navy">{lvl.name}</Badge> : <span style={{ fontSize: 13, color: 'var(--ink-soft)' }}>Not competing</span>}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          <div className="card card-pad" style={{ marginBottom: 16 }}>
            <h3 className="card-title">Meet-day</h3>
            <div className="grid cols-2">
              <ViewRow label="Emergency contact" value={person.emergency.contact} />
              <ViewRow label="Relation" value={person.emergency.relation} />
              <ViewRow label="Emergency phone" value={person.emergency.phone} />
            </div>
            {person.dietary.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink-soft)' }}>Dietary restrictions</span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                  {person.dietary.map((d) => <Badge key={d} tone="info">{d}</Badge>)}
                </div>
              </div>
            )}
            {person.dietaryNotes && (
              <div style={{ marginTop: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink-soft)' }}>Dietary notes</span>
                <p style={{ fontSize: 13, margin: '4px 0 0' }}>{person.dietaryNotes}</p>
              </div>
            )}
          </div>

          {person.achievements.length > 0 && (
            <div className="card card-pad" style={{ marginBottom: 16 }}>
              <h3 className="card-title">Achievements</h3>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {person.achievements.map((a) => <Badge key={a} tone="info">🏅 {a}</Badge>)}
              </div>
            </div>
          )}

          {/* Waivers on file */}
          <WaiversSection
            personId={pid}
            personFirstName={person.firstName}
            personLastName={person.lastName}
            personEmail={person.email}
            waivers={waivers}
            adminView={adminView}
            memberships={person.memberships}
            seasons={db.seasons}
          />
        </>
      )}

      {clubReqOpen && <ClubRequestForm requesterPersonId={pid} onClose={() => setClubReqOpen(false)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Waivers on file section
// ---------------------------------------------------------------------------
import type { Membership, Season } from '../lib/types';

interface WaiversSectionProps {
  personId: string;
  personFirstName: string;
  personLastName: string;
  personEmail: string;
  waivers: Membership[];
  adminView: boolean;
  memberships: Membership[];
  seasons: Season[];
}

function WaiversSection({ personFirstName, personLastName, personEmail, waivers, adminView, memberships, seasons }: WaiversSectionProps) {
  const toast = useToast();
  const [emailModalOpen, setEmailModalOpen] = useState(false);

  return (
    <div className="card card-pad" style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
        <h3 className="card-title" style={{ margin: 0 }}>Waivers on file</h3>
        {adminView && (
          <button className="btn small ghost" onClick={() => setEmailModalOpen(true)}>
            ✉ Email waiver
          </button>
        )}
      </div>

      {waivers.length === 0 ? (
        <p style={{ fontSize: 13, color: 'var(--ink-soft)', margin: 0 }}>No waivers on file.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {waivers.map((m) => {
            const season = seasons.find((s) => s.id === m.seasonId);
            const seasonLabel = season?.name ?? m.seasonId;
            const typeLabel = m.type === 'coach' ? 'Coach' : 'Athlete';
            const signedDate = m.waiverSignedAt ? m.waiverSignedAt.slice(0, 10) : '';
            const signedBy = m.waiverSignedBy ?? '';
            return (
              <div key={`${m.seasonId}-${m.type}`} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <Badge tone="ok">Signed</Badge>
                <span style={{ fontSize: 13, fontWeight: 500 }}>{seasonLabel} · {typeLabel}</span>
                <span style={{ fontSize: 12, color: 'var(--ink-soft)' }}>
                  {signedDate}{signedBy ? ` · by ${signedBy}` : ''}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {adminView && emailModalOpen && (
        <EmailWaiverModal
          memberships={memberships}
          seasons={seasons}
          onClose={() => setEmailModalOpen(false)}
          onSend={(seasonId, type) => {
            const season = seasons.find((s) => s.id === seasonId);
            const typeLabel = type === 'coach' ? 'Coach' : 'Athlete';
            const appUrl = window.location.origin + import.meta.env.BASE_URL.replace(/\/$/, '');
            const link = `${appUrl}/#/membership`;
            const subject = `Action needed: sign your ${season?.name ?? ''} ${typeLabel} waiver`;
            const html = `<p>Hi ${personFirstName},</p>
<p>Please sign your <strong>${season?.name ?? ''}</strong> ${typeLabel} membership waiver
for United Club Gymnastics to keep your membership active.</p>
<p><a href="${link}">Review &amp; sign your waiver &rarr;</a></p>`;
            sendEmail(subject, html, [{ email: personEmail, name: `${personFirstName} ${personLastName}` }])
              .then((res) => toast(res.ok && res.sentCount > 0
                ? `Waiver email sent to ${personEmail}.`
                : `Waiver email failed: ${res.error ?? 'unknown error'}.`));
            setEmailModalOpen(false);
          }}
        />
      )}
    </div>
  );
}

interface EmailWaiverModalProps {
  memberships: Membership[];
  seasons: Season[];
  onClose: () => void;
  onSend: (seasonId: string, type: 'athlete' | 'coach') => void;
}

function EmailWaiverModal({ memberships, seasons, onClose, onSend }: EmailWaiverModalProps) {
  // Build options: one per (season, type) combination, defaulting to all active seasons
  const options: { seasonId: string; type: 'athlete' | 'coach'; label: string }[] = [];
  for (const s of seasons) {
    // Offer for each membership type the person has (or both if no memberships yet)
    const personTypes = new Set(memberships.map((m) => m.type));
    const types: Array<'athlete' | 'coach'> = personTypes.size > 0 ? Array.from(personTypes) : ['athlete'];
    for (const t of types) {
      options.push({ seasonId: s.id, type: t, label: `${s.name} · ${t === 'coach' ? 'Coach' : 'Athlete'}` });
    }
  }

  const [selected, setSelected] = useState(options[0]?.label ?? '');
  const chosen = options.find((o) => o.label === selected);

  return (
    <Modal title="Email waiver" onClose={onClose}>
      <p style={{ marginTop: 0, fontSize: 13 }}>
        Choose the waiver (season + type) to send to this person.
      </p>
      <Field label="Waiver">
        <select className="input" value={selected} onChange={(e) => setSelected(e.target.value)}>
          {options.map((o) => (
            <option key={o.label} value={o.label}>{o.label}</option>
          ))}
        </select>
      </Field>
      <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
        <button
          className="btn primary"
          disabled={!chosen}
          onClick={() => chosen && onSend(chosen.seasonId, chosen.type)}
        >
          Send waiver
        </button>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Small helper: read-only label/value pair
// ---------------------------------------------------------------------------
function ViewRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--ink-soft)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</span>
      <p style={{ fontSize: 14, margin: '2px 0 0', fontWeight: 500 }}>{value || <span style={{ color: 'var(--ink-soft)' }}>—</span>}</p>
    </div>
  );
}

/** Member-facing "request a new club" form. Admins review the queue in AdminClubs.
 *  Email to newclubinquiries@naigc.org is deferred (see CLAUDE.md). */
function ClubRequestForm({ requesterPersonId, onClose }: { requesterPersonId: string; onClose: () => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [shortName, setShortName] = useState('');
  const [state, setState] = useState('');
  const [note, setNote] = useState('');
  const states = Object.keys(STATE_REGIONS);

  const submit = () => {
    if (!name.trim()) return;
    const req: ClubRequest = {
      id: crypto.randomUUID(),
      requesterPersonId,
      proposedName: name.trim(),
      shortName: shortName.trim(),
      state,
      region: (STATE_REGIONS[state] ?? '') as Region | '',
      note: note.trim(),
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    mutate((d) => { d.clubRequests.push(req); pushClubRequest(req); });
    toast('Request submitted — a UCG admin will review it.');
    onClose();
  };

  return (
    <Modal title="Request a new club" onClose={onClose}>
      <Field label="Club name"><input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Rocky Mountain Gymnastics Club" autoFocus /></Field>
      <Field label="Short name" hint="Abbreviation shown on results."><input type="text" value={shortName} onChange={(e) => setShortName(e.target.value)} placeholder="RMGC" /></Field>
      <Field label="State">
        <select className="input" value={state} onChange={(e) => setState(e.target.value)}>
          <option value="">Select a state…</option>
          {states.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </Field>
      <Field label="Anything else?" hint="Region is set automatically from the state."><textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
        <button className="btn primary" disabled={!name.trim()} onClick={submit}>Submit request</button>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

function AdminMembershipControls({
  personId,
  revokeSeasonId,
  setRevokeSeasonId,
}: {
  personId: string;
  revokeSeasonId: string | null;
  setRevokeSeasonId: (id: string | null) => void;
}) {
  const db = useDB();
  const toast = useToast();
  const caps = useCapabilities();
  const person = db.people.find((x) => x.id === personId)!;
  const roles = effectiveRoles(person);

  const confirmRevoke = () => {
    if (!revokeSeasonId) return;
    let removedCount = 0;
    mutate((d) => {
      const personInDraft = d.people.find((x) => x.id === personId)!;
      // Update membership status
      const em = personInDraft.memberships.find((x) => x.seasonId === revokeSeasonId);
      if (em) {
        em.status = 'none';
        pushMembership(personInDraft.id, em);
      }
      // Remove from upcoming meets
      const openStatuses = new Set(['draft', 'reg-open', 'reg-closed']);
      const openMeetIds = new Set(d.meets.filter((m) => openStatuses.has(m.status)).map((m) => m.id));
      const toRemove = d.registrations.filter((r) => r.athleteId === personId && openMeetIds.has(r.meetId));
      removedCount = toRemove.length;
      toRemove.forEach((r) => deleteRegistration(r.id));
      d.registrations = d.registrations.filter((r) => !(r.athleteId === personId && openMeetIds.has(r.meetId)));
    });
    toast(`Membership revoked; removed from ${removedCount} upcoming competition${removedCount !== 1 ? 's' : ''}.`);
    setRevokeSeasonId(null);
  };

  return (
    <>
      {[...db.seasons].sort((a, b) => {
        if (a.current && !b.current) return -1;
        if (!a.current && b.current) return 1;
        return b.startsOn.localeCompare(a.startsOn); // newest → oldest
      }).map((s) => {
        const m = person.memberships.find((x) => x.seasonId === s.id);
        const isActive = m?.status === 'active';
        return (
          <div key={s.id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <strong style={{ fontSize: 13 }}>{s.name}{s.current ? ' (Current)' : ''}:</strong>
            {isActive ? <Badge tone="ok">Active{m?.activatedByAdmin ? ' (admin)' : ''}</Badge>
              : m?.status === 'pending-club-payment' ? <Badge tone="warn">Pending club</Badge>
              : <Badge tone="err">None</Badge>}
            {m?.waiverSignedAt && <span data-tip={`Signed by ${m.waiverSignedBy} · ${m.waiverSignedAt.slice(0, 10)}`} style={{ fontSize: 12, cursor: 'help' }}>📝</span>}
            {caps.actingAsAdmin && (
              <button
                className="btn small ghost"
                onClick={() => {
                  if (isActive) {
                    setRevokeSeasonId(s.id);
                  } else {
                    // Default new grant type: coach if coach-only, else athlete
                    const defaultType: 'athlete' | 'coach' = (roles.coach && !roles.athlete) ? 'coach' : 'athlete';
                    mutate((d) => {
                      const personInDraft = d.people.find((x) => x.id === personId)!;
                      let em = personInDraft.memberships.find((x) => x.seasonId === s.id);
                      if (em) {
                        em.status = 'active'; em.activatedByAdmin = true;
                      } else {
                        em = { seasonId: s.id, type: defaultType, status: 'active', waiverSignedAt: null, waiverSignedBy: null, paidVia: 'comp', activatedByAdmin: true };
                        personInDraft.memberships.push(em);
                      }
                      pushMembership(personInDraft.id, em);
                    });
                    toast(`Membership activated for ${s.name}.`);
                  }
                }}
              >
                {isActive ? 'Revoke' : 'Activate'}
              </button>
            )}
          </div>
        );
      })}

      {revokeSeasonId && (
        <Modal title="Revoke membership?" onClose={() => setRevokeSeasonId(null)}>
          <p style={{ marginTop: 0 }}>
            Revoking this membership will remove <strong>{person.firstName} {person.lastName}</strong> from all future registered competitions.
          </p>
          <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
            <button className="btn primary" style={{ background: 'var(--coral-600)', borderColor: 'var(--coral-600)' }} onClick={confirmRevoke}>
              Yes, revoke
            </button>
            <button className="btn ghost" onClick={() => setRevokeSeasonId(null)}>Cancel</button>
          </div>
        </Modal>
      )}
    </>
  );
}
