import { describe, it, expect } from 'vitest';
import { confirmationSubject, hostMessageCardHtml, registeredForLineHtml } from '../supabase/functions/_shared/registration-confirmation';

describe('confirmationSubject', () => {
  it('falls back to the generic receipt subject for zero events (membership-only purchase)', () => {
    expect(confirmationSubject([])).toBe('Your United Club Gymnastics receipt');
    expect(confirmationSubject([null, undefined, ''])).toBe('Your United Club Gymnastics receipt');
  });

  it('names the one event when exactly one distinct event is referenced', () => {
    expect(confirmationSubject(['ZZTEST_MIT Sanction'])).toBe('ZZTEST_MIT Sanction Registration Confirmation');
  });

  it('treats repeated references to the same event as ONE distinct event', () => {
    expect(confirmationSubject(['Spring Open', 'Spring Open', 'Spring Open'])).toBe('Spring Open Registration Confirmation');
  });

  it('ignores blank entries when counting distinct events', () => {
    expect(confirmationSubject(['Spring Open', null, '', 'Spring Open'])).toBe('Spring Open Registration Confirmation');
  });

  it('falls back to the generic subject for MULTIPLE distinct events', () => {
    expect(confirmationSubject(['Spring Open', 'Fall Classic'])).toBe('Your United Club Gymnastics receipt');
  });
});

describe('hostMessageCardHtml', () => {
  it('returns empty string for no message', () => {
    expect(hostMessageCardHtml('')).toBe('');
    expect(hostMessageCardHtml(undefined)).toBe('');
    expect(hostMessageCardHtml(null)).toBe('');
    expect(hostMessageCardHtml('   ')).toBe('');
  });

  it('labels the card "A message from your host" (not the event name)', () => {
    const html = hostMessageCardHtml('<p>Bring your own leotard.</p>');
    expect(html).toContain('A message from your host');
    expect(html).not.toContain('A message from the event');
  });

  it('renders host bodyHtml AS-IS, never escaped (host-authored HTML)', () => {
    const html = hostMessageCardHtml('<strong>Bold</strong> & <em>italic</em>');
    expect(html).toContain('<strong>Bold</strong> & <em>italic</em>');
  });
});

describe('registeredForLineHtml', () => {
  it('returns empty string for no events', () => {
    expect(registeredForLineHtml([])).toBe('');
  });

  it('renders one line per distinct event, HTML-escaped', () => {
    const html = registeredForLineHtml(['Spring <Open>', 'Spring <Open>', 'Fall Classic']);
    expect(html).toBe("<p>You're registered for Spring &lt;Open&gt;.</p><p>You're registered for Fall Classic.</p>");
  });
});
