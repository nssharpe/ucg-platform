import { useState, useMemo, useEffect, type CSSProperties } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { useDB, mutate } from '../lib/store';
import { useCapabilities } from '../lib/capabilities';
import { Combo, Field, Modal, Badge } from '../components/ui';
import { useToast } from '../components/ui-hooks';
import { SHIRT_SIZES, DIETARY_OPTIONS, STATE_REGIONS, DISCIPLINES } from '../lib/types';
import type { Athlete, ClubRequest, Gender, MembershipType, Region } from '../lib/types';
import { membershipTypeOf } from '../lib/capabilities-core';
import { GENERAL_WAIVER_TYPE } from '../lib/types';
import { pushClubRequest, pushMembership, pushPerson, deleteRegistration, sendEmail, createWaiverLink, fetchPublishedWaiver, requestManagerAccess, adminDeletePerson } from '../lib/supabase';
import { getSession, useAuthLoading, useRolesLoaded } from '../lib/auth';
import { syncFromSupabase } from '../lib/store';
import { MfaSection } from './ProfileMfa';
import { PasskeysSection } from './ProfilePasskeys';
import { escapeHtml } from '../lib/sanitize-html';
import { downloadWaiverProof, formatSignedAt } from '../lib/waiver-proof';
import { isMinorAt } from '../lib/waivers-core';
import { eventIsInPhase } from '../lib/events-core';
import { collectPersonData } from '../lib/person-data';
import { downloadPersonDataJson, downloadPersonDataPdf } from '../lib/person-export';
import type { AdminDeletePersonManifest } from '../lib/supabase';

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

/** Is an athlete profile still "not yet completed"? We reuse the required
 *  `studentStatus` field as the unset marker (`''` = never filled in) rather
 *  than adding a DB column. A brand-new self-signup person lands here with
 *  `studentStatus === ''` and `mainClubId === null`. */
function athleteProfileIncomplete(p: Athlete): boolean {
  return effectiveRoles(p).athlete && !p.studentStatus;
}

