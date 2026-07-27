import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useDB, mutate } from '../lib/store';
import { useCapabilities } from '../lib/capabilities';
import { useRolesLoaded } from '../lib/auth';
import { seasonForDate, clubHasActiveMembershipForEvent, paidRegistrationClub } from '../lib/capabilities-core';
import { currentSeason } from '../lib/season-lifecycle';
import { eventIsInPhase } from '../lib/events-core';
import { normalizeExternalUrl, appBaseUrl, copyToClipboard } from '../lib/url';
import { tzAbbrev } from '../lib/timezone';
import { Badge, Field, Modal, Tabs } from '../components/ui';
import { useToast, useFmtDate } from '../components/ui-hooks';
import { EventWizard } from '../components/EventWizard';
import { RegistrationEditor } from '../components/RegistrationEditor';
import { EventCheckinAdminCard } from '../components/EventCheckinCard';
import { EventStatusBadge } from './Home';
import { APPARATUS, SHIRT_SIZES } from '../lib/types';
import type { Athlete, CartItem, Discipline, Event, EventAdmin, EventSession, JudgeAccessCode, Registration } from '../lib/types';
import { DisciplineIcon } from '../components/DisciplineIcon';
import { SizedAddonPicker } from '../components/AddonPickers';
import {
  deleteRegistration, fetchCampSurveys, fetchEventCollectedTotal, fetchEventHostAddons, fetchEventHostRoster, fetchEventWaitlist, findPersonForHost, grantEventAdmin,
  hostDeleteRegistration, hostUpsertRegistration, insuranceCertificateUrl,
  listSanctioningTeam, manageWaitlist, markMedalsReceived, pushCampSurvey, pushCart, pushEvent, pushEventSessions, pushJudgeAccessCode, pushRegistration,
  revokeEventAdmin, revokeJudgeAccessCode, syncSynchroPartnerLevelRemote, uploadInsuranceCertificate,
} from '../lib/supabase';
import type { HostAddonRow, HostRosterRow, SanctioningTeamMember, WaitlistQueueRow } from '../lib/supabase';
import { fetchEventScoresOnce } from '../lib/scores-slice';
import { useEventRegistrations, useMyRegistrations, fetchEventRegistrationsOnce, applyLocalRegistrationUpsert, applyLocalRegistrationRemove, mergeUpsertedRegs } from '../lib/registrations-slice';
import { summarizeRoster, levelNameResolver } from '../lib/host-page';
import { buildRegistrationWorkbookSheets } from '../lib/host-export';
import { downloadWorkbook } from '../lib/xlsx-download';
import { stateCode } from '../lib/sanction';
import { fmtMoney } from '../lib/scoring';
import {
  newRegistrationEntryTotal, registrationChangeFee, syncSynchroPartnerLevel, findIncomingSynchroPartner,
  lateFeeApplies, lateFeeAnchor, addonPurchaseOpen, initialAddonDraft, anyAddonWindowOpen, addonDraftValid,
  buildAddonCartItems, type AddonDraft,
  campSurveyQuestionsOf, campSurveyAnswersValid, campSurveyToStored, campSurveySummary, campSurveyAnswerLabel,
} from '../lib/pricing';
import { holdStamp } from '../lib/capacity';
import { OWNER_TASKS, ownerTaskDueDate } from '../../supabase/functions/_shared/owner-checklist';
import type { OwnerChecklist, OwnerChecklistEntry, OwnerTaskId } from '../../supabase/functions/_shared/owner-checklist';

const today = () => new Date().toISOString().slice(0, 10);
const isPast = (iso: string) => Date.now() > new Date(iso).getTime();

/** Registration state for an event from its open/close timestamps (vs now):
 *  `regOpen` = now within [opens, closes]; `regClosed` = now past closes. */
function regState(regOpens: string, regCloses: string): { regOpen: boolean; regClosed: boolean } {
  const now = Date.now();
  const regClosed = now > new Date(regCloses).getTime();
  return { regClosed, regOpen: !regClosed && now >= new Date(regOpens).getTime() };
}

// Sortable columns of the Events table. Each maps to a comparable underlying value.
type SortKey = 'name' | 'location' | 'date' | 'disciplines' | 'regOpens' | 'regCloses';

// Pure comparator: returns the underlying value (lowercased for text) for a column.
function sortValue(ev: Event, key: SortKey): string {
  switch (key) {
    case 'name': return ev.name.toLowerCase();
    case 'location': return `${ev.city}, ${ev.state}`.toLowerCase();
    case 'date': return ev.startDate; // ISO yyyy-mm-dd sorts lexicographically
    case 'disciplines': return ev.disciplines.join(' · ').toLowerCase();
    case 'regOpens': return ev.regOpens.slice(0, 10);
    case 'regCloses': return ev.regCloses.slice(0, 10);
  }
}

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: 'name', label: 'Event Name' },
  { key: 'location', label: 'Location' },
  { key: 'date', label: 'Date(s)' },
  { key: 'disciplines', label: 'Disciplines' },
  { key: 'regOpens', label: 'Reg Opens' },
  { key: 'regCloses', label: 'Reg Closes' },
];

/** Events list (MY UCG / public): all UCG-hosted & sanctioned events, split into
 *  Upcoming / Past (on `endDate >= today`), searchable by name/location/disciplines,
 *  and shown as a sortable, horizontally-scrollable table. Modeled on
 *  MyRegistrations.tsx. Admins can sanction a new event via the wizard. */
