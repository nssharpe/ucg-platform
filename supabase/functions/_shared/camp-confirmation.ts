// _shared/camp-confirmation.ts — pure HTML-building for the camp confirmation
// block appended to stripe-webhook's receipt email (event-mgmt v2 Phase 2
// §G). NO Deno/Supabase imports here — unit-tested by vitest under node
// (tests/camp-confirmation.test.ts) and imported by stripe-webhook at
// runtime, mirroring the event-comm.ts / owner-checklist.ts pattern.
//
// This module only formats already-resolved data (athlete names, survey
// answers, add-on labels) into HTML fragments — it does no DB work and makes
// no assumptions about how the caller fetched that data, so a failure
// upstream (a query error, a missing field) never has to touch this file to
// stay contained: the CALLER wraps the whole build in try/catch and falls
// back to '' (see stripe-webhook/index.ts).

const CAMP_BEDTIME_LABELS: Record<string, string> = {
  'before-10': 'Before 10pm',
  '10-to-midnight': '10pm–midnight',
  'after-midnight': 'After midnight',
};
const CAMP_NOISE_LABELS: Record<string, string> = {
  quiet: 'Quiet',
  moderate: 'Moderate',
  lively: 'Lively',
};

export interface CampSurveyLike {
  bedtime?: string | null;
  noiseLevel?: string | null;
  cabinGenderPref?: string | null;
  roommateRequest?: string | null;
}

export interface CampAthleteSurvey {
  name: string;
  survey: CampSurveyLike | null | undefined;
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

/** True iff a survey object has at least one answered field. */
function surveyHasAnswers(survey: CampSurveyLike | null | undefined): boolean {
  if (!survey) return false;
  return !!(survey.bedtime || survey.noiseLevel || survey.cabinGenderPref || survey.roommateRequest);
}

/** One athlete's survey answers as a definition-list-style HTML block, or ''
 *  if nothing was answered (the survey is off/absent for this athlete). */
export function campSurveyBlockHtml(name: string, survey: CampSurveyLike | null | undefined): string {
  if (!surveyHasAnswers(survey)) return '';
  const rows: string[] = [];
  if (survey!.bedtime) rows.push(`<tr><td style="padding:2px 12px 2px 0;color:#5b6b7a;">Bedtime</td><td style="padding:2px 0;color:#1E2B38;">${esc(CAMP_BEDTIME_LABELS[survey!.bedtime!] ?? survey!.bedtime!)}</td></tr>`);
  if (survey!.noiseLevel) rows.push(`<tr><td style="padding:2px 12px 2px 0;color:#5b6b7a;">Noise level</td><td style="padding:2px 0;color:#1E2B38;">${esc(CAMP_NOISE_LABELS[survey!.noiseLevel!] ?? survey!.noiseLevel!)}</td></tr>`);
  if (survey!.cabinGenderPref) rows.push(`<tr><td style="padding:2px 12px 2px 0;color:#5b6b7a;">Cabin preference</td><td style="padding:2px 0;color:#1E2B38;">${esc(survey!.cabinGenderPref!)}</td></tr>`);
  if (survey!.roommateRequest) rows.push(`<tr><td style="padding:2px 12px 2px 0;color:#5b6b7a;vertical-align:top;">Roommate request</td><td style="padding:2px 0;color:#1E2B38;">${esc(survey!.roommateRequest!)}</td></tr>`);
  return `<p style="margin:12px 0 4px;font-weight:700;color:#1E2B38;">${esc(name)}</p>` +
    `<table style="border-collapse:collapse;font-size:13px;margin:0 0 4px;">${rows.join('')}</table>`;
}

/** The full camp confirmation block appended above the receipt table, or ''
 *  if there is nothing to show (no athlete has survey answers AND no
 *  add-ons were purchased) — a camp entry with neither doesn't need the
 *  section at all. */
export function buildCampConfirmationHtml(input: CampConfirmationInput): string {
  const surveyBlocks = input.athletes
    .map((a) => campSurveyBlockHtml(a.name, a.survey))
    .filter((h) => h.length > 0);
  const hasAddons = input.addonLabels.length > 0;
  if (surveyBlocks.length === 0 && !hasAddons) return '';

  const surveySection = surveyBlocks.length
    ? `<p style="margin:0 0 4px;font-weight:700;color:#1E2B38;">Overnight stay preferences</p>${surveyBlocks.join('')}`
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
