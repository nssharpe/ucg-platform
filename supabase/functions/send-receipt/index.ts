// send-receipt — email the CALLER their own purchase confirmation + HTML receipt.
//
// Called best-effort by a signed-in member (or club manager) right after a
// checkout completes. Builds a clean, AA-contrast HTML receipt from the line
// items + total in the payload and emails it to the caller's OWN email address,
// which is resolved server-side from their linked people row (auth_user_id
// match) — the client cannot redirect the receipt to someone else.
//
// Why a service-role notify-style function instead of the admin-gated
// `send-email`: a regular member checking out their own memberships is NOT an
// admin, so they can't use `send-email`. This function allows any signed-in
// caller and self-resolves the recipient, so it works regardless of who pays.
//
// Auth: any signed-in user. Recipient = the caller's own people.email.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendOne } from '../_shared/resend.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Amounts are whole dollars (e.g. 35 → "$35.00"), matching the app's fmtMoney.
const fmtMoney = (dollars: number) =>
  `$${dollars.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

interface Item { label?: string; amount?: number; kind?: string }

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  // --- Authenticate (any signed-in user) ---
  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return json({ ok: false, error: 'Missing Authorization header.' }, 401);

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const { data: userData, error: userErr } = await db.auth.getUser(token);
  if (userErr || !userData.user) return json({ ok: false, error: 'Invalid or expired session.' }, 401);

  // --- Validate payload ---
  let body: { items?: Item[]; total?: number; invoiceNumber?: string; couponCode?: string };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON body.' }, 400);
  }

  const items = (body.items ?? []).filter((i) => i && typeof i.label === 'string');
  if (items.length === 0) return json({ ok: false, error: 'No items to receipt.' }, 400);

  // --- Resolve the recipient: the caller's OWN person row ---
  const { data: caller } = await db
    .from('people')
    .select('first_name, last_name, email')
    .eq('auth_user_id', userData.user.id)
    .maybeSingle();
  if (!caller) return json({ ok: false, error: 'No linked person for caller.' }, 403);

  const toEmail = (caller.email ?? '').trim();
  if (!EMAIL_RE.test(toEmail)) {
    return json({ ok: true, sent: false, note: 'Caller has no valid email.' });
  }
  const forName = `${caller.first_name ?? ''} ${caller.last_name ?? ''}`.trim() || 'Member';

  // --- Compose the receipt ---
  // Full-price lines (discount lines summarised separately, mirroring receipt.ts).
  const fullLines = items.filter((i) => i.kind !== 'discount');
  const discountTotal = -items
    .filter((i) => i.kind === 'discount')
    .reduce((s, i) => s + (typeof i.amount === 'number' ? i.amount : 0), 0);
  const total = typeof body.total === 'number'
    ? body.total
    : items.reduce((s, i) => s + (typeof i.amount === 'number' ? i.amount : 0), 0);

  const rows = fullLines
    .map((i) => `<tr><td style="padding:6px 16px 6px 0;color:#1d2a38;">${esc(i.label!)}</td>` +
      `<td style="padding:6px 0;text-align:right;white-space:nowrap;color:#1d2a38;">${fmtMoney(i.amount ?? 0)}</td></tr>`)
    .join('');
  const discountRow = discountTotal > 0
    ? `<tr><td style="padding:6px 16px 6px 0;color:#5b6b7a;">Promo code${body.couponCode ? ` (${esc(body.couponCode)})` : ''}</td>` +
      `<td style="padding:6px 0;text-align:right;white-space:nowrap;color:#5b6b7a;">&minus;${fmtMoney(discountTotal)}</td></tr>`
    : '';
  const numberLine = body.invoiceNumber ? `<p style="color:#5b6b7a;font-size:13px;margin:0 0 12px;">Receipt ${esc(body.invoiceNumber)}</p>` : '';

  const subject = 'Your United Club Gymnastics membership receipt';
  const html = `<div style="color:#1d2a38;font-size:15px;line-height:1.55;">
<p>Hi ${esc(forName)},</p>
<p>Thanks for your purchase. Here's your receipt — your membership is now active.</p>
${numberLine}
<table style="border-collapse:collapse;margin:8px 0;font-size:14px;">
${rows}${discountRow}
<tr><td style="padding:10px 16px 0 0;border-top:2px solid #1d2a38;font-weight:700;color:#1d2a38;">Total paid</td>
<td style="padding:10px 0 0;border-top:2px solid #1d2a38;text-align:right;font-weight:700;color:#1d2a38;">${fmtMoney(total)}</td></tr>
</table>
<p style="color:#5b6b7a;font-size:12px;">Billed to ${esc(forName)} (${esc(toEmail)}). You can re-download a PDF receipt any time from your Purchase History on the platform.</p>
</div>`;

  try {
    await sendOne({ to: `${forName} <${toEmail}>`, subject, html });
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
  return json({ ok: true, sent: true });
});
