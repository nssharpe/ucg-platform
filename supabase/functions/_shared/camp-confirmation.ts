// _shared/camp-confirmation.ts — pure HTML-building for the camp confirmation
// block appended to stripe-webhook's receipt email (event-mgmt v2 Phase 2
// §G; survey questions made per-event-editable 2026-07-23). NO Deno/Supabase
// imports here — unit-tested by vitest under node
// (tests/camp-confirmation.test.ts) and imported by stripe-webhook at
// runtime, mirroring the event-comm.ts / owner-checklist.ts pattern.
//
// This module only formats already-resolved data (athlete names, survey
// answers, add-on labels) into HTML fragments — it does no DB work and makes
// no assumptions about how the caller fetched that data, so a failure
// upstream (a query error, a missing field) never has to touch this file to
// stay contained: the CALLER wraps the whole build in try/catch and falls
// back to '' (see stripe-webhook/index.ts).
//
// Renders GENERICALLY off each athlete's own event's `questions` list rather
// than a fixed 4-field shape, so a host's custom survey questions show up
// here too. Legacy fixed-id questions (`bedtime`/`noiseLevel`) still map
// their coded answer values through the historical label maps below —
// mirrors `campSurveyAnswerLabel` (src/lib/pricing.ts), duplicated here
// because this file can't import client code (outside tsconfig.app.json's
// `src` rootDir; it runs under Deno).

const LEGACY_BEDTIME_LABELS: Record<string, string> = {
  'before-10': 'Before 10pm',
  '10-to-midnight': '10pm–midnight',
  'after-midnight': 'After midnight',
};
const LEGACY_NOISE_LABELS: Record<string, string> = {
  quiet: 'Quiet',
  moderate: 'Moderate',
  lively: 'Lively',
};

/** Human-readable label for one answer VALUE to question `questionId` —
 *  mirrors `campSurveyAnswerLabel` in src/lib/pricing.ts. */
function answerLabel(questionId: string, value: string): string {
  if (questionId === 'bedtime') return LEGACY_BEDTIME_LABELS[value] ?? value;
  if (questionId === 'noiseLevel') return LEGACY_NOISE_LABELS[value] ?? value;
  return value;
}

/** Minimal `events.camp_config` shape this resolver needs — mirrors
 *  `CampConfigForSurvey` in src/lib/pricing.ts (duplicated for the same
 *  Deno/rootDir reason as the label maps above). */
export interface CampConfigLike {
  overnightSurvey?: boolean;
  surveyMandatory?: { bedtime?: boolean; noiseLevel?: boolean; cabinGenderPref?: boolean; roommateRequest?: boolean };
  survey?: { enabled: boolean; questions: CampSurveyQuestionLike[] };
}

const CABIN_GENDER_OPTIONS = ['Male', 'Female', 'Non-binary', 'Genderfluid', 'Agender', 'Other', 'No preference'];

function legacyQuestions(config?: CampConfigLike): CampSurveyQuestionLike[] {
  const m = config?.surveyMandatory;
  return [
    {
      id: 'bedtime', label: 'What time do you plan to go to bed?', type: 'single',
      options: ['before-10', '10-to-midnight', 'after-midnight'], required: m?.bedtime ?? true,
    },
    {
      id: 'noiseLevel', label: 'What is the preferred noise level in your cabin?', type: 'single',
      options: ['quiet', 'moderate', 'lively'], required: m?.noiseLevel ?? true,
    },
    {
      id: 'cabinGenderPref', label: 'Would you prefer a co-ed or single gender cabin?', type: 'single',
      options: [...CABIN_GENDER_OPTIONS], required: m?.cabinGenderPref ?? true,
    },
    {
      id: 'roommateRequest',
      label: 'If you have any roommate requests (including people you DO NOT want to room with), please list them here.',
      type: 'text', required: m?.roommateRequest ?? false,
    },
  ];
}

/** Resolve an event's effective survey (enabled + question list) from its
 *  `camp_config` column — mirrors `campSurveyQuestionsOf` in
 *  src/lib/pricing.ts exactly (kept in lockstep; same legacy-derivation
 *  rules). */
export function campSurveyQuestionsOfConfig(config?: CampConfigLike): { enabled: boolean; questions: CampSurveyQuestionLike[] } {
  if (config?.survey) return config.survey;
  return { enabled: !!config?.overnightSurvey, questions: legacyQuestions(config) };
}

