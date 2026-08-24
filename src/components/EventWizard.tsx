import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { mutate, useDB } from '../lib/store';
import { pushEvent } from '../lib/supabase';
import { useCapabilities } from '../lib/capabilities';
import { useEventRegistrations } from '../lib/registrations-slice';
import { scaffoldNationalsConfig } from '../lib/nationals-adapter';
import { toDatetimeLocalValue, scoringConfigOf, assignSessionIds } from '../lib/events-core';
import { eventCreationBlocked } from '../lib/season-lifecycle';
import { buildNationalsSessions, singleLeagueHostClubId } from '../lib/ucg-event-templates';
import { normalizeExternalUrl } from '../lib/url';
import { campSurveyQuestionsOf } from '../lib/pricing';
import { capacityUsage } from '../lib/capacity';
import {
  capacityConfigFromDraft,
  capacityDraftFromEvent,
  validateCapacityDraft,
  type CapacityDraft,
  type DisciplineCapacityDraft,
} from '../lib/capacity-draft';
import { Combo, Field, Modal } from './ui';
import { useToast } from './ui-hooks';
import { APPARATUS, DISCIPLINES, SHIRT_SIZES, STATE_REGIONS } from '../lib/types';
import { timezoneForState } from '../lib/timezone';
import type { CampSurveyQuestion, Discipline, Level, Event, EventSession, EventStatus, ScoringConfig } from '../lib/types';

// Capacity input unit — currently "routines" (apparatus entries, the P4
// semantic `capacity.ts` enforces: one athlete on 4 apparatus counts as 4).
// The owners are separately deciding whether they'd rather cap athletes
// instead (2026-08-24) — every capacity-unit string in this file is routed
// through these two constants so that decision is a one-line change.
const CAPACITY_UNIT_LABEL = 'routines';
const CAPACITY_UNIT_HINT = 'One athlete on 4 apparatus counts as 4.';

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
  /** The persisted `EventSession.id` this draft was loaded from — absent for
   *  a brand-new session (added via "+ Add session" or a discipline toggle),
   *  which gets a freshly-minted id at save time. MUST follow the draft
   *  across reorders/adds/removes (never re-derived from the draft's
   *  position in `sessions`) — see the save-time id assignment below and
   *  `diffSessions` (events-core.ts) for why (UAT Z-06). */
  id?: string;
  discipline: Discipline;
  label: string;
  date: string;
  time: string;
  levelIds: string[];
  phase: 'prelim' | 'final';
  /** Per-apparatus routine cap input values (event-mgmt v2 P4 T4); blank = uncapped. */
  maxRoutines: Record<string, string>;
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
    maxRoutines: {},
  }));
}

/**
 * Derive SessionDraft[] from existing EventSession[] for editing. Keys are
 * assigned by index (1..N) rather than from the component's keyRef, so this can
 * run as initial state without reading a ref during render; the caller seeds the
 * key counter to N+1 so later nextKey() calls don't collide.
 *
 * `keepIds` carries the real `EventSession.id` over (UAT Z-06) — it is the
 * ONLY thing that ties a draft back to its persisted row once the admin
 * starts reordering/adding/removing; the array position can't be trusted
 * (that was exactly the bug: the old save-time code used
 * `editEvent.sessions[i]?.id`, matching by CURRENT index, which reassigns
 * ids to the wrong session under any reorder or an add/remove that isn't at
 * the end). Pass `false` — a CREATE seeded from a template's own `sessions`
 * (not `editEvent`) — to load every OTHER field from the template but start
 * every draft with no `id`, exactly like a brand-new session: an id from a
 * template is either absent today or, if a future template ever populated
 * one, could belong to some OTHER real event's session — saving under it
 * verbatim would silently upsert onto (and steal) that event's row via
 * `event_sessions`' primary key. `isEdit` is the caller's only signal for
 * which case this is; sessionsTodrafts has no other way to tell.
 */
function sessionsTodrafts(sessions: EventSession[], keepIds: boolean): SessionDraft[] {
  return sessions.map((s, i) => {
    // Strip the "Session N — " prefix from the stored name
    const label = s.name.replace(/^Session \d+ — /, '');
    return {
      key: i + 1,
      ...(keepIds ? { id: s.id } : {}),
      discipline: s.discipline,
      label,
      date: s.date,
      time: s.time,
      levelIds: s.levelIds,
      phase: (s.phase ?? 'prelim') as 'prelim' | 'final',
      maxRoutines: Object.fromEntries(
        Object.entries(s.maxRoutines ?? {}).map(([code, n]) => [code, String(n)]),
      ),
    };
  });
}

// Camp registrant-survey question editor draft (PM requirement 2026-07-23:
// replaces the old fixed 4-question survey with an admin-authored list).
// `key` is a stable React key (assigned via a keyRef counter, same idiom as
// SessionDraft above — never Date.now()-per-render); `id` is the STORED
// answer key and is preserved across edits so re-saving an existing camp
// doesn't orphan already-collected answers under a new id. `optionsText` is
// the raw one-option-per-line textarea value for single/multi questions.
interface SurveyQuestionDraft {
  key: number;
  id: string;
  label: string;
  type: 'text' | 'single' | 'multi';
  optionsText: string;
  required: boolean;
}

function surveyQuestionsToDrafts(questions: CampSurveyQuestion[], nextKey: () => number): SurveyQuestionDraft[] {
  return questions.map((q) => ({
    key: nextKey(), id: q.id, label: q.label, type: q.type,
    optionsText: (q.options ?? []).join('\n'), required: q.required,
  }));
}

/** Drafts → the `CampSurveyQuestion[]` saved onto `campConfig.survey`. Drops
 *  any question left with a blank label (an abandoned "+ Add question" row);
 *  options are split on newlines, trimmed, and blank lines dropped. */
function draftsToSurveyQuestions(drafts: SurveyQuestionDraft[]): CampSurveyQuestion[] {
  return drafts
    .filter((d) => d.label.trim())
    .map((d) => ({
      id: d.id,
      label: d.label.trim(),
      type: d.type,
      required: d.required,
      ...(d.type !== 'text' ? { options: d.optionsText.split('\n').map((s) => s.trim()).filter(Boolean) } : {}),
    }));
}

// Nationals create-mode "Sessions × Gyms" drafts (PM feedback 2026-07-22 §C).
// Session slot names are auto-assigned "Session N" on save; gyms carry their
// own name/discipline/levels. Both cross-product into EventSession[] via
// `buildNationalsSessions` at submit time.
interface NationalsSlotDraft {
  key: number;
  date: string;
  time: string;
}
interface NationalsGymDraft {
  key: number;
  name: string;
  discipline: Discipline;
  levelIds: string[];
}

function defaultNationalsSlots(date: string, nextKey: () => number): NationalsSlotDraft[] {
  return ['08:00', '11:00', '14:00', '17:00'].map((time) => ({ key: nextKey(), date, time }));
}

// Masters is intentionally excluded everywhere (PM requirement) — Orange
// (MAG) explicitly drops it; Yellow (WAG) simply never includes it.
function defaultNationalsGyms(levels: Level[], nextKey: () => number): NationalsGymDraft[] {
  const idsFor = (ids: string[]) => levels.filter((l) => ids.includes(l.id) && !l.retired).map((l) => l.id);
  const magExceptMasters = levels.filter((l) => l.discipline === 'MAG' && !l.retired && l.id !== 'mag-masters').map((l) => l.id);
  const tntAll = levels.filter((l) => l.discipline === 'TNT' && !l.retired).map((l) => l.id);
  return [
    { key: nextKey(), name: 'Orange', discipline: 'MAG' as const, levelIds: magExceptMasters },
    { key: nextKey(), name: 'Red', discipline: 'WAG' as const, levelIds: idsFor(['wag-diamond']) },
    { key: nextKey(), name: 'Green', discipline: 'WAG' as const, levelIds: idsFor(['wag-plat']) },
    { key: nextKey(), name: 'Yellow', discipline: 'WAG' as const, levelIds: idsFor(['wag-silver', 'wag-l9', 'wag-open']) },
    { key: nextKey(), name: 'Purple', discipline: 'TNT' as const, levelIds: tntAll },
  ];
}

// Nationals create-mode default finals levels (PM feedback 2026-07-22 §B):
// MAG Intermediate/Advanced, WAG Platinum/Diamond/Level 9 — the seed.ts ids.
const NATIONALS_DEFAULT_FINALS_LEVEL_IDS = ['mag-int', 'mag-adv', 'wag-plat', 'wag-diamond', 'wag-l9'];

interface EventWizardProps {
  onClose: () => void;
  /** When provided, the wizard edits this event rather than creating a new one. */
  editEvent?: Event;
  /** When provided (and `editEvent` is absent), prefills every field from this
   *  partial event the same way `editEvent` does, but SAVES AS CREATE (a
   *  brand-new event, not an update) — the FlipFest/Nationals "Create" flow
   *  (`src/lib/ucg-event-templates.ts`, `src/pages/admin/UcgEvent.tsx`).
   *  Mutually exclusive with `editEvent` (editEvent wins if both are passed). */
  template?: Partial<Event>;
  /** 'page' renders the same form inline in the page flow (heading + Cancel,
   *  no Modal overlay) — used for the Nationals create/edit-details flows
   *  (PM feedback 2026-07-22 §A). Default 'modal' is unchanged for every
   *  other caller. */
  variant?: 'modal' | 'page';
}

