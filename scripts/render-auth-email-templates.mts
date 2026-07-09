// Renders the Supabase Auth email templates (supabase/templates/*.html) from the
// SAME shared layout the Resend emails use (supabase/functions/_shared/email-layout.ts),
// so all outbound email shares one design. Go-template variables ({{ .ConfirmationURL }}
// etc.) are left for Supabase Auth to interpolate.
//
// Run:   node --experimental-strip-types scripts/render-auth-email-templates.mts
// Apply: supabase config push                                   (prod, linked)
//        supabase config push --project-ref xogpiksqtkayxwmczlbx (staging)
// (config.toml's [auth.email.template.*] points at the generated files.)
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderEmail } from '../supabase/functions/_shared/email-layout.ts';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'supabase', 'templates');
mkdirSync(outDir, { recursive: true });

const templates: Record<string, string> = {
  confirmation: renderEmail({
    heading: 'Confirm your account',
    bodyHtml:
      '<p style="margin:0 0 12px;">Welcome to United Club Gymnastics! Confirm your email address to finish setting up your account.</p>',
    cta: { text: 'Confirm my account', href: '{{ .ConfirmationURL }}' },
    footnoteHtml:
      'If you didn&rsquo;t create a UCG account, you can safely ignore this email.',
  }),
  invite: renderEmail({
    heading: 'You&rsquo;re invited',
    bodyHtml:
      '<p style="margin:0 0 12px;">You&rsquo;ve been invited to join the United Club Gymnastics platform. Accept the invitation to set your password and get started.</p>',
    cta: { text: 'Accept invitation', href: '{{ .ConfirmationURL }}' },
    footnoteHtml:
      'If you weren&rsquo;t expecting this invitation, you can safely ignore this email.',
  }),
  magic_link: renderEmail({
    heading: 'Your sign-in link',
    bodyHtml:
      '<p style="margin:0 0 12px;">Use the button below to sign in to United Club Gymnastics. This link can only be used once.</p>',
    cta: { text: 'Sign in', href: '{{ .ConfirmationURL }}' },
    footnoteHtml:
      'If you didn&rsquo;t request this link, you can safely ignore this email &mdash; your account is unchanged.',
  }),
  recovery: renderEmail({
    heading: 'Reset your password',
    bodyHtml:
      '<p style="margin:0 0 12px;">We received a request to reset the password for your United Club Gymnastics account. Use the button below to choose a new one.</p>',
    cta: { text: 'Set a new password', href: '{{ .ConfirmationURL }}' },
    footnoteHtml:
      'If you didn&rsquo;t request a password reset, you can safely ignore this email &mdash; your password is unchanged.',
  }),
  email_change: renderEmail({
    heading: 'Confirm your new email',
    bodyHtml:
      '<p style="margin:0 0 12px;">We received a request to change your United Club Gymnastics sign-in email from <strong>{{ .Email }}</strong> to <strong>{{ .NewEmail }}</strong>. Confirm the change below.</p>',
    cta: { text: 'Confirm email change', href: '{{ .ConfirmationURL }}' },
    footnoteHtml:
      'If you didn&rsquo;t request this change, contact us &mdash; do not click the button.',
  }),
  reauthentication: renderEmail({
    heading: 'Your verification code',
    bodyHtml:
      '<p style="margin:0 0 12px;">Enter this code to confirm it&rsquo;s you:</p>' +
      '<p style="margin:0;font-size:28px;font-weight:700;letter-spacing:6px;color:#1E2B38;">{{ .Token }}</p>',
    footnoteHtml:
      'If you didn&rsquo;t request a code, you can safely ignore this email.',
  }),
};

for (const [name, html] of Object.entries(templates)) {
  writeFileSync(join(outDir, `${name}.html`), html + '\n');
  console.log(`wrote supabase/templates/${name}.html`);
}
