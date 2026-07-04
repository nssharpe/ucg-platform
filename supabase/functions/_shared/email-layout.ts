// _shared/email-layout.ts — shared branded HTML wrapper for all outbound emails.
//
// Matches the look of Supabase's magic-link sign-in email (dark navy header with
// the UCG wordmark, white card, orange CTA button, muted footer) so every email
// the platform sends — Resend or Supabase Auth — reads as one product.

export interface EmailLayoutOptions {
  /** Card heading, e.g. "Your sign-in link". */
  heading: string;
  /** Inner content — plain text or simple inline-styled HTML (paragraphs, tables). */
  bodyHtml: string;
  /** Optional single call-to-action button. */
  cta?: { text: string; href: string };
  /** Small print under the body/CTA — expiry notes, "ignore if unexpected", etc. */
  footnoteHtml?: string;
}

const NAVY = '#1a2634';
const NAVY_SUB = '#8fa1b3';
const ORANGE = '#ef6a45';
const TEXT = '#1d2a38';
const MUTED = '#5b6b7a';
// Must stay >=4.5:1 against BG for AA — #9aa7b4 (the original pick) only hit ~2.2:1.
const FOOTER_MUTED = '#5b6b7a';
const BG = '#eef1f4';

export function renderEmail({ heading, bodyHtml, cta, footnoteHtml }: EmailLayoutOptions): string {
  const ctaHtml = cta
    ? `<div style="margin:24px 0 4px;">
<a href="${cta.href}" style="display:inline-block;background:${ORANGE};color:#ffffff;font-weight:700;font-size:15px;text-decoration:none;padding:14px 26px;border-radius:8px;">${cta.text}</a>
</div>`
    : '';
  const footnote = footnoteHtml
    ? `<p style="color:${MUTED};font-size:12px;line-height:1.5;margin:20px 0 0;">${footnoteHtml}</p>`
    : '';
  return `<div style="background:${BG};padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" style="max-width:560px;margin:0 auto;border-collapse:collapse;background:#ffffff;border-radius:10px;overflow:hidden;">
<tr><td style="background:${NAVY};padding:28px 32px;">
<div style="color:#ffffff;font-size:22px;font-weight:800;letter-spacing:0.3px;">UCG<span style="color:${ORANGE};">.</span></div>
<div style="color:${NAVY_SUB};font-size:11px;font-weight:600;letter-spacing:1.5px;margin-top:4px;">UNITED CLUB GYMNASTICS</div>
</td></tr>
<tr><td style="padding:32px;">
<h1 style="color:${TEXT};font-size:19px;font-weight:700;margin:0 0 12px;">${heading}</h1>
<div style="color:${MUTED};font-size:15px;line-height:1.6;">${bodyHtml}</div>
${ctaHtml}
${footnote}
</td></tr>
</table>
<p style="text-align:center;color:${FOOTER_MUTED};font-size:12px;margin:20px 0 0;">
United Club Gymnastics &middot; For the love of the sport.<br>
<a href="https://naigc.org" style="color:${FOOTER_MUTED};text-decoration:underline;">naigc.org</a>
</p>
</div>`;
}