// `independent` is local form state (the "No club" checkbox), not stored on the
// person — the stored value is `mainClubId` (null = no club). validateProfile
// takes it so it can require an explicit club-vs-Independent choice for new
// athlete accounts. Defaults to deriving from `mainClubId` for callers (e.g.
// the initial editMode check) that don't have the live toggle.
function validateProfile(p: Athlete, independentChecked: boolean = p.mainClubId === null): ValidationErrors {
  const errs: ValidationErrors = [];
  // Athlete-only fields: a later task hides student status + grad year for
  // coach-only accounts, so only require them when the person is an athlete.
  const isAthlete = effectiveRoles(p).athlete;
  if (!p.firstName.trim()) errs.push({ field: 'firstName', label: 'First name' });
  if (!p.lastName.trim()) errs.push({ field: 'lastName', label: 'Last name' });
  if (!p.dob) errs.push({ field: 'dob', label: 'Date of birth' });
  if (isAthlete && !p.gradYear) errs.push({ field: 'gradYear', label: 'Graduation year' }); // 0/undefined = not chosen; 1900 = N/A (ok)
  // Coach-only accounts see "Coaching state"; anyone training outside the US has no state.
  const coachOnly = effectiveRoles(p).coach && !effectiveRoles(p).athlete;
  if (!p.outsideUs && !p.state) errs.push({ field: 'state', label: coachOnly ? 'Coaching state' : 'Training state' });
  if (!p.phone) errs.push({ field: 'phone', label: 'Phone' });
  if (!p.shirt) errs.push({ field: 'shirt', label: 'T-shirt size' });
  if (isAthlete && !p.studentStatus) errs.push({ field: 'studentStatus', label: 'Student status' });
  // Main club: `string` = a club is picked, `null` = "No club / Independent
  // Athlete". For a COMPLETE athlete profile both are valid choices. But a new
  // self-signup account is created with `mainClubId = null` and lands here to
  // fill in its profile — we must NOT treat that default null as "Independent
  // chosen". So for an incomplete athlete profile require an explicit choice:
  // a club picked OR the Independent box ticked (feedback 1c). The local
  // `independent` toggle is the only signal that null means a deliberate choice.
  if (isAthlete && athleteProfileIncomplete(p)) {
    const clubChosen = independentChecked || !!p.mainClubId;
    if (!clubChosen) errs.push({ field: 'mainClubId', label: 'Main club' });
  }
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

// Admin-header role label (T3a): derived from the same effective-roles logic
// as `effectiveRoles` above, rather than the raw `p.kind` field, so a member
// with both roles reads as "athlete/coach" instead of just their legacy kind.
// AdminMembers.tsx's Type column (T2, typed-membership residuals) mirrors
// this exact same derivation via its own local `localEffectiveRoles` — kept
// local rather than imported cross-file to avoid breaking this file's
// react-refresh/only-export-components constraint (Profile.tsx must only
// export components).
function adminRoleLabel(p: Athlete): string {
  const roles = effectiveRoles(p);
  if (roles.athlete && roles.coach) return 'athlete/coach';
  if (roles.athlete) return 'athlete';
  if (roles.coach) return 'coach';
  return p.kind;
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
  // Auth/sync readiness signals — only meaningful for the SELF view. On an
  // account switch (or fresh email-confirm sign-in) the session changes before
  // syncFromSupabase() pulls the new user's person row into the snapshot, so a
  // naive `!person` check would flash "Person not found." `rolesLoaded` is the
  // reliable "ready" gate: onAuthenticated awaits linkOrCreatePerson →
  // syncFromSupabase() → fetchMyRoles before setting it true, so
  // rolesLoaded === true implies the new user's person row is already in the
  // snapshot. (It's reset to false on every user change.)
  const authLoading = useAuthLoading();
  const rolesLoaded = useRolesLoaded();
  const personId = adminView ? params.personId! : caps.personId;
  const person = db.people.find((p) => p.id === personId);
  // Self view: are we still resolving auth/sync, so a missing person is just
  // "not loaded yet" rather than "no access"? Don't show not-found during this
  // window — show the loader, then (once settled) redirect Home if truly absent.
  const selfResolving = !adminView && (authLoading || !rolesLoaded);

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
  // Per-type revoke target (T2, typed-membership residuals) — athlete and
  // coach memberships are independent rows, so the revoke confirmation needs
  // to know WHICH type it's acting on.
  const [revokeTarget, setRevokeTarget] = useState<{ seasonId: string; type: MembershipType } | null>(null);
  // F5: admin data export / delete-and-anonymize
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  // "Independent Athlete" = no club (mainClubId null). Tracked locally so the
  // user can tick it before/instead of picking a club from the dropdown.
  // For an INCOMPLETE new athlete profile (studentStatus unset + no club) we
  // start UNCHECKED so neither a club nor No-club is pre-selected — the user
  // must take an explicit action (feedback 1c). Only derive Independent from a
  // null club when the profile is already complete (or it's a coach).
  const [independent, setIndependent] = useState<boolean>(() =>
    person ? !athleteProfileIncomplete(person) && person.mainClubId === null : false
  );

  // Hooks must run unconditionally, so derive these before the early return below.
  // `current` is null only when `person` is missing (the not-found path).
  const current = draft ?? person ?? null;
  const validationErrors = useMemo(() => (current ? validateProfile(current, independent) : []), [current, independent]);

  // When arriving from membership, highlight still-empty required fields in red.
  // The club-choice guard (feedback 1c) also self-surfaces outside that flow:
  // a new self-signup lands in edit mode without `?return=membership`, so always
  // surface a missing `mainClubId` choice so the disabled Save has a visible reason.
  const missingFieldKeys = useMemo(
    () => {
      const base = highlightMissing ? validationErrors.map((e) => e.field) : [];
      const keys = new Set(base);
      if (validationErrors.some((e) => e.field === 'mainClubId')) keys.add('mainClubId');
      return keys;
    },
    [highlightMissing, validationErrors]
  );

  // Self view, settled, and still no person row = the signed-in user genuinely
  // has no profile for the current account. Don't strand them on "Person not
  // found" — send them Home. (Terminal state: rolesLoaded is true here, so this
  // can't loop with the loader below.) The admin members detail view keeps its
  // real not-found for a bad :personId.
  const selfNoAccess = !adminView && !person && !selfResolving;
  useEffect(() => {
    if (selfNoAccess) navigate('/', { replace: true });
  }, [selfNoAccess, navigate]);

  // While auth/sync is still resolving on the self view, show the loader rather
  // than a transient "Person not found" (feedback 1i/1j). Same Loading… style
  // as App's PageFallback.
  if (!person) {
    if (selfResolving || selfNoAccess) {
      return <div style={{ padding: 40, textAlign: 'center', color: 'var(--ink-soft)' }}>Loading…</div>;
    }
    return <p>Person not found.</p>;
  }
  const pid: string = person.id;
  const p = draft ?? person;
  const set = (patch: Partial<Athlete>) => setDraft({ ...p, ...patch });
  const clubOptions = db.clubs.map((c) => ({ value: c.id, label: c.name, sub: `${c.state} · ${c.region}` }));
  const states = Object.keys(STATE_REGIONS);

  const roles = effectiveRoles(p);
  const isAthlete = roles.athlete;
  const isCoach = roles.coach;
  // Coach-only: hide student status + grad year, relabel state field (feedback 1e).
  const coachOnly = isCoach && !isAthlete;
  const outsideUs = !!p.outsideUs;
  const stateLabel = coachOnly ? 'Coaching state' : 'Training state';

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
    // When the user is saving THEIR OWN profile (not an admin editing someone
    // else), stamp the session uid so a first-time self INSERT satisfies the
    // `people` insert RLS policy (`auth_user_id = auth.uid()`). adminView edits
    // of OTHER people must NOT pass it (they pass is_admin() instead).
    const selfAuthUserId = adminView ? undefined : getSession()?.user.id;
    const applied = mutate((d) => {
      const i = d.people.findIndex((x) => x.id === pid);
      d.people[i] = { ...p };
      pushPerson(d.people[i], selfAuthUserId ? { selfAuthUserId } : undefined);
    });
    if (!applied) return; // offline read-only gate — no false success toast
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
          ? <>{adminRoleLabel(p)} · {p.email}</>
          : 'Your competition levels, contact info, and event-day details.'}
      </p>

      {adminView && (
        <div className="card card-pad" style={{ marginBottom: 16, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <AdminMembershipControls
            personId={pid}
            revokeTarget={revokeTarget}
            setRevokeTarget={setRevokeTarget}
          />
        </div>
      )}

      {/* F5: admin-operated data export / delete-and-anonymize. */}
      {adminView && person && (
        <div className="card card-pad" style={{ marginBottom: 16, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 13.5 }}>Data privacy</strong>
          <button
            className="btn small ghost"
            onClick={() => {
              const data = collectPersonData(db, pid);
              downloadPersonDataJson(data);
              downloadPersonDataPdf(data);
              toast('Data export downloaded (JSON + PDF).');
            }}
          >
            Export data
          </button>
          <button
            className="btn small ghost"
            style={{ color: 'var(--coral-700)', borderColor: 'var(--coral-700)' }}
            onClick={() => setShowDeleteModal(true)}
          >
            Delete / anonymize…
          </button>
        </div>
      )}
      {showDeleteModal && person && (
        <DeletePersonModal person={person} onClose={() => setShowDeleteModal(false)} />
      )}

      {/* Self-service only — MFA factors / passkeys belong to the auth session,
          not to an arbitrary person record an admin is editing. */}
      {!adminView && <MfaSection />}
      {!adminView && <PasskeysSection />}

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
                <select className="input" value={p.gender ?? ''} onChange={(e) => set({ gender: (e.target.value || null) as Gender })}>
                  <option value="">Select…</option>
                  {['Male', 'Female', 'Non-binary', 'Genderfluid', 'Agender', 'Other'].map((g) => <option key={g}>{g}</option>)}
                </select>
              </Field>
              {isAthlete && !!p.gender && p.gender !== 'Male' && p.gender !== 'Female' && (
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
              {!coachOnly && (
                <Field label="Undergrad graduation year">
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    <input type="number" disabled={p.gradYear === 1900} placeholder="YYYY" style={missingStyle('gradYear')}
                      value={p.gradYear === 1900 || !p.gradYear ? '' : p.gradYear}
                      onChange={(e) => set({ gradYear: +e.target.value || 0 })} />
                    <label className="checkrow" style={{ whiteSpace: 'nowrap', margin: 0 }}>
                      {/* 1900 = N/A; 0 = not yet chosen */}
                      <input type="checkbox" checked={p.gradYear === 1900} onChange={(e) => set({ gradYear: e.target.checked ? 1900 : 0 })} />
                      N/A
                    </label>
                  </div>
                  {missingFieldKeys.has('gradYear') && !p.gradYear && <div style={{ fontSize: 12, color: 'var(--coral-600)', marginTop: 4 }}>Enter a year or check N/A.</div>}
                </Field>
              )}
              {!coachOnly && (
                <Field label="Student status" hint="Full-time student for ≥1 semester this season (Jul–Jun)? Grad students may pick either.">
                  <select className="input" value={p.studentStatus || ''} onChange={(e) => set({ studentStatus: e.target.value as Athlete['studentStatus'] })} style={missingStyle('studentStatus')}>
                    <option value="" disabled>Select a student status…</option>
                    <option value="Student">Student</option><option value="Non-Student">Non-Student</option>
                  </select>
                  {missingFieldKeys.has('studentStatus') && !p.studentStatus && <div style={{ fontSize: 12, color: 'var(--coral-600)', marginTop: 4 }}>Required</div>}
                </Field>
              )}
              <Field label="T-shirt size">
                <select className="input" value={p.shirt} onChange={(e) => set({ shirt: e.target.value })} style={missingStyle('shirt')}>
                  <option value="">Select a size…</option>
                  {SHIRT_SIZES.map((s) => <option key={s}>{s}</option>)}
                </select>
                {missingFieldKeys.has('shirt') && !p.shirt && <div style={{ fontSize: 12, color: 'var(--coral-600)', marginTop: 4 }}>Required</div>}
              </Field>
              <Field label={stateLabel}>
                {outsideUs ? (
                  <input type="text" disabled value="Outside US" />
                ) : (
                  <div style={missingStyle('state')}>
                    <Combo options={states.map((s) => ({ value: s, label: s, sub: STATE_REGIONS[s] }))} value={p.state} onChange={(v) => set({ state: v })} />
                  </div>
                )}
                <label className="checkrow" style={{ margin: '8px 0 0' }}>
                  <input type="checkbox" checked={outsideUs}
                    onChange={(e) => set(e.target.checked ? { outsideUs: true, state: '' } : { outsideUs: false })} />
                  {coachOnly ? 'Coaching outside the US' : 'Training outside the US'}
                </label>
                {!outsideUs && missingFieldKeys.has('state') && !p.state && <div style={{ fontSize: 12, color: 'var(--coral-600)', marginTop: 4 }}>Required</div>}
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
            <p style={{ fontSize: 13, color: 'var(--ink-soft)', marginTop: 8, marginBottom: 0 }}>
              UCG may text this number about award notifications (e.g. at Nationals) — covered by
              the liability waiver signed at registration. Msg &amp; data rates may apply. Reply STOP to opt out at any time.
            </p>
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
                {independent ? (
                  <input type="text" disabled value="Independent Athlete" />
                ) : (
                  <div style={missingStyle('mainClubId')}>
                    <Combo options={clubOptions} value={p.mainClubId} placeholder="Select a club…" onChange={(v) => set({ mainClubId: v })} />
                  </div>
                )}
                {!isCoach && (
                  <label className="checkrow" style={{ margin: '8px 0 0' }}>
                    <input type="checkbox" checked={independent}
                      onChange={(e) => { setIndependent(e.target.checked); if (e.target.checked) set({ mainClubId: null }); }} />
                    No club — I am an Independent Athlete
                  </label>
                )}
                {missingFieldKeys.has('mainClubId') && (
                  <div style={{ fontSize: 12, color: 'var(--coral-600)', marginTop: 4 }}>Pick a club, or check "No club".</div>
                )}
              </Field>
              <Field label="Region" hint={outsideUs ? 'Set because you train outside the US.' : `Derived from ${stateLabel.toLowerCase()}.`}>
                <input type="text" disabled value={outsideUs ? 'Outside US' : p.state ? STATE_REGIONS[p.state] ?? 'Other' : '—'} />
              </Field>
              <Field
                label={isCoach ? 'Other clubs you coach for' : 'Other clubs'}
                hint={isCoach ? 'Additional clubs you coach or affiliate with.' : 'Clubs you also belong to — choose which one you compete for per event at registration.'}
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
            <h3 className="card-title">Event-day</h3>
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
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', position: 'sticky', bottom: 16, zIndex: 10, background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 12, padding: '10px 14px', boxShadow: 'var(--shadow-lg)', marginInline: 24 }}>
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
              {!coachOnly && <ViewRow label="Grad year" value={person.gradYear === 1900 ? 'N/A' : String(person.gradYear)} />}
              {!coachOnly && <ViewRow label="Student status" value={person.studentStatus} />}
              <ViewRow label="T-shirt size" value={person.shirt} />
              <ViewRow label={stateLabel} value={person.outsideUs ? 'Outside US' : `${person.state}${STATE_REGIONS[person.state] ? ` (${STATE_REGIONS[person.state]})` : ''}`} />
              <ViewRow label="Phone" value={person.phone} />
            </div>
          </div>

          <div className="card card-pad" style={{ marginBottom: 16 }}>
            <h3 className="card-title">
              {isAthlete && isCoach ? 'Competition & Coaching' : isCoach ? 'Coaching' : 'Competition'}
            </h3>
            <div className="grid cols-2">
              <ViewRow label={isCoach ? 'Primary club' : 'Main club'} value={db.clubs.find((c) => c.id === person.mainClubId)?.name ?? '—'} />
              <ViewRow label="Region" value={person.outsideUs ? 'Outside US' : STATE_REGIONS[person.state] ?? 'Other'} />
              {!adminView && person.mainClubId && !caps.managedClubIds.includes(person.mainClubId) && (
                <div style={{ gridColumn: '1 / -1' }}>
                  <RequestAdminRoleButton
                    clubId={person.mainClubId}
                    clubName={db.clubs.find((c) => c.id === person.mainClubId)?.name ?? 'your club'}
                  />
                </div>
              )}
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
            <h3 className="card-title">Event-day</h3>
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
            const html = `<p>Hi ${escapeHtml(personFirstName)},</p>
<p>Please sign your <strong>${escapeHtml(season?.name ?? '')}</strong> ${typeLabel} membership waiver
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
    if (!mutate((d) => { d.clubRequests.push(req); pushClubRequest(req); })) return; // offline read-only gate
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

// "Request Club Admin Role" — emails the club's managers + admins a no-login
// review link. The first to approve adds this member as a club manager.
function RequestAdminRoleButton({ clubId, clubName }: { clubId: string; clubName: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const request = async () => {
    setBusy(true);
    const res = await requestManagerAccess(clubId);
    setBusy(false);
    if (res.ok) { setSent(true); toast(`Request sent — ${clubName}'s managers and league admins can approve it.`); }
    else toast(res.error ?? 'Could not send the request.', { variant: 'error' });
  };

  return (
    <div style={{ marginTop: 8 }}>
      <button className="btn ghost small" disabled={busy || sent} onClick={request}>
        {sent ? '✓ Admin role requested' : busy ? 'Sending…' : 'Request Club Admin Role'}
      </button>
      <p style={{ fontSize: 12, color: 'var(--ink-soft)', margin: '4px 0 0' }}>
        Ask {clubName}'s managers for permission to manage its roster, registrations, and cart.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// F5: admin-operated delete / anonymize (type-the-name confirmation)
// ---------------------------------------------------------------------------
function manifestSummaryLines(m: AdminDeletePersonManifest): string[] {
  const lines: string[] = [];
  const deletedTotal = Object.values(m.deleted).reduce((a, b) => a + b, 0);
  lines.push(`Deleted ${deletedTotal} row(s): ${Object.entries(m.deleted).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  const anonTotal = Object.values(m.anonymized).reduce((a, b) => a + b, 0);
  lines.push(`Anonymized ${anonTotal} label(s): ${Object.entries(m.anonymized).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  lines.push(`Kept as-is: ${m.kept.join(', ')}`);
  lines.push(m.personDeleted
    ? 'The person record itself was fully deleted (no financial/competition/waiver records referenced it).'
    : 'The person record was scrubbed into a tombstone in place (financial, competition, or waiver records still reference it).');
  lines.push(m.authUserDeleted ? 'Their login account was deleted.' : 'No login account was attached (or deletion failed — check error_logs).');
  return lines;
}

function DeletePersonModal({ person, onClose }: { person: Athlete; onClose: () => void }) {
  const toast = useToast();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [manifest, setManifest] = useState<AdminDeletePersonManifest | null>(null);
  const fullName = `${person.firstName} ${person.lastName}`.trim();
  const canConfirm = typed.trim().toLowerCase() === fullName.toLowerCase() && !busy;

  const doDelete = async () => {
    setBusy(true);
    const res = await adminDeletePerson({ personId: person.id, confirmName: typed.trim() });
    setBusy(false);
    if (!res.ok || !res.manifest) {
      toast(`Delete failed: ${res.error ?? 'unknown error'}.`, { variant: 'error' });
      return;
    }
    setManifest(res.manifest);
    await syncFromSupabase();
  };

  if (manifest) {
    return (
      <Modal title="Delete / anonymize — complete" onClose={onClose}>
        <ul style={{ margin: '0 0 12px', paddingLeft: 18, fontSize: 13.5, lineHeight: 1.7 }}>
          {manifestSummaryLines(manifest).map((l, i) => <li key={i}>{l}</li>)}
        </ul>
        <button className="btn primary" onClick={onClose}>Done</button>
      </Modal>
    );
  }

  return (
    <Modal title="Delete / anonymize this person?" onClose={onClose}>
      <p style={{ marginTop: 0, fontSize: 14, color: 'var(--coral-700)', fontWeight: 600 }}>
        This is irreversible. Their login account will be deleted immediately.
      </p>
      <p style={{ fontSize: 13.5 }}>
        <strong>Deleted outright:</strong> never-paid registrations, their cart items, waitlist entries,
        guardian signing links, pending/rejected refund requests, pending account invites, and any
        per-event admin grants.
      </p>
      <p style={{ fontSize: 13.5 }}>
        <strong>Retained but anonymized:</strong> paid registrations, scores, invoices, payments, and
        approved refund requests stay on record for financial/competition history — only their name is
        scrubbed out of purchase-line labels.
      </p>
      <p style={{ fontSize: 13.5 }}>
        <strong>Kept as-is:</strong> signed waiver records (legal retention).
      </p>
      <Field label={`Type "${fullName}" to confirm`}>
        <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={fullName} autoFocus />
      </Field>
      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <button
          className="btn primary"
          style={{ background: 'var(--coral-700)', borderColor: 'var(--coral-700)' }}
          disabled={!canConfirm}
          onClick={doDelete}
        >
          {busy ? 'Deleting…' : 'Delete / anonymize'}
        </button>
        <button className="btn ghost" disabled={busy} onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

const MEMBERSHIP_TYPES: MembershipType[] = ['athlete', 'coach'];
const membershipTypeLabel = (t: MembershipType) => (t === 'coach' ? 'Coach' : 'Athlete');

function AdminMembershipControls({
  personId,
  revokeTarget,
  setRevokeTarget,
}: {
  personId: string;
  revokeTarget: { seasonId: string; type: MembershipType } | null;
  setRevokeTarget: (v: { seasonId: string; type: MembershipType } | null) => void;
}) {
  const db = useDB();
  const toast = useToast();
  const caps = useCapabilities();
  const person = db.people.find((x) => x.id === personId)!;
  // Season for which the "pending waiver" link popup is open.
  const [waiverPopupSeason, setWaiverPopupSeason] = useState<string | null>(null);

  // A waiver is on file if a membership row records it, or a signature exists.
  // Shared per season (the single General waiver, confirmed final) — NOT
  // per-type, so this check stays season-only.
  const hasWaiverOnFile = (seasonId: string) =>
    person.memberships.some((x) => x.seasonId === seasonId && x.waiverSignedAt) ||
    (db.waiverSignatures ?? []).some((x) => x.personId === person.id && x.seasonId === seasonId);

  // Admin "Activate": if a waiver is already on file the membership goes active
  // immediately; otherwise it becomes "pending-waiver" (like a minor) and we open
  // the popup so the admin can email or copy a no-login signing link. Signing
  // flips it to active via record-waiver-signature. Acts on ONLY the given
  // type's row — athlete and coach memberships are independent (T2).
  const activate = (seasonId: string, type: MembershipType) => {
    const seasonName = db.seasons.find((s) => s.id === seasonId)?.name ?? seasonId;
    const waiverOk = hasWaiverOnFile(seasonId);
    const applied = mutate((d) => {
      const pid = d.people.find((x) => x.id === personId)!;
      let em = pid.memberships.find((x) => x.seasonId === seasonId && membershipTypeOf(x) === type);
      const status = waiverOk ? 'active' : 'pending-waiver';
      if (em) { em.status = status; em.activatedByAdmin = true; if (!em.paidVia) em.paidVia = 'comp'; }
      else {
        em = { seasonId, type, status, waiverSignedAt: null, waiverSignedBy: null, paidVia: 'comp', activatedByAdmin: true };
        pid.memberships.push(em);
      }
      pushMembership(pid.id, em);
    });
    if (!applied) return; // offline read-only gate — no false success toast
    if (waiverOk) toast(`${membershipTypeLabel(type)} membership activated for ${seasonName}.`);
    else {
      toast(`${seasonName} ${membershipTypeLabel(type).toLowerCase()} membership is pending a signed waiver.`);
      setWaiverPopupSeason(seasonId);
    }
  };

  const confirmRevoke = () => {
    if (!revokeTarget) return;
    const { seasonId, type } = revokeTarget;
    let removedCount = 0;
    const applied = mutate((d) => {
      const personInDraft = d.people.find((x) => x.id === personId)!;
      // Update membership status for ONLY this type's row.
      const em = personInDraft.memberships.find((x) => x.seasonId === seasonId && membershipTypeOf(x) === type);
      if (em) {
        em.status = 'none';
        pushMembership(personInDraft.id, em);
      }
      // Removing from upcoming competitions only makes sense when revoking the
      // ATHLETE membership — a coach membership doesn't gate registration, so
      // revoking it must NOT touch the person's (or anyone else's) registrations.
      if (type === 'athlete') {
        // Remove from upcoming events (draft, or live-and-not-yet-happened).
        const openEventIds = new Set(
          d.events
            .filter((m) => m.status === 'draft' || eventIsInPhase(m, 'reg-open') || eventIsInPhase(m, 'reg-closed'))
            .map((m) => m.id),
        );
        const toRemove = d.registrations.filter((r) => r.athleteId === personId && openEventIds.has(r.eventId));
        removedCount = toRemove.length;
        toRemove.forEach((r) => deleteRegistration(r.id));
        d.registrations = d.registrations.filter((r) => !(r.athleteId === personId && openEventIds.has(r.eventId)));
      }
    });
    if (!applied) return; // offline read-only gate — no false success toast
    toast(type === 'athlete'
      ? `Athlete membership revoked; removed from ${removedCount} upcoming competition${removedCount !== 1 ? 's' : ''}.`
      : 'Coach membership revoked.');
    setRevokeTarget(null);
  };

  // T3b: only show CURRENT and FUTURE seasons on the admin member profile —
  // past seasons clutter the card with nothing actionable. "Future" = starts
  // on/after the current season (so a season already marked `current` never
  // gets excluded by its own comparison). If no season is currently marked
  // `current` (e.g. mid-rollover), fall back to "hasn't ended yet" by date.
  const currentSeason = db.seasons.find((s) => s.current);
  const todayIso = new Date().toISOString().slice(0, 10);
  const visibleSeasons = db.seasons.filter((s) =>
    currentSeason ? s.startsOn >= currentSeason.startsOn : s.endsOn >= todayIso
  );

  return (
    <>
      {[...visibleSeasons].sort((a, b) => {
        if (a.current && !b.current) return -1;
        if (!a.current && b.current) return 1;
        return b.startsOn.localeCompare(a.startsOn); // newest → oldest
      }).map((s) => (
        <div key={s.id} style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 13 }}>{s.name}{s.current ? ' (Current)' : ''}:</strong>
          {MEMBERSHIP_TYPES.map((type) => {
            const m = person.memberships.find((x) => x.seasonId === s.id && membershipTypeOf(x) === type);
            const isActive = m?.status === 'active';
            return (
              <span key={type} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                <span style={{ fontSize: 12, color: 'var(--ink-soft)' }}>{membershipTypeLabel(type)}:</span>
                {isActive ? <Badge tone="ok">Active{m?.activatedByAdmin ? ' (admin)' : ''}</Badge>
                  : m?.status === 'pending-club-payment' ? <Badge tone="warn">Pending club</Badge>
                  : m?.status === 'pending-waiver' ? (
                    <button
                      className="badge warn"
                      data-tip="Awaiting a signed waiver — click to email or copy the signing link"
                      style={{ cursor: 'pointer', border: 'none' }}
                      onClick={() => setWaiverPopupSeason(s.id)}
                    >
                      Pending waiver
                    </button>
                  ) : <Badge tone="err">None</Badge>}
                {m?.waiverSignedAt && <span data-tip={`Signed by ${m.waiverSignedBy} · ${formatSignedAt(m.waiverSignedAt)}`} style={{ fontSize: 12, cursor: 'help' }}>📝</span>}
                {m?.waiverSignedAt && (() => {
                  // The waiver is a single per-season document — the proof
                  // download is the same regardless of which type's row
                  // triggered it, so this can key off (person, season) only.
                  const sig = (db.waiverSignatures ?? []).find((x) => x.personId === person.id && x.seasonId === s.id);
                  if (!sig) return null;
                  const doc = (db.waiverDocuments ?? []).find((d) => d.id === sig.waiverDocumentId);
                  return (
                    <button className="btn small ghost" style={{ fontSize: 11 }}
                      onClick={() => downloadWaiverProof(sig, doc?.version ?? 0, `${person.firstName} ${person.lastName}`, doc?.body)}>
                      Download proof
                    </button>
                  );
                })()}
                {caps.isAdmin && (
                  isActive ? (
                    <button className="btn small ghost" onClick={() => setRevokeTarget({ seasonId: s.id, type })}>Revoke</button>
                  ) : m?.status === 'pending-waiver' ? (
                    <button className="btn small ghost" onClick={() => setRevokeTarget({ seasonId: s.id, type })}>Cancel</button>
                  ) : (
                    <button className="btn small ghost" onClick={() => activate(s.id, type)}>Activate</button>
                  )
                )}
              </span>
            );
          })}
        </div>
      ))}

      {revokeTarget && (
        <Modal title={`Revoke ${membershipTypeLabel(revokeTarget.type).toLowerCase()} membership?`} onClose={() => setRevokeTarget(null)}>
          <p style={{ marginTop: 0 }}>
            {revokeTarget.type === 'athlete'
              ? <>Revoking this membership will remove <strong>{person.firstName} {person.lastName}</strong> from all future registered competitions.</>
              : <>Revoking this coach membership does not affect <strong>{person.firstName} {person.lastName}</strong>'s athlete registrations, if any.</>}
          </p>
          <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
            <button className="btn primary" style={{ background: 'var(--coral-600)', borderColor: 'var(--coral-600)' }} onClick={confirmRevoke}>
              Yes, revoke
            </button>
            <button className="btn ghost" onClick={() => setRevokeTarget(null)}>Cancel</button>
          </div>
        </Modal>
      )}

      {waiverPopupSeason && (
        <WaiverLinkPopup
          person={person}
          seasonId={waiverPopupSeason}
          seasonName={db.seasons.find((s) => s.id === waiverPopupSeason)?.name ?? waiverPopupSeason}
          onClose={() => setWaiverPopupSeason(null)}
        />
      )}
    </>
  );
}

// ---- WaiverLinkPopup --------------------------------------------------------
// Shown after an admin manually activates a membership that has no waiver on
// file. Mints a no-login signing link (tied to the athlete record) and lets the
// admin email it or copy it. Signing the link activates the membership.
function WaiverLinkPopup({ person, seasonId, seasonName, onClose }: {
  person: Athlete; seasonId: string; seasonName: string; onClose: () => void;
}) {
  const toast = useToast();
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [emailing, setEmailing] = useState(false);
  const [copied, setCopied] = useState(false);

  // Route the waiver by the athlete's age: a minor needs a parent/guardian to
  // sign (email the guardian), an adult signs their own (email the athlete).
  const isMinor = isMinorAt(person.dob ?? '', new Date());
  const [guardianName, setGuardianName] = useState('');
  const [guardianEmail, setGuardianEmail] = useState('');

  // Who the link goes to. The minted token always resolves to the same no-login
  // signing page; we only differ in the recipient + copy.
  const recipientEmail = isMinor ? guardianEmail.trim() : (person.email ?? '');
  const recipientValid = isMinor
    ? guardianName.trim().length >= 2 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guardianEmail)
    : !!person.email;

  // Mint the link once when the popup opens.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const doc = await fetchPublishedWaiver(seasonId, GENERAL_WAIVER_TYPE);
      const waiverType = doc?.waiverType ?? GENERAL_WAIVER_TYPE;
      if (!doc) { if (!cancelled) setError(`No published waiver exists for ${seasonName}. Publish one in League Controls → Waivers first.`); return; }
      const res = await createWaiverLink({
        personId: person.id, seasonId, waiverType, membershipType: 'all',
        signerRole: isMinor ? 'guardian' : 'self',
      });
      if (cancelled) return;
      if (res.ok && res.link) setLink(res.link);
      else setError(res.error ?? 'Could not create a signing link.');
    })();
    return () => { cancelled = true; };
  }, [person.id, seasonId, seasonName, isMinor]);

  const copy = async () => {
    if (!link) return;
    try { await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 1800); }
    catch { toast('Could not copy — select the link and copy manually.', { variant: 'error' }); }
  };

  const email = async () => {
    if (!link) return;
    if (!recipientValid) {
      toast(isMinor ? 'Enter the guardian name and a valid email.' : 'No email on file for this member.', { variant: 'error' });
      return;
    }
    setEmailing(true);
    const athleteName = `${person.firstName} ${person.lastName}`;
    const subject = isMinor
      ? `Action needed: sign the ${seasonName} waiver for ${athleteName}`
      : `Action needed: sign your ${seasonName} United Club Gymnastics waiver`;
    const html = isMinor
      ? `<p>Hi ${escapeHtml(guardianName.trim())},</p>
<p><strong>${escapeHtml(athleteName)}</strong>'s <strong>${escapeHtml(seasonName)}</strong> United Club Gymnastics
membership has been activated, but it stays pending until a parent/guardian signs the waiver. No login is required.</p>
<p><a href="${link}">Review &amp; sign the waiver &rarr;</a></p>
<p>Once signed, the membership becomes active automatically.</p>`
      : `<p>Hi ${escapeHtml(person.firstName)},</p>
<p>Your <strong>${escapeHtml(seasonName)}</strong> membership has been activated, but it stays pending until your
waiver is signed. No login is required.</p>
<p><a href="${link}">Review &amp; sign your waiver &rarr;</a></p>
<p>Once signed, your membership becomes active automatically.</p>`;
    const recipientName = isMinor ? guardianName.trim() : athleteName;
    const res = await sendEmail(subject, html, [{ email: recipientEmail, name: recipientName }]);
    setEmailing(false);
    if (res.ok && res.sentCount > 0) { toast(`Waiver link emailed to ${recipientEmail}.`); onClose(); }
    else toast(`Email failed: ${res.error ?? 'unknown error'}.`, { variant: 'error' });
  };

  return (
    <Modal title={`Waiver required — ${person.firstName} ${person.lastName}`} onClose={onClose}>
      <p style={{ marginTop: 0, fontSize: 14, color: 'var(--ink-soft)' }}>
        {seasonName} membership is <strong>pending a signed waiver</strong>.{' '}
        {isMinor
          ? <>This athlete is <strong>under 18</strong>, so a parent/guardian must sign. Email the guardian a no-login signing link — once they sign, the membership activates automatically.</>
          : <>Send the member a no-login signing link — once they sign, their membership activates automatically.</>}
      </p>
      {isMinor && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
          <Field label="Guardian name">
            <input className="input" value={guardianName} onChange={(e) => setGuardianName(e.target.value)} placeholder="Parent / guardian full name" />
          </Field>
          <Field label="Guardian email">
            <input className="input" type="email" value={guardianEmail} onChange={(e) => setGuardianEmail(e.target.value)} placeholder="guardian@example.com" />
          </Field>
        </div>
      )}
      {error ? (
        <p style={{ color: 'var(--coral-600)', fontSize: 14 }}>{error}</p>
      ) : !link ? (
        <p style={{ fontSize: 14, color: 'var(--ink-soft)' }}>Generating signing link…</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input className="input" readOnly value={link} onFocus={(e) => e.currentTarget.select()} style={{ fontSize: 12.5 }} />
        </div>
      )}
      <div style={{ display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
        <button
          className="btn primary"
          disabled={!link || emailing || !recipientValid}
          onClick={email}
          data-tip={recipientValid ? undefined : (isMinor ? 'Enter the guardian name and email' : 'No email on file')}
        >
          {emailing ? 'Emailing…' : (isMinor ? '✉ Email guardian the link' : '✉ Email waiver link')}
        </button>
        <button className="btn ghost" disabled={!link} onClick={copy}>{copied ? '✓ Copied' : 'Copy link'}</button>
        <button className="btn ghost" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}
