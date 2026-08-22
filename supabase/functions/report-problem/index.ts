// report-problem — in-app "Report a problem" (nav-drawer entry point, any
// signed-in user). Validates the payload, resolves the reporter's identity
// SERVER-SIDE from the JWT (never trusts a client-sent name/email), and
// routes ONE email to the recipients for the chosen category. Replies go
// straight to the reporter via `reply_to`.
//
// verify_jwt stays TRUE (default) — this is NOT one of the no-verify-jwt trio
// (stripe-webhook / sms-webhook / notify-manager-access-denied).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendOne } from '../_shared/resend.ts';
import { renderEmail } from '../_shared/email-layout.ts';
import { validateAttachments } from '../_shared/attachment-validation.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const DESCRIPTION_MAX = 5000;
const RECENT_ERROR_MAX = 10;
const RECENT_ERROR_MSG_MAX = 500;
const ROUTE_MAX = 300;
const VERSION_MAX = 100;

type Category = 'bug' | 'question' | 'unsure';
const CATEGORIES: Category[] = ['bug', 'question', 'unsure'];
const CATEGORY_LABEL: Record<Category, string> = {
  bug: "The website isn't working correctly",
  question: 'I have a question about an event, rule, or policy',
  unsure: "I'm not sure",
};

// Clearly-marked routing map — referenced by docs/stripe-go-live-checklist.md
// and the deferred/TODO notes; keep in sync if recipients ever change.
const ROUTES: Record<Category, string[]> = {
  bug: ['nssharpe@gmail.com', 'jzsharpe@gmail.com'],
  question: ['jzsharpe+ucghelp@gmail.com', 'nssharpe+ucghelp@gmail.com'],
  unsure: ['nssharpe@gmail.com', 'jzsharpe@gmail.com', 'jzsharpe+ucghelp@gmail.com', 'nssharpe+ucghelp@gmail.com'],
};

interface RecentErrorIn { message?: unknown; at?: unknown }

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
  let body: {
    category?: unknown;
    description?: unknown;
    route?: unknown;
    appVersion?: unknown;
    recentErrors?: unknown;
    attachments?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'Invalid JSON body.' }, 400);
  }

  const category = body.category as Category;
  if (typeof category !== 'string' || !CATEGORIES.includes(category)) {
    return json({ ok: false, error: 'category must be one of bug, question, unsure.' }, 400);
  }

  const description = typeof body.description === 'string' ? body.description.trim() : '';
  if (!description) return json({ ok: false, error: 'description is required.' }, 400);
  const descriptionSafe = description.slice(0, DESCRIPTION_MAX);

  const route = typeof body.route === 'string' ? body.route.slice(0, ROUTE_MAX) : '';
  const appVersion = typeof body.appVersion === 'string' ? body.appVersion.slice(0, VERSION_MAX) : 'unknown';

  const recentErrorsIn = Array.isArray(body.recentErrors) ? (body.recentErrors as RecentErrorIn[]) : [];
  const recentErrors = recentErrorsIn.slice(0, RECENT_ERROR_MAX).map((e) => {
    const at = typeof e?.at === 'string' ? e.at : '';
    const message = typeof e?.message === 'string' ? e.message : typeof e === 'string' ? e : '';
    const line = at ? `${at} — ${message}` : message;
    return line.slice(0, RECENT_ERROR_MSG_MAX);
  }).filter((l) => l.length > 0);

  // --- Validate optional screenshot attachments (count/type/size/magic-bytes) ---
  const attachmentResult = validateAttachments(body.attachments);
  if (!attachmentResult.ok) {
    return json({ ok: false, error: attachmentResult.error ?? 'Invalid attachments.' }, 400);
  }
  const attachments = attachmentResult.attachments;

  // --- Resolve the reporter SERVER-SIDE (never trust client-sent identity) ---
  const { data: caller } = await db
    .from('people')
    .select('id, first_name, last_name, email')
    .eq('auth_user_id', userData.user.id)
    .maybeSingle();
  const reporterEmail = (caller?.email ?? userData.user.email ?? '').trim();
  const reporterName = caller ? `${caller.first_name} ${caller.last_name}`.trim() : '';
  const reporterLabel = reporterName ? `${reporterName}${reporterEmail ? ` (${reporterEmail})` : ''}` : (reporterEmail || 'Unknown reporter');
  const userAgent = req.headers.get('user-agent') ?? null;

  const recipients = ROUTES[category];

  // --- Persist a durable row FIRST, so it exists even if the email send
  // below fails (Resend outage, bad recipient, etc.) — the admin "Errors &
  // Problems" page is now the review path, the email is only the alerting
  // path. Insert failure must not block the email either way: log it to
  // error_logs and keep going, mirroring process-refund's
  // insert(...).then(() => {}, () => {}) fire-and-forget idiom.
  const { error: insertErr } = await db.from('problem_reports').insert({
    auth_user_id: userData.user.id,
    reporter_person_id: caller?.id ?? null,
    reporter_email: reporterEmail || null,
    reporter_name: reporterName || null,
    category,
    description: descriptionSafe,
    route: route || null,
    app_version: appVersion,
    user_agent: userAgent,
    recent_errors: recentErrors.length ? recentErrors : null,
    attachment_count: attachments.length,
  });
  // PostgREST insert errors resolve, not reject — check `.error`, not a
  // catch. Never blocks the email below either way (fire-and-forget log).
  if (insertErr) {
    await db.from('error_logs').insert({
      context: 'report-problem',
      message: `Failed to persist problem_reports row: ${insertErr.message}`,
      detail: { category, route },
    }).then(() => {}, () => {});
  }

  const errorsBlock = recentErrors.length
    ? `<p style="margin:16px 0 4px;font-weight:700;">Recent console errors</p>
<pre style="background:#f4f4f4;border-radius:6px;padding:10px;font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word;margin:0;">${esc(recentErrors.join('\n'))}</pre>`
    : '';
  const attachmentsBlock = attachments.length
    ? `<p><strong>Screenshots:</strong> ${attachments.length} attached</p>`
    : '';

  const html = renderEmail({
    heading: `Problem report — ${CATEGORY_LABEL[category]}`,
    bodyHtml: `<p><strong>Category:</strong> ${esc(CATEGORY_LABEL[category])}</p>
<p><strong>Reporter:</strong> ${esc(reporterLabel)}</p>
<p><strong>Route:</strong> ${esc(route || '(unknown)')}</p>
<p><strong>App version:</strong> ${esc(appVersion)}</p>
${attachmentsBlock}
<p style="margin:16px 0 4px;font-weight:700;">Description</p>
<p style="white-space:pre-wrap;">${esc(descriptionSafe)}</p>
${errorsBlock}`,
  });

  try {
    await sendOne({
      to: recipients,
      subject: `[UCG] Problem report: ${CATEGORY_LABEL[category]}`,
      html,
      ...(reporterEmail ? { reply_to: reporterEmail } : {}),
      ...(attachments.length ? { attachments: attachments.map((a) => ({ filename: a.filename, content: a.dataBase64 })) } : {}),
    });
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }

  return json({ ok: true });
});
