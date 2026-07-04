import { describe, it, expect } from 'vitest';
import { renderEmail } from '../supabase/functions/_shared/email-layout';

describe('renderEmail', () => {
  it('renders heading and body', () => {
    const html = renderEmail({ heading: 'Your sign-in link', bodyHtml: '<p>Hi Jane,</p>' });
    expect(html).toContain('Your sign-in link');
    expect(html).toContain('<p>Hi Jane,</p>');
    expect(html).toContain('UNITED CLUB GYMNASTICS');
  });

  it('omits the CTA block when no cta is given', () => {
    const html = renderEmail({ heading: 'No CTA here', bodyHtml: '<p>Body</p>' });
    expect(html).not.toContain('display:inline-block');
  });

  it('renders the CTA button with the given text and href', () => {
    const html = renderEmail({
      heading: 'Set up your account',
      bodyHtml: '<p>Body</p>',
      cta: { text: 'Set your password', href: 'https://example.com/reset' },
    });
    expect(html).toContain('Set your password');
    expect(html).toContain('href="https://example.com/reset"');
  });

  it('omits the footnote block when none is given', () => {
    const html = renderEmail({ heading: 'No footnote', bodyHtml: '<p>Body</p>' });
    expect(html).not.toMatch(/font-size:12px;line-height:1.5/);
  });

  it('renders a footnote when given', () => {
    const html = renderEmail({ heading: 'Has footnote', bodyHtml: '<p>Body</p>', footnoteHtml: 'Ignore if unexpected.' });
    expect(html).toContain('Ignore if unexpected.');
  });
});
