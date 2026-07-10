import { describe, it, expect } from 'vitest';
import { campSurveyBlockHtml, buildCampConfirmationHtml } from '../supabase/functions/_shared/camp-confirmation';

describe('campSurveyBlockHtml', () => {
  it('returns empty string when the survey is absent', () => {
    expect(campSurveyBlockHtml('Jane Doe', null)).toBe('');
    expect(campSurveyBlockHtml('Jane Doe', undefined)).toBe('');
  });

  it('returns empty string when the survey has no answered fields', () => {
    expect(campSurveyBlockHtml('Jane Doe', {})).toBe('');
  });

  it('renders human-readable labels for answered fields', () => {
    const html = campSurveyBlockHtml('Jane Doe', {
      bedtime: '10-to-midnight',
      noiseLevel: 'quiet',
      cabinGenderPref: 'Female',
      roommateRequest: 'With my sister',
    });
    expect(html).toContain('Jane Doe');
    expect(html).toContain('10pm–midnight');
    expect(html).toContain('Quiet');
    expect(html).toContain('Female');
    expect(html).toContain('With my sister');
  });

  it('omits rows for unanswered fields but renders answered ones', () => {
    const html = campSurveyBlockHtml('Jane Doe', { bedtime: 'before-10' });
    expect(html).toContain('Before 10pm');
    expect(html).not.toContain('Noise level');
    expect(html).not.toContain('Cabin preference');
    expect(html).not.toContain('Roommate request');
  });

  it('escapes HTML in name and free-text fields', () => {
    const html = campSurveyBlockHtml('<b>Jane</b>', { roommateRequest: '<script>x</script>' });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<b>Jane</b>');
  });
});

describe('buildCampConfirmationHtml', () => {
  const editUrl = 'https://example.com/#/me/registrations';

  it('returns empty string when nothing to show', () => {
    expect(buildCampConfirmationHtml({ athletes: [], addonLabels: [], editUrl })).toBe('');
    expect(buildCampConfirmationHtml({
      athletes: [{ name: 'Jane', survey: null }],
      addonLabels: [],
      editUrl,
    })).toBe('');
  });

  it('renders the survey section when at least one athlete answered', () => {
    const html = buildCampConfirmationHtml({
      athletes: [
        { name: 'Jane Doe', survey: { bedtime: 'before-10' } },
        { name: 'No Survey Kid', survey: null },
      ],
      addonLabels: [],
      editUrl,
    });
    expect(html).toContain('Overnight stay preferences');
    expect(html).toContain('Jane Doe');
    expect(html).not.toContain('No Survey Kid');
    expect(html).not.toContain('Add-ons purchased');
  });

  it('renders the add-ons section when add-ons were purchased, even with no survey answers', () => {
    const html = buildCampConfirmationHtml({
      athletes: [{ name: 'Jane Doe', survey: null }],
      addonLabels: ['Camp t-shirt — Jane Doe (size YM)'],
      editUrl,
    });
    expect(html).not.toContain('Overnight stay preferences');
    expect(html).toContain('Add-ons purchased');
    expect(html).toContain('Camp t-shirt');
  });

  it('always includes the edit link when the block renders', () => {
    const html = buildCampConfirmationHtml({
      athletes: [{ name: 'Jane Doe', survey: { noiseLevel: 'lively' } }],
      addonLabels: [],
      editUrl,
    });
    expect(html).toContain(editUrl);
    expect(html).toContain('Edit your registration');
  });
});