export function Events() {
  const db = useDB();
  const fmtDate = useFmtDate();
  const [tab, setTab] = useState<'upcoming' | 'past'>('upcoming');
  const [q, setQ] = useState('');
  // Single sort state. `null` dir ⇒ apply the tab-appropriate default (date asc for
  // Upcoming, date desc for Past). A user click sets an explicit key + direction.
  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const t = today();
  const lq = q.trim().toLowerCase();

  const inTab = db.events.filter((ev) => (tab === 'upcoming' ? ev.endDate >= t : ev.endDate < t));
  const matched = inTab.filter((ev) => {
    if (!lq) return true;
    const hay = `${ev.name} ${ev.city}, ${ev.state} ${ev.disciplines.join(' · ')}`.toLowerCase();
    return hay.includes(lq);
  });

  // Effective sort: explicit user choice, or the per-tab default (date, asc for
  // upcoming / desc for past).
  const effKey: SortKey = sortKey ?? 'date';
  const effDir: 'asc' | 'desc' = sortKey ? sortDir : (tab === 'upcoming' ? 'asc' : 'desc');
  const rows = [...matched].sort((a, b) => {
    const cmp = sortValue(a, effKey).localeCompare(sortValue(b, effKey));
    return effDir === 'asc' ? cmp : -cmp;
  });

  const onSort = (key: SortKey) => {
    if (effKey === key) {
      setSortKey(key);
      setSortDir(effDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const switchTab = (id: 'upcoming' | 'past') => {
    setTab(id);
    setSortKey(null); // re-apply the tab-appropriate default sort
  };

  return (
    <div>
      <h1 className="page-title display">Events</h1>
      <p className="page-sub">Current and Past UCG Hosted (Nationals, FlipFest, etc.) and UCG Sanctioned (Regular Season Meets) Events</p>

      <Tabs
        tabs={[{ id: 'upcoming' as const, label: 'Upcoming' }, { id: 'past' as const, label: 'Past' }]}
        active={tab}
        onChange={switchTab}
      />

      <input
        type="search" className="input" placeholder="Search by name, location, or discipline…"
        value={q} onChange={(e) => setQ(e.target.value)}
        style={{ maxWidth: 320, margin: '12px 0' }}
      />

      {rows.length === 0 ? (
        <p style={{ color: 'var(--ink-soft)' }}>No {tab} events.</p>
      ) : (
        <div className="card" style={{ overflow: 'hidden' }}>
          <div className="events-table-wrap">
            <table className="tbl events-table">
              <thead>
                <tr>
                  {COLUMNS.map((c) => (
                    <th
                      key={c.key}
                      onClick={() => onSort(c.key)}
                      style={{ cursor: 'pointer', userSelect: 'none', color: 'var(--ink)' }}
                    >
                      {c.label}
                      {effKey === c.key && <span style={{ marginLeft: 4 }}>{effDir === 'asc' ? '▲' : '▼'}</span>}
                    </th>
                  ))}
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((ev) => {
                  const dates = ev.startDate === ev.endDate
                    ? fmtDate(ev.startDate)
                    : `${fmtDate(ev.startDate)}–${fmtDate(ev.endDate)}`;
                  // Registration state drives the date-cell highlighting:
                  //  • open   → Reg Opens date highlighted green (badge ok)
                  //  • closed → Reg Closes date highlighted coral (badge err)
                  const { regOpen, regClosed } = regState(ev.regOpens, ev.regCloses);
                  return (
                    <tr key={ev.id}>
                      <td data-label="Event">
                        <Link to={`/events/${ev.slug}`}>{ev.name}</Link>
                      </td>
                      <td data-label="Location" style={{ whiteSpace: 'nowrap' }}>{ev.city}, {stateCode(ev.state)}</td>
                      <td data-label="Date(s)" style={{ whiteSpace: 'nowrap' }}>{dates}</td>
                      <td data-label="Disciplines" style={{ color: 'var(--ink-soft)' }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          {(ev.disciplines as Discipline[]).map((d, i) => (
                            <span key={d} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                              {i > 0 && <span style={{ color: 'var(--line)' }}>·</span>}
                              <DisciplineIcon discipline={d} size={14} />
                              {d}
                            </span>
                          ))}
                        </span>
                      </td>
                      <td data-label="Reg Opens" style={{ whiteSpace: 'nowrap' }}>
                        {!ev.regOpens
                          ? <span style={{ color: 'var(--ink-soft)' }}>—</span>
                          : regOpen
                          ? <span className="badge ok">{fmtDate(ev.regOpens.slice(0, 10))}</span>
                          : <span style={{ color: 'var(--ink-soft)' }}>{fmtDate(ev.regOpens.slice(0, 10))}</span>}
                      </td>
                      <td data-label="Reg Closes" style={{ whiteSpace: 'nowrap' }}>
                        {!ev.regCloses
                          ? <span style={{ color: 'var(--ink-soft)' }}>—</span>
                          : regClosed
                          ? <span className="badge err">{fmtDate(ev.regCloses.slice(0, 10))}</span>
                          : <span style={{ color: 'var(--ink-soft)' }}>{fmtDate(ev.regCloses.slice(0, 10))}</span>}
                      </td>
                      <td data-label="">
                        {!ev.listingOnly && <Link className="btn small" to={`/events/${ev.slug}`}>Details</Link>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// EventDetail
// ---------------------------------------------------------------------------
export function EventDetail() {
  const { slug } = useParams();
  const db = useDB();
  const caps = useCapabilities();
  const toast = useToast();
  const fmtDate = useFmtDate();
  const navigate = useNavigate();
  const event = db.events.find((m) => m.slug === slug);
  const [editWizardOpen, setEditWizardOpen] = useState(false);
  const [selfRegOpen, setSelfRegOpen] = useState(false);
  const [addonsOpen, setAddonsOpen] = useState(false);

  // Phase 3 (data-layer-scale): called unconditionally (Rules of Hooks)
  // before the `!event` early return below, since event?.id is
  // undefined-safe and hooks must run in the same order every render.
  const { rows: eventRegs, status: regsStatus } = useEventRegistrations(event?.id);
  const myRegsAll = useMyRegistrations();

  if (!event) return <p>Event not found.</p>;
  const host = db.clubs.find((c) => c.id === event.hostClubId);
  const regs = eventRegs.filter((r) => r.eventId === event.id && !r.refunded);
  const canManage = caps.isEventHost(event.id);
  // Editing event DETAIL (dates/fees/disciplines/etc. via EventWizard) is
  // admin/sanctioning-only — exactly the events-table RLS grant
  // (20260709131708_event_owner_checklist.sql: sanctioning_update/insert; the
  // deliberate design in 20260710020303 withholds an events UPDATE policy from
  // hosts). A host-club manager has canManage/isEventHost=true and so used to
  // see the "Edit event" button, but their events upsert is rejected by RLS
  // (verified: rows=0) — the write silently failed and edits "didn't persist".
  // Gate the edit UI on the real capability instead. (isSanctioning === admin
  // || sanctioning.)
  const canEditEvent = caps.isSanctioning;
  const tz = tzAbbrev(event.timezone);
  const isUcg = !!event.ucgHosted;
  // UCG-run events (feedback-2 §5): an admin edits via the dedicated
  // full-page admin editor (`/admin/ucg-event/:template/:seasonId`), not the
  // overlay wizard — it's the same editor the Seasons card links to, opened
  // straight into edit mode via router state. Non-admin sanctioning users
  // (no route access — RequireAdmin-gated) keep the overlay.
  const openEditEvent = () => {
    if (isUcg && caps.isAdmin) {
      const seasonId = seasonForDate(db, event.startDate);
      if (seasonId) {
        navigate(`/admin/ucg-event/${event.ucgHosted}/${seasonId}`, { state: { edit: true } });
        return;
      }
    }
    setEditWizardOpen(true);
  };

  // Standalone add-on purchase (Phase 2 T3): available to a signed-in user who
  // already has a (non-refunded) registration for this event, for as long as ANY
  // configured add-on type's purchase window is still open — which may extend
  // PAST regCloses via `lastPurchaseAt`. Banner isn't offered here (registration-
  // popup only, per spec) so it's excluded from the window check.
  const myAthlete = caps.personId ? db.people.find((p) => p.id === caps.personId) : undefined;
  // Phase 3: "mine" (Tier 2, synchronous) — this is the signed-in caller's
  // own registration set, per the COMPLETENESS rule (not a by-event slice).
  const myRegs = myAthlete
    ? myRegsAll.filter((r) => r.eventId === event.id && r.athleteId === myAthlete.id && !r.refunded)
    : [];
  const anyStandaloneAddonOpen = anyAddonWindowOpen(event, new Date(), { includeBanner: false });

  // H3: absolute link to this event, built from the app base so it survives
  // the GitHub Pages subpath (and any future host) — never hand-concatenate
  // location.origin + '#/...'.
  const copyEventLink = async () => {
    const ok = await copyToClipboard(`${appBaseUrl()}/#/events/${event.slug}`);
    if (ok) toast('Link copied');
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 className="page-title display">{event.name}</h1>
          <p className="page-sub">
            {event.city}, {event.state} · {fmtDate(event.startDate)}–{fmtDate(event.endDate)} ·
            hosted by {event.ucgHosted ? 'UCG' : host?.name}
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 6 }}>
            {(event.disciplines as Discipline[]).map((d) => (
              <span key={d} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 13, fontWeight: 700, color: 'var(--ink-soft)' }}>
                <DisciplineIcon discipline={d} size={20} />
                {d === 'TNT' ? 'T&T' : d}
              </span>
            ))}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <EventStatusBadge event={event} />
          <button className="btn small ghost" onClick={copyEventLink}>Copy link</button>
          {(canManage || caps.isSanctioning) && (
            <Link className="btn small ghost" to={`/events/${event.slug}/host`}>Host dashboard →</Link>
          )}
          {canEditEvent && (
            <button className="btn small ghost" onClick={openEditEvent}>Edit event</button>
          )}
        </div>
      </div>

      {editWizardOpen && <EventWizard editEvent={event} onClose={() => setEditWizardOpen(false)} />}

      {/* Event-owner assignment + task checklist (event-mgmt v2 §B3-4) — visible to
          the Sanctioning Team (not just the event's host manager) for competitions,
          which is what actually goes through the sanctioning workflow. Not
          applicable to UCG-run events (FlipFest/Nationals) — there's no host
          to own tasks for; the Director of Nationals tracks work elsewhere
          (PM feedback-2 §1). */}
      {caps.isSanctioning && event.eventType !== 'camp' && !isUcg && (
        <>
          <OwnerAssignBlock event={event} toast={toast} />
          <OwnerChecklistCard event={event} fmtDate={fmtDate} toast={toast} />
        </>
      )}

      {/* Per-event admin grants (event-mgmt v2 §C) — visible to anyone with
          host-level access (host-club managers, league admins, and granted
          event admins themselves). Not applicable to UCG-run events — there's
          no separate host account to delegate to (PM feedback-2 §2). */}
      {canManage && !isUcg && <EventAdminsCard event={event} toast={toast} />}

      {/* Waitlist queue (event-mgmt v2 P4 T7) — visible to anyone with
          host-level access; Promote/Requeue renders only for
          admin/sanctioning (manage-waitlist's server-returned canManage,
          re-checked server-side on every action — hosts see it read-only). */}
      {canManage && <WaitlistCard event={event} toast={toast} />}

      {/* Camp overnight-accommodations survey responses (PM requirement
          2026-07-22): reviewable by hosts/admins individually and as
          totals/summaries. Only rendered for camps (survey doesn't apply to
          competitions) — shown even when the event never turned the survey
          on, so a host who just enabled it can find where responses land. */}
      {canManage && event.eventType === 'camp' && (
        <CampSurveyResponsesCard event={event} regs={regs} />
      )}

      {/* Set Competition Order lock (event-mgmt v2 Phase 5 §E6): admin-only —
          once checked, club managers may only VIEW their competition_orders
          rows (RLS-enforced server-side, event_order_locked()); admins can
          keep editing regardless. MAG/WAG only, so hidden for a T&T-only
          event. */}
      {caps.isAdmin && event.disciplines.some((d) => d === 'MAG' || d === 'WAG') && (
        <CompetitionOrderLockCard event={event} toast={toast} />
      )}

      {/* Nationals event summary (event-mgmt v2 Phase 5 D1, spec §L.3 —
          REPLACED per PM feedback-2 §3: the old "view as club/athlete"
          scoped-dashboard picker was cut in favor of a real aggregate
          summary of the event). Visible to admin + sanctioning. */}
      {(caps.isAdmin || caps.isSanctioning) && event.kind === 'nationals' && (
        <NationalsSummaryCard event={event} />
      )}

      {/* Nationals check-in — admin open + view-as (event-mgmt v2 Phase 5
          E1, spec §L.4). Gated on admin/sanctioning (opening check-in is an
          admin/league action per the E1 RLS) + event.kind === 'nationals' to
          keep check-in scoped to P5, though the underlying feature isn't
          nationals-specific per spec. */}
      {(caps.isAdmin || caps.isSanctioning) && event.kind === 'nationals' && (
        <EventCheckinAdminCard eventId={event.id} />
      )}

      <div className="grid cols-3" style={{ marginBottom: 18 }}>
        <div className="card card-pad">
          <h3 className="card-title">Registration</h3>
          <p style={{ margin: '0 0 8px', fontSize: 14 }}>
            {event.regOpens && event.regCloses
              ? <>Opens {fmtDate(event.regOpens.slice(0, 10))} · closes <strong>{fmtDate(event.regCloses.slice(0, 10))}</strong> ({tz})<br /></>
              : <>Registration dates not yet set.<br /></>}
            {fmtMoney(event.entryFee)} / discipline · {fmtMoney(event.secondDisciplineFee)} each additional
            {event.banquet && <><br />{event.banquet.name}: {fmtMoney(event.banquet.price)}</>}
            {event.tshirtAddon && <><br />T-shirt: {fmtMoney(event.tshirtAddon.price)}</>}
            {event.bannerAddon && <><br />Club banner: {fmtMoney(event.bannerAddon.price)}</>}
            {event.changeFee && (
              <><br /><span style={{ color: 'var(--warn)' }}>Change fee {fmtMoney(event.changeFee.amount)} after {new Date(event.changeFee.startsAt).toLocaleDateString()}</span></>
            )}
          </p>
          {event.status === 'draft' ? (
            <Badge tone="info">Draft — not yet published</Badge>
          ) : !event.listingOnly && eventIsInPhase(event, 'reg-open') ? (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {caps.managedClubIds.length > 0 && (
                <Link className="btn primary small" to={`/club/${caps.managedClubIds[0]}`}>Register your club →</Link>
              )}
              {caps.canRegister && (
                <button className="btn primary small" onClick={() => setSelfRegOpen(true)}>Register yourself →</button>
              )}
              {!caps.canRegister && caps.managedClubIds.length === 0 && (
                caps.coachMembership?.status === 'active' ? (
                  // A coach membership doesn't confer registration eligibility — say so
                  // explicitly and point at the membership page (the "add athlete"
                  // purchase path there already prices the coach→athlete difference).
                  <>
                    <Badge tone="warn">Athlete membership required to register</Badge>
                    <Link className="btn small ghost" to="/membership">Get athlete membership →</Link>
                  </>
                ) : (
                  <Badge tone="warn">Registration open</Badge>
                )
              )}
            </div>
          ) : (
            <Badge tone="warn">Registration closed{canEditEvent ? ' — edit the event to adjust dates' : ''}</Badge>
          )}
          {canEditEvent && event.status === 'live' && !eventIsInPhase(event, 'reg-open') && (
            <div style={{ marginTop: 10, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button className="btn small ghost" onClick={openEditEvent}>Edit event to adjust registration dates</button>
              <button className="btn small ghost" data-tip="Generates a private reg link + password for late adds" onClick={() => toast(`Private link: ucg.org/#/events/${event.slug}?code=LATE26 (demo)`)}>Private reg link</button>
            </div>
          )}
          {myAthlete && myRegs.length > 0 && anyStandaloneAddonOpen && (
            <div style={{ marginTop: 10 }}>
              <button className="btn small ghost" onClick={() => setAddonsOpen(true)}>Add-ons →</button>
            </div>
          )}
        </div>
        <div className="card card-pad">
          <h3 className="card-title">Participants</h3>
          {regsStatus === 'loading' ? (
            <div className="stat-label">Loading…</div>
          ) : (
            <>
              <div className="stat-big stat-accent">{regs.length}</div>
              <div className="stat-label">registrations · {[...new Set(regs.map((r) => r.athleteId))].length} athletes · {[...new Set(regs.map((r) => r.clubId))].length} clubs</div>
            </>
          )}
        </div>
        {(() => {
          const isCamp = event.eventType === 'camp';
          const quickLinks = [
            !isCamp && (
              <Link key="results" to={`/results/${event.slug}`}>→ Live results</Link>
            ),
            canManage && event.kind === 'nationals' && (
              <Link key="nationals" to={`/events/${event.slug}/nationals`} style={{ fontWeight: 700 }}>→ Finals qualification &amp; awards</Link>
            ),
            canManage && !isCamp && (
              <Link key="manage" to={`/events/${event.slug}/manage`}>→ Manage sessions & squads</Link>
            ),
            canManage && !isCamp && (
              <Link key="score" to={`/judge?event=${event.id}`}>→ Score entry</Link>
            ),
            canManage && (
              <a
                key="export-regs" href="#"
                onClick={(e) => {
                  e.preventDefault();
                  exportCsv(db, event).catch((err: unknown) => {
                    console.error('[Events] exportCsv failed:', err);
                    toast('Could not export registrations — try again.', { variant: 'error' });
                  });
                }}
              >
                → Export registrations (CSV)
              </a>
            ),
            canManage && !isCamp && (
              <a
                key="export-scores" href="#"
                onClick={(e) => {
                  e.preventDefault();
                  exportScoresCsv(db, event).catch((err: unknown) => {
                    console.error('[Events] exportScoresCsv failed:', err);
                    toast('Could not export scores — try again.', { variant: 'error' });
                  });
                }}
              >
                → Export scores incl. calculator detail (CSV)
              </a>
            ),
          ].filter(Boolean);
          return quickLinks.length > 0 ? (
            <div className="card card-pad">
              <h3 className="card-title">Quick links</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {quickLinks}
              </div>
            </div>
          ) : null;
        })()}
      </div>

      <div className="card" style={{ overflow: 'hidden' }}>
        <table className="tbl">
          <thead><tr><th>Session</th><th>Date</th><th>Levels</th><th className="num">Athletes</th><th className="num">Squads</th></tr></thead>
          <tbody>
            {event.sessions.map((s) => (
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
            event={event}
            athlete={athlete}
            onClose={() => setSelfRegOpen(false)}
            toast={toast}
          />
        );
      })()}

      {/* Standalone add-on purchase modal (Phase 2 T3) */}
      {addonsOpen && myAthlete && (
        <StandaloneAddonsModal
          event={event}
          athlete={myAthlete}
          onClose={() => setAddonsOpen(false)}
          toast={toast}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// OwnerAssignBlock — event-owner assignment (event-mgmt v2 §B3)
// ---------------------------------------------------------------------------

function saveEventOwner(event: Event, owner: Event['owner']): boolean {
  const updated: Event = { ...event, owner };
  const applied = mutate((d) => {
    const idx = d.events.findIndex((e) => e.id === event.id);
    if (idx >= 0) d.events[idx] = updated;
  });
  if (applied) pushEvent(updated); // offline read-only gate: never push what local lacks
  return applied;
}

function OwnerAssignBlock({ event, toast }: { event: Event; toast: (msg: string, opts?: { variant?: 'info' | 'error' }) => void }) {
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [team, setTeam] = useState<SanctioningTeamMember[] | null>(null);
  const [selectedId, setSelectedId] = useState('');

  const openEditor = async () => {
    setEditing(true);
    setSelectedId(event.owner?.userId ?? '');
    if (team !== null) return;
    setLoading(true);
    const list = await listSanctioningTeam();
    setLoading(false);
    setTeam(list);
    if (list.length === 0) toast('Could not load the sanctioning team — try again.', { variant: 'error' });
  };

  const save = () => {
    const member = (team ?? []).find((m) => m.userId === selectedId);
    if (!member) return;
    if (!saveEventOwner(event, { userId: member.userId, name: member.name, email: member.email })) return;
    setEditing(false);
  };

  return (
    <div className="card card-pad" style={{ marginBottom: 18, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <strong>Event owner:</strong>
      {event.owner ? (
        <span>{event.owner.name} <span style={{ color: 'var(--ink-soft)' }}>({event.owner.email})</span></span>
      ) : (
        <Badge tone="err">Unassigned</Badge>
      )}
      {!editing ? (
        <button className="btn small ghost" onClick={openEditor}>{event.owner ? 'Reassign' : 'Assign owner'}</button>
      ) : (
        <>
          <select className="input" style={{ maxWidth: 280 }} value={selectedId} onChange={(e) => setSelectedId(e.target.value)} disabled={loading}>
            <option value="">{loading ? 'Loading team…' : 'Select a team member'}</option>
            {(team ?? []).map((m) => (
              <option key={m.userId} value={m.userId}>{m.name} ({m.email})</option>
            ))}
          </select>
          <button className="btn small primary" disabled={!selectedId} onClick={save}>Save</button>
          <button className="btn small ghost" onClick={() => setEditing(false)}>Cancel</button>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// EventAdminsCard — per-event admin grants (event-mgmt v2 §C)
// ---------------------------------------------------------------------------
// Hosts grant other ACCOUNTS host-level access to this ONE event. Writes go
// through the grant_event_admin/revoke_event_admin SECURITY DEFINER RPCs
// (exact-email account lookup server-side — deliberately no name search);
// this card only reflects the result into the local db.

export function EventAdminsCard({ event, toast }: { event: Event; toast: (msg: string, opts?: { variant?: 'info' | 'error' }) => void }) {
  const db = useDB();
  const admins = (db.eventAdmins ?? []).filter((ea) => ea.eventId === event.id);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);

  const add = async () => {
    const addr = email.trim();
    if (!addr) return;
    setBusy(true);
    const res = await grantEventAdmin(event.id, addr);
    setBusy(false);
    if (!res.ok) { toast(res.error, { variant: 'error' }); return; }
    mutate((d) => {
      const list = d.eventAdmins ?? (d.eventAdmins = []);
      const existing = list.find((ea) => ea.eventId === event.id && ea.userId === res.userId);
      if (existing) { existing.email = res.email; existing.name = res.name; }
      // Local-only synthetic id — the server generated its own; the next full
      // sync replaces this row. Uniqueness per (event, user) matches the DB.
      else list.push({ id: `ea-${event.id}-${res.userId}`, eventId: event.id, userId: res.userId, email: res.email, name: res.name });
    });
    setEmail('');
    toast(`${res.name || res.email} can now manage this event.`);
  };

  const remove = async (ea: EventAdmin) => {
    const err = await revokeEventAdmin(event.id, ea.userId);
    if (err) { toast(err, { variant: 'error' }); return; }
    mutate((d) => {
      d.eventAdmins = (d.eventAdmins ?? []).filter((x) => !(x.eventId === event.id && x.userId === ea.userId));
    });
    toast(`Removed ${ea.name || ea.email} as an event admin.`);
  };

  return (
    <div className="card card-pad" style={{ marginBottom: 18 }}>
      <h3 className="card-title">Event admins</h3>
      <p style={{ margin: '0 0 10px', fontSize: 13, color: 'var(--ink-soft)' }}>
        Grant another account the same management access as the host — for this event only.
      </p>
      {admins.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
          {admins.map((ea) => (
            <div key={ea.id} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <strong>{ea.name || ea.email}</strong>
              {ea.name && <span style={{ color: 'var(--ink-soft)', fontSize: 13 }}>({ea.email})</span>}
              <button className="btn small ghost" aria-label={`Remove ${ea.name || ea.email}`} onClick={() => remove(ea)}>✕</button>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          type="email" className="input" style={{ maxWidth: 280 }} placeholder="Account email"
          value={email} onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
        />
        <button className="btn small primary" disabled={busy || !email.trim()} onClick={add}>
          {busy ? 'Adding…' : 'Add admin'}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// JudgeAccessCard — codeless judge access (2026-07-19)
// ---------------------------------------------------------------------------
// ONE active code per event: URL, 6-digit code, and QR are three forms of the
// same long `token` — a device that unlocks with any of them can enter
// scores for ANY discipline/apparatus at this event, no per-judge identity
// (see supabase/functions/judge-entry + src/pages/Judge.tsx). Writes go
// through the normal client RLS path (judge_access_codes' insert/update
// policies mirror is_event_host, same reach as this whole host page), unlike
// event_admins' RPC-only model — there's no cross-account lookup here to
// gate, just this event's own row.
function randomAccessToken(): string {
  const bytes = new Uint8Array(20); // 40 hex chars — well over the 16-char floor
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
function randomSixDigitCode(): string {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return String(arr[0] % 1_000_000).padStart(6, '0');
}

function JudgeAccessCard({ event, toast }: { event: Event; toast: (msg: string, opts?: { variant?: 'info' | 'error' }) => void }) {
  const db = useDB();
  const active = (db.judgeAccessCodes ?? []).find((c) => c.eventId === event.id && !c.revokedAt);
  const [busy, setBusy] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  // `appBaseUrl()` (src/lib/url.ts) was extracted FROM this expression for the
  // H3 copy-link buttons — use it here too rather than keeping a second copy.
  const link = active ? `${appBaseUrl()}/#/judge/access/${active.token}` : '';

  useEffect(() => {
    // No synchronous setState here (CLAUDE.md ESLint trap) — when there's no
    // active code, `link` is '' and the QR <img> is never rendered anyway
    // (nested under `{active ? ... : ...}` below), so a stale qrDataUrl from
    // a previous code is harmless; it's overwritten as soon as the next
    // active code's QR resolves.
    if (!link) return;
    let cancelled = false;
    import('qrcode')
      .then((QRCode) => QRCode.toDataURL(link, { margin: 1, width: 220 }))
      .then((dataUrl) => { if (!cancelled) setQrDataUrl(dataUrl); })
      .catch(() => { if (!cancelled) setQrDataUrl(null); });
    return () => { cancelled = true; };
  }, [link]);

  const generate = () => {
    setBusy(true);
    mutate((d) => {
      const now = new Date().toISOString();
      const list = d.judgeAccessCodes ?? (d.judgeAccessCodes = []);
      // One ACTIVE code per event (mirrors the DB's partial unique index) —
      // revoke any existing active row before inserting the new one.
      const prior = list.find((c) => c.eventId === event.id && !c.revokedAt);
      if (prior) { prior.revokedAt = now; revokeJudgeAccessCode(prior.id); }
      const created: JudgeAccessCode = {
        id: crypto.randomUUID(), eventId: event.id, token: randomAccessToken(), code: randomSixDigitCode(),
        createdAt: now,
      };
      list.push(created);
      pushJudgeAccessCode(created);
    });
    setBusy(false);
    toast('Judge access code generated.');
  };

  const revoke = () => {
    if (!active) return;
    mutate((d) => {
      const row = (d.judgeAccessCodes ?? []).find((c) => c.id === active.id);
      if (row) row.revokedAt = new Date().toISOString();
    });
    revokeJudgeAccessCode(active.id);
    toast('Judge access code revoked.');
  };

  return (
    <div className="card card-pad" style={{ marginBottom: 18 }}>
      <h3 className="card-title">Judge access</h3>
      <p style={{ margin: '0 0 10px', fontSize: 13, color: 'var(--ink-soft)' }}>
        Anyone with this link, code, or QR can enter scores for any discipline/apparatus at this
        event — no judge account needed. Revoke it anytime; regenerating invalidates the old one.
      </p>
      {active ? (
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'center' }}>
          <div>
            <div style={{ fontFamily: 'var(--font-display)', fontSize: 40, letterSpacing: '0.12em' }}>{active.code}</div>
            <div style={{ fontSize: 12, color: 'var(--ink-soft)', wordBreak: 'break-all', maxWidth: 320, marginTop: 4 }}>{link}</div>
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button className="btn small ghost" disabled={busy} onClick={generate}>Regenerate</button>
              <button className="btn small ghost" disabled={busy} onClick={revoke}>Revoke</button>
            </div>
          </div>
          {qrDataUrl && (
            <img src={qrDataUrl} alt="Judge access QR code" width={140} height={140} style={{ borderRadius: 8, border: '1px solid var(--line)' }} />
          )}
        </div>
      ) : (
        <button className="btn small primary" disabled={busy} onClick={generate}>Generate access code</button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// WaitlistCard — waitlist queue + admin override (event-mgmt v2 P4 T7)
// ---------------------------------------------------------------------------
// FIFO table of every live (waiting/notified) waitlist group for this event,
// fetched through manage-waitlist's read-only 'list' action — NOT a client
// waitlist_groups read, because that table's RLS deliberately only exposes a
// group to its own club/person (plus admins); hosts and sanctioning get the
// queue via the server-side-authorized read instead of an RLS relaxation.
// The automatic scheduled-dispatch sweep (every 15 min) does the real
// promoting; Promote/Requeue here are the admin/sanctioning-only manual
// override. The buttons render off the server-returned `canManage` flag, and
// manage-waitlist re-checks the role server-side regardless — the flag is
// UX, not the security boundary.

function WaitlistCard({ event, toast }: {
  event: Event; toast: (msg: string, opts?: { variant?: 'info' | 'error' }) => void;
}) {
  const db = useDB();
  const fmtDate = useFmtDate();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [queue, setQueue] = useState<WaitlistQueueRow[] | null>(null);
  const [canOverride, setCanOverride] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Bumped after a promote/requeue to re-fetch the queue.
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let live = true;
    void fetchEventWaitlist(event.id).then((res) => {
      if (!live) return;
      if (!res.ok) { setLoadError(res.error ?? 'Could not load the waitlist.'); setQueue([]); return; }
      setLoadError(null);
      setQueue(res.groups ?? []);
      setCanOverride(!!res.canManage);
    });
    return () => { live = false; };
  }, [event.id, refreshKey]);

  const groups = (queue ?? []).slice().sort((a, b) => {
    // 'waiting' groups sort by FIFO queuedAt; 'notified' groups (already
    // promoted, not competing for a queue position) sort after, by
    // notifiedAt, so the table reads top-to-bottom as "queue, then holds".
    if (a.status !== b.status) return a.status === 'waiting' ? -1 : 1;
    const av = a.status === 'waiting' ? a.queuedAt : (a.notifiedAt ?? a.queuedAt);
    const bv = b.status === 'waiting' ? b.queuedAt : (b.notifiedAt ?? b.queuedAt);
    return av.localeCompare(bv) || a.id.localeCompare(b.id);
  });

  const waitingOnly = groups.filter((g) => g.status === 'waiting');
  const levelName = (id?: string | null) => (id ? db.levels.find((l) => l.id === id)?.name ?? id : '—');
  const sessionName = (id?: string | null) => (id ? event.sessions.find((s) => s.id === id)?.name ?? id : '—');

  const act = async (group: WaitlistQueueRow, action: 'promote' | 'requeue') => {
    setBusyId(group.id);
    const res = await manageWaitlist(group.id, action);
    setBusyId(null);
    if (!res.ok) { toast(res.error ?? 'Could not update the waitlist group.', { variant: 'error' }); return; }
    toast(action === 'promote'
      ? 'Group promoted — they have been emailed and their spots are held.'
      : 'Group requeued to the back of the line.');
    setRefreshKey((k) => k + 1);
  };

  return (
    <div className="card card-pad" style={{ marginBottom: 18 }}>
      <h3 className="card-title">Waitlist{queue !== null ? ` (${groups.length})` : ''}</h3>
      {loadError ? (
        <p style={{ margin: 0, fontSize: 13, color: 'var(--coral-700)' }}>{loadError}</p>
      ) : queue === null ? (
        <p style={{ margin: 0, fontSize: 13, color: 'var(--ink-soft)' }}>Loading…</p>
      ) : groups.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13, color: 'var(--ink-soft)' }}>No one is currently waitlisted for this event.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="tbl">
            <thead>
              <tr>
                <th>#</th><th>Club / Athlete</th><th>Discipline</th><th>Level</th><th>Session</th>
                <th className="num">Regs</th><th>Status</th><th>Queued / hold expires</th>
                {canOverride && <th />}
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => {
                const pos = g.status === 'waiting' ? waitingOnly.findIndex((w) => w.id === g.id) + 1 : null;
                return (
                  <tr key={g.id}>
                    <td>{pos ?? '—'}</td>
                    <td>{g.name}</td>
                    <td>{g.discipline === 'TNT' ? 'T&T' : g.discipline}</td>
                    <td>{levelName(g.levelId)}</td>
                    <td>{sessionName(g.sessionId)}</td>
                    <td className="num">{g.regCount}</td>
                    <td>{g.status === 'waiting' ? <Badge tone="info">Waiting</Badge> : <Badge tone="warn">Holding — must checkout</Badge>}</td>
                    <td style={{ fontSize: 12.5 }}>
                      {g.status === 'waiting'
                        ? `Queued ${fmtDate(g.queuedAt.slice(0, 10))}`
                        : g.holdExpiresAt ? `Until ${new Date(g.holdExpiresAt).toLocaleString()}` : '—'}
                    </td>
                    {canOverride && (
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {g.status === 'waiting' && (
                          <button className="btn small ghost" disabled={busyId === g.id} onClick={() => act(g, 'promote')}>
                            {busyId === g.id ? '…' : 'Promote'}
                          </button>
                        )}
                        {g.status === 'notified' && (
                          <button className="btn small ghost" disabled={busyId === g.id} onClick={() => act(g, 'requeue')}>
                            {busyId === g.id ? '…' : 'Requeue'}
                          </button>
                        )}
                      </td>
                    )}
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

// ---------------------------------------------------------------------------
// CampSurveyResponsesCard — overnight-accommodations survey review (PM
// requirement 2026-07-22): hosts/admins review answers both individually and
// as totals/summaries. Reads through the scoped `registration_camp_surveys`
// RPC (fetchCampSurveys) — same as the registrant-facing prefill — never a
// direct `camp_survey` column read (excluded from loadAll by design, privacy
// fix 2026-07-17).
// ---------------------------------------------------------------------------

function CampSurveyResponsesCard({ event, regs }: { event: Event; regs: Registration[] }) {
  const db = useDB();
  const [surveys, setSurveys] = useState<Record<string, Registration['campSurvey'] | null> | null>(null);
  const [showIndividual, setShowIndividual] = useState(false);

  useEffect(() => {
    let live = true;
    void fetchCampSurveys(event.id).then((res) => { if (live) setSurveys(res); });
    return () => { live = false; };
  }, [event.id]);

  const { enabled, questions } = campSurveyQuestionsOf(event.campConfig);

  const rows = surveys === null ? null : regs
    .filter((r) => surveys[r.id])
    .map((r) => ({
      reg: r,
      athleteName: (() => {
        const p = db.people.find((pp) => pp.id === r.athleteId);
        return p ? `${p.firstName} ${p.lastName}` : r.athleteId;
      })(),
      survey: surveys[r.id]!,
    }))
    .sort((a, b) => a.athleteName.localeCompare(b.athleteName));

  // Per-question totals: for text questions, count of non-empty answers; for
  // single/multi, count per option (labeled via campSurveyAnswerLabel so
  // legacy coded values — 'before-10', 'quiet', … — read as their historical
  // human labels; custom questions' option text is already the label).
  const summaryFor = (q: ReturnType<typeof campSurveyQuestionsOf>['questions'][number]) => {
    if (!rows) return { kind: 'counts' as const, counts: [] as [string, number][] };
    if (q.type === 'text') {
      const n = rows.filter((r) => typeof r.survey[q.id] === 'string' && (r.survey[q.id] as string).trim()).length;
      return { kind: 'text' as const, count: n };
    }
    const counts = new Map<string, number>();
    for (const r of rows) {
      const v = r.survey[q.id];
      const values = Array.isArray(v) ? v : v ? [v] : [];
      for (const raw of values) {
        const label = campSurveyAnswerLabel(q.id, raw);
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
    }
    return { kind: 'counts' as const, counts: [...counts.entries()].sort((a, b) => b[1] - a[1]) };
  };

  const summaryBlock = (q: ReturnType<typeof campSurveyQuestionsOf>['questions'][number]) => {
    const s = summaryFor(q);
    return (
      <div key={q.id}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>{q.label}</div>
        {s.kind === 'text' ? (
          <div style={{ fontSize: 13 }}><strong>{s.count}</strong> of {rows?.length ?? 0} answered</div>
        ) : s.counts.length === 0 ? (
          <div style={{ fontSize: 12.5, color: 'var(--ink-soft)' }}>No answers yet</div>
        ) : (
          s.counts.map(([label, n]) => (
            <div key={label} style={{ fontSize: 13, display: 'flex', justifyContent: 'space-between', gap: 8, maxWidth: 240 }}>
              <span>{label}</span><strong>{n}</strong>
            </div>
          ))
        )}
      </div>
    );
  };

  return (
    <div className="card card-pad" style={{ marginBottom: 18 }}>
      <h3 className="card-title">Survey responses{rows !== null ? ` (${rows.length})` : ''}</h3>
      <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--ink-soft)' }}>
        Registrant-survey answers from camp registrants.
        {!enabled && ' The survey is currently turned off in "Edit event" — no new answers will come in.'}
      </p>
      {rows === null ? (
        <p style={{ margin: 0, fontSize: 13, color: 'var(--ink-soft)' }}>Loading…</p>
      ) : rows.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13, color: 'var(--ink-soft)' }}>No survey answers yet.</p>
      ) : (
        <>
          <div className="grid cols-3" style={{ gap: 16, marginBottom: 14 }}>
            {questions.map((q) => summaryBlock(q))}
          </div>
          <button className="btn small ghost" onClick={() => setShowIndividual((v) => !v)}>
            {showIndividual ? 'Hide individual answers' : 'Show individual answers'}
          </button>
          {showIndividual && (
            <div style={{ overflowX: 'auto', marginTop: 12 }}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Athlete</th>
                    {questions.map((q) => <th key={q.id}>{q.label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ reg, athleteName, survey }) => (
                    <tr key={reg.id}>
                      <td>{athleteName}</td>
                      {questions.map((q) => {
                        const v = survey[q.id];
                        const text = Array.isArray(v)
                          ? v.map((x) => campSurveyAnswerLabel(q.id, x)).join(', ')
                          : v ? campSurveyAnswerLabel(q.id, v) : '';
                        return <td key={q.id} style={{ maxWidth: 260, whiteSpace: 'normal' }}>{text || '—'}</td>;
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CompetitionOrderLockCard — admin lock toggle (event-mgmt v2 P5 §E6)
// ---------------------------------------------------------------------------

function CompetitionOrderLockCard({ event, toast }: {
  event: Event; toast: (msg: string, opts?: { variant?: 'info' | 'error' }) => void;
}) {
  const locked = !!event.competitionOrderLocked;

  const toggle = (checked: boolean) => {
    const updated: Event = { ...event, competitionOrderLocked: checked };
    const applied = mutate((d) => {
      const idx = d.events.findIndex((e) => e.id === event.id);
      if (idx >= 0) d.events[idx] = updated;
    });
    if (!applied) return; // offline read-only gate — don't push or claim success
    pushEvent(updated);
    toast(checked
      ? 'Competition orders locked — club managers now see them read-only.'
      : 'Competition orders unlocked — club managers can edit again.');
  };

  return (
    <div className="card card-pad" style={{ marginBottom: 18 }}>
      <h3 className="card-title">Set competition order</h3>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, cursor: 'pointer' }}>
        <input type="checkbox" checked={locked} onChange={(e) => toggle(e.target.checked)} />
        Lock competition orders (clubs view-only)
      </label>
      <p style={{ margin: '6px 0 0', fontSize: 12.5, color: 'var(--ink-soft)' }}>
        Once locked, club managers can still see their submitted competition order but can't change it — only admins can.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// NationalsSummaryCard — event-wide aggregate summary (event-mgmt v2 P5 D1,
// spec §L.3, REPLACED per PM feedback-2 §3). The prior version was a "view
// as club/athlete" dropdown that just rendered a scoped NationalsDashboard —
// testing showed that's not what an admin/sanctioning reviewer wants when
// they land here; they want the numbers for the whole event. Registration
// counts come from the already-loaded local `db` (same source as the
// Participants stat tile above); add-on purchase counts reuse the
// `event_host_addons` RPC (`fetchEventHostAddons`) — the same server source
// the host export workbook uses — rather than standing up a new fetch path.
// ---------------------------------------------------------------------------

const ADDON_LABEL: Record<NonNullable<HostAddonRow['refLineType']>, string> = {
  tshirt: 'T-shirts', leo: 'Leotards', banquet: 'Banquet seats',
};

function NationalsSummaryCard({ event }: { event: Event }) {
  const db = useDB();
  const [addons, setAddons] = useState<HostAddonRow[] | null>(null);
  const [addonsError, setAddonsError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchEventHostAddons(event.id).then((res) => {
      if (cancelled) return;
      if (!res.ok) { setAddonsError(res.error); return; }
      setAddons(res.rows);
    });
    return () => { cancelled = true; };
  }, [event.id]);

  // Phase 3 (data-layer-scale): reads the by-event slice instead of
  // db.registrations. status gates the empty state below — a loading slice
  // must never render "No registrations yet." (CONTRACT completeness rule).
  const { rows: eventRegs, status: regsStatus } = useEventRegistrations(event.id);
  const regs = eventRegs.filter((r) => r.eventId === event.id && !r.refunded);
  const active = regs.filter((r) => !r.waitlisted);
  const waitlisted = regs.filter((r) => r.waitlisted).length;

  if (regsStatus === 'loading') {
    return (
      <div className="card card-pad" style={{ marginBottom: 18 }}>
        <h3 className="card-title">Event summary</h3>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--ink-soft)' }}>Loading…</p>
      </div>
    );
  }

  if (active.length === 0) {
    return (
      <div className="card card-pad" style={{ marginBottom: 18 }}>
        <h3 className="card-title">Event summary</h3>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--ink-soft)' }}>No registrations yet.</p>
      </div>
    );
  }

  const byDiscipline = new Map<string, number>();
  for (const r of active) byDiscipline.set(r.discipline, (byDiscipline.get(r.discipline) ?? 0) + 1);

  const athleteCount = new Set(active.map((r) => r.athleteId)).size;
  const clubIds = new Set(active.map((r) => r.clubId).filter((id): id is string => !!id));
  const independentCount = new Set(
    active.filter((r) => db.people.find((p) => p.id === r.athleteId)?.mainClubId === null).map((r) => r.athleteId),
  ).size;

  const addonCounts = new Map<string, number>();
  if (addons) {
    for (const a of addons) {
      if (!a.refLineType) continue;
      addonCounts.set(a.refLineType, (addonCounts.get(a.refLineType) ?? 0) + 1);
    }
  }
  const addonTypes = (['tshirt', 'leo', 'banquet'] as const).filter((t) => addonCounts.has(t));

  return (
    <div className="card card-pad" style={{ marginBottom: 18 }}>
      <h3 className="card-title">Event summary</h3>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, fontSize: 14 }}>
        <div>
          <strong>{active.length}</strong> registrations
          {[...byDiscipline.entries()].map(([d, n]) => (
            <span key={d} style={{ color: 'var(--ink-soft)' }}> · {n} {d === 'TNT' ? 'T&T' : d}</span>
          ))}
        </div>
        <div><strong>{athleteCount}</strong> unique athletes</div>
        <div>
          <strong>{clubIds.size}</strong> clubs
          {independentCount > 0 && <span style={{ color: 'var(--ink-soft)' }}> · {independentCount} independent</span>}
        </div>
        {waitlisted > 0 && <div><strong>{waitlisted}</strong> waitlisted</div>}
      </div>
      {(event.tshirtAddon || event.campConfig?.leoAddon || event.banquet) && (
        <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--line)' }}>
          <h4 style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 700, color: 'var(--ink-soft)' }}>Add-on purchases</h4>
          {addonsError ? (
            <p style={{ margin: 0, fontSize: 13, color: 'var(--coral-700)' }}>Couldn't load add-on counts: {addonsError}</p>
          ) : !addons ? (
            <p style={{ margin: 0, fontSize: 13, color: 'var(--ink-soft)' }}>Loading…</p>
          ) : addonTypes.length === 0 ? (
            <p style={{ margin: 0, fontSize: 13, color: 'var(--ink-soft)' }}>No add-on purchases yet.</p>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, fontSize: 14 }}>
              {addonTypes.map((t) => (
                <div key={t}><strong>{addonCounts.get(t)}</strong> {ADDON_LABEL[t]}</div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// OwnerChecklistCard — event-owner task checklist (event-mgmt v2 §B4)
// ---------------------------------------------------------------------------

function OwnerChecklistCard({ event, fmtDate, toast }: { event: Event; fmtDate: (iso: string) => string; toast: (msg: string, opts?: { variant?: 'info' | 'error' }) => void }) {
  const checklist: OwnerChecklist = event.ownerChecklist ?? {};
  const [uploading, setUploading] = useState(false);

  const patchTask = (taskId: OwnerTaskId, patch: Partial<OwnerChecklistEntry>) => {
    const entry = { ...checklist[taskId], ...patch };
    const updated: Event = { ...event, ownerChecklist: { ...checklist, [taskId]: entry } };
    const applied = mutate((d) => {
      const idx = d.events.findIndex((e) => e.id === event.id);
      if (idx >= 0) d.events[idx] = updated;
    });
    if (applied) pushEvent(updated); // offline read-only gate: never push what local lacks
  };

  const toggleDone = (taskId: OwnerTaskId) => {
    const entry = checklist[taskId];
    const done = !entry?.done;
    patchTask(taskId, { done, doneAt: done ? new Date().toISOString() : undefined });
  };

  return (
    <div className="card card-pad" style={{ marginBottom: 18 }}>
      <h3 className="card-title">Owner task checklist</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {OWNER_TASKS.map(({ id, label }) => {
          const entry = checklist[id];
          const due = ownerTaskDueDate(id, event, checklist);
          const overdue = !entry?.done && !!due && new Date(due).getTime() < new Date().getTime();
          return (
            <div key={id} style={{ paddingBottom: 12, borderBottom: '1px solid var(--line)' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', cursor: 'pointer' }}>
                <input type="checkbox" checked={!!entry?.done} onChange={() => toggleDone(id)} />
                <strong>{label}</strong>
                <span style={{ fontSize: 13, fontWeight: overdue ? 700 : 400, color: overdue ? 'var(--coral-700)' : 'var(--ink-soft)' }}>
                  {due ? `Due ${fmtDate(due.slice(0, 10))}` : 'No due date yet'}
                </span>
              </label>

              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8, marginLeft: 24 }}>
                {id === 'medalsOrdered' && (
                  <Field label="Ordered on">
                    <input type="date" className="input" value={entry?.orderedOn ?? ''} onChange={(e) => patchTask(id, { orderedOn: e.target.value })} />
                  </Field>
                )}
                {id === 'medalsTracking' && (
                  <>
                    <Field label="Tracking link">
                      <input
                        type="text" className="input" value={entry?.trackingLink ?? ''}
                        onChange={(e) => patchTask(id, { trackingLink: e.target.value })}
                        onBlur={(e) => patchTask(id, { trackingLink: normalizeExternalUrl(e.target.value) })}
                        placeholder="https://…"
                      />
                    </Field>
                    <Field label="Host received?">
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <input type="checkbox" checked={!!entry?.hostReceived} onChange={(e) => patchTask(id, { hostReceived: e.target.checked })} /> Yes
                      </label>
                    </Field>
                  </>
                )}
                {id === 'insurance' && (
                  <Field label="Certificate file" hint="PDF, JPG, or PNG — up to 10MB.">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      <input
                        type="file" accept=".pdf,.jpg,.jpeg,.png" disabled={uploading}
                        onChange={async (e) => {
                          const file = e.target.files?.[0];
                          e.target.value = '';
                          if (!file) return;
                          setUploading(true);
                          const result = await uploadInsuranceCertificate(event.id, file);
                          setUploading(false);
                          if (!result.ok) { toast(result.error, { variant: 'error' }); return; }
                          patchTask(id, { filePath: result.path });
                          toast('Certificate uploaded.');
                        }}
                      />
                      {uploading && <span style={{ fontSize: 13, color: 'var(--ink-soft)' }}>Uploading…</span>}
                      {entry?.filePath && !uploading && <InsuranceCertificateLink filePath={entry.filePath} />}
                    </div>
                  </Field>
                )}
                {id === 'onsiteRep' && (
                  <>
                    <Field label="Rep name">
                      <input type="text" className="input" value={entry?.name ?? ''} onChange={(e) => patchTask(id, { name: e.target.value })} />
                    </Field>
                    <Field label="Rep email">
                      <input type="email" className="input" value={entry?.email ?? ''} onChange={(e) => patchTask(id, { email: e.target.value })} />
                    </Field>
                  </>
                )}
                {id === 'payHost' && (
                  <>
                    <Field label="Method">
                      <select className="input" value={entry?.method ?? ''} onChange={(e) => patchTask(id, { method: (e.target.value || undefined) as OwnerChecklistEntry['method'] })}>
                        <option value="">Select…</option>
                        <option value="check">Check</option>
                        <option value="paypal">PayPal</option>
                      </select>
                    </Field>
                    <Field label="Paid on">
                      <input type="date" className="input" value={entry?.paidOn ?? ''} onChange={(e) => patchTask(id, { paidOn: e.target.value })} />
                    </Field>
                  </>
                )}
                <Field label="Note">
                  <input type="text" className="input" value={entry?.note ?? ''} onChange={(e) => patchTask(id, { note: e.target.value })} placeholder="Optional note" />
                </Field>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Link that resolves a signed URL for a stored insurance certificate ON
 *  CLICK (not on render) — signed URLs expire (~10 min), so resolving eagerly
 *  would churn them for no reason. Reusable by the host-facing page (event-mgmt
 *  v2 §C status card) as well as this owner checklist. */
export function InsuranceCertificateLink({ filePath }: { filePath: string }) {
  const [loading, setLoading] = useState(false);
  return (
    <button
      type="button" className="btn small ghost" disabled={loading}
      onClick={async () => {
        setLoading(true);
        const result = await insuranceCertificateUrl(filePath);
        setLoading(false);
        if (!result.ok) { window.alert(result.error); return; }
        window.open(result.url, '_blank', 'noopener,noreferrer');
      }}
    >
      {loading ? 'Opening…' : 'View certificate'}
    </button>
  );
}

// ---------------------------------------------------------------------------
// EventHostPage — event-mgmt v2 §C: status card + registration summary for
// hosts (host-club managers, granted event admins) and the sanctioning team.
// Excel exports (the follow-up task) belong on this page too — see the
// "Excel exports" spot below the registration summary card, left empty here.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// RosterToolsCard — event-mgmt v2 P1 Task 8: scoped post-close host roster
// editing (spec §C + Nate's 2026-07-09 scope answer). Hosts (host-club
// managers + event-admin grantees) can add/remove athletes and adjust
// level/apparatus/session on THEIR event once registration has closed.
// Every write goes through host_upsert_registration/host_delete_registration/
// find_person_for_host (never a direct `registrations` write) and NEVER
// touches payment state: a host-added registration lands paid:true with no
// cart line/fee (mirrors the host-club $0 rule); removal does NOT refund
// (refunds are a Phase 3 feature). A one-time-per-page-visit warning modal
// gates the FIRST roster mutation.
// ---------------------------------------------------------------------------

const HOST_ROSTER_WARNING =
  "You're editing registrations directly as the event host. Changes here do not charge or refund anyone — "
  + 'removed athletes are NOT automatically refunded, and added athletes are NOT charged. Entry-fee corrections '
  + 'must be handled with the UCG team.';

interface RosterDraft { levelId: string; apparatus: string[]; sessionId: string }

function RosterToolsCard({
  event, rows, onChanged, toast,
}: {
  event: Event;
  rows: HostRosterRow[] | null;
  onChanged: () => void;
  toast: (msg: string, opts?: { variant?: 'info' | 'error' }) => void;
}) {
  const db = useDB();
  const [warned, setWarned] = useState(false);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, RosterDraft>>({});

  const [addEmail, setAddEmail] = useState('');
  const [addDiscipline, setAddDiscipline] = useState<Discipline>(event.disciplines[0]);
  const [addLevelId, setAddLevelId] = useState('');
  const [addApparatus, setAddApparatus] = useState<string[]>([]);
  const [addSessionId, setAddSessionId] = useState('');
  const [addBusy, setAddBusy] = useState(false);

  const disciplineLevels = (disc: Discipline) => db.levels.filter((l) => l.discipline === disc && !l.retired);
  const disciplineSessions = (disc: Discipline) => event.sessions.filter((s) => s.discipline === disc);

  const draftFor = (row: HostRosterRow): RosterDraft =>
    drafts[row.regId] ?? { levelId: row.levelId ?? '', apparatus: row.apparatus, sessionId: row.sessionId ?? '' };
  const setDraft = (row: HostRosterRow, patch: Partial<RosterDraft>) => {
    setDrafts((prev) => ({ ...prev, [row.regId]: { ...draftFor(row), ...patch } }));
  };

  /** Runs `action` immediately once the host has seen the warning this page
   *  visit; otherwise stashes it and opens the modal. */
  const runOrWarn = (action: () => void) => {
    if (warned) { action(); return; }
    setPendingAction(() => action);
  };
  const confirmWarning = () => {
    setWarned(true);
    const action = pendingAction;
    setPendingAction(null);
    if (action) action();
  };

  const save = async (row: HostRosterRow) => {
    const d = draftFor(row);
    if (!d.levelId || d.apparatus.length === 0) { toast('Pick a level and at least one apparatus.', { variant: 'error' }); return; }
    setBusyId(row.regId);
    const reg: Registration = {
      id: row.regId, eventId: event.id, athleteId: row.athleteId, clubId: row.clubId ?? '',
      discipline: row.discipline as Discipline, levelId: d.levelId, apparatus: d.apparatus,
      sessionId: d.sessionId || null,
      ...(row.apparatusLevels ? { apparatusLevels: row.apparatusLevels } : {}),
      ...(row.partnerAthleteId ? { partnerAthleteId: row.partnerAthleteId } : {}),
    };
    const err = await hostUpsertRegistration(event.id, reg);
    setBusyId(null);
    if (err) { toast(err, { variant: 'error' }); return; }
    toast('Registration updated.');
    onChanged();
  };

  const remove = async (row: HostRosterRow) => {
    setBusyId(row.regId);
    const err = await hostDeleteRegistration(event.id, row.regId);
    setBusyId(null);
    if (err) { toast(err, { variant: 'error' }); return; }
    toast(`Removed ${row.firstName} ${row.lastName}. This does not issue a refund.`);
    onChanged();
  };

  const addAthlete = async () => {
    const email = addEmail.trim();
    if (!email || !addLevelId || addApparatus.length === 0) {
      toast('Enter an email, level, and at least one apparatus.', { variant: 'error' });
      return;
    }
    setAddBusy(true);
    const found = await findPersonForHost(event.id, email);
    if (!found.ok) { setAddBusy(false); toast(found.error, { variant: 'error' }); return; }
    // Club-membership gate (CLAUDE.md domain rule): every registration entry
    // point must verify the competing club holds an active club membership for
    // the event's season — same idiom as Club.tsx's clubMembershipBlocked().
    // The reg is created under the athlete's main club (find_person_for_host).
    const seasonId = seasonForDate(db, event.startDate);
    if (!found.clubId || !clubHasActiveMembershipForEvent(db, found.clubId, seasonId, event.eventType)) {
      setAddBusy(false);
      const sName = db.seasons.find((s) => s.id === seasonId)?.name ?? "this event's season";
      toast(
        found.clubId
          ? `That athlete's club has no active ${sName} club membership, so they can't be registered for this event.`
          : "That athlete has no club, so they can't be registered for this event.",
        { variant: 'error' },
      );
      return;
    }
    const reg: Registration = {
      id: `reg-host-${Date.now()}-${found.personId}-${addDiscipline}`,
      eventId: event.id, athleteId: found.personId, clubId: found.clubId ?? '',
      discipline: addDiscipline, levelId: addLevelId, apparatus: addApparatus,
      sessionId: addSessionId || null,
    };
    const err = await hostUpsertRegistration(event.id, reg);
    setAddBusy(false);
    if (err) { toast(err, { variant: 'error' }); return; }
    toast(`Added ${found.firstName} ${found.lastName}. No charge was made.`);
    setAddEmail(''); setAddApparatus([]); setAddSessionId('');
    onChanged();
  };

  const byClub = new Map<string, HostRosterRow[]>();
  for (const row of rows ?? []) {
    const key = row.clubId ?? 'unassigned';
    const list = byClub.get(key) ?? [];
    list.push(row);
    byClub.set(key, list);
  }

  return (
    <div className="card card-pad" style={{ marginBottom: 18 }}>
      <h3 className="card-title">Roster tools</h3>
      <p style={{ margin: '0 0 10px', fontSize: 13, color: 'var(--ink-soft)' }}>
        Add or remove athletes and adjust level/apparatus/session directly. This does not charge or refund anyone —
        entry-fee corrections go through the UCG team.
      </p>

      {!rows && <p style={{ fontSize: 13, color: 'var(--ink-soft)' }}>Loading roster…</p>}
      {rows && rows.length === 0 && <p style={{ fontSize: 13, color: 'var(--ink-soft)' }}>No registrations yet.</p>}

      {rows && rows.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18, marginBottom: 18 }}>
          {[...byClub.entries()].map(([clubKey, clubRows]) => (
            <div key={clubKey}>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 8 }}>{clubRows[0]?.clubName ?? 'Unassigned'}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {clubRows.map((row) => {
                  const d = draftFor(row);
                  const disc = row.discipline as Discipline;
                  return (
                    <div
                      key={row.regId}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 8 }}
                    >
                      <DisciplineIcon discipline={disc} size={16} />
                      <strong style={{ minWidth: 140 }}>{row.firstName} {row.lastName}</strong>
                      <select className="input" style={{ maxWidth: 160 }} value={d.levelId} onChange={(e) => setDraft(row, { levelId: e.target.value })}>
                        <option value="" disabled>Level…</option>
                        {disciplineLevels(disc).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                      </select>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 8px' }}>
                        {APPARATUS[disc].map((ev) => (
                          <label key={ev.code} className="checkrow" style={{ fontSize: 12 }}>
                            <input
                              type="checkbox"
                              checked={d.apparatus.includes(ev.code)}
                              onChange={() => setDraft(row, {
                                apparatus: d.apparatus.includes(ev.code)
                                  ? d.apparatus.filter((c) => c !== ev.code)
                                  : [...d.apparatus, ev.code],
                              })}
                            />
                            {ev.code}
                          </label>
                        ))}
                      </div>
                      <select className="input" style={{ maxWidth: 180 }} value={d.sessionId} onChange={(e) => setDraft(row, { sessionId: e.target.value })}>
                        <option value="">No session</option>
                        {disciplineSessions(disc).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </select>
                      <button className="btn small primary" disabled={busyId === row.regId} onClick={() => runOrWarn(() => save(row))}>
                        {busyId === row.regId ? 'Saving…' : 'Save'}
                      </button>
                      <button
                        className="btn small ghost" aria-label={`Remove ${row.firstName} ${row.lastName}`}
                        disabled={busyId === row.regId} onClick={() => runOrWarn(() => remove(row))}
                      >✕</button>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ borderTop: '1px solid var(--line)', paddingTop: 14 }}>
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 8 }}>Add athlete by email</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
          <input
            type="email" className="input" style={{ maxWidth: 240 }} placeholder="Account email"
            value={addEmail} onChange={(e) => setAddEmail(e.target.value)}
          />
          <select
            className="input" style={{ maxWidth: 100 }} value={addDiscipline}
            onChange={(e) => { setAddDiscipline(e.target.value as Discipline); setAddLevelId(''); setAddApparatus([]); setAddSessionId(''); }}
          >
            {event.disciplines.map((dsc) => <option key={dsc} value={dsc}>{dsc === 'TNT' ? 'T&T' : dsc}</option>)}
          </select>
          <select className="input" style={{ maxWidth: 160 }} value={addLevelId} onChange={(e) => setAddLevelId(e.target.value)}>
            <option value="" disabled>Level…</option>
            {disciplineLevels(addDiscipline).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
          <select className="input" style={{ maxWidth: 180 }} value={addSessionId} onChange={(e) => setAddSessionId(e.target.value)}>
            <option value="">No session</option>
            {disciplineSessions(addDiscipline).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', marginBottom: 10 }}>
          {APPARATUS[addDiscipline].map((ev) => (
            <label key={ev.code} className="checkrow" style={{ fontSize: 13 }}>
              <input
                type="checkbox"
                checked={addApparatus.includes(ev.code)}
                onChange={() => setAddApparatus((prev) => (prev.includes(ev.code) ? prev.filter((c) => c !== ev.code) : [...prev, ev.code]))}
              />
              {ev.code} — {ev.name}
            </label>
          ))}
        </div>
        <button className="btn small primary" disabled={addBusy || !addEmail.trim()} onClick={() => runOrWarn(addAthlete)}>
          {addBusy ? 'Adding…' : 'Add athlete'}
        </button>
      </div>

      {pendingAction && (
        <Modal title="You're editing this event's roster" onClose={() => setPendingAction(null)}>
          <p style={{ marginBottom: 16, fontSize: 14 }}>{HOST_ROSTER_WARNING}</p>
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn primary" onClick={confirmWarning}>Continue</button>
            <button className="btn ghost" onClick={() => setPendingAction(null)}>Cancel</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

export function EventHostPage() {
  const { slug } = useParams();
  const db = useDB();
  const caps = useCapabilities();
  const toast = useToast();
  const fmtDate = useFmtDate();
  const rolesLoaded = useRolesLoaded();
  const event = db.events.find((m) => m.slug === slug);

  // Whether this caller may load the event-wide host roster. Computed BEFORE
  // the fetch effect so we never call event_host_roster for a viewer the RPC
  // will reject — an athlete who lands on a /host URL would otherwise trigger a
  // "Not authorized" console error and a wasted round-trip. Gating on
  // rolesLoaded also makes the fetch wait for roles instead of racing them (a
  // real host would briefly read as unauthorized before roles resolve).
  const canManage = !!event && rolesLoaded && (caps.isEventHost(event.id) || caps.isSanctioning);

  // Roster is fetched once here and shared by the registration-summary card
  // and the Excel-export card below, rather than each fetching its own copy.
  const [rosterRows, setRosterRows] = useState<HostRosterRow[] | null>(null);
  const [rosterError, setRosterError] = useState<string | null>(null);

  const refreshRoster = useCallback(() => {
    if (!event || !canManage) return;
    fetchEventHostRoster(event.id).then((res) => {
      if (!res.ok) { setRosterError(res.error); toast(`Couldn't load the registration roster: ${res.error}`, { variant: 'error' }); return; }
      setRosterError(null);
      setRosterRows(res.rows);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event?.id, canManage]);

  useEffect(() => {
    refreshRoster();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event?.id, canManage]);

  if (!event) return <div className="page"><p>Event not found.</p></div>;

  // Roles load async after the session resolves (CLAUDE.md "rolesLoaded
  // gate") — wait rather than flashing "access denied" at an actual host on
  // refresh.
  if (!rolesLoaded) return <div className="page"><p>Loading…</p></div>;

  if (!canManage) {
    return (
      <div className="page">
        <p>You don't have access to this event's host dashboard. Contact the event host or a UCG administrator if you believe this is an error.</p>
      </div>
    );
  }

  const isUcg = !!event.ucgHosted;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 className="page-title display">{event.name} — Host dashboard</h1>
          <p className="page-sub">{event.city}, {event.state} · {fmtDate(event.startDate)}–{fmtDate(event.endDate)}</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link className="btn ghost small" to={`/events/${event.slug}/communicate`}>Email registrants</Link>
          <Link className="btn ghost small" to={`/events/${event.slug}`}>← Event page</Link>
        </div>
      </div>

      {/* Event status (§C) — hidden for UCG-run events: every row (UCG
          owner contact, hotel block, insurance, medal order, payment-to-host)
          is meaningless when UCG runs the event itself (PM feedback-2 §6). */}
      {!isUcg && <HostStatusCard event={event} fmtDate={fmtDate} toast={toast} />}
      <HostRegistrationSummaryCard rows={rosterRows} error={rosterError} />

      <HostExportCard event={event} rows={rosterRows} error={rosterError} toast={toast} />

      {/* Per-event admin grants — not applicable to UCG-run events (PM
          feedback-2 §2, mirrors the detail-page gate). */}
      {!isUcg && <EventAdminsCard event={event} toast={toast} />}

      <JudgeAccessCard event={event} toast={toast} />

      {/* Camps have no competition to set up and no roster to correct — the
          Camp roster EXPORT sheet (HostExportCard above) still carries the
          survey answers, so that card stays; Competition setup + Roster tools
          are removed entirely for camps (PM feedback 2026-07-23). */}
      {event.eventType !== 'camp' && (
        <div className="card card-pad" style={{ marginBottom: 18 }}>
          <h3 className="card-title">Competition setup</h3>
          {isPast(event.regCloses) ? (
            <>
              <p style={{ margin: '0 0 10px', fontSize: 13, color: 'var(--ink-soft)' }}>
                Registration is closed. Build session squads and run scoring from Manage this event, or use Roster
                tools below for last-minute roster corrections.
              </p>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Link className="btn ghost small" to={`/events/${event.slug}/manage`}>Sessions & squads →</Link>
              </div>
            </>
          ) : (
            <p style={{ margin: 0, fontSize: 13, color: 'var(--ink-soft)' }}>
              Competition setup (roster corrections, sessions/squads) unlocks when registration closes.
            </p>
          )}
        </div>
      )}

      {event.eventType !== 'camp' && isPast(event.regCloses) && (
        <RosterToolsCard event={event} rows={rosterRows} onChanged={refreshRoster} toast={toast} />
      )}
    </div>
  );
}

/** Excel-export card (event-mgmt v2 §C/§K, Phase 2 T7): one workbook built
 *  from the shared host roster + purchased add-on units — see
 *  src/lib/host-export.ts for the sheet shapes (Athletes / Counts / Shirt
 *  sizes [profile] always; Shirts (purchased) / Leo sizes / Banquet when
 *  configured; Camp roster for camp events). exceljs is dynamically imported
 *  so it isn't in the main bundle (same reasoning as any heavy on-demand
 *  export lib — this page is the only place it's used). */
function HostExportCard({ event, rows, error, toast }: { event: Event; rows: HostRosterRow[] | null; error: string | null; toast: (msg: string, opts?: { variant?: 'info' | 'error' }) => void }) {
  const db = useDB();
  const [building, setBuilding] = useState(false);
  const ready = !!rows && !error;

  // Purchased add-on units (Shirts/Leo/Banquet sheets, event-mgmt v2 Phase 2
  // T7) are only needed at download time, unlike the roster which the
  // summary card above also renders — fetched fresh on each click rather
  // than kept in state, since this card has no other reason to re-render on
  // an addon purchase happening mid-visit.
  const download = async () => {
    if (!rows) return;
    setBuilding(true);
    try {
      const addonRes = await fetchEventHostAddons(event.id);
      if (!addonRes.ok) {
        toast(`Couldn't load purchased add-ons: ${addonRes.error}`, { variant: 'error' });
        setBuilding(false);
        return;
      }
      const sheets = buildRegistrationWorkbookSheets(rows, levelNameResolver(db.levels), addonRes.rows, {
        tshirtConfigured: !!event.tshirtAddon,
        leoConfigured: !!event.campConfig?.leoAddon,
        banquetConfigured: !!event.banquet,
        isCamp: event.eventType === 'camp',
        campSurveyQuestions: campSurveyQuestionsOf(event.campConfig).questions,
      });
      await downloadWorkbook(sheets, `${event.slug}-registrations.xlsx`);
    } catch (err) {
      toast(`Couldn't build the workbook: ${err instanceof Error ? err.message : String(err)}`, { variant: 'error' });
    } finally {
      setBuilding(false);
    }
  };

  return (
    <div className="card card-pad" style={{ marginBottom: 18 }}>
      <h3 className="card-title">Registration workbook</h3>
      <p style={{ margin: '0 0 10px', fontSize: 13, color: 'var(--ink-soft)' }}>
        Full athlete detail, level × club × apparatus counts, shirt/leo/banquet purchases, and (for camps) an
        overnight-survey roster — all in one .xlsx file.
      </p>
      {error && <p style={{ color: 'var(--coral-700)' }}>Couldn't load the roster — try refreshing the page.</p>}
      <button className="btn primary small" disabled={!ready || building} onClick={download}>
        {building ? 'Building…' : 'Download registration workbook (.xlsx)'}
      </button>
    </div>
  );
}

/** Status card (§C): each line reads "waiting" until the underlying data
 *  exists — event owner contact, hotel block, insurance, medal order/
 *  tracking, onsite rep, and payment status. */
function HostStatusCard({ event, fmtDate, toast }: { event: Event; fmtDate: (iso: string) => string; toast: (msg: string, opts?: { variant?: 'info' | 'error' }) => void }) {
  const checklist: OwnerChecklist = event.ownerChecklist ?? {};
  const medalsOrdered = checklist.medalsOrdered;
  const medalsTracking = checklist.medalsTracking;
  const onsiteRep = checklist.onsiteRep;
  const payHost = checklist.payHost;
  const [markingReceived, setMarkingReceived] = useState(false);
  const [collected, setCollected] = useState<number | null>(null);
  const [collectedError, setCollectedError] = useState(false);

  const hasPricedAddons = !!(event.tshirtAddon?.price || event.bannerAddon?.price || event.banquet?.price);
  const collectingFees = !(event.entryFee === 0 && !hasPricedAddons);

  useEffect(() => {
    if (!collectingFees) return;
    let cancelled = false;
    fetchEventCollectedTotal(event.id).then((res) => {
      if (cancelled) return;
      if (!res.ok) { setCollectedError(true); toast(`Couldn't load the amount collected: ${res.error}`, { variant: 'error' }); return; }
      setCollected(res.total);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event.id, collectingFees]);

  const markReceived = async () => {
    setMarkingReceived(true);
    const err = await markMedalsReceived(event.id);
    setMarkingReceived(false);
    if (err) { toast(err, { variant: 'error' }); return; }
    const updated: Event = { ...event, ownerChecklist: { ...checklist, medalsTracking: { ...medalsTracking, hostReceived: true } } };
    mutate((d) => {
      const idx = d.events.findIndex((e) => e.id === event.id);
      if (idx >= 0) d.events[idx] = updated;
    });
    toast('Marked medals as received.');
  };

  const pastEndDate = isPast(event.endDate);

  return (
    <div className="card card-pad" style={{ marginBottom: 18 }}>
      <h3 className="card-title">Event status</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, fontSize: 14 }}>
        <div>
          <strong>UCG event-owner contact: </strong>
          {event.owner ? <span>{event.owner.name} ({event.owner.email})</span> : <span style={{ color: 'var(--ink-soft)' }}>Waiting for owner assignment</span>}
        </div>
        <div>
          <strong>Hotel block: </strong>
          {event.hotelLink ? <a href={normalizeExternalUrl(event.hotelLink)} target="_blank" rel="noopener noreferrer">Book here →</a> : <span style={{ color: 'var(--ink-soft)' }}>Waiting on hotel block</span>}
        </div>
        <div>
          <strong>Insurance: </strong>
          {checklist.insurance?.filePath
            ? <InsuranceCertificateLink filePath={checklist.insurance.filePath} />
            : <span style={{ color: 'var(--ink-soft)' }}>Waiting on insurance certificate</span>}
        </div>
        <div>
          <strong>Medal order: </strong>
          {!medalsOrdered?.orderedOn ? (
            <span style={{ color: 'var(--ink-soft)' }}>Waiting</span>
          ) : (
            <span>
              Ordered {fmtDate(medalsOrdered.orderedOn.slice(0, 10))}
              {medalsTracking?.trackingLink && (
                <> · <a href={normalizeExternalUrl(medalsTracking.trackingLink)} target="_blank" rel="noopener noreferrer">Track shipment →</a></>
              )}
              {medalsTracking?.trackingLink && !medalsTracking.hostReceived && (
                <> · <button className="btn small ghost" disabled={markingReceived} onClick={markReceived}>{markingReceived ? 'Marking…' : 'Mark received'}</button></>
              )}
              {medalsTracking?.hostReceived && <> · <span style={{ fontWeight: 700 }}>Received ✓</span></>}
            </span>
          )}
        </div>
        <div>
          <strong>Onsite rep: </strong>
          {onsiteRep?.name || onsiteRep?.email
            ? <span>{onsiteRep.name} {onsiteRep.email && <span style={{ color: 'var(--ink-soft)' }}>({onsiteRep.email})</span>}</span>
            : <span style={{ color: 'var(--ink-soft)' }}>Assigned 2 weeks before the event</span>}
        </div>
        <div>
          <strong>Payment status: </strong>
          {!collectingFees ? (
            <span style={{ color: 'var(--ink-soft)' }}>Not collecting fees through the platform</span>
          ) : (
            <>
              <span>
                {collectedError ? 'Could not load the amount collected.' : collected === null ? 'Loading…' : `Collected so far: ${fmtMoney(collected)} (excluding processing fees)`}
              </span>
              {payHost?.done ? (
                <div>Sent via {payHost.method === 'paypal' ? 'PayPal' : 'check'} on {payHost.paidOn ? fmtDate(payHost.paidOn.slice(0, 10)) : ''}</div>
              ) : pastEndDate ? (
                <div style={{ color: 'var(--coral-700)', fontWeight: 700 }}>Payment will be sent 1 week after the event</div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Registration summary card (§C): per level, participating clubs + athletes
 *  per apparatus, from `event_host_roster` (a deliberate RLS exception —
 *  hosts see athlete detail across every competing club for THIS event).
 *  Roster is fetched once by the parent (`EventHostPage`) and shared with
 *  the Excel-export card below it. */
function HostRegistrationSummaryCard({ rows, error }: { rows: HostRosterRow[] | null; error: string | null }) {
  const db = useDB();

  const summary = useMemo(
    () => (rows ? summarizeRoster(rows, levelNameResolver(db.levels)) : null),
    [rows, db.levels],
  );

  return (
    <div className="card card-pad" style={{ marginBottom: 18 }}>
      <h3 className="card-title">Registration summary</h3>
      {error && <p style={{ color: 'var(--coral-700)' }}>Couldn't load the roster — try refreshing the page.</p>}
      {!error && !summary && <p style={{ color: 'var(--ink-soft)' }}>Loading…</p>}
      {summary && summary.length === 0 && <p style={{ color: 'var(--ink-soft)' }}>No registrations yet.</p>}
      {summary && summary.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {summary.map((level) => (
            <div key={level.levelId || 'unassigned'} style={{ paddingBottom: 12, borderBottom: '1px solid var(--line)' }}>
              <h4 style={{ margin: '0 0 6px' }}>{level.levelName}</h4>
              <p style={{ margin: '0 0 6px', fontSize: 13, color: 'var(--ink-soft)' }}>
                {level.clubs.map((c) => `${c.clubName} (${c.athleteCount})`).join(' · ')}
              </p>
              <p style={{ margin: 0, fontSize: 13 }}>
                {Object.entries(level.apparatusCounts).map(([code, count]) => `${code}: ${count}`).join(' · ')}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-unit add-on pickers (event-mgmt v2 Phase 2 T3) — shared between the
// registration popup's add-on step and the standalone post-registration
// purchase dialog. Kept at MODULE scope (not nested in SelfRegModal/
// EventDetail) per the ESLint rule against components defined inside another
// component's render.
// ---------------------------------------------------------------------------

// AddonDraft / initialAddonDraft / anyAddonWindowOpen / addonDraftValid /
// buildAddonCartItems are pure logic — they live in src/lib/pricing.ts
// (unit-tested in tests/pricing.test.ts) and are imported above.
// `SizedAddonPicker` (the shirt/leo quantity+size picker) is extracted to
// src/components/AddonPickers.tsx (T4) so the club-manager Add-ons card can
// reuse it without importing from this page file.

/** Banquet ticket picker: a quantity stepper where only the FIRST ticket can
 *  be assigned to the buying athlete (max-1-assigned-per-person server rule +
 *  self-cart-can-only-assign-self rule) — every additional ticket is always
 *  "Extra". `alreadyAssignedSelf` disables re-assigning when the athlete
 *  already has an assigned ticket for this event elsewhere in their cart. */
function BanquetPicker({
  name, price, deadline, athleteName, selfAssigneeId, alreadyAssignedSelf, units, onChange, fmtDate,
}: {
  name: string;
  price: number;
  deadline?: string;
  athleteName: string;
  selfAssigneeId: string;
  alreadyAssignedSelf: boolean;
  units: string[];
  onChange: (units: string[]) => void;
  fmtDate: (iso: string) => string;
}) {
  const priceLabel = price === 0 ? 'Free' : fmtMoney(price);
  const addUnit = () => onChange([...units, units.length === 0 && !alreadyAssignedSelf ? selfAssigneeId : 'extra']);
  const removeUnit = () => onChange(units.slice(0, -1));

  return (
    <div className="card card-pad" style={{ marginBottom: 14 }}>
      <h3 className="card-title">{name} — {priceLabel}</h3>
      {deadline && (
        <p style={{ fontSize: 12, color: 'var(--ink-soft)', margin: '0 0 8px' }}>
          Purchase by {fmtDate(deadline.slice(0, 10))}
        </p>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: units.length > 0 ? 10 : 0 }}>
        <span style={{ fontSize: 14 }}>Tickets</span>
        <button type="button" className="btn small ghost" onClick={removeUnit} disabled={units.length === 0} aria-label="Remove a ticket">−</button>
        <span style={{ minWidth: 18, textAlign: 'center' }}>{units.length}</span>
        <button type="button" className="btn small ghost" onClick={addUnit} aria-label="Add a ticket">+</button>
      </div>
      {units.map((u, i) => (
        i === 0 ? (
          <Field key={i} label="Ticket #1">
            <select
              className="input"
              value={u}
              onChange={(e) => onChange(units.map((x, idx) => (idx === 0 ? e.target.value : x)))}
            >
              <option value={selfAssigneeId} disabled={alreadyAssignedSelf}>
                For {athleteName}{alreadyAssignedSelf ? ' (already have a ticket)' : ''}
              </option>
              <option value="extra">Extra ticket</option>
            </select>
          </Field>
        ) : (
          <div key={i} style={{ fontSize: 13, color: 'var(--ink-soft)', marginBottom: 6 }}>
            Ticket #{i + 1}: Extra ticket
          </div>
        )
      ))}
    </div>
  );
}

/** Composes the shirt/leo/banquet/banner pickers for one athlete+event,
 *  shared by the registration popup's add-on step (`mode:'registration'`,
 *  which also offers the banner) and the standalone post-registration
 *  purchase dialog (`mode:'standalone'`, shirts/leo/banquet only). Renders
 *  nothing if every add-on type's purchase window is closed. */
function AddonSection({ event, athlete, mode, draft, onChange, existingCart, fmtDate }: {
  event: Event;
  athlete: Athlete;
  mode: 'registration' | 'standalone';
  draft: AddonDraft;
  onChange: (next: AddonDraft) => void;
  existingCart: CartItem[];
  fmtDate: (iso: string) => string;
}) {
  const now = new Date();
  const isCamp = event.eventType === 'camp';

  const tshirtCfg = event.tshirtAddon;
  const tshirtOpen = !!tshirtCfg && addonPurchaseOpen(tshirtCfg, event.regCloses, now);

  const leoCfg = event.campConfig?.leoAddon;
  const leoOpen = !!leoCfg && addonPurchaseOpen(leoCfg, event.regCloses, now);

  const banquetCfg = event.banquet;
  const banquetOpen = !!banquetCfg && addonPurchaseOpen(banquetCfg, event.regCloses, now);

  const bannerCfg = event.bannerAddon;
  const bannerOpen = mode === 'registration' && !!bannerCfg && addonPurchaseOpen(bannerCfg, event.regCloses, now);

  const alreadyAssignedSelf = existingCart.some(
    (ci) => ci.kind === 'addon' && ci.refLineType === 'banquet' && ci.refEventId === event.id && ci.addonAssigneeId === athlete.id,
  );

  if (!tshirtOpen && !leoOpen && !banquetOpen && !bannerOpen) return null;

  return (
    <div>
      {tshirtOpen && tshirtCfg && (
        <SizedAddonPicker
          title="T-shirt"
          price={tshirtCfg.price}
          sizes={tshirtCfg.sizes.length > 0 ? tshirtCfg.sizes : SHIRT_SIZES}
          deadline={tshirtCfg.lastPurchaseAt}
          forceSingle={mode === 'registration' && isCamp}
          noneLabel="No shirt"
          units={draft.shirtUnits}
          onChange={(units) => onChange({ ...draft, shirtUnits: units })}
          fmtDate={fmtDate}
        />
      )}
      {leoOpen && leoCfg && (
        <SizedAddonPicker
          title="Leotard"
          price={leoCfg.price}
          sizes={leoCfg.sizes.length > 0 ? leoCfg.sizes : SHIRT_SIZES}
          deadline={leoCfg.lastPurchaseAt}
          forceSingle={mode === 'registration'}
          noneLabel="No leotard"
          units={draft.leoUnits}
          onChange={(units) => onChange({ ...draft, leoUnits: units })}
          fmtDate={fmtDate}
        />
      )}
      {banquetOpen && banquetCfg && (
        <BanquetPicker
          name={banquetCfg.name}
          price={banquetCfg.price}
          deadline={banquetCfg.lastPurchaseAt}
          athleteName={`${athlete.firstName} ${athlete.lastName}`}
          selfAssigneeId={athlete.id}
          alreadyAssignedSelf={alreadyAssignedSelf}
          units={draft.banquetUnits}
          onChange={(units) => onChange({ ...draft, banquetUnits: units })}
          fmtDate={fmtDate}
        />
      )}
      {bannerOpen && bannerCfg && (
        <div className="card card-pad" style={{ marginBottom: 14 }}>
          <h3 className="card-title">Club banner — {bannerCfg.price === 0 ? 'Free' : fmtMoney(bannerCfg.price)}</h3>
          {bannerCfg.lastPurchaseAt && (
            <p style={{ fontSize: 12, color: 'var(--ink-soft)', margin: '0 0 8px' }}>
              Purchase by {fmtDate(bannerCfg.lastPurchaseAt.slice(0, 10))}
            </p>
          )}
          <Field label="Banner text (leave blank to skip)" hint="Text to print on the banner.">
            <input
              className="input"
              value={draft.bannerText}
              onChange={(e) => onChange({ ...draft, bannerText: e.target.value })}
              placeholder="e.g. Springfield Gymnastics Club"
            />
          </Field>
        </div>
      )}
    </div>
  );
}

/** Standalone post-registration add-on purchase (Phase 2 T3): opened from the
 *  event page for a signed-in athlete who already has a registration here.
 *  Reuses `AddonSection` in `'standalone'` mode (no banner) and pushes
 *  straight to the athlete's own cart — available for as long as ANY add-on
 *  type's window is open, independent of whether registration itself is
 *  still open (a `lastPurchaseAt` may extend past `regCloses`). */
function StandaloneAddonsModal({ event, athlete, onClose, toast }: {
  event: Event;
  athlete: Athlete;
  onClose: () => void;
  toast: (msg: string, opts?: { variant?: 'info' | 'error' }) => void;
}) {
  const db = useDB();
  const navigate = useNavigate();
  const fmtDate = useFmtDate();
  const [draft, setDraft] = useState<AddonDraft>(() => initialAddonDraft(event, 'standalone'));

  const hasSelection =
    draft.shirtUnits.some((u) => u && u !== 'none') ||
    draft.leoUnits.some((u) => u && u !== 'none') ||
    draft.banquetUnits.length > 0;

  const handleSubmit = () => {
    const items = buildAddonCartItems(event, athlete, draft, Date.now());
    if (items.length === 0) {
      toast('Choose at least one add-on to purchase.', { variant: 'error' });
      return;
    }
    const applied = mutate((d) => {
      const cart = d.carts[athlete.id] ?? (d.carts[athlete.id] = []);
      for (const item of items) cart.push(item);
      pushCart(athlete.id, cart, false);
    });
    if (!applied) return; // offline read-only gate — no false success toast
    toast('Add-ons saved to your cart. Check out to complete payment.');
    onClose();
    navigate('/cart');
  };

  return (
    <Modal title={`Add-ons — ${event.name}`} onClose={onClose}>
      <p style={{ fontSize: 14, color: 'var(--ink-soft)', marginBottom: 14 }}>
        Purchase additional add-ons for your existing registration.
      </p>
      <AddonSection
        event={event}
        athlete={athlete}
        mode="standalone"
        draft={draft}
        onChange={setDraft}
        existingCart={db.carts[athlete.id] ?? []}
        fmtDate={fmtDate}
      />
      <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
        <button className="btn primary" onClick={handleSubmit} disabled={!hasSelection}>Add to cart</button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// SelfRegModal — individual self-registration
// ---------------------------------------------------------------------------

interface SelfRegModalProps {
  event: Event;
  athlete: Athlete;
  onClose: () => void;
  toast: (msg: string, opts?: { variant?: 'info' | 'error' }) => void;
}

function SelfRegModal({ event, athlete, onClose, toast }: SelfRegModalProps) {
  const db = useDB();
  const navigate = useNavigate();
  const fmtDate = useFmtDate();

  // Phase 3 (data-layer-scale): `athlete` here is ALWAYS the signed-in caller
  // (EventDetail only ever opens this modal as `db.people.find(p => p.id ===
  // caps.personId)`), so myRegs (Tier 2, synchronous, always complete) is the
  // right source for this athlete's OWN registration history — per the
  // COMPLETENESS rule, priorDisciplineCount/existingRegs/existingForAthlete
  // callers must use "mine", not a by-event slice. Synchro-partner sync needs
  // a DIFFERENT athlete's row though, so it separately uses eventRegs
  // (by-event, all athletes) — which also feeds allEventRegs (capacity,
  // event-wide across every club, never "mine"-scoped).
  const myRegs = useMyRegistrations();
  const { rows: eventRegs, status: regsStatus } = useEventRegistrations(event.id);

  // Clubs the athlete is affiliated with (main + alt)
  const myClubs = [
    ...(athlete.mainClubId ? [db.clubs.find((c) => c.id === athlete.mainClubId)] : []),
    ...athlete.altClubIds.map((id) => db.clubs.find((c) => c.id === id)),
  ].filter((c): c is NonNullable<typeof c> => !!c);

  // Cross-club lock (3d): if the athlete already has a PAID, non-refunded reg for
  // this event under one of their clubs, they're locked to it — they can't compete
  // for a DIFFERENT club. (excludeClubId omitted ⇒ returns ANY paid-reg club.)
  const lockedClubId = paidRegistrationClub(myRegs, {
    athleteId: athlete.id, eventId: event.id,
  });
  const lockedClubShort = lockedClubId
    ? db.clubs.find((c) => c.id === lockedClubId)?.shortName ?? 'another club'
    : null;

  // Default to the locked club when one applies, else the athlete's first club.
  const [selectedClubId, setSelectedClubId] = useState(lockedClubId ?? myClubs[0]?.id ?? '');
  const [step, setStep] = useState<'reg' | 'addons' | 'survey'>('reg');
  // Add-on selections (per-unit model — one cart line per unit, Phase 2 T3).
  const [addonDraft, setAddonDraft] = useState<AddonDraft>(() => initialAddonDraft(event, 'registration'));
  // Saved regs from editor (used in the add-on / survey steps)
  const [pendingRegs, setPendingRegs] = useState<Registration[] | null>(null);
  const [pendingAddonItems, setPendingAddonItems] = useState<CartItem[]>([]);

  const season = currentSeason(db)!;
  const existingRegs = myRegs.filter(
    (r) => r.eventId === event.id && r.athleteId === athlete.id && !r.refunded,
  );

  // Camp registrant survey (event-mgmt v2 §G; editable questions 2026-07-23):
  // asked LAST in the popup, after add-ons, only when the event's resolved
  // survey is enabled. Seeded from any prior answer on this athlete's
  // existing reg (re-registering keeps it).
  const surveyConfig = useMemo(() => campSurveyQuestionsOf(event.campConfig), [event.campConfig]);
  const surveyRequired = event.eventType === 'camp' && surveyConfig.enabled;
  const surveyQuestions = surveyConfig.questions;
  const [surveyAnswers, setSurveyAnswers] = useState<Record<string, string | string[]>>(
    () => existingRegs[0]?.campSurvey ?? {},
  );
  // camp_survey is no longer part of the broad loadAll read (privacy fix,
  // docs/research/2026-07-17-supabomb-scan-results.md) — existingRegs[0]
  // above never carries a prior answer any more, so fetch it on demand via
  // the scoped RPC (self-scoped: this athlete's own registration) to seed
  // the redo-registration prefill. No-op when there's nothing to prefill.
  useEffect(() => {
    if (!surveyRequired || existingRegs.length === 0) return;
    let cancelled = false;
    fetchCampSurveys(event.id).then((surveys) => {
      if (cancelled) return;
      const prior = surveys[existingRegs[0].id];
      if (prior) setSurveyAnswers(prior);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const setSurveyAnswer = (id: string, value: string | string[]) => setSurveyAnswers((a) => ({ ...a, [id]: value }));
  const toggleSurveyMultiOption = (id: string, option: string) => setSurveyAnswers((a) => {
    const cur = Array.isArray(a[id]) ? a[id] as string[] : [];
    return { ...a, [id]: cur.includes(option) ? cur.filter((x) => x !== option) : [...cur, option] };
  });

  const changeFeeApplies = !!(
    event.changeFee && new Date() >= new Date(event.changeFee.startsAt)
  );

  const hasAddons = anyAddonWindowOpen(event, new Date());

  // Called by RegistrationEditor when the athlete confirms their selections
  const handleRegSave = (regs: Registration[]) => {
    // Cross-club lock (3d): block registering under a DIFFERENT club than the one
    // this athlete is already paid-registered with. (Belt-and-suspenders for the
    // single-club case where the selector — and its disabled options — isn't shown.)
    if (lockedClubId && selectedClubId !== lockedClubId) {
      toast(`You're already registered with ${lockedClubShort} for this event — you can't register under a different club. Edit your existing registration instead.`, { variant: 'error' });
      return;
    }
    // Gate: the competing club must hold an active membership for the event's
    // season — waived for camps (event-mgmt v2 §G): a camp registrant's club
    // needn't be a member; the individual-membership check (caps.canRegister,
    // gating the "Register yourself" button) still applies to camps.
    const seasonId = seasonForDate(db, event.startDate);
    if (!clubHasActiveMembershipForEvent(db, selectedClubId, seasonId, event.eventType)) {
      const sName = db.seasons.find((s) => s.id === seasonId)?.name ?? 'this season';
      const club = db.clubs.find((c) => c.id === selectedClubId);
      toast(`${club?.shortName ?? 'Your club'} needs an active ${sName} club membership before anyone can register for this event. A club manager can purchase it on the club page.`, { variant: 'error' });
      return;
    }
    if (hasAddons) {
      setPendingRegs(regs);
      setStep('addons');
    } else if (surveyRequired) {
      setPendingRegs(regs);
      setStep('survey');
    } else {
      persistRegs(regs, []);
    }
  };

  const persistRegs = (regs: Registration[], addonItems: CartItem[]) => {
    // Camp survey answers (§G) are stored per-registration and are free to
    // change — never part of the pricing above.
    const storedSurvey = surveyRequired ? campSurveyToStored(surveyAnswers) : undefined;
    if (storedSurvey) {
      for (const r of regs) r.campSurvey = storedSurvey;
    }
    let hostFree = false;
    // Phase 3: read from the pre-write "mine" snapshot (first read of
    // registration state in this call, so no staleness relative to
    // d.registrations, which is perpetually empty in Supabase-configured mode
    // once Stage 4 lands).
    const existingForAthlete = myRegs.filter(
      (r) => r.eventId === event.id && r.athleteId === athlete.id && !r.refunded,
    );
    const applied = mutate((d) => {
      const newDiscSet = new Set(regs.map((r) => r.discipline));
      const alreadyHadRegs = existingForAthlete.length > 0;
      const competingClubId = selectedClubId;

      // Disciplines already registered for that we are KEEPING (count toward
      // "second discipline" pricing for the ones being added now).
      const priorDisciplineCount = existingForAthlete.filter((r) => newDiscSet.has(r.discipline)).length;
      // Brand-new disciplines (not previously registered).
      const addedRegs = regs.filter((r) => !existingForAthlete.some((e) => e.discipline === r.discipline));

      // Late-registration fee attachment (emv2 P0 Task 3, corrected): the
      // surcharge attaches ONLY to the line containing the athlete's
      // earliest-created reg for this event — `lateFeeAnchor` returns that
      // line's anchor or null (⇒ no surcharge on this line; the athlete's
      // FIRST entry line carried it). Once per athlete+event across repeat
      // purchases, not per discipline or per save.
      const lateAnchor = lateFeeAnchor(addedRegs, existingForAthlete, new Date().toISOString());

      // Entry total for the newly-added disciplines, host-club aware ($0 ⇒ free).
      const entryTotal = newRegistrationEntryTotal(event, {
        competingClubId,
        priorDisciplineCount,
        newDisciplineCount: addedRegs.length,
        late: lateAnchor ? { earliestCreatedAtISO: lateAnchor } : undefined,
      });
      const changeFee = changeFeeApplies && alreadyHadRegs
        ? registrationChangeFee(event, { competingClubId })
        : 0;
      hostFree = !alreadyHadRegs && entryTotal === 0;

      // Which regs get a cart-add capacity hold stamped (event-mgmt v2 P4):
      // exactly the regs referenced by a cart line pushed further below —
      // mirrors those conditions exactly so a free edit never stamps.
      const cartLinkedIds = new Set<string>();
      if (!alreadyHadRegs && entryTotal > 0) {
        for (const r of addedRegs) cartLinkedIds.add(r.id);
      }
      if (changeFee > 0) {
        for (const r of regs) cartLinkedIds.add(r.id);
      }

      // Remove dropped disciplines
      for (const old of existingForAthlete) {
        if (!newDiscSet.has(old.discipline)) {
          d.registrations = d.registrations.filter((r) => r.id !== old.id);
          deleteRegistration(old.id);
          applyLocalRegistrationRemove(old);
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
        if (cartLinkedIds.has(reg.id)) {
          reg.holdExpiresAt = holdStamp(event, event.sessions, Date.now());
        }
        const idx = d.registrations.findIndex((r) => r.id === reg.id);
        if (idx >= 0) d.registrations[idx] = reg;
        else d.registrations.push(reg);
        pushRegistration(reg);
        applyLocalRegistrationUpsert(reg);
        // camp_survey travels through its own targeted-update write (see
        // pushCampSurvey's doc comment) — never via the row upsert above.
        if (reg.campSurvey) pushCampSurvey(reg.id, reg.campSurvey);
      }

      // Synchro same-level auto-sync (B4.4): whoever actively saves a partner
      // selection sets the SY level for BOTH — not a validation, an active
      // sync. Update the local snapshot optimistically; the actual remote
      // write goes through sync_synchro_partner_level (an RPC, NOT a plain
      // upsert) because the caller typically lacks RLS write access to the
      // PARTNER's own registration row (a different athlete, often a
      // different club) — the RPC re-derives + authorizes it server-side
      // from the caller's OWN just-saved registration.
      //
      // Phase 3: the partner is a DIFFERENT athlete, so this needs the
      // by-event slice (eventRegs), not "mine" — merged with this call's own
      // writes (regs, just upserted above) via mergeUpsertedRegs so a partner
      // pairing involving a row this SAME save just touched is still found.
      const eventRegsForSync = mergeUpsertedRegs(eventRegs, regs).filter((r) => r.eventId === event.id && !r.refunded);
      for (const reg of regs) {
        const partnerUpdate = syncSynchroPartnerLevel(eventRegsForSync, reg);
        const mySyLevel = reg.apparatusLevels?.SY;
        if (partnerUpdate && mySyLevel) {
          const idx = d.registrations.findIndex((r) => r.id === partnerUpdate.id);
          if (idx >= 0) d.registrations[idx] = partnerUpdate;
          syncSynchroPartnerLevelRemote(reg.id, mySyLevel);
          applyLocalRegistrationUpsert(partnerUpdate);
        }
      }

      // Cart: entry / change fee for new or re-pending registrations.
      const cart = d.carts[athlete.id] ?? (d.carts[athlete.id] = []);

      if (!alreadyHadRegs && entryTotal > 0) {
        const lateSuffix = lateAnchor !== null && lateFeeApplies(event, lateAnchor) ? ' (incl. late fee)' : '';
        // Add-on + survey answers summarized on the athlete's line item (§G).
        const ADDON_TYPE_LABELS: Record<string, string> = { tshirt: 'shirt', leo: 'leotard', banquet: 'banquet', banner: 'banner' };
        const addonSummary = addonItems
          .map((it) => (it.refLineType ? ADDON_TYPE_LABELS[it.refLineType] ?? it.refLineType : null))
          .filter((v): v is string => !!v)
          .join(', ');
        const surveySummary = storedSurvey ? campSurveySummary(storedSurvey, surveyQuestions) : '';
        const summarySuffix = [addonSummary, surveySummary].filter(Boolean).join('; ');
        // Camps ask nothing discipline-related — no "(MAG)"/"(MAG+WAG)"
        // parenthetical on the cart label (PM feedback 2026-07-23).
        const discParen = event.eventType === 'camp' ? '' : ` (${addedRegs.map((r) => r.discipline).join('+')})`;
        cart.push({
          id: `ci-self-${Date.now()}-${athlete.id}`,
          label: `${event.name} entry — ${athlete.firstName} ${athlete.lastName}${discParen}${lateSuffix}${summarySuffix ? ` [${summarySuffix}]` : ''}`,
          amount: entryTotal,
          kind: 'meet-entry',
          refUserId: athlete.id,
          refRegIds: addedRegs.map((r) => r.id),
          refEventId: event.id,
          refLineType: 'entry',
        });
      }
      if (changeFee > 0) {
        cart.push({
          id: `ci-change-${Date.now()}-${athlete.id}`,
          label: `${event.name} change fee — ${athlete.firstName} ${athlete.lastName}`,
          amount: changeFee,
          kind: 'meet-entry',
          refUserId: athlete.id,
          refRegIds: regs.map((r) => r.id),
          refEventId: event.id,
          refLineType: 'change',
        });
      }

      // Add-on cart items (one line per unit — per-unit add-on model, Phase 2)
      for (const item of addonItems) {
        cart.push(item);
      }

      pushCart(athlete.id, cart, false);
      // No client-side invoice stub: the cart is the pre-payment source of truth and
      // the Stripe webhook writes the authoritative paid invoice on fulfillment.
      // (The old stub reused cart-item ids as invoice_items PKs, colliding across
      // registrations — `invoice_items_pkey` duplicate-key error.)
    });
    if (!applied) return; // offline read-only gate — no false success toast

    toast(
      hostFree
        ? 'Registration complete — no entry fee for your host club.'
        : changeFeeApplies
          ? 'Registration updated. Change fee added to your cart.'
          : 'Registration saved! Check your cart to complete payment.',
    );
    onClose();
    // Always land on the cart so the member can complete payment (both the add-on
    // and no-add-on paths funnel through here).
    navigate('/cart');
  };

  const handleAddons = () => {
    if (!pendingRegs) return;
    if (!addonDraftValid(event, addonDraft, new Date())) {
      toast('Choose a shirt/leotard option ("No shirt"/"No leotard" if you don\'t want one) before continuing.', { variant: 'error' });
      return;
    }
    const items = buildAddonCartItems(event, athlete, addonDraft, Date.now());
    if (surveyRequired) {
      setPendingAddonItems(items);
      setStep('survey');
    } else {
      persistRegs(pendingRegs, items);
    }
  };

  // Survey questions come LAST in the popup (§G), after add-ons.
  const handleSurvey = () => {
    if (!pendingRegs) return;
    if (!campSurveyAnswersValid(surveyAnswers, surveyQuestions)) {
      toast('Answer every required survey question before continuing.', { variant: 'error' });
      return;
    }
    persistRegs(pendingRegs, pendingAddonItems);
  };

  const title = step === 'reg'
    ? `Register for ${event.name}`
    : step === 'addons'
      ? `Add-ons — ${event.name}`
      : `Overnight accommodations — ${event.name}`;

  return (
    <Modal title={title} onClose={onClose}>
      {/* Club selector (only if athlete has >1 affiliated club) */}
      {step === 'reg' && myClubs.length > 1 && (
        <Field label="Compete for" hint="Choose which club you will compete under at this event.">
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
              Already registered with {lockedClubShort} for this event — you can only edit that registration.
            </p>
          )}
        </Field>
      )}

      {step === 'reg' && regsStatus === 'loading' && <p>Loading…</p>}
      {step === 'reg' && regsStatus !== 'loading' && (
        <RegistrationEditor
          event={event}
          athlete={athlete}
          clubId={selectedClubId}
          existing={existingRegs}
          allAthletes={db.people.filter((p) => p.kind === 'athlete')}
          levels={db.levels}
          season={season}
          onSave={handleRegSave}
          onCancel={onClose}
          changeFeeApplies={changeFeeApplies}
          incomingPartnerId={findIncomingSynchroPartner(eventRegs, event.id, athlete.id)?.athleteId ?? null}
          incomingPartnerSyLevel={(() => {
            const r = findIncomingSynchroPartner(eventRegs, event.id, athlete.id);
            return r ? (r.apparatusLevels?.SY ?? r.levelId) : null;
          })()}
          allEventRegs={eventRegs.filter((r) => !r.refunded)}
          waitlistGroups={db.waitlistGroups?.filter((g) => g.eventId === event.id) ?? []}
        />
      )}

      {step === 'addons' && (
        <div>
          <p style={{ fontSize: 14, color: 'var(--ink-soft)', marginBottom: 14 }}>
            Optional add-ons for this event.
          </p>

          <AddonSection
            event={event}
            athlete={athlete}
            mode="registration"
            draft={addonDraft}
            onChange={setAddonDraft}
            existingCart={db.carts[athlete.id] ?? []}
            fmtDate={fmtDate}
          />

          <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
            <button className="btn primary" onClick={handleAddons} disabled={!addonDraftValid(event, addonDraft, new Date())}>
              {surveyRequired ? 'Continue' : 'Continue to cart'}
            </button>
          </div>
        </div>
      )}

      {step === 'survey' && (
        <div>
          <p style={{ fontSize: 14, color: 'var(--ink-soft)', marginBottom: 14 }}>
            A few questions for {athlete.firstName}. You can update these answers any time before the
            event's edit deadline.
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {surveyQuestions.map((q) => {
              const value = surveyAnswers[q.id];
              if (q.type === 'text') {
                return (
                  <Field key={q.id} label={q.required ? q.label : `${q.label} (optional)`} required={q.required}>
                    <input
                      className="input"
                      value={typeof value === 'string' ? value : ''}
                      onChange={(e) => setSurveyAnswer(q.id, e.target.value)}
                    />
                  </Field>
                );
              }
              if (q.type === 'single') {
                return (
                  <Field key={q.id} label={q.required ? q.label : `${q.label} (optional)`} required={q.required}>
                    <select
                      className="input"
                      value={typeof value === 'string' ? value : ''}
                      onChange={(e) => setSurveyAnswer(q.id, e.target.value)}
                    >
                      <option value="" disabled>— select —</option>
                      {(q.options ?? []).map((opt) => (
                        <option key={opt} value={opt}>{campSurveyAnswerLabel(q.id, opt)}</option>
                      ))}
                    </select>
                  </Field>
                );
              }
              const selected = Array.isArray(value) ? value : [];
              return (
                <Field key={q.id} label={q.required ? q.label : `${q.label} (optional)`} required={q.required}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {(q.options ?? []).map((opt) => (
                      <label key={opt} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 14 }}>
                        <input
                          type="checkbox"
                          checked={selected.includes(opt)}
                          onChange={() => toggleSurveyMultiOption(q.id, opt)}
                        />
                        {campSurveyAnswerLabel(q.id, opt)}
                      </label>
                    ))}
                  </div>
                </Field>
              );
            })}
          </div>

          <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
            <button className="btn primary" onClick={handleSurvey} disabled={!campSurveyAnswersValid(surveyAnswers, surveyQuestions)}>
              Continue to cart
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// exportCsv helpers (unchanged from original)
// ---------------------------------------------------------------------------

// Phase 3 (data-layer-scale): async now — registrations are no longer
// globally hydrated, so this is a one-off scoped fetch (fetchEventRegistrationsOnce)
// rather than a `db.registrations` filter (mirrors exportScoresCsv below,
// which made the same change for scores in Phase 2).
async function exportCsv(db: ReturnType<typeof useDB>, event: Event) {
  // Spec: "just export all the things and let the user trim". Includes
  // refunded-but-kept regs (`keepListed`, event-mgmt v2 Phase 3 spec §H —
  // "name still appears in event materials" for a post-edit-deadline refund);
  // a pre-deadline refund deletes its row outright and is naturally absent.
  const eventRegs = await fetchEventRegistrationsOnce(event.id);
  const rows = [['Athlete', 'Club', 'Discipline', 'Level', 'Session', 'Events', 'Shirt', 'Dietary', 'Email', 'Phone', 'Emergency contact', 'Student', 'Region']];
  for (const r of eventRegs.filter((x) => x.eventId === event.id && (!x.refunded || x.keepListed))) {
    const a = db.people.find((p) => p.id === r.athleteId)!;
    const club = db.clubs.find((c) => c.id === r.clubId)!;
    rows.push([
      `${a.firstName} ${a.lastName}`, club.name, r.discipline,
      db.levels.find((l) => l.id === r.levelId)?.name ?? '',
      event.sessions.find((s) => s.id === r.sessionId)?.name ?? '',
      r.apparatus.join('|'), a.shirt, a.dietary.join('|'), a.email, a.phone,
      `${a.emergency.contact} ${a.emergency.phone}`, a.studentStatus, club.region,
    ]);
  }
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  downloadCsv(csv, `${event.slug}-export.csv`);
}

/** Scores export — includes the captured calculator state so verification has
 *  the full breakdown of how every score was built. Async (Phase 2, docs/specs/
 *  2026-07-24-data-layer-scale.md): scores are no longer globally hydrated, so
 *  this is a one-off scoped fetch rather than a `db.scores` filter. */
async function exportScoresCsv(db: ReturnType<typeof useDB>, event: Event) {
  const [scores, eventRegs] = await Promise.all([fetchEventScoresOnce(event.id), fetchEventRegistrationsOnce(event.id)]);
  const rows = [['Athlete', 'Club', 'Session', 'Event', 'Level', 'D/SV', 'Deductions', 'E-score', 'Final', 'Source', 'Calculator', 'Entered by', 'Entered at', 'Adjusted at', 'Adjust note', 'Calculator state (JSON)']];
  for (const s of scores) {
    const reg = eventRegs.find((r) => r.id === s.regId);
    const a = reg && db.people.find((p) => p.id === reg.athleteId);
    const club = reg && db.clubs.find((c) => c.id === reg.clubId);
    const session = event.sessions.find((x) => x.id === s.sessionId);
    rows.push([
      a ? `${a.firstName} ${a.lastName}` : s.regId, club?.name ?? '', session?.name ?? '', s.apparatus,
      db.levels.find((l) => l.id === reg?.levelId)?.name ?? '',
      s.sv ?? '', s.deductions ?? '', s.eScore ?? '', s.final ?? '',
      s.source ?? 'manual', s.calc ?? '', s.enteredBy, s.enteredAt,
      s.adjustedAt ?? '', s.adjustNote ?? '',
      s.calcState ? JSON.stringify(s.calcState) : '',
    ].map(String));
  }
  const csv = rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(',')).join('\n');
  downloadCsv(csv, `${event.slug}-scores.csv`);
}

function downloadCsv(csv: string, filename: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = filename;
  a.click();
}

// ---------------------------------------------------------------------------
// EventManage: sessions & squads (unchanged logic, updated imports)
// ---------------------------------------------------------------------------
export function EventManage() {
  const { slug } = useParams();
  const db = useDB();
  const caps = useCapabilities();
  const event = db.events.find((m) => m.slug === slug);
  const [sessionId, setSessionId] = useState(event?.sessions[0]?.id ?? '');
  if (!event) return <p>Event not found.</p>;
  const session = event.sessions.find((s) => s.id === sessionId) ?? event.sessions[0];
  const canScore = caps.isEventHost(event.id) || caps.isSanctioning;

  return (
    <div>
      <h1 className="page-title display">Manage — {event.name}</h1>
      <p className="page-sub">Build squads per session, copy a squad setup to other sessions, and save everything at once. New athletes land in the Holding squad until placed.</p>
      {canScore && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
          <Link className="btn primary" to={`/judge?event=${event.id}`}>Score entry →</Link>
          <Link className="btn ghost" to={`/results/${event.slug}`}>Live results</Link>
        </div>
      )}
      <Tabs
        tabs={event.sessions.map((s) => ({ id: s.id, label: s.name.split('—')[0].trim() }))}
        active={session.id}
        onChange={setSessionId}
      />
      <SquadBuilder event={event} session={session} />
    </div>
  );
}

function SquadBuilder({ event, session }: { event: Event; session: EventSession }) {
  const db = useDB();
  const toast = useToast();
  // Phase 3 (data-layer-scale): reads the by-event slice instead of
  // db.registrations. pushEventSessions needs the FULL by-event set (it
  // derives squad_id placements for every session, not just this one) — see
  // the eventRegs usages below, which replace `d.registrations` inside the
  // mutate() blocks for exactly that reason (d.registrations is no longer
  // populated once Stage 4 removes registrations from loadAll).
  const { rows: eventRegs, status: regsStatus } = useEventRegistrations(event.id);
  const regs = eventRegs.filter((r) => r.sessionId === session.id && !r.refunded);
  const events = APPARATUS[session.discipline];
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
    const applied = mutate((d) => {
      const m = d.events.find((x) => x.id === event.id)!;
      const s = m.sessions.find((x) => x.id === session.id)!;
      s.squads = Array.from({ length: n }, (_, i) => ({
        id: `${s.id}-q${i + 1}`, name: `Squad ${String.fromCharCode(65 + i)}`,
        startEvent: Math.floor((i * events.length) / n) % events.length,
        athleteRegIds: [],
      }));
      regs.forEach((r, i) => s.squads[i % n].athleteRegIds.push(r.id));
      pushEventSessions(m, eventRegs);
    });
    if (!applied) return; // offline read-only gate — no false success toast
    toast(`Split ${regs.length} athletes into ${n} squads. Adjust then Save.`);
  };

  const copyToOthers = () => {
    const applied = mutate((d) => {
      const m = d.events.find((x) => x.id === event.id)!;
      for (const s of m.sessions) {
        if (s.id === session.id || s.discipline !== session.discipline) continue;
        const sregs = eventRegs.filter((r) => r.sessionId === s.id && !r.refunded);
        const n = Math.max(1, session.squads.filter((q) => !q.holding).length);
        s.squads = Array.from({ length: n }, (_, i) => ({
          id: `${s.id}-q${i + 1}`, name: `Squad ${String.fromCharCode(65 + i)}`,
          startEvent: session.squads[i]?.startEvent ?? 0,
          athleteRegIds: [],
        }));
        sregs.forEach((r, i) => s.squads[i % n].athleteRegIds.push(r.id));
      }
      pushEventSessions(m, eventRegs);
    });
    if (!applied) return; // offline read-only gate — no false success toast
    toast('Squad setup copied to other ' + session.discipline + ' sessions.');
  };

  const move = (regId: string, toSquadId: string | 'holding') => {
    mutate((d) => {
      const m = d.events.find((x) => x.id === event.id)!;
      const s = m.sessions.find((x) => x.id === session.id)!;
      for (const q of s.squads) q.athleteRegIds = q.athleteRegIds.filter((id) => id !== regId);
      if (toSquadId !== 'holding') s.squads.find((q) => q.id === toSquadId)!.athleteRegIds.push(regId);
      pushEventSessions(m, eventRegs);
    });
  };

  const defaults = session.discipline === 'MAG' ? [2, 3, 6] : session.discipline === 'WAG' ? [4, 8] : [2, 3];

  if (regsStatus === 'loading') return <p style={{ fontSize: 13, color: 'var(--ink-soft)' }}>Loading registrations…</p>;

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
          {holding.length === 0 && <p style={{ color: 'var(--teal-900)', fontWeight: 600, fontSize: 13.5 }}>✓ Everyone placed</p>}
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