export function EventWizard({ onClose, editEvent, template, variant = 'modal' }: EventWizardProps) {
  const db = useDB();
  const caps = useCapabilities();
  const toast = useToast();
  const navigate = useNavigate();
  // `seedEvt` feeds every field initializer below (like `editEvent` alone
  // used to) whether we're editing a real event or prefilling from a
  // FlipFest/Nationals template on create; `isEdit`/save-mode stays keyed on
  // `editEvent` alone.
  const seedEvt = editEvent ?? (template as Event | undefined);
  const isEdit = !!editEvent;
  // FlipFest/Nationals events pin their own timezone and kind — the admin
  // never picks either (spec 2026-07-20 §FlipFest/Nationals model).
  const isUcgHosted = !!seedEvt?.ucgHosted;
  // Nationals CREATE only (never edit — reconstructing slots×gyms from
  // arbitrary existing sessions is lossy, PM feedback 2026-07-22 §C): drives
  // both the create-mode defaults (§B) and the Sessions×Gyms UI (§C).
  const isNationalsCreate = !editEvent && template?.ucgHosted === 'nationals';
  // A UCG-nationals event edited while its `sessions` are still empty — i.e.
  // it was published "Dates and Location Only" (two-tier publish model, PM
  // feedback 2026-07-23) — ALSO gets the slots×gyms UI, otherwise there'd be
  // no path to author sessions after a dates-only publish. An edited event
  // WITH sessions keeps the classic per-session cards. Deliberately separate
  // from `isNationalsCreate`, which stays CREATE-only so editing a
  // dates-only event doesn't re-force its create-mode defaults (checkboxes,
  // finals levels, judge panels) over already-saved values.
  const useGymsUi = isNationalsCreate || (isEdit && seedEvt?.ucgHosted === 'nationals' && (seedEvt?.sessions?.length ?? 0) === 0);
  // Two-tier publish model applies only to the UCG-hosted Nationals
  // full-page wizard (FlipFest and normal sanctioned events keep the single
  // "Sanction event"/"Save changes" button).
  const isNationalsUcgWizard = variant === 'page' && seedEvt?.ucgHosted === 'nationals';

  const defaultStart = addDays(new Date().toISOString().slice(0, 10), 60);
  const seedStartDate = seedEvt?.startDate ?? defaultStart;
  // Initial sessions: a real event's (edit) or template's own sessions if it
  // provided any; else, for a template that only specifies disciplines (e.g.
  // Nationals), fall back to the same per-discipline default-session
  // templates `toggleDiscipline` uses below. Keys are 1..N (no ref read
  // during render); the key counter starts at N+1 so later additions don't collide.
  // Camps are session-less entirely (PM feedback 2026-07-22): never build
  // default per-discipline sessions for them, even though the template seeds
  // `disciplines` (that field only drives the equipment-availability picker
  // for camps now, not a session builder).
  const initialSessions: SessionDraft[] = seedEvt?.eventType === 'camp'
    ? []
    : seedEvt?.sessions?.length
      ? sessionsTodrafts(seedEvt.sessions, isEdit)
      : (() => {
          let key = 1;
          return (seedEvt?.disciplines ?? []).flatMap((d) => defaultSessions(db.levels, d, seedStartDate, () => key++));
        })();
  const keyRef = useRef(initialSessions.length + 1);
  const nextKey = () => keyRef.current++;

  // Nationals (admin only): adds prelim/finals phases + qualification config.
  const [kind, setKind] = useState<'standard' | 'nationals'>(seedEvt?.kind ?? 'standard');
  const [finalsLevelIds, setFinalsLevelIds] = useState<string[]>(
    seedEvt?.nationalsConfig?.finalsLevelIds ?? (isNationalsCreate ? NATIONALS_DEFAULT_FINALS_LEVEL_IDS : []),
  );

  // Basics
  const [name, setName] = useState(seedEvt?.name ?? '');
  const [hostClubId, setHostClubId] = useState<string | null>(seedEvt?.hostClubId ?? null);
  const [city, setCity] = useState(seedEvt?.city ?? '');
  const [state, setState] = useState(seedEvt?.state ?? '');
  // Location detail (event-mgmt v2 §A)
  const [venue, setVenue] = useState(seedEvt?.venue ?? '');
  const [streetAddress, setStreetAddress] = useState(seedEvt?.streetAddress ?? '');
  const [country, setCountry] = useState(seedEvt?.country ?? 'United States');
  // Timezone is derived from location, not user-selected (2026-07-20). An
  // existing event keeps its stored zone until the admin changes the state,
  // which recomputes it for consistency going forward. FlipFest/Nationals
  // events are always America/Los_Angeles regardless of venue state.
  const [timezone, setTimezone] = useState(
    seedEvt?.timezone ?? (isUcgHosted ? 'America/Los_Angeles' : timezoneForState(state, seedEvt?.country ?? 'United States')),
  );
  const [hotelLink, setHotelLink] = useState(seedEvt?.hotelLink ?? '');
  // Dates
  const [startDate, setStartDate] = useState(seedEvt?.startDate ?? defaultStart);
  const [endDate, setEndDate] = useState(seedEvt?.endDate ?? defaultStart);
  // Stored reg dates are timestamptz columns (return with seconds + a 'Z'),
  // which datetime-local can't render — normalize to YYYY-MM-DDTHH:MM so the
  // edit wizard shows (and round-trips) them instead of blanking the field.
  const [regOpens, setRegOpens] = useState(seedEvt?.regOpens ? toDatetimeLocalValue(seedEvt.regOpens) : `${new Date().toISOString().slice(0, 10)}T12:00`);
  const [regCloses, setRegCloses] = useState(seedEvt?.regCloses ? toDatetimeLocalValue(seedEvt.regCloses) : `${addDays(defaultStart, -14)}T23:59`);
  const regClosesDirty = useRef(isEdit);
  // Last date to edit (B4): optional edit-lockout, past which only an admin
  // or the event's host club may still edit a registration.
  const [hasEditLockout, setHasEditLockout] = useState(!!seedEvt?.lastDateToEdit || isNationalsCreate);
  const [lastDateToEdit, setLastDateToEdit] = useState(seedEvt?.lastDateToEdit ? toDatetimeLocalValue(seedEvt.lastDateToEdit) : `${addDays(defaultStart, -7)}T23:59`);
  // Finals lineup deadline (event-mgmt v2 P5 §L.3, nationals only): scheduled-dispatch
  // nags club managers at/after this instant and hard-locks finals rosters 1h later.
  const [hasFinalsDeadline, setHasFinalsDeadline] = useState(!!seedEvt?.finalsLineupDeadlineAt || isNationalsCreate);
  const [finalsLineupDeadlineAt, setFinalsLineupDeadlineAt] = useState(seedEvt?.finalsLineupDeadlineAt ? toDatetimeLocalValue(seedEvt.finalsLineupDeadlineAt) : `${addDays(defaultStart, -1)}T21:00`);
  // Age-calculation date (event-mgmt v2 §A): applies to all events, not just camps.
  const [hasAgeCalcAt, setHasAgeCalcAt] = useState(!!seedEvt?.ageCalcAt);
  const [ageCalcAt, setAgeCalcAt] = useState(seedEvt?.ageCalcAt ? toDatetimeLocalValue(seedEvt.ageCalcAt) : `${defaultStart}T00:00`);
  // Fees
  const [entryFee, setEntryFee] = useState(String(seedEvt?.entryFee ?? 60));
  const [secondFee, setSecondFee] = useState(String(seedEvt?.secondDisciplineFee ?? 30));
  // Banquet — defaults ON for Nationals create (PM feedback 2026-07-22 §B).
  const [hasBanquet, setHasBanquet] = useState(!!seedEvt?.banquet || isNationalsCreate);
  const [banquetName, setBanquetName] = useState(seedEvt?.banquet?.name ?? 'Banquet');
  const [banquetPrice, setBanquetPrice] = useState(String(seedEvt?.banquet?.price ?? 45));
  const [banquetLastPurchaseAt, setBanquetLastPurchaseAt] = useState(seedEvt?.banquet?.lastPurchaseAt ?? '');
  // T-shirt add-on — defaults ON for Nationals create.
  const [hasTshirt, setHasTshirt] = useState(!!seedEvt?.tshirtAddon || isNationalsCreate);
  const [tshirtPrice, setTshirtPrice] = useState(String(seedEvt?.tshirtAddon?.price ?? 25));
  const [tshirtSizes, setTshirtSizes] = useState<string[]>(seedEvt?.tshirtAddon?.sizes ?? [...SHIRT_SIZES]);
  const [tshirtLastPurchaseAt, setTshirtLastPurchaseAt] = useState(seedEvt?.tshirtAddon?.lastPurchaseAt ?? '');
  // Banner add-on — defaults ON for Nationals create.
  const [hasBanner, setHasBanner] = useState(!!seedEvt?.bannerAddon || isNationalsCreate);
  const [bannerPrice, setBannerPrice] = useState(String(seedEvt?.bannerAddon?.price ?? 30));
  const [bannerLastPurchaseAt, setBannerLastPurchaseAt] = useState(seedEvt?.bannerAddon?.lastPurchaseAt ?? '');
  // Change fee — defaults ON for Nationals create.
  const [hasChangeFee, setHasChangeFee] = useState(!!seedEvt?.changeFee || isNationalsCreate);
  const [changeFeeAmount, setChangeFeeAmount] = useState(String(seedEvt?.changeFee?.amount ?? 15));
  const [changeFeeStartsAt, setChangeFeeStartsAt] = useState(
    seedEvt?.changeFee?.startsAt ?? `${addDays(defaultStart, -21)}T00:00`,
  );
  // Late registration (event-mgmt v2 §A): fee is added ON TOP of the entry fee.
  const [hasLateReg, setHasLateReg] = useState(!!seedEvt?.lateReg || isNationalsCreate);
  const [lateRegStartsAt, setLateRegStartsAt] = useState(
    seedEvt?.lateReg?.startsAt ?? `${addDays(defaultStart, -14)}T00:00`,
  );
  const [lateRegFee, setLateRegFee] = useState(String(seedEvt?.lateReg?.fee ?? 20));
  // Director contact (event-mgmt v2 §A): general to competitions + camps.
  const [directorName, setDirectorName] = useState(seedEvt?.director?.name ?? '');
  const [directorEmail, setDirectorEmail] = useState(seedEvt?.director?.email ?? '');
  const [directorCc, setDirectorCc] = useState(seedEvt?.director?.ccOnConfirmation ?? false);
  // Capacity (capacity rework, 2026-08-24 — T2): per-discipline draft editor,
  // enforced server-side at checkout (src/lib/capacity.ts mirrored in
  // supabase/functions/_shared/capacity.ts). The old event-wide `total`
  // (athlete) cap is gone outright (T1) — `legacyTotal` below is read
  // straight off the RAW stored value (never normalized, since
  // `normalizeCapacity` drops `total` on purpose) and used ONLY to drive the
  // one-time migration notice; it never feeds back into the draft or the save.
  const legacyTotal = seedEvt?.capacity?.total ?? null;
  const [legacyCapNoticeDismissed, setLegacyCapNoticeDismissed] = useState(false);
  // Seeded for all three disciplines (not just the event's currently-selected
  // ones) so toggling a discipline off and back on doesn't lose whatever the
  // admin already typed for it.
  const [capacityDraft, setCapacityDraft] = useState<CapacityDraft>(
    () => capacityDraftFromEvent(seedEvt?.capacity, DISCIPLINES),
  );
  const updateCapacityDraft = (d: Discipline, patch: Partial<DisciplineCapacityDraft>) => {
    setCapacityDraft((prev) => ({
      ...prev,
      [d]: { ...(prev[d] ?? { mode: 'none', cap: '', perLevel: {} }), ...patch },
    }));
  };
  // Confirmation email override (event-mgmt v2 §A)
  const [hasConfirmationEmail, setHasConfirmationEmail] = useState(!!seedEvt?.confirmationEmail || isNationalsCreate);
  const [confirmationBodyHtml, setConfirmationBodyHtml] = useState(seedEvt?.confirmationEmail?.bodyHtml ?? '');
  const [confirmationFromAlias, setConfirmationFromAlias] = useState(seedEvt?.confirmationEmail?.fromAlias ?? '');
  // UCG-hosted CREATE only (PM feedback 2026-07-22): prefill the reply-to with
  // the general-questions address when the seed/template didn't set one. An
  // edit of an existing event keeps whatever it already has (incl. blank).
  const [confirmationReplyTo, setConfirmationReplyTo] = useState(
    seedEvt?.confirmationEmail?.replyTo ?? (isUcgHosted && !isEdit ? 'info@unitedgymnastics.org' : ''),
  );
  const [confirmationPreview, setConfirmationPreview] = useState(false);
  // Disciplines & sessions
  const [disciplines, setDisciplines] = useState<Discipline[]>(seedEvt?.disciplines ?? []);
  const [sessions, setSessions] = useState<SessionDraft[]>(initialSessions);
  // UAT Z-06: removing a session that still has live (non-refunded)
  // registrations would delete its `event_sessions` row server-side, and
  // `registrations.session_id references event_sessions(id) on delete set
  // null` silently nulls every one of those registrations' session — the
  // exact class of bug this whole fix targets, just triggered by an
  // intentional removal instead of the id-churn one. Block it in the editor
  // instead, where there's an easy count. `editEvent?.id` is undefined on
  // create, so this is a no-op fetch (and an always-empty map) there — a
  // brand-new event has no registrations yet regardless.
  const { rows: wizardEventRegs, status: wizardRegsStatus } = useEventRegistrations(editEvent?.id);
  const liveRegCountBySession = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of wizardEventRegs) {
      if (r.refunded || !r.sessionId) continue;
      m.set(r.sessionId, (m.get(r.sessionId) ?? 0) + 1);
    }
    return m;
  }, [wizardEventRegs]);
  /** Returns whether it's safe to drop `draft` from `sessions` right now —
   *  toasts and returns false otherwise. A draft with no `id` was never
   *  persisted (added this session), so it can never have a registration
   *  pointing at it. */
  const canRemoveSession = (draft: SessionDraft): boolean => {
    if (!draft.id) return true;
    // `isEdit` guard first: on a brand-new event `useEventRegistrations(undefined)`
    // never fetches, so its status sits at 'loading' forever — without this,
    // Remove would be permanently blocked on create. Belt-and-suspenders with
    // the `!draft.id` check above (which already covers create-mode today,
    // since sessionsTodrafts only keeps ids when `isEdit`): this doesn't rely
    // on that staying true.
    if (isEdit && wizardRegsStatus !== 'ready') {
      // Data-layer rule: never treat "loading" as "empty" — a partial read
      // here would wrongly clear a session that DOES have athletes on it.
      toast('Registrations are still loading — try again in a moment.', { variant: 'error' });
      return false;
    }
    const n = liveRegCountBySession.get(draft.id) ?? 0;
    if (n > 0) {
      toast(`${n} ${n === 1 ? 'athlete is' : 'athletes are'} registered for this session — move ${n === 1 ? 'them' : 'them all'} to another session first.`, { variant: 'error' });
      return false;
    }
    return true;
  };
  // Nationals create-mode "Sessions × Gyms" (PM feedback 2026-07-22 §C) —
  // replaces the per-discipline session cards entirely; disciplines[] and
  // sessions[] above stay populated (from the template) but unused in this
  // mode, so edit mode falls back to the classic UI unaffected.
  // Initial rows are keyed via a local counter (not a ref — refs can't be
  // read during render, same reason `initialSessions`/`keyRef` above use this
  // pattern); the refs' starting values are then seeded past that count so
  // later add-row calls don't collide.
  const initialNationalsSlots: NationalsSlotDraft[] = useGymsUi ? (() => {
    let key = 1;
    return defaultNationalsSlots(seedStartDate, () => key++);
  })() : [];
  const slotKeyRef = useRef(initialNationalsSlots.length + 1);
  const nextSlotKey = () => slotKeyRef.current++;
  const initialNationalsGyms: NationalsGymDraft[] = useGymsUi ? (() => {
    let key = 1;
    return defaultNationalsGyms(db.levels, () => key++);
  })() : [];
  const gymKeyRef = useRef(initialNationalsGyms.length + 1);
  const nextGymKey = () => gymKeyRef.current++;
  const [nationalsSlots, setNationalsSlots] = useState<NationalsSlotDraft[]>(initialNationalsSlots);
  const [nationalsGyms, setNationalsGyms] = useState<NationalsGymDraft[]>(initialNationalsGyms);
  const gymDisciplines = useMemo(() => [...new Set(nationalsGyms.map((g) => g.discipline))], [nationalsGyms]);
  // Everywhere downstream (capacity, finals levels, submit) reads this
  // instead of `disciplines`/`sessions` when the slots×gyms UI is active.
  const effectiveDisciplines = useGymsUi ? DISCIPLINES.filter((d) => gymDisciplines.includes(d)) : disciplines;
  // Registration mode (event-mgmt v2 P4 T4): competitions only — camps always
  // register per-athlete, no session choice.
  const isCamp = seedEvt?.eventType === 'camp';
  const [registrationMode, setRegistrationMode] = useState<'by-discipline' | 'by-session'>(
    seedEvt?.registrationMode ?? 'by-discipline',
  );
  // Registrant survey (camps only; question list made editable 2026-07-23):
  // the master on/off toggle plus a fully editable question list (label,
  // type, options for choice types, required). Seeded via the shared
  // resolver so a brand-new camp starts from the historical 4 questions
  // (editable from here on) and an existing camp — whether it already has
  // `campConfig.survey` or only the pre-2026-07-23 legacy fields — opens
  // with its actual effective questions. A brand-new camp (no campConfig at
  // all) defaults enabled=true (the resolver alone would say false, since it
  // has no signal either way); an existing camp honors its resolved value.
  const initialSurvey = campSurveyQuestionsOf(seedEvt?.campConfig);
  const [surveyEnabled, setSurveyEnabled] = useState(seedEvt?.campConfig ? initialSurvey.enabled : true);
  const initialSurveyQuestions: SurveyQuestionDraft[] = (() => {
    let key = 1;
    return surveyQuestionsToDrafts(initialSurvey.questions, () => key++);
  })();
  const surveyKeyRef = useRef(initialSurveyQuestions.length + 1);
  const nextSurveyKey = () => surveyKeyRef.current++;
  const [surveyQuestions, setSurveyQuestions] = useState<SurveyQuestionDraft[]>(initialSurveyQuestions);
  // Scoring config (PM decision 2026-07-19): judge panels + default entry mode.
  const initialScoringConfig = scoringConfigOf(seedEvt);
  const [scoringPanels, setScoringPanels] = useState<1 | 2>(isNationalsCreate ? 2 : initialScoringConfig.panels);
  const [scoringEntryMode, setScoringEntryMode] = useState<ScoringConfig['entryMode']>(initialScoringConfig.entryMode);
  // Publication state (B4: Draft/Live only — the real-time phase is derived
  // from regOpens/regCloses/startDate/endDate, not manually set).
  const [status, setStatus] = useState<EventStatus>(seedEvt?.status ?? 'live');
  const [error, setError] = useState('');

  const takenSlugs = db.events.filter((m) => m.id !== editEvent?.id).map((m) => m.slug);
  const slug = useMemo(
    () => isEdit ? editEvent!.slug : uniqueSlug(name, takenSlugs),
    [name, takenSlugs, isEdit, editEvent],
  );

  const wizardTitle = isEdit
    ? `Edit ${seedEvt?.ucgHosted === 'flipfest' ? 'FlipFest' : seedEvt?.ucgHosted === 'nationals' ? 'UCG Nationals' : 'event'} — ${editEvent!.name}`
    : seedEvt?.ucgHosted === 'flipfest'
      ? 'Create FlipFest'
      : seedEvt?.ucgHosted === 'nationals'
        ? 'Create UCG Nationals'
        : 'Sanction a new event';

  const allCompetingLevelIds = useMemo(
    () => useGymsUi
      ? [...new Set(nationalsGyms.flatMap((g) => g.levelIds))]
      : [...new Set(sessions.flatMap((s) => s.levelIds))],
    [useGymsUi, nationalsGyms, sessions],
  );
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
      // UAT Z-06: block dropping a whole discipline if ANY of its sessions
      // still has live registrations — same guard as the per-session Remove
      // button, applied to every session this would drop at once. `.find`
      // (not `.filter`) so canRemoveSession's toast fires at most once.
      if (!isCamp) {
        const blocked = sessions.find((s) => s.discipline === d && !canRemoveSession(s));
        if (blocked) return;
      }
      setDisciplines(disciplines.filter((x) => x !== d));
      // Camps never carry sessions (PM feedback 2026-07-22) — nothing to prune.
      if (!isCamp) setSessions(sessions.filter((s) => s.discipline !== d));
    } else {
      setDisciplines([...disciplines, d]);
      if (!isCamp) setSessions([...sessions, ...defaultSessions(db.levels, d, startDate, nextKey)]);
    }
  };

  const toggleTshirtSize = (size: string) => {
    setTshirtSizes((prev) =>
      prev.includes(size) ? prev.filter((s) => s !== size) : [...prev, size],
    );
  };

  const updateSession = (key: number, patch: Partial<SessionDraft>) =>
    setSessions(sessions.map((s) => (s.key === key ? { ...s, ...patch } : s)));

  /** Shared save/navigate tail for both publish modes. */
  const finishSave = (event: Event) => {
    if (isEdit) {
      // `editEvent.sessions` is the pre-edit snapshot (captured in this
      // closure before `mutate()` reassigns the in-place `db.events[idx]`) —
      // pushEvent needs it to tell an untouched session from a removed one
      // (UAT Z-06); passing nothing would default to `event.sessions` (the
      // NEW list) and silently never prune a removed session server-side.
      const previousSessions = editEvent?.sessions ?? [];
      const applied = mutate((d) => { const idx = d.events.findIndex((m) => m.id === event.id); if (idx >= 0) d.events[idx] = event; pushEvent(event, previousSessions); });
      if (!applied) return; // offline read-only gate — no false success toast
      toast(`${event.name} updated.`);
    } else {
      const applied = mutate((d) => { d.events.push(event); pushEvent(event); });
      if (!applied) return; // offline read-only gate — no false success toast
      toast(event.ucgHosted ? `${event.name} created — #/events/${slug}` : `${event.name} sanctioned — #/events/${slug}`);
    }
    onClose();
    navigate(`/events/${event.slug}`);
  };

  /**
   * `mode` drives the UCG-Nationals two-tier publish model (PM feedback
   * 2026-07-23 — `isNationalsUcgWizard` footer only): 'dates-only' validates
   * + saves only name/dates/location (+ an optional matched reg-open/close
   * pair) and marks `listingOnly: true`, skipping discipline/session/gym,
   * fee, add-on, capacity, finals, and confirmation-email validation.
   * 'full' (the only mode every other caller uses) is today's complete
   * validation and clears `listingOnly`.
   */
  const submit = (mode: 'full' | 'dates-only' = 'full') => {
    if (!name.trim()) return setError('Event name is required.');
    // Host club input is hidden for UCG-hosted events (PM feedback
    // 2026-07-22). UCG-hosted events need NO host club at all — still prefer
    // a single league-host club if one happens to exist (keeps the old
    // host-club-$0 behavior working for UCG's own club when flagged), but
    // fall back to '' (no host club) rather than blocking the save. Non-UCG
    // events are unchanged: a host club is still required.
    const resolvedHostClubId = isUcgHosted ? (hostClubId ?? singleLeagueHostClubId(db) ?? '') : hostClubId;
    if (!isUcgHosted && !resolvedHostClubId) return setError('Pick a host club.');
    if (!city.trim() || !state) return setError('City and state are required.');
    if (!startDate || !endDate || endDate < startDate) return setError('End date must be on or after the start date.');
    // F6 season lifecycle: an event's season is derived from its start date —
    // block creating (or re-dating) it into a season that isn't launched yet.
    const seasonBlock = eventCreationBlocked(db, startDate);
    if (seasonBlock.blocked) return setError(seasonBlock.reason ?? 'That season is not yet available for events.');

    if (mode === 'dates-only') {
      // Reg dates are optional here, but if either is set both are required,
      // with the same ordering rules as a full publish.
      const regDatesProvided = !!regOpens || !!regCloses;
      if (regDatesProvided) {
        if (!regOpens || !regCloses) return setError('Set both registration open and close dates, or leave both blank.');
        if (regCloses.slice(0, 10) > startDate) return setError('Registration must close on or before the event start date.');
        if (regOpens >= regCloses) return setError('Registration must open before it closes.');
      }
      const eventId = editEvent?.id ?? `meet-${Date.now()}`;
      // Only author sessions from the slots×gyms inputs if they're fully
      // filled in — otherwise a dates-only publish saves no sessions at all
      // (create mode) or leaves an existing event's sessions untouched (edit
      // mode with the classic per-session cards, `useGymsUi` false — a
      // dates-only re-publish must never silently wipe already-authored
      // sessions).
      let eventSessions: EventSession[] = editEvent?.sessions ?? [];
      if (useGymsUi) {
        const slotsOk = nationalsSlots.length > 0 && nationalsSlots.every((s) => s.date && s.time);
        const gymsOk = nationalsGyms.length > 0 && nationalsGyms.every((g) => g.name.trim() && g.levelIds.length > 0);
        if (slotsOk && gymsOk) {
          eventSessions = buildNationalsSessions(
            nationalsSlots.map((s, i) => ({ name: `Session ${i + 1}`, date: s.date, time: s.time })),
            nationalsGyms.map((g) => ({ name: g.name.trim(), discipline: g.discipline, levelIds: g.levelIds })),
            eventId,
          );
        }
      }
      const orderedDisciplines = DISCIPLINES.filter((d) => effectiveDisciplines.includes(d));
      const event: Event = {
        ...(editEvent ?? template ?? {}),
        id: eventId,
        slug: editEvent?.slug ?? slug,
        name: name.trim(),
        hostClubId: resolvedHostClubId!,
        city: city.trim(), state, timezone,
        startDate, endDate, status: 'live', regOpens, regCloses,
        // Fees aren't validated in this mode — fall back to a benign default
        // rather than writing a non-finite value if left blank/invalid.
        entryFee: Number(entryFee) || 0,
        secondDisciplineFee: Number(secondFee) || 0,
        disciplines: orderedDisciplines,
        sessions: eventSessions,
        venue: venue.trim() || undefined,
        streetAddress: streetAddress.trim() || undefined,
        country: country.trim() || undefined,
        listingOnly: true,
      };
      return finishSave(event);
    }

    if (!regOpens || !regCloses || regCloses.slice(0, 10) > startDate) return setError('Registration must close on or before the event start date.');
    if (regOpens >= regCloses) return setError('Registration must open before it closes.');
    if (useGymsUi) {
      if (nationalsSlots.length === 0) return setError('Add at least one session.');
      const badSlot = nationalsSlots.find((s) => !s.date || !s.time);
      if (badSlot) return setError('Every session needs a date and time.');
      if (nationalsGyms.length === 0) return setError('Add at least one gym.');
      const badGym = nationalsGyms.find((g) => !g.name.trim() || g.levelIds.length === 0);
      if (badGym) return setError('Every gym needs a name and at least one level.');
    } else {
      if (disciplines.length === 0) return setError('Select at least one discipline.');
      // Camps are session-less entirely (PM feedback 2026-07-22) — no
      // "add at least one session" requirement for them.
      if (!isCamp) {
        if (sessions.length === 0) return setError('Add at least one session.');
        const bad = sessions.find((s) => !s.label.trim() || !s.date || !s.time || s.levelIds.length === 0);
        if (bad) return setError('Every session needs a name, date, time, and at least one level.');
      }
    }
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
    // Capacity (T2): the per-discipline chooser is hidden entirely in
    // by-session mode (session maxRoutines caps are the only knob there), so
    // its draft is never validated or written in that mode — whatever
    // capacity the event already had passes through unchanged (see the
    // write-out below).
    if (!isCamp && registrationMode === 'by-discipline') {
      // `wizardEventRegs` (already fetched above for the session-removal
      // guard) never resolves for a brand-new event (`isEdit` false), so only
      // gate on freshness when editing — same guard as `canRemoveSession`.
      if (isEdit && wizardRegsStatus !== 'ready') {
        return setError('Registrations are still loading — try again in a moment.');
      }
      const groupsById = Object.fromEntries((db.waitlistGroups ?? []).map((g) => [g.id, g]));
      // ENFORCEMENT tally (paid + live holds) via capacityUsage — never
      // paidUsage — so a save can't undercut a spot already promised by a
      // live cart hold or a promoted waitlist group. A brand-new event has no
      // registrations yet, so usage is all zero.
      const usage = editEvent
        ? capacityUsage(editEvent, wizardEventRegs, groupsById, Date.now())
        : { totalAthletes: 0, perDiscipline: {}, perDisciplineLevel: {}, perSession: {} };
      const levelName = (levelId: string) => {
        const l = db.levels.find((x) => x.id === levelId);
        return l ? `${discLabel(l.discipline)} ${l.name}` : levelId;
      };
      const issues = validateCapacityDraft(capacityDraft, usage, levelName);
      if (issues.length > 0) return setError(issues[0].message);
    }
    if (!useGymsUi) {
      for (const s of sessions) {
        for (const a of APPARATUS[s.discipline]) {
          const v = s.maxRoutines[a.code];
          if (v && v.trim()) {
            const n = Number(v);
            if (!Number.isInteger(n) || n < 0) {
              return setError(`${s.label.trim() || 'Session'} — max routines (${a.code}) must be a non-negative whole number.`);
            }
          }
        }
      }
    }
    // by-session mode needs sessions to pick from at registration — already
    // guaranteed by the general "add at least one session" check above, since
    // every event (any mode) requires at least one session.
    if (hasConfirmationEmail && !confirmationBodyHtml.trim()) return setError('Confirmation email needs a body, or turn the toggle off.');

    const nationals = kind === 'nationals';

    const eventId = editEvent?.id ?? `meet-${Date.now()}`;
    // Camps are truly session-less (PM feedback 2026-07-22) — save `[]`
    // regardless of whatever `sessions` state holds (it stays empty for
    // camps anyway per `initialSessions`/`toggleDiscipline` above; this is
    // belt-and-suspenders against any future path that populates it).
    const eventSessions: EventSession[] = isCamp
      ? []
      : useGymsUi
      ? buildNationalsSessions(
          nationalsSlots.map((s, i) => ({ name: `Session ${i + 1}`, date: s.date, time: s.time })),
          nationalsGyms.map((g) => ({ name: g.name.trim(), discipline: g.discipline, levelIds: g.levelIds })),
          eventId,
        )
      : (() => {
          // Ids for brand-new session drafts (UAT Z-06) — an existing
          // draft's own id is reused verbatim so the save is an UPSERT of
          // the same row rather than a delete+reinsert under a new one;
          // `pushEvent`'s stable-id write path relies on that. See
          // `assignSessionIds` (events-core.ts) for why `editEvent.sessions`
          // (not just the surviving drafts) has to seed the collision set —
          // a mint that recycled a just-removed session's id in the same
          // save would silently re-attach that old session's dependents to
          // a session they never competed in.
          const ids = assignSessionIds(
            eventId,
            sessions.map((s) => s.id),
            (editEvent?.sessions ?? []).map((es) => es.id),
          );
          return sessions.map((s, i) => {
            // Strip blank/invalid entries — never persist non-finite or null caps
            // (the capacity engine treats those as "not configured," but a clean
            // save shouldn't write garbage either).
            const maxRoutines = Object.entries(s.maxRoutines).reduce<Record<string, number>>((acc, [code, v]) => {
              if (v.trim()) {
                const n = Number(v);
                if (Number.isFinite(n)) acc[code] = n;
              }
              return acc;
            }, {});
            const id = ids[i];
            // Squads belong to the SAME session id, not the same array
            // position (that pairing broke identically to the id bug above
            // under reorder — a reordered session used to inherit whatever
            // squads/athlete placements sat at its new index).
            const squads = s.id ? (editEvent?.sessions.find((es) => es.id === s.id)?.squads ?? []) : [];
            return {
              id,
              name: `Session ${i + 1} — ${s.label.trim()}`,
              discipline: s.discipline, date: s.date, time: s.time, levelIds: s.levelIds,
              squads,
              ...(nationals ? { phase: s.phase } : {}),
              ...(Object.keys(maxRoutines).length > 0 ? { maxRoutines } : {}),
            };
          });
        })();
    if (nationals && !eventSessions.some((s) => s.phase === 'prelim')) return setError('A Nationals event needs at least one prelim session.');
    const orderedDisciplines = DISCIPLINES.filter((d) => effectiveDisciplines.includes(d));
    const event: Event = {
      ...(editEvent ?? template ?? {}),
      id: eventId,
      slug: editEvent?.slug ?? slug,
      name: name.trim(),
      hostClubId: resolvedHostClubId!,
      city: city.trim(), state, timezone,
      startDate, endDate, status, regOpens, regCloses,
      entryFee: fee,
      // Camps charge one flat per-athlete fee regardless of discipline count —
      // the 2nd-discipline fee input is hidden for camps, so force it to 0
      // rather than silently charging the hidden default (PM feedback
      // 2026-07-22 camp session/level-less pass).
      secondDisciplineFee: isCamp ? 0 : fee2,
      disciplines: orderedDisciplines,
      sessions: eventSessions,
      ...(isCamp ? {} : { registrationMode }),
      ...(hasBanquet ? { banquet: { name: banquetName.trim(), price: bPrice, ...(banquetLastPurchaseAt ? { lastPurchaseAt: banquetLastPurchaseAt } : {}) } } : { banquet: undefined }),
      ...(hasTshirt ? { tshirtAddon: { price: Number(tshirtPrice), sizes: tshirtSizes, ...(tshirtLastPurchaseAt ? { lastPurchaseAt: tshirtLastPurchaseAt } : {}) } } : { tshirtAddon: undefined }),
      ...(hasBanner ? { bannerAddon: { price: Number(bannerPrice), ...(bannerLastPurchaseAt ? { lastPurchaseAt: bannerLastPurchaseAt } : {}) } } : { bannerAddon: undefined }),
      ...(hasChangeFee ? { changeFee: { amount: Number(changeFeeAmount), startsAt: changeFeeStartsAt } } : { changeFee: undefined }),
      // Camps hide the edit-lockout toggle (PM feedback 2026-07-22) — lock
      // out editing as soon as registration closes instead.
      lastDateToEdit: isCamp ? regCloses : (hasEditLockout ? lastDateToEdit : null),
      finalsLineupDeadlineAt: nationals && hasFinalsDeadline ? finalsLineupDeadlineAt : null,
      venue: venue.trim() || undefined,
      streetAddress: streetAddress.trim() || undefined,
      country: country.trim() || undefined,
      hotelLink: normalizeExternalUrl(hotelLink) || undefined,
      ageCalcAt: hasAgeCalcAt ? ageCalcAt : undefined,
      ...(hasLateReg ? { lateReg: { startsAt: lateRegStartsAt, fee: Number(lateRegFee) } } : { lateReg: undefined }),
      ...(directorName.trim()
        ? { director: { name: directorName.trim(), email: directorEmail.trim(), ccOnConfirmation: directorCc } }
        : { director: undefined }),
      // Capacity (T2): camps never have caps (session-less/level-less —
      // there's no discipline/level to scope one to). By-session mode hides
      // the per-discipline chooser entirely, so this save leaves whatever
      // `capacity` the event already had untouched (the `...(editEvent ??
      // template ?? {})` spread at the top of this object already carries it
      // forward — no explicit key needed here). By-discipline mode writes
      // ONLY the new per-discipline shape straight from the draft, dropping
      // `total`/legacy keys entirely.
      ...(isCamp
        ? { capacity: undefined }
        : registrationMode === 'by-session'
          ? {}
          : { capacity: capacityConfigFromDraft(capacityDraft) }),
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
      scoringConfig: { panels: scoringPanels, entryMode: scoringEntryMode },
      // Registrant survey (camps only; question list editable 2026-07-23) —
      // preserves any `leoAddon` the sanction-approval flow set (this wizard
      // has no UI for it) while writing the new `survey` shape from the
      // editor above. `overnightSurvey` is mirrored true/false for any
      // straggler reader that still checks it directly; `surveyMandatory`
      // is no longer written (each question now carries its own `required`).
      // Non-camp events keep whatever campConfig they already had — there's
      // nothing to edit for them.
      ...(isCamp
        ? {
            campConfig: {
              ...seedEvt?.campConfig,
              overnightSurvey: surveyEnabled,
              surveyMandatory: undefined,
              survey: { enabled: surveyEnabled, questions: draftsToSurveyQuestions(surveyQuestions) },
            },
          }
        : {}),
      // A full publish clears the dates-only flag, even for an event
      // previously published via "Publish Dates and Location Only". Only
      // stamped where the flag is in play (the two-button Nationals wizard,
      // or clearing a previously-set flag) — leaving it undefined elsewhere
      // lets eventToRow omit the column entirely, which keeps every other
      // event save working against a DB that predates migration
      // 20260722221027 (prod at ship time).
      ...(isNationalsUcgWizard || seedEvt?.listingOnly ? { listingOnly: false } : {}),
    };
    finishSave(event);
  };

  const sectionTitle = (t: string) => (
    <h3 className="card-title" style={{ margin: '14px 0 8px', paddingTop: 10, borderTop: '1px solid var(--line)' }}>{t}</h3>
  );

  const formBody = (
    <>
      {caps.isAdmin && !isUcgHosted && (
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
      <Field
        label="Event name"
        hint={isUcgHosted ? undefined : (name.trim() ? `URL: ucg.org/#/events/${slug}` : 'The URL slug is derived automatically.')}
      >
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Southeast Open 2027" autoFocus />
      </Field>
      {!isUcgHosted && (
        <Field label="Host club">
          <Combo
            options={db.clubs.map((c) => ({ value: c.id, label: c.name, sub: `${c.state} · ${c.region}` }))}
            value={hostClubId} onChange={setHostClubId} placeholder="Type to search clubs…"
          />
        </Field>
      )}
      {/* Location — hidden for FlipFest, which always runs at its fixed
          UCG address (baked into the template, PM feedback 2026-07-22).
          Nationals keeps these (its venue changes year to year). */}
      {seedEvt?.ucgHosted !== 'flipfest' && (
        <>
          <div className="grid cols-2">
            <Field label="City"><input className="input" value={city} onChange={(e) => setCity(e.target.value)} /></Field>
            <Field label="State">
              <select
                className="input"
                value={state}
                onChange={(e) => { const v = e.target.value; setState(v); if (!isUcgHosted) setTimezone(timezoneForState(v, country)); }}
              >
                <option value="" disabled>Select…</option>
                {Object.keys(STATE_REGIONS).map((s) => <option key={s}>{s}</option>)}
              </select>
            </Field>
          </div>
          <Field label="Venue name"><input className="input" value={venue} onChange={(e) => setVenue(e.target.value)} placeholder="e.g. University Arena" /></Field>
        </>
      )}
      {(seedEvt?.ucgHosted !== 'flipfest' || !isCamp) && (
        <div className="grid cols-3">
          {seedEvt?.ucgHosted !== 'flipfest' && (
            <>
              <Field label="Street address"><input className="input" value={streetAddress} onChange={(e) => setStreetAddress(e.target.value)} /></Field>
              <Field label="Country"><input className="input" value={country} onChange={(e) => setCountry(e.target.value)} placeholder="United States" /></Field>
            </>
          )}
          {!isCamp && (
            <Field label="Hotel block link" hint="URL to the room-block booking page.">
              <input className="input" type="url" value={hotelLink} onChange={(e) => setHotelLink(e.target.value)} placeholder="https://…" />
            </Field>
          )}
        </div>
      )}

      {sectionTitle('Dates')}
      <p style={{ fontSize: 13, color: 'var(--ink-soft)', margin: '0 0 8px' }}>
        {isUcgHosted
          ? 'All dates & times for UCG-hosted events are in Pacific Time (America/Los_Angeles).'
          : 'Dates & times are in the time zone of the event location.'}
      </p>
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

      {/* Age-calculation date (event-mgmt v2 §A) — camps don't have age-based
          levels, so this is hidden for them (PM feedback 2026-07-22). Also
          hidden for UCG-hosted events (PM feedback 2026-07-22): it only
          matters for meets using Masters rules. An existing event with
          `ageCalcAt` already set keeps it — the checkbox state still seeds
          from `seedEvt` above and submit still writes it below, just via a
          hidden/unreachable-but-preserved toggle. */}
      {!isCamp && !isUcgHosted && (
        <>
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
        </>
      )}

      {sectionTitle('Fees')}
      <div className="grid cols-3">
        <Field label="Entry fee ($)"><input className="input" type="number" min={0} step={5} value={entryFee} onChange={(e) => setEntryFee(e.target.value)} /></Field>
        {!isCamp && (
          <Field label="2nd discipline ($)"><input className="input" type="number" min={0} step={5} value={secondFee} onChange={(e) => setSecondFee(e.target.value)} /></Field>
        )}
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

      {/* Banquet — hidden for camps (PM feedback 2026-07-22). */}
      {!isCamp && (
        <>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14, marginBottom: hasBanquet ? 8 : 0 }}>
            <input type="checkbox" checked={hasBanquet} onChange={(e) => setHasBanquet(e.target.checked)} /> Offer a banquet add-on
          </label>
          {hasBanquet && (
            <div className="grid cols-3">
              <Field label="Banquet name"><input className="input" value={banquetName} onChange={(e) => setBanquetName(e.target.value)} /></Field>
              <Field label="Banquet price ($)"><input className="input" type="number" min={0} step={5} value={banquetPrice} onChange={(e) => setBanquetPrice(e.target.value)} /></Field>
              <Field label={`Last date to purchase (${timezone})`} hint="Optional. Leave blank to allow purchase any time registration is open.">
                <input className="input" type="datetime-local" value={banquetLastPurchaseAt} onChange={(e) => setBanquetLastPurchaseAt(e.target.value)} />
              </Field>
            </div>
          )}
        </>
      )}

      {/* T-shirt add-on */}
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14, marginTop: 8, marginBottom: hasTshirt ? 8 : 0 }}>
        <input type="checkbox" checked={hasTshirt} onChange={(e) => setHasTshirt(e.target.checked)} /> Offer a t-shirt add-on
      </label>
      {hasTshirt && (
        <div className="card card-pad" style={{ marginBottom: 8 }}>
          <div className="grid cols-3" style={{ marginBottom: 10 }}>
            <Field label="T-shirt price ($)"><input className="input" type="number" min={0} step={1} value={tshirtPrice} onChange={(e) => setTshirtPrice(e.target.value)} /></Field>
            <Field label={`Last date to purchase (${timezone})`} hint="Optional. Leave blank to allow purchase any time registration is open.">
              <input className="input" type="datetime-local" value={tshirtLastPurchaseAt} onChange={(e) => setTshirtLastPurchaseAt(e.target.value)} />
            </Field>
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

      {/* Club banner add-on — hidden for camps (PM feedback 2026-07-22). */}
      {!isCamp && (
        <>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14, marginTop: hasTshirt ? 0 : 8, marginBottom: hasBanner ? 8 : 0 }}>
            <input type="checkbox" checked={hasBanner} onChange={(e) => setHasBanner(e.target.checked)} /> Offer a club banner add-on
          </label>
          {hasBanner && (
            <div className="grid cols-3" style={{ marginBottom: 8 }}>
              <Field label="Banner price ($)" hint="Clubs enter their banner text at registration.">
                <input className="input" type="number" min={0} step={5} value={bannerPrice} onChange={(e) => setBannerPrice(e.target.value)} />
              </Field>
              <Field label={`Last date to purchase (${timezone})`} hint="Optional. Leave blank to allow purchase any time registration is open.">
                <input className="input" type="datetime-local" value={bannerLastPurchaseAt} onChange={(e) => setBannerLastPurchaseAt(e.target.value)} />
              </Field>
            </div>
          )}
        </>
      )}

      {/* Change fee — hidden for camps (PM feedback 2026-07-22). */}
      {!isCamp && (
        <>
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
        </>
      )}

      {/* Last date to edit (B4) — hidden for camps (PM feedback 2026-07-22);
          submit() sets it to regCloses automatically for them instead. */}
      {!isCamp && (
        <>
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
        </>
      )}

      {/* Event director — hidden for UCG-hosted events (PM feedback
          2026-07-22): the Director of Nationals is always UCG itself, baked
          into `flipfestTemplate`/`nationalsTemplate` (director name "UCG",
          email info@unitedgymnastics.org, no confirmation CC — the PM never
          wants those). State still seeds from `seedEvt?.director` above and
          submit below still writes it unconditionally off that state, so the
          template-provided value round-trips even with the section hidden. */}
      {!isUcgHosted && (
        <>
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
        </>
      )}

      {/* Disciplines & sessions: camps get a minimal "which disciplines'
          equipment will be available" checkbox row only — no registration
          mode, no session cards (PM feedback 2026-07-22 — camps are truly
          session-less/level-less). Camp registration still reads
          `disciplines` downstream (RosterToolsCard, RegistrationEditor's
          per-discipline enable checkbox), but `sessions` is always `[]`. */}
      {isCamp ? (
        <>
          {sectionTitle('Disciplines')}
          <p style={{ fontSize: 13, color: 'var(--ink-soft)', margin: '0 0 10px' }}>
            Which disciplines&rsquo; equipment will be available at the camp. Camps have no
            sessions, levels, or scoring — this only controls equipment availability.
          </p>
          <div style={{ display: 'flex', gap: 16, marginBottom: 10 }}>
            {DISCIPLINES.map((d) => (
              <label key={d} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 14, fontWeight: 600 }}>
                <input type="checkbox" checked={disciplines.includes(d)} onChange={() => toggleDiscipline(d)} /> {discLabel(d)}
              </label>
            ))}
          </div>

          {sectionTitle('Registrant survey')}
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14, marginBottom: surveyEnabled ? 10 : 0 }}>
            <input type="checkbox" checked={surveyEnabled} onChange={(e) => setSurveyEnabled(e.target.checked)} />
            Do you want to survey registrants during registration?
          </label>
          {surveyEnabled && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {surveyQuestions.map((q) => (
                <div key={q.key} style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '10px 12px', border: '1px solid var(--line)', borderRadius: 8 }}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                    <input
                      className="input"
                      type="text"
                      placeholder="Question text"
                      value={q.label}
                      onChange={(e) => setSurveyQuestions((qs) => qs.map((x) => x.key === q.key ? { ...x, label: e.target.value } : x))}
                      style={{ flex: '2 1 260px' }}
                    />
                    <select
                      className="input"
                      value={q.type}
                      onChange={(e) => setSurveyQuestions((qs) => qs.map((x) => x.key === q.key ? { ...x, type: e.target.value as SurveyQuestionDraft['type'] } : x))}
                      style={{ flex: '1 1 160px' }}
                    >
                      <option value="text">Text input</option>
                      <option value="single">Multiple choice</option>
                      <option value="multi">Checkboxes</option>
                    </select>
                    <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap' }}>
                      <input
                        type="checkbox"
                        checked={q.required}
                        onChange={(e) => setSurveyQuestions((qs) => qs.map((x) => x.key === q.key ? { ...x, required: e.target.checked } : x))}
                      />
                      Required?
                    </label>
                    <button
                      type="button"
                      className="btn small ghost"
                      onClick={() => setSurveyQuestions((qs) => qs.filter((x) => x.key !== q.key))}
                    >
                      Remove
                    </button>
                  </div>
                  {q.type !== 'text' && (
                    <Field label="Options (one per line)">
                      <textarea
                        className="input"
                        rows={3}
                        value={q.optionsText}
                        onChange={(e) => setSurveyQuestions((qs) => qs.map((x) => x.key === q.key ? { ...x, optionsText: e.target.value } : x))}
                      />
                    </Field>
                  )}
                </div>
              ))}
              <button
                type="button"
                className="btn small ghost"
                style={{ alignSelf: 'flex-start' }}
                onClick={() => setSurveyQuestions((qs) => {
                  const n = nextSurveyKey();
                  return [...qs, { key: n, id: `q-${n}`, label: '', type: 'text', optionsText: '', required: false }];
                })}
              >
                + Add question
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          {sectionTitle('Disciplines & sessions')}
          {useGymsUi ? (
            <>
              <p style={{ fontSize: 13, color: 'var(--ink-soft)', margin: '0 0 10px' }}>
                Every discipline runs at every session — the venue is split into gyms, each holding one
                discipline&rsquo;s level group. Set the session time slots and gyms below; the underlying
                per-discipline sessions (one per session × gym) are generated automatically on save.
              </p>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>Sessions</div>
              {nationalsSlots.length === 0 && <p style={{ fontSize: 13, color: 'var(--ink-soft)', margin: '4px 0' }}>Add at least one session.</p>}
              {nationalsSlots.map((slot, i) => (
                <div key={slot.key} className="grid cols-3" style={{ marginBottom: 8, alignItems: 'end' }}>
                  <Field label={`Session ${i + 1} date`}>
                    <input
                      className="input" type="date" min={startDate} max={endDate} value={slot.date}
                      onChange={(e) => setNationalsSlots((rows) => rows.map((r) => (r.key === slot.key ? { ...r, date: e.target.value } : r)))}
                    />
                  </Field>
                  <Field label={`Session ${i + 1} time`}>
                    <input
                      className="input" type="time" value={slot.time}
                      onChange={(e) => setNationalsSlots((rows) => rows.map((r) => (r.key === slot.key ? { ...r, time: e.target.value } : r)))}
                    />
                  </Field>
                  <div>
                    <button className="btn small ghost" onClick={() => setNationalsSlots((rows) => rows.filter((r) => r.key !== slot.key))}>Remove</button>
                  </div>
                </div>
              ))}
              <button
                className="btn small ghost" style={{ marginBottom: 16 }}
                onClick={() => setNationalsSlots((rows) => [...rows, { key: nextSlotKey(), date: startDate, time: '09:00' }])}
              >+ Add session</button>

              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>Gyms</div>
              {nationalsGyms.length === 0 && <p style={{ fontSize: 13, color: 'var(--ink-soft)', margin: '4px 0' }}>Add at least one gym.</p>}
              {nationalsGyms.map((gym) => {
                const discLevels = db.levels.filter((l) => l.discipline === gym.discipline && !l.retired).sort((a, b) => a.order - b.order);
                return (
                  <div key={gym.key} className="card card-pad" style={{ marginBottom: 10 }}>
                    <div className="grid cols-3" style={{ marginBottom: 8 }}>
                      <Field label="Gym name">
                        <input
                          className="input" value={gym.name}
                          onChange={(e) => setNationalsGyms((rows) => rows.map((r) => (r.key === gym.key ? { ...r, name: e.target.value } : r)))}
                        />
                      </Field>
                      <Field label="Discipline">
                        <select
                          className="input" value={gym.discipline}
                          onChange={(e) => setNationalsGyms((rows) => rows.map((r) => (r.key === gym.key ? { ...r, discipline: e.target.value as Discipline, levelIds: [] } : r)))}
                        >
                          {DISCIPLINES.map((d) => <option key={d} value={d}>{discLabel(d)}</option>)}
                        </select>
                      </Field>
                      <div style={{ display: 'flex', alignItems: 'end' }}>
                        <button className="btn small ghost" onClick={() => setNationalsGyms((rows) => rows.filter((r) => r.key !== gym.key))}>Remove</button>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                      {discLevels.map((l) => (
                        <label key={l.id} style={{ display: 'flex', gap: 5, alignItems: 'center', fontSize: 13.5 }}>
                          <input
                            type="checkbox"
                            checked={gym.levelIds.includes(l.id)}
                            onChange={(e) => setNationalsGyms((rows) => rows.map((r) => (r.key === gym.key ? {
                              ...r,
                              levelIds: e.target.checked
                                ? discLevels.map((x) => x.id).filter((id) => r.levelIds.includes(id) || id === l.id)
                                : r.levelIds.filter((id) => id !== l.id),
                            } : r)))}
                          /> {l.name}
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })}
              <button
                className="btn small ghost"
                onClick={() => setNationalsGyms((rows) => [...rows, { key: nextGymKey(), name: '', discipline: 'MAG', levelIds: [] }])}
              >+ Add gym</button>
            </>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 16, marginBottom: 10 }}>
                {DISCIPLINES.map((d) => (
                  <label key={d} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 14, fontWeight: 600 }}>
                    <input type="checkbox" checked={disciplines.includes(d)} onChange={() => toggleDiscipline(d)} /> {discLabel(d)}
                  </label>
                ))}
              </div>
              <div className="card card-pad" style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>Registration mode</div>
                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                  <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 14 }}>
                    <input
                      type="radio" name="registrationMode" checked={registrationMode === 'by-discipline'}
                      onChange={() => setRegistrationMode('by-discipline')}
                    />
                    By discipline (default)
                  </label>
                  <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 14 }}>
                    <input
                      type="radio" name="registrationMode" checked={registrationMode === 'by-session'}
                      onChange={() => setRegistrationMode('by-session')}
                    />
                    By session
                  </label>
                </div>
                <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', margin: '6px 0 0' }}>
                  By-session: athletes pick a pre-created session at registration instead of just a discipline —
                  sessions (below) must be created before registration opens.
                </p>
              </div>
              {registrationMode === 'by-discipline' ? (
                // Sessions still exist underneath (results/squads use them,
                // and by-discipline capacity's per-level caps read the
                // levels they were seeded with) — this mode just doesn't
                // expose the session-template editor, since athletes never
                // pick a session at registration here.
                <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', margin: '0 0 10px' }}>
                  Session templates are hidden in by-discipline mode (athletes register by discipline, not by
                  session). Switch to "By session" above to edit them.
                </p>
              ) : (
                <>
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
                        <button className="btn small ghost" onClick={() => { if (canRemoveSession(s)) setSessions(sessions.filter((x) => x.key !== s.key)); }}>Remove</button>
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
                    <div style={{ marginTop: 10 }}>
                      <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--ink-soft)', marginBottom: 4 }}>
                        Max routines per apparatus (optional — blank = uncapped, counts apparatus entries)
                      </div>
                      <div className="grid cols-3">
                        {APPARATUS[s.discipline].map((a) => (
                          <Field key={a.code} label={a.name}>
                            <input
                              className="input" type="number" min={0} step={1}
                              value={s.maxRoutines[a.code] ?? ''}
                              onChange={(e) => updateSession(s.key, { maxRoutines: { ...s.maxRoutines, [a.code]: e.target.value } })}
                            />
                          </Field>
                        ))}
                      </div>
                    </div>
                  </div>
                    );
                  })}
                  {disciplines.length > 0 && (
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 4 }}>
                      {disciplines.map((d) => (
                        <button key={d} className="btn small ghost" onClick={() => setSessions([...sessions, { key: nextKey(), discipline: d, label: `${discLabel(d)} `, date: startDate, time: '09:00', levelIds: [], phase: 'prelim', maxRoutines: {} }])}>
                          + Add {discLabel(d)} session
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </>
      )}

      {sectionTitle('Capacity')}
      {legacyTotal != null && !legacyCapNoticeDismissed && (
        <div
          style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8,
            marginBottom: 10, padding: '10px 12px', borderRadius: 6,
            background: 'var(--warn-50, #fff8f0)', border: '1px solid var(--warn-200, #f9d87a)',
          }}
          role="status"
        >
          <p style={{ margin: 0, fontSize: 13 }}>
            This event had an overall participant cap of {legacyTotal} — that cap type was removed.
            Re-enter it below as per-discipline or per-level caps if you still want limits.
          </p>
          <button
            type="button" className="btn small ghost" style={{ flexShrink: 0 }}
            onClick={() => setLegacyCapNoticeDismissed(true)}
          >Dismiss</button>
        </div>
      )}
      {isCamp ? (
        <p style={{ fontSize: 13, color: 'var(--ink-soft)' }}>Camps have no participant caps.</p>
      ) : registrationMode === 'by-session' ? (
        <p style={{ fontSize: 13, color: 'var(--ink-soft)' }}>
          By-session mode caps routines per session instead (see "Max routines per apparatus" on each
          session above) — the per-discipline chooser doesn't apply here.
        </p>
      ) : effectiveDisciplines.length === 0 ? (
        <p style={{ fontSize: 13, color: 'var(--ink-soft)' }}>Select a discipline above to configure its cap.</p>
      ) : (
        effectiveDisciplines.map((d) => {
          const draftEntry = capacityDraft[d] ?? { mode: 'none', cap: '', perLevel: {} };
          // Same level set the by-session editor's own per-session pickers
          // use for this discipline: every non-retired level the event's
          // sessions were seeded/authored with (see `allCompetingLevelIds`).
          const discLevels = db.levels
            .filter((l) => l.discipline === d && allCompetingLevelIds.includes(l.id))
            .sort((a, b) => a.order - b.order);
          return (
            <div key={d} className="card card-pad" style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>{discLabel(d)} cap</div>
              <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 8 }}>
                <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 14 }}>
                  <input
                    type="radio" name={`capMode-${d}`} checked={draftEntry.mode === 'none'}
                    onChange={() => updateCapacityDraft(d, { mode: 'none' })}
                  /> No cap
                </label>
                <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 14 }}>
                  <input
                    type="radio" name={`capMode-${d}`} checked={draftEntry.mode === 'discipline'}
                    onChange={() => updateCapacityDraft(d, { mode: 'discipline' })}
                  /> One cap for the whole discipline
                </label>
                <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 14 }}>
                  <input
                    type="radio" name={`capMode-${d}`} checked={draftEntry.mode === 'perLevel'}
                    onChange={() => updateCapacityDraft(d, { mode: 'perLevel' })}
                  /> Per-level caps
                </label>
              </div>
              {draftEntry.mode === 'discipline' && (
                <div className="grid cols-3">
                  <Field label={`Cap (${CAPACITY_UNIT_LABEL})`} hint={CAPACITY_UNIT_HINT}>
                    <input
                      className="input" type="number" min={1} step={1}
                      value={draftEntry.cap}
                      onChange={(e) => updateCapacityDraft(d, { cap: e.target.value })}
                    />
                  </Field>
                </div>
              )}
              {draftEntry.mode === 'perLevel' && (
                <div className="grid cols-3">
                  {discLevels.length === 0 && (
                    <p style={{ fontSize: 12.5, color: 'var(--ink-soft)' }}>
                      No levels configured for {discLabel(d)} yet — add a session with levels above.
                    </p>
                  )}
                  {discLevels.map((l) => (
                    <Field key={l.id} label={`${l.name} cap (${CAPACITY_UNIT_LABEL})`} hint={CAPACITY_UNIT_HINT}>
                      <input
                        className="input" type="number" min={1} step={1}
                        value={draftEntry.perLevel[l.id] ?? ''}
                        onChange={(e) => updateCapacityDraft(d, { perLevel: { ...draftEntry.perLevel, [l.id]: e.target.value } })}
                      />
                    </Field>
                  ))}
                </div>
              )}
            </div>
          );
        })
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

          {/* Finals lineup deadline (event-mgmt v2 P5 §L.3) */}
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14, marginTop: 12, marginBottom: hasFinalsDeadline ? 8 : 0 }}>
            <input type="checkbox" checked={hasFinalsDeadline} onChange={(e) => setHasFinalsDeadline(e.target.checked)} /> Set a finals lineup deadline
          </label>
          {hasFinalsDeadline && (
            <div className="grid cols-3" style={{ marginBottom: 8 }}>
              <Field
                label={`Finals lineup deadline (${timezone})`}
                hint="Managers are reminded at this time; lineups hard-lock 1 hour later."
              >
                <input className="input" type="datetime-local" value={finalsLineupDeadlineAt} onChange={(e) => setFinalsLineupDeadlineAt(e.target.value)} />
              </Field>
            </div>
          )}
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

      {/* Scoring — hidden for camps (no judging), PM feedback 2026-07-22.
          submit() still saves whatever scoringPanels/scoringEntryMode default
          to (state stays at its initial value since there's no UI to change it). */}
      {!isCamp && (
        <>
          {sectionTitle('Scoring')}
          <div className="card card-pad" style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>Judge panels</div>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 14 }}>
                <input type="radio" name="scoringPanels" checked={scoringPanels === 1} onChange={() => setScoringPanels(1)} />
                1 judge panel (default)
              </label>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 14 }}>
                <input type="radio" name="scoringPanels" checked={scoringPanels === 2} onChange={() => setScoringPanels(2)} />
                2 judge panels
              </label>
            </div>
            <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', margin: '6px 0 0' }}>
              With 2 panels, each judge enters their own execution evaluation and the two are averaged into the final score.
            </p>
          </div>
          <div className="card card-pad" style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>Default entry mode</div>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 14 }}>
                <input type="radio" name="scoringEntryMode" checked={scoringEntryMode === 'calculator'} onChange={() => setScoringEntryMode('calculator')} />
                Calculator (default)
              </label>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 14 }}>
                <input type="radio" name="scoringEntryMode" checked={scoringEntryMode === 'simple'} onChange={() => setScoringEntryMode('simple')} />
                Simple entry (manual)
              </label>
            </div>
            <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', margin: '6px 0 0' }}>
              Judges can still switch modes per score at the judges' table — this just sets which one opens by default.
            </p>
          </div>
        </>
      )}

      {/* Status is hidden for the UCG-Nationals two-tier publish wizard —
          publishing (either mode) always implies live. */}
      {!isNationalsUcgWizard && (
        <>
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
        </>
      )}

      {error && <p style={{ color: 'var(--coral-text)', fontSize: 13.5, fontWeight: 600, margin: '8px 0 0' }}>{error}</p>}
      <div style={{ display: 'flex', justifyContent: 'end', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        {isNationalsUcgWizard ? (
          <>
            <button className="btn" onClick={() => submit('dates-only')}>
              {isEdit && seedEvt?.listingOnly ? 'Edit Dates and Location Only' : 'Publish Dates and Location Only'}
            </button>
            <button className="btn primary" onClick={() => submit('full')}>
              {isEdit && !seedEvt?.listingOnly ? 'Edit Full Details' : 'Publish Full Details'}
            </button>
          </>
        ) : (
          <button className="btn primary" onClick={() => submit('full')}>{isEdit ? 'Save changes' : 'Sanction event'}</button>
        )}
      </div>
    </>
  );

  if (variant === 'page') {
    return (
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
          <h1 className="page-title display" style={{ marginBottom: 0 }}>{wizardTitle}</h1>
          <button className="btn ghost" onClick={onClose}>← Cancel</button>
        </div>
        {formBody}
      </div>
    );
  }

  return <Modal title={wizardTitle} onClose={onClose}>{formBody}</Modal>;
}