export interface CampSurveyQuestionLike {
  id: string;
  label: string;
  type: 'text' | 'single' | 'multi';
  options?: string[];
  required: boolean;
}

export interface CampAthleteSurvey {
  name: string;
  survey: Record<string, string | string[]> | null | undefined;
  /** This athlete's event's resolved survey question list (`campSurveyQuestionsOf`
   *  equivalent, resolved by the caller) — drives which columns render and
   *  in what order/wording. */
  questions: CampSurveyQuestionLike[];
}

export interface CampConfirmationInput {
  /** One entry per registered athlete this payment covers for the camp
   *  event(s) — even if that athlete has no survey answers (they're simply
   *  skipped when rendering). */
  athletes: CampAthleteSurvey[];
  /** Human-readable add-on lines already formatted with athlete name / size
   *  / assignee by the cart-line builder (e.g. "Camp t-shirt — Jane Doe
   *  (size YM)", "Camp Banquet — Extra ticket") — reused as-is. */
  addonLabels: string[];
  /** Link to the member's registration-edit surface. */
  editUrl: string;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** True iff at least one of this athlete's questions has a non-blank answer. */
function surveyHasAnswers(survey: Record<string, string | string[]> | null | undefined, questions: CampSurveyQuestionLike[]): boolean {
  if (!survey) return false;
  return questions.some((q) => {
    const v = survey[q.id];
    return Array.isArray(v) ? v.length > 0 : !!(v && String(v).trim());
  });
}

/** One athlete's survey answers as a definition-list-style HTML block, or ''
 *  if nothing was answered (the survey is off/absent for this athlete, or
 *  every question was skipped). */
export function campSurveyBlockHtml(name: string, survey: Record<string, string | string[]> | null | undefined, questions: CampSurveyQuestionLike[]): string {
  if (!surveyHasAnswers(survey, questions)) return '';
  const rows: string[] = [];
  for (const q of questions) {
    const v = survey![q.id];
    if (v == null || (Array.isArray(v) && v.length === 0) || v === '') continue;
    const text = Array.isArray(v) ? v.map((x) => answerLabel(q.id, x)).join(', ') : answerLabel(q.id, v);
    rows.push(`<tr><td style="padding:2px 12px 2px 0;color:#5b6b7a;vertical-align:top;">${esc(q.label)}</td><td style="padding:2px 0;color:#1E2B38;">${esc(text)}</td></tr>`);
  }
  if (rows.length === 0) return '';
  return `<p style="margin:12px 0 4px;font-weight:700;color:#1E2B38;">${esc(name)}</p>` +
    `<table style="border-collapse:collapse;font-size:13px;margin:0 0 4px;">${rows.join('')}</table>`;
}

/** The full camp confirmation block appended above the receipt table, or ''
 *  if there is nothing to show (no athlete has survey answers AND no
 *  add-ons were purchased) — a camp entry with neither doesn't need the
 *  section at all. */
export function buildCampConfirmationHtml(input: CampConfirmationInput): string {
  const surveyBlocks = input.athletes
    .map((a) => campSurveyBlockHtml(a.name, a.survey, a.questions))
    .filter((h) => h.length > 0);
  const hasAddons = input.addonLabels.length > 0;
  if (surveyBlocks.length === 0 && !hasAddons) return '';

  const surveySection = surveyBlocks.length
    ? `<p style="margin:0 0 4px;font-weight:700;color:#1E2B38;">Registrant survey answers</p>${surveyBlocks.join('')}`
    : '';
  const addonSection = hasAddons
    ? `<p style="margin:12px 0 4px;font-weight:700;color:#1E2B38;">Add-ons purchased</p>` +
      `<ul style="margin:0 0 4px;padding-left:18px;color:#1E2B38;">${input.addonLabels.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`
    : '';

  return `<div style="margin:16px 0;padding:12px 14px;border-left:3px solid #F4694A;background:#f7f9fb;">` +
    `<p style="margin:0 0 8px;font-weight:700;color:#1E2B38;">Camp details</p>` +
    surveySection + addonSection +
    `<p style="margin:12px 0 0;font-size:13px;"><a href="${input.editUrl}" style="color:#F4694A;">Edit your registration / survey answers</a></p>` +
    `</div>`;
}
