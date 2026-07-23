import { describe, it, expect } from 'vitest';
import { campSurveyBlockHtml, buildCampConfirmationHtml, campSurveyQuestionsOfConfig, type CampSurveyQuestionLike } from '../supabase/functions/_shared/camp-confirmation';

// The legacy 4-question survey, resolved the same way a pre-2026-07-23 event
// (no `camp_config.survey`) resolves — reused across tests so they exercise
// the real legacy-derivation path rather than a hand-rolled fixture.
const legacyQuestions = campSurveyQuestionsOfConfig(undefined).questions;

const customQuestions: CampSurveyQuestionLike[] = [
  { id: 'q-1', label: 'Favorite color?', type: 'text', required: true },
  { id: 'q-2', label: 'T-shirt style', type: 'single', options: ['Crew', 'V-neck'], required: true },
  { id: 'q-3', label: 'Activities interested in', type: 'multi', options: ['Archery', 'Swimming', 'Crafts'], required: false },
];

describe('campSurveyQuestionsOfConfig', () => {
  it('derives the legacy 4-question survey (enabled=false) when no config at all', () => {
    const { enabled, questions } = campSurveyQuestionsOfConfig(undefined);
    expect(enabled).toBe(false);
    expect(questions.map((q) => q.id)).toEqual(['bedtime', 'noiseLevel', 'cabinGenderPref', 'roommateRequest']);
    expect(questions.find((q) => q.id === 'roommateRequest')?.required).toBe(false);
    expect(questions.find((q) => q.id === 'bedtime')?.required).toBe(true);
  });

  it('honors legacy surveyMandatory overrides', () => {
    const { questions } = campSurveyQuestionsOfConfig({ overnightSurvey: true, surveyMandatory: { bedtime: false, roommateRequest: true } });
    expect(questions.find((q) => q.id === 'bedtime')?.required).toBe(false);
    expect(questions.find((q) => q.id === 'roommateRequest')?.required).toBe(true);
  });

  it('prefers the new `survey` shape when present', () => {
    const resolved = campSurveyQuestionsOfConfig({ survey: { enabled: true, questions: customQuestions } });
    expect(resolved.enabled).toBe(true);
    expect(resolved.questions).toBe(customQuestions);
  });
});

describe('campSurveyBlockHtml', () => {
  it('returns empty string when the survey is absent', () => {
    expect(campSurveyBlockHtml('Jane Doe', null, legacyQuestions)).toBe('');
    expect(campSurveyBlockHtml('Jane Doe', undefined, legacyQuestions)).toBe('');
  });

  it('returns empty string when the survey has no answered fields', () => {
    expect(campSurveyBlockHtml('Jane Doe', {}, legacyQuestions)).toBe('');
  });

  it('renders human-readable labels for answered legacy fields', () => {
    const html = campSurveyBlockHtml('Jane Doe', {
      bedtime: '10-to-midnight',
      noiseLevel: 'quiet',
      cabinGenderPref: 'Female',
      roommateRequest: 'With my sister',
    }, legacyQuestions);
    expect(html).toContain('Jane Doe');
    expect(html).toContain('10pm–midnight');
    expect(html).toContain('Quiet');
    expect(html).toContain('Female');
    expect(html).toContain('With my sister');
  });

  it('omits rows for unanswered fields but renders answered ones', () => {
    const html = campSurveyBlockHtml('Jane Doe', { bedtime: 'before-10' }, legacyQuestions);
    expect(html).toContain('Before 10pm');
    expect(html).not.toContain('preferred noise level');
    expect(html).not.toContain('co-ed or single gender');
    expect(html).not.toContain('roommate requests');
  });

  it('escapes HTML in name and free-text fields', () => {
    const html = campSurveyBlockHtml('<b>Jane</b>', { roommateRequest: '<script>x</script>' }, legacyQuestions);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<b>Jane</b>');
  });

  it('renders custom questions generically, including a multi-select as a joined list', () => {
    const html = campSurveyBlockHtml('Jane Doe', {
      'q-1': 'Blue',
      'q-2': 'V-neck',
      'q-3': ['Archery', 'Crafts'],
    }, customQuestions);
    expect(html).toContain('Favorite color?');
    expect(html).toContain('Blue');
    expect(html).toContain('T-shirt style');
    expect(html).toContain('V-neck');
    expect(html).toContain('Activities interested in');
    expect(html).toContain('Archery, Crafts');
  });
});

describe('buildCampConfirmationHtml', () => {
  const editUrl = 'https://example.com/#/me/registrations';

  it('returns empty string when nothing to show', () => {
    expect(buildCampConfirmationHtml({ athletes: [], addonLabels: [], editUrl })).toBe('');
    expect(buildCampConfirmationHtml({
      athletes: [{ name: 'Jane', survey: null, questions: legacyQuestions }],
      addonLabels: [],
      editUrl,
    })).toBe('');
  });

  it('renders the survey section when at least one athlete answered', () => {
    const html = buildCampConfirmationHtml({
      athletes: [
        { name: 'Jane Doe', survey: { bedtime: 'before-10' }, questions: legacyQuestions },
        { name: 'No Survey Kid', survey: null, questions: legacyQuestions },
      ],
      addonLabels: [],
      editUrl,
    });
    expect(html).toContain('Registrant survey answers');
    expect(html).toContain('Jane Doe');
    expect(html).not.toContain('No Survey Kid');
    expect(html).not.toContain('Add-ons purchased');
  });

  it('renders the add-ons section when add-ons were purchased, even with no survey answers', () => {
    const html = buildCampConfirmationHtml({
      athletes: [{ name: 'Jane Doe', survey: null, questions: legacyQuestions }],
      addonLabels: ['Camp t-shirt — Jane Doe (size YM)'],
      editUrl,
    });
    expect(html).not.toContain('Registrant survey answers');
    expect(html).toContain('Add-ons purchased');
    expect(html).toContain('Camp t-shirt');
  });

  it('always includes the edit link when the block renders', () => {
    const html = buildCampConfirmationHtml({
      athletes: [{ name: 'Jane Doe', survey: { noiseLevel: 'lively' }, questions: legacyQuestions }],
      addonLabels: [],
      editUrl,
    });
    expect(html).toContain(editUrl);
    expect(html).toContain('Edit your registration');
  });

  it('renders each athlete against their own event\'s custom questions', () => {
    const html = buildCampConfirmationHtml({
      athletes: [{ name: 'Jane Doe', survey: { 'q-1': 'Green' }, questions: customQuestions }],
      addonLabels: [],
      editUrl,
    });
    expect(html).toContain('Favorite color?');
    expect(html).toContain('Green');
  });
});
