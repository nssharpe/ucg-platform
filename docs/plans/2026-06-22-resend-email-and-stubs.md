# Resend Email Transport + Dead Stub Wiring — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all email off Gmail SMTP onto Resend behind one shared helper, then wire every dead "email" stub to actually send with result-driven toasts.

**Architecture:** A dependency-free `_shared/resend.ts` helper (`sendOne` / `sendBatch` over `fetch`) replaces the per-function denomailer `SMTPClient`. Three existing functions swap transport only. Admin-initiated stubs reuse the admin-only `send-email`; non-admin-triggered stubs get new notify-style Edge Functions (any signed-in caller → authorize → resolve recipients with the service role → send), mirroring the existing `notify-club-cart`.

**Tech Stack:** Supabase Edge Functions (Deno), Resend HTTP API, React + TypeScript front end, `supabase` JS client invokers.

**Testing note:** The repo's Vitest suite is node-only and covers pure logic (`src/scoring/*`, `capabilities-core`). There is **no** harness for Deno Edge Functions or React components, so per-task verification is: (a) `npm run build` stays green for front-end edits, and (b) a **live smoke test** against the deployed function to a real inbox. This is called out explicitly per task rather than faking unit tests.

**Deploy command (every function):**
`supabase functions deploy <name> --project-ref wkyerxlgricfphopocoz` (run with the shell sandbox disabled; Docker not required).

---

## Phase 0 — Shared helper + secrets

### Task 1: Set Resend secrets

**Files:** none (Supabase project secrets).

- [ ] **Step 1: Set the secrets**

Run (sandbox disabled):
```bash
supabase secrets set RESEND_API_KEY='<the Resend key>' --project-ref wkyerxlgricfphopocoz
supabase secrets set RESEND_FROM='United Club Gymnastics <nate.sharpe@naigc.org>' --project-ref wkyerxlgricfphopocoz
```

- [ ] **Step 2: Verify they exist**

Run: `supabase secrets list --project-ref wkyerxlgricfphopocoz`
Expected: `RESEND_API_KEY` and `RESEND_FROM` appear (values are hashed). The `GMAIL_*` secrets remain listed — leave them (rollback path).

### Task 2: Create the shared Resend helper

**Files:**
- Create: `supabase/functions/_shared/resend.ts`

- [ ] **Step 1: Write the helper**

```ts
// _shared/resend.ts — Resend HTTP transport shared by all email functions.
//
// Sender is config, not code: RESEND_FROM (default onboarding@resend.dev) flips
// to the verified naigc.org address with a secret change only. RESEND_API_KEY is
// required; a missing key throws a clear, caller-surfaced error.

const EMAILS_URL = 'https://api.resend.com/emails';
const BATCH_URL = 'https://api.resend.com/emails/batch';

export function resendFrom(): string {
  return Deno.env.get('RESEND_FROM') ?? 'United Club Gymnastics <onboarding@resend.dev>';
}

function apiKey(): string {
  const key = Deno.env.get('RESEND_API_KEY');
  if (!key) throw new Error('Email is not configured: RESEND_API_KEY secret is missing.');
  return key;
}

export interface EmailMessage {
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
}

export interface BatchResult {
  ok: boolean;
  sentCount: number;
  failedCount: number;
  sent: string[];
  failed: { email: string; error: string }[];
}

const toLabel = (to: string | string[]) => (Array.isArray(to) ? to.join(',') : to);

/** Send a single message. Throws on transport/API error. */
export async function sendOne(msg: EmailMessage): Promise<{ id: string }> {
  const res = await fetch(EMAILS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: resendFrom(), to: msg.to, subject: msg.subject, html: msg.html, text: msg.text }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.message ?? `Resend error (${res.status})`);
  return { id: body?.id ?? '' };
}

/** Send many distinct messages in one request (≤100). Resend's batch endpoint
 *  keeps each message separate (no leaked recipient list). On a non-2xx the whole
 *  batch is reported failed with the API error (it validates atomically). */
export async function sendBatch(messages: EmailMessage[]): Promise<BatchResult> {
  if (messages.length === 0) return { ok: true, sentCount: 0, failedCount: 0, sent: [], failed: [] };
  const payload = messages.map((m) => ({ from: resendFrom(), to: m.to, subject: m.subject, html: m.html, text: m.text }));
  const res = await fetch(BATCH_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  const addrs = messages.map((m) => toLabel(m.to));
  if (!res.ok) {
    const error = body?.message ?? `Resend error (${res.status})`;
    return { ok: false, sentCount: 0, failedCount: messages.length, sent: [], failed: addrs.map((email) => ({ email, error })) };
  }
  return { ok: true, sentCount: messages.length, failedCount: 0, sent: addrs, failed: [] };
}
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/_shared/resend.ts
git commit -m "feat(email): add shared Resend transport helper"
```

---

## Phase 1 — Swap existing functions to Resend (transport only)

### Task 3: Migrate `send-email`

**Files:**
- Modify: `supabase/functions/send-email/index.ts`

- [ ] **Step 1: Replace the denomailer import**

Change line 19 from:
```ts
import { SMTPClient } from 'https://deno.land/x/denomailer@1.6.0/mod.ts';
```
to:
```ts
import { sendBatch, type EmailMessage } from '../_shared/resend.ts';
```

- [ ] **Step 2: Drop the Gmail env reads + guard**

Delete the `gmailUser` / `gmailPass` / `fromName` reads (lines ~52-54) and the `if (!gmailUser || !gmailPass) { ... }` guard (lines ~56-58). Keep `supabaseUrl` / `serviceKey`.

- [ ] **Step 3: Reword the recipient-cap error**

In the `recipients.length > MAX_RECIPIENTS` branch, change the message to:
```ts
      error: `This sender is capped at ${MAX_RECIPIENTS} recipients (got ${recipients.length}). ` +
        `Raise MAX_RECIPIENTS once on a paid Resend plan with a higher daily limit.`,
```

- [ ] **Step 4: Replace the SMTP send block**

Replace the whole `const client = new SMTPClient({...})` … `return json({ ok: failed.length === 0, ... })` block (lines ~101-134) with:
```ts
  // --- Send via Resend batch (one distinct message per recipient) ---
  const messages: EmailMessage[] = recipients.map((r) => ({
    to: r.name ? `${r.name} <${r.email.trim()}>` : r.email.trim(),
    subject,
    html: html || undefined,
    text: text || undefined,
  }));

  let result;
  try {
    result = await sendBatch(messages);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
  return json({
    ok: result.ok,
    sentCount: result.sentCount,
    failedCount: result.failedCount,
    sent: result.sent,
    failed: result.failed,
  });
```

- [ ] **Step 5: Deploy**

Run: `supabase functions deploy send-email --project-ref wkyerxlgricfphopocoz`
Expected: "Deployed Function send-email".

- [ ] **Step 6: Live smoke test**

In the app → **Communicate**, send a one-recipient email to your own inbox.
Expected: email arrives **from `nate.sharpe@naigc.org`**; toast reads "sent to 1 recipient".

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/send-email/index.ts
git commit -m "feat(email): send-email via Resend batch"
```

### Task 4: Migrate `request-guardian-waiver`

**Files:**
- Modify: `supabase/functions/request-guardian-waiver/index.ts`

- [ ] **Step 1: Swap import** — replace the `SMTPClient` import (line 11) with:
```ts
import { sendOne } from '../_shared/resend.ts';
```

- [ ] **Step 2: Drop Gmail env reads + guard** — remove `gmailUser` / `gmailPass` / `fromName` reads and the `if (!gmailUser || !gmailPass)` guard (lines ~34-41). Keep `appUrl`.

- [ ] **Step 3: Replace the SMTP send block** — replace `const client = new SMTPClient({...})` … `finally { ... }` (lines ~102-122) with:
```ts
  try {
    await sendOne({ to: guardianEmail, subject: `Sign the NAIGC waiver for ${athlete}`, html });
  } catch (e) {
    return json({ ok: false, error: `Email failed: ${e instanceof Error ? e.message : String(e)}` }, 500);
  }
```

- [ ] **Step 4: Deploy** — `supabase functions deploy request-guardian-waiver --project-ref wkyerxlgricfphopocoz`

- [ ] **Step 5: Live smoke test** — in the membership wizard (minor path), request a guardian signature to your own inbox. Expected: signing-link email arrives from the naigc.org sender.

- [ ] **Step 6: Commit**
```bash
git add supabase/functions/request-guardian-waiver/index.ts
git commit -m "feat(email): request-guardian-waiver via Resend"
```

### Task 5: Migrate `notify-club-cart`

**Files:**
- Modify: `supabase/functions/notify-club-cart/index.ts`

- [ ] **Step 1: Swap import** — replace the `SMTPClient` import (line 13) with:
```ts
import { sendBatch, type EmailMessage } from '../_shared/resend.ts';
```

- [ ] **Step 2: Drop Gmail env reads + guard** — remove `gmailUser` / `gmailPass` / `fromName` reads and the `if (!gmailUser || !gmailPass)` guard (lines ~44-51). Keep `appUrl`.

- [ ] **Step 3: Replace the SMTP send loop** — replace `const client = new SMTPClient({...})` … `return json({ ok: failed.length === 0, ... })` (lines ~139-164) with:
```ts
  const messages: EmailMessage[] = recipients.map((r) => ({
    to: `${r.first_name} ${r.last_name} <${r.email.trim()}>`,
    subject,
    html,
  }));
  let result;
  try {
    result = await sendBatch(messages);
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
  return json({ ok: result.ok, sentCount: result.sentCount, failedCount: result.failedCount, failed: result.failed });
```

- [ ] **Step 4: Deploy** — `supabase functions deploy notify-club-cart --project-ref wkyerxlgricfphopocoz`

- [ ] **Step 5: Live smoke test** — push a fee to a club cart where you manage the club via a second account; confirm the manager email arrives.

- [ ] **Step 6: Commit**
```bash
git add supabase/functions/notify-club-cart/index.ts
git commit -m "feat(email): notify-club-cart via Resend"
```

---

## Phase 2 — Admin-initiated stubs (reuse `send-email`)

### Task 6: Wire the account invite (#1) + Resend button

**Files:**
- Modify: `src/pages/Admin.tsx` (`createAccountInvite` ~273-297; invite button ~380-388)

- [ ] **Step 1: Add a shared invite-email helper above `createAccountInvite`**

```tsx
  // Branded account-setup invite. Claiming is by email-match at signup
  // (link_or_create_person), so the link just routes to signup and the copy
  // tells them to use THIS email. Admin-only path → reuses sendEmail.
  const sendInviteEmail = async (p: Athlete): Promise<SendEmailResult> => {
    const appUrl = window.location.origin + import.meta.env.BASE_URL.replace(/\/$/, '');
    const link = `${appUrl}/#/?signup=1`;
    const subject = 'Set up your United Club Gymnastics account';
    const html = `<p>Hi ${p.firstName},</p>
<p>An account has been created for you on the United Club Gymnastics platform.
To activate it, sign up using <strong>this email address</strong> (${p.email}):</p>
<p><a href="${link}">Create your account &rarr;</a></p>
<p>Use the same email shown above so your existing record is linked automatically.</p>`;
    return sendEmail(subject, html, [{ email: p.email, name: `${p.firstName} ${p.lastName}` }]);
  };
```

- [ ] **Step 2: Make `createAccountInvite` async, send, and toast the real result**

Replace the body from `const invite: AccountInvite = {` through the closing `toast(...)` (lines ~283-296) with:
```tsx
    const invite: AccountInvite = {
      id: `inv-${Date.now()}-${p.id.slice(0, 8)}`,
      personId: p.id,
      email: p.email,
      token: randomPromoCode(24),
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    mutate((d) => {
      d.accountInvites = [...(d.accountInvites ?? []), invite];
      pushAccountInvite(invite);
    });
    const res = await sendInviteEmail(p);
    if (res.ok && res.sentCount > 0) {
      toast(`Setup invite emailed to ${p.email}.`);
    } else {
      toast(`Invite created, but the email failed: ${res.error ?? 'unknown error'}. Use Resend to retry.`);
    }
```
Change the function signature to `const createAccountInvite = async (p: Athlete) => {`.

- [ ] **Step 3: Add a resend handler**

Add after `createAccountInvite`:
```tsx
  const resendAccountInvite = async (p: Athlete) => {
    const res = await sendInviteEmail(p);
    toast(res.ok && res.sentCount > 0
      ? `Setup invite re-sent to ${p.email}.`
      : `Resend failed: ${res.error ?? 'unknown error'}.`);
  };
```

- [ ] **Step 4: Replace the locked button with Invite / Resend**

Replace the single `<button>` block (lines ~380-388) with:
```tsx
                        {hasPendingInvite ? (
                          <button
                            className="btn small ghost"
                            style={{ fontSize: 11, padding: '1px 6px' }}
                            title="Re-send the account setup email"
                            onClick={() => resendAccountInvite(p)}
                          >
                            Resend
                          </button>
                        ) : (
                          <button
                            className="btn small ghost"
                            style={{ fontSize: 11, padding: '1px 6px' }}
                            title="Create account & email setup link"
                            onClick={() => createAccountInvite(p)}
                          >
                            Invite
                          </button>
                        )}
```

- [ ] **Step 5: Ensure `SendEmailResult` is imported**

In the `from '../lib/supabase'` import (line 15), add `type SendEmailResult` (it's exported there). If mixing value + type imports is awkward, add a separate `import type { SendEmailResult } from '../lib/supabase';`.

- [ ] **Step 6: Build**

Run: `npm run build`
Expected: "files generated"; confirm `dist/index.html` script refs resolve under `dist/assets`. Lint touched file: `npx eslint src/pages/Admin.tsx` — no NEW errors beyond pre-existing debt.

- [ ] **Step 7: Live smoke test** — Admin → Members → a person with no account: click **Invite** (email arrives, button becomes **Resend**), then click **Resend** (second email arrives).

- [ ] **Step 8: Commit**
```bash
git add src/pages/Admin.tsx
git commit -m "feat(email): account invite sends + resend button"
```

### Task 7: Wire the waiver email modal (#4)

**Files:**
- Modify: `src/pages/Profile.tsx` (`EmailWaiverModal` `onSend` ~573-580)

- [ ] **Step 1: Replace the stub `onSend` body**

Replace lines ~574-580 (`const season = ...` through `setEmailModalOpen(false);`) with:
```tsx
            const season = seasons.find((s) => s.id === seasonId);
            const typeLabel = type === 'coach' ? 'Coach' : 'Athlete';
            const appUrl = window.location.origin + import.meta.env.BASE_URL.replace(/\/$/, '');
            const link = `${appUrl}/#/membership`;
            const subject = `Action needed: sign your ${season?.name ?? ''} ${typeLabel} waiver`;
            const html = `<p>Hi ${person.firstName},</p>
<p>Please sign your <strong>${season?.name ?? ''}</strong> ${typeLabel} membership waiver
for United Club Gymnastics to keep your membership active.</p>
<p><a href="${link}">Review &amp; sign your waiver &rarr;</a></p>`;
            sendEmail(subject, html, [{ email: person.email, name: `${person.firstName} ${person.lastName}` }])
              .then((res) => toast(res.ok && res.sentCount > 0
                ? `Waiver email sent to ${person.email}.`
                : `Waiver email failed: ${res.error ?? 'unknown error'}.`));
            setEmailModalOpen(false);
```

- [ ] **Step 2: Import `sendEmail`**

Confirm `sendEmail` is imported from `../lib/supabase` in Profile.tsx; add it to the existing import if absent.

- [ ] **Step 3: Build** — `npm run build` (green) + `npx eslint src/pages/Profile.tsx` (no new errors).

- [ ] **Step 4: Live smoke test** — Admin view of a member → open the waiver email modal → pick a season/type → Send. Confirm the email arrives.

- [ ] **Step 5: Commit**
```bash
git add src/pages/Profile.tsx
git commit -m "feat(email): waiver email modal actually sends"
```

---

## Phase 3 — `send-club-invite` (#2 coach invite, #3 membership invite)

### Task 8: Create the `send-club-invite` Edge Function

**Files:**
- Create: `supabase/functions/send-club-invite/index.ts`

- [ ] **Step 1: Write the function**

```ts
// send-club-invite — a club manager invites someone by email.
//   kind 'coach'      → invite to join the club as a coach (sign up).
//   kind 'membership' → invite an athlete to purchase their membership.
//
// Auth: any signed-in user who manages the target club (or an admin). Recipient
// address comes from the caller but the club authorization is enforced
// server-side, so a manager can only invite on behalf of clubs they manage.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendOne } from '../_shared/resend.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const appUrl = Deno.env.get('APP_PUBLIC_URL') ?? 'https://nssharpe.github.io/ucg-platform';

  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return json({ ok: false, error: 'Missing Authorization header.' }, 401);

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const { data: userData, error: userErr } = await db.auth.getUser(token);
  if (userErr || !userData.user) return json({ ok: false, error: 'Invalid or expired session.' }, 401);

  let body: { clubId?: string; kind?: string; email?: string; name?: string };
  try { body = await req.json(); } catch { return json({ ok: false, error: 'Invalid JSON body.' }, 400); }

  const clubId = (body.clubId ?? '').trim();
  const kind = body.kind === 'membership' ? 'membership' : 'coach';
  const email = (body.email ?? '').trim();
  const name = (body.name ?? '').trim();
  if (!clubId) return json({ ok: false, error: 'clubId is required.' }, 400);
  if (!EMAIL_RE.test(email)) return json({ ok: false, error: 'A valid recipient email is required.' }, 400);

  // Authorize: caller manages this club, OR caller is an admin.
  const { data: caller } = await db.from('people').select('id').eq('auth_user_id', userData.user.id).maybeSingle();
  const { data: adminRole } = await db.from('user_roles').select('role').eq('user_id', userData.user.id).eq('role', 'admin').maybeSingle();
  let authorized = !!adminRole;
  if (!authorized && caller) {
    const { data: mgr } = await db.from('club_managers').select('person_id').eq('club_id', clubId).eq('person_id', caller.id).maybeSingle();
    authorized = !!mgr;
  }
  if (!authorized) return json({ ok: false, error: 'You must manage this club to invite members.' }, 403);

  const { data: club } = await db.from('clubs').select('name, short_name').eq('id', clubId).maybeSingle();
  if (!club) return json({ ok: false, error: 'Club not found.' }, 404);

  const greeting = name ? `Hi ${esc(name)},` : 'Hello,';
  let subject: string; let html: string;
  if (kind === 'membership') {
    const link = `${appUrl}/#/membership`;
    subject = `Purchase your ${club.short_name} membership`;
    html = `<p>${greeting}</p>
<p><strong>${esc(club.name)}</strong> has invited you to purchase your United Club Gymnastics membership.</p>
<p><a href="${link}">Choose &amp; purchase your membership &rarr;</a></p>`;
  } else {
    const link = `${appUrl}/#/?signup=1`;
    subject = `You're invited to join ${club.short_name} on United Club Gymnastics`;
    html = `<p>${greeting}</p>
<p><strong>${esc(club.name)}</strong> has added you as a coach on the United Club Gymnastics platform.
Sign up using <strong>this email address</strong> (${esc(email)}) to claim your account:</p>
<p><a href="${link}">Create your account &rarr;</a></p>`;
  }

  try {
    await sendOne({ to: name ? `${name} <${email}>` : email, subject, html });
  } catch (e) {
    return json({ ok: false, error: `Email failed: ${e instanceof Error ? e.message : String(e)}` }, 500);
  }
  return json({ ok: true, sentCount: 1 });
});
```

- [ ] **Step 2: Deploy** — `supabase functions deploy send-club-invite --project-ref wkyerxlgricfphopocoz`

- [ ] **Step 3: Commit**
```bash
git add supabase/functions/send-club-invite/index.ts
git commit -m "feat(email): add send-club-invite function"
```

### Task 9: Add the `sendClubInvite` invoker

**Files:**
- Modify: `src/lib/supabase.ts` (after `notifyClubCart`, ~546)

- [ ] **Step 1: Add the invoker**

```ts
/** Invite someone to a club by email (coach invite or membership purchase).
 *  Caller must manage the club (the function re-checks). */
export async function sendClubInvite(args: {
  clubId: string;
  kind: 'coach' | 'membership';
  email: string;
  name?: string;
}): Promise<{ ok: boolean; sentCount?: number; error?: string }> {
  if (!supabase) return { ok: false, error: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('send-club-invite', { body: args });
  if (error) {
    let msg = error.message;
    try {
      const ctx = (error as { context?: Response }).context;
      if (ctx && typeof ctx.json === 'function') { const b = await ctx.json(); if (b?.error) msg = b.error; }
    } catch { /* fall back */ }
    return { ok: false, error: msg };
  }
  return data as { ok: boolean; sentCount?: number; error?: string };
}
```

- [ ] **Step 2: Build** — `npm run build` (green).

- [ ] **Step 3: Commit**
```bash
git add src/lib/supabase.ts
git commit -m "feat(email): add sendClubInvite invoker"
```

### Task 10: Wire Club.tsx coach invite (#2) + membership invite (#3)

**Files:**
- Modify: `src/pages/Club.tsx` (`inviteByEmail` ~213-231; membership-invite button ~650-657)

- [ ] **Step 1: Import the invoker** — add `sendClubInvite` to the existing `from '../lib/supabase'` import in Club.tsx.

- [ ] **Step 2: Send on coach invite**

In `inviteByEmail`, replace the final toast (line ~230) with a send + result toast. After `addManager(id); setEmail('');` replace:
```tsx
    toast('Invited coach added as a manager — they can claim the account by signing up with this email.');
```
with:
```tsx
    sendClubInvite({ clubId: club.id, kind: 'coach', email: addr, name: `${person.firstName} ${person.lastName}` })
      .then((res) => toast(res.ok
        ? `Coach invited — a setup email was sent to ${addr}.`
        : `Coach added as manager, but the email failed: ${res.error ?? 'unknown error'}.`));
```

- [ ] **Step 3: Send on membership invite**

Replace the membership-invite button `onClick` (lines ~652-655):
```tsx
                      onClick={() => {
                        // TODO: send actual email via transactional email provider
                        toast(`Membership invite sent to ${a.email}.`);
                      }}
```
with:
```tsx
                      onClick={() => {
                        sendClubInvite({ clubId: club.id, kind: 'membership', email: a.email, name: `${a.firstName} ${a.lastName}` })
                          .then((res) => toast(res.ok
                            ? `Membership invite sent to ${a.email}.`
                            : `Invite failed: ${res.error ?? 'unknown error'}.`));
                      }}
```

- [ ] **Step 4: Build** — `npm run build` (green) + `npx eslint src/pages/Club.tsx` (no new errors).

- [ ] **Step 5: Live smoke test** — as a club manager: invite a coach by email (your inbox) and click "Invite to purchase membership" on a no-membership athlete (their email). Confirm both arrive.

- [ ] **Step 6: Commit**
```bash
git add src/pages/Club.tsx
git commit -m "feat(email): club coach + membership invites send"
```

---

## Phase 4 — `request-manager-access` (#5)

### Task 11: Create the `request-manager-access` Edge Function

**Files:**
- Create: `supabase/functions/request-manager-access/index.ts`

- [ ] **Step 1: Write the function**

```ts
// request-manager-access — a signed-in member asks to manage a club.
// Emails the club's current managers + all league admins. No DB record (email
// only); recipients are resolved server-side so the caller never sees them.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendBatch, type EmailMessage } from '../_shared/resend.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const appUrl = Deno.env.get('APP_PUBLIC_URL') ?? 'https://nssharpe.github.io/ucg-platform';

  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return json({ ok: false, error: 'Missing Authorization header.' }, 401);

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const { data: userData, error: userErr } = await db.auth.getUser(token);
  if (userErr || !userData.user) return json({ ok: false, error: 'Invalid or expired session.' }, 401);

  let body: { clubId?: string };
  try { body = await req.json(); } catch { return json({ ok: false, error: 'Invalid JSON body.' }, 400); }
  const clubId = (body.clubId ?? '').trim();
  if (!clubId) return json({ ok: false, error: 'clubId is required.' }, 400);

  const { data: club } = await db.from('clubs').select('name, short_name').eq('id', clubId).maybeSingle();
  if (!club) return json({ ok: false, error: 'Club not found.' }, 404);

  const { data: caller } = await db.from('people').select('id, first_name, last_name, email').eq('auth_user_id', userData.user.id).maybeSingle();
  const requester = caller ? `${caller.first_name} ${caller.last_name}`.trim() : 'A member';
  const requesterEmail = caller?.email ?? userData.user.email ?? '';

  // Recipients: club managers + league admins.
  const { data: mgrRows } = await db.from('club_managers').select('person_id').eq('club_id', clubId);
  const managerIds = (mgrRows ?? []).map((r: { person_id: string }) => r.person_id);
  const { data: adminRoleRows } = await db.from('user_roles').select('user_id').eq('role', 'admin');
  const adminUserIds = (adminRoleRows ?? []).map((r: { user_id: string }) => r.user_id);

  const byManager = managerIds.length
    ? (await db.from('people').select('first_name, last_name, email').in('id', managerIds)).data ?? []
    : [];
  const byAdmin = adminUserIds.length
    ? (await db.from('people').select('first_name, last_name, email').in('auth_user_id', adminUserIds)).data ?? []
    : [];

  const seen = new Set<string>();
  const recipients = [...byManager, ...byAdmin].filter((p) => {
    const e = (p.email ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(e) || seen.has(e)) return false;
    seen.add(e);
    return true;
  });
  if (recipients.length === 0) return json({ ok: true, sentCount: 0, note: 'No managers or admins with valid emails.' });

  const link = `${appUrl}/#/club/${clubId}`;
  const subject = `Manager access requested for ${club.short_name}`;
  const html = `<p>Hello,</p>
<p><strong>${esc(requester)}</strong>${requesterEmail ? ` (${esc(requesterEmail)})` : ''} has requested manager access to <strong>${esc(club.name)}</strong> on the United Club Gymnastics platform.</p>
<p>If this is legitimate, add them as a manager from the club page:</p>
<p><a href="${link}">Open ${esc(club.short_name)} &rarr;</a></p>`;

  const messages: EmailMessage[] = recipients.map((r) => ({
    to: `${r.first_name} ${r.last_name} <${(r.email as string).trim()}>`,
    subject,
    html,
  }));
  let result;
  try { result = await sendBatch(messages); }
  catch (e) { return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500); }
  return json({ ok: result.ok, sentCount: result.sentCount, failedCount: result.failedCount, failed: result.failed });
});
```

- [ ] **Step 2: Deploy** — `supabase functions deploy request-manager-access --project-ref wkyerxlgricfphopocoz`

- [ ] **Step 3: Commit**
```bash
git add supabase/functions/request-manager-access/index.ts
git commit -m "feat(email): add request-manager-access function"
```

### Task 12: Add invoker + wire Club.tsx (#5)

**Files:**
- Modify: `src/lib/supabase.ts` (after `sendClubInvite`)
- Modify: `src/pages/Club.tsx` (manager-access button ~106-110)

- [ ] **Step 1: Add the invoker**

```ts
/** Ask a club's managers + league admins for manager access. Email only. */
export async function requestManagerAccess(
  clubId: string,
): Promise<{ ok: boolean; sentCount?: number; error?: string }> {
  if (!supabase) return { ok: false, error: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('request-manager-access', { body: { clubId } });
  if (error) return { ok: false, error: error.message };
  return data as { ok: boolean; sentCount?: number; error?: string };
}
```

- [ ] **Step 2: Wire the button** — import `requestManagerAccess` in Club.tsx, then replace the `onClick` (line ~108):
```tsx
            onClick={() => toast("Request sent — the club's managers and league admin have been notified.")}
```
with:
```tsx
            onClick={() => {
              requestManagerAccess(club.id).then((res) => toast(res.ok
                ? "Request sent — the club's managers and league admins have been notified."
                : `Request failed: ${res.error ?? 'unknown error'}.`));
            }}
```

- [ ] **Step 3: Build** — `npm run build` (green) + `npx eslint src/pages/Club.tsx src/lib/supabase.ts` (no new errors).

- [ ] **Step 4: Live smoke test** — as a non-manager member of a club, click "Request manager access"; confirm the club's managers/admins receive the email.

- [ ] **Step 5: Commit**
```bash
git add src/lib/supabase.ts src/pages/Club.tsx
git commit -m "feat(email): manager-access request notifies managers + admins"
```

---

## Phase 5 — `notify-sanction` (#6 submit, #7 approve, #8 reject)

### Task 13: Create the `notify-sanction` Edge Function

**Files:**
- Create: `supabase/functions/notify-sanction/index.ts`

- [ ] **Step 1: Write the function**

```ts
// notify-sanction — sanction-request lifecycle emails.
//   event 'submitted' → notify Sanctioning Team + admins (time to vote).
//   event 'approved' / 'rejected' → notify the host (requester) of the decision.
// The request is re-read server-side by id; the caller only sends { requestId, event }.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { sendBatch, sendOne, type EmailMessage } from '../_shared/resend.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const appUrl = Deno.env.get('APP_PUBLIC_URL') ?? 'https://nssharpe.github.io/ucg-platform';

  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return json({ ok: false, error: 'Missing Authorization header.' }, 401);

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const { data: userData, error: userErr } = await db.auth.getUser(token);
  if (userErr || !userData.user) return json({ ok: false, error: 'Invalid or expired session.' }, 401);

  let body: { requestId?: string; event?: string };
  try { body = await req.json(); } catch { return json({ ok: false, error: 'Invalid JSON body.' }, 400); }
  const requestId = (body.requestId ?? '').trim();
  const event = body.event;
  if (!requestId) return json({ ok: false, error: 'requestId is required.' }, 400);
  if (event !== 'submitted' && event !== 'approved' && event !== 'rejected') {
    return json({ ok: false, error: 'event must be submitted | approved | rejected.' }, 400);
  }

  const { data: sreq } = await db
    .from('sanction_requests')
    .select('id, host_club_id, requester_person_id, payload, sanction_id, created_meet_id')
    .eq('id', requestId)
    .maybeSingle();
  if (!sreq) return json({ ok: false, error: 'Sanction request not found.' }, 404);

  const eventName = (sreq.payload as Record<string, unknown>)?.eventName as string | undefined;
  const label = esc(eventName ?? 'event');
  const reqLink = `${appUrl}/#/sanctioning/${requestId}`;

  if (event === 'submitted') {
    // Sanctioning Team + admins.
    const { data: roleRows } = await db.from('user_roles').select('user_id').in('role', ['sanctioning', 'admin']);
    const ids = (roleRows ?? []).map((r: { user_id: string }) => r.user_id);
    if (ids.length === 0) return json({ ok: true, sentCount: 0, note: 'No sanctioning team / admins.' });
    const { data: people } = await db.from('people').select('first_name, last_name, email').in('auth_user_id', ids);
    const seen = new Set<string>();
    const recipients = (people ?? []).filter((p) => {
      const e = (p.email ?? '').trim().toLowerCase();
      if (!EMAIL_RE.test(e) || seen.has(e)) return false; seen.add(e); return true;
    });
    if (recipients.length === 0) return json({ ok: true, sentCount: 0, note: 'No team emails.' });
    const subject = `New sanction request: ${eventName ?? 'event'}`;
    const html = `<p>Hello,</p>
<p>A new event sanction request (<strong>${label}</strong>) has been submitted and is awaiting the Sanctioning Team's vote.</p>
<p><a href="${reqLink}">Review &amp; vote &rarr;</a></p>`;
    const messages: EmailMessage[] = recipients.map((r) => ({ to: `${r.first_name} ${r.last_name} <${(r.email as string).trim()}>`, subject, html }));
    const result = await sendBatch(messages);
    return json({ ok: result.ok, sentCount: result.sentCount, failedCount: result.failedCount, failed: result.failed });
  }

  // approved / rejected → notify the requester.
  const { data: requester } = sreq.requester_person_id
    ? await db.from('people').select('first_name, last_name, email').eq('id', sreq.requester_person_id).maybeSingle()
    : { data: null };
  const email = (requester?.email ?? '').trim();
  if (!EMAIL_RE.test(email)) return json({ ok: true, sentCount: 0, note: 'Requester has no valid email.' });

  let subject: string; let html: string;
  if (event === 'approved') {
    const meetLink = sreq.created_meet_id ? `${appUrl}/#/admin/meets/${sreq.created_meet_id}` : reqLink;
    subject = `Approved: ${eventName ?? 'your event'} sanction`;
    html = `<p>Hi ${esc(requester?.first_name ?? '')},</p>
<p>Your sanction request for <strong>${label}</strong> has been <strong>approved</strong>${sreq.sanction_id ? ` (Sanction ID: ${esc(String(sreq.sanction_id))})` : ''}.</p>
<p>A draft meet has been created.</p>
<p><a href="${meetLink}">Open your meet &rarr;</a></p>`;
  } else {
    subject = `Update on your ${eventName ?? 'event'} sanction request`;
    html = `<p>Hi ${esc(requester?.first_name ?? '')},</p>
<p>After review, your sanction request for <strong>${label}</strong> was <strong>not approved</strong>.</p>
<p>Reply to this email or contact the Sanctioning Team if you have questions.</p>`;
  }
  try { await sendOne({ to: `${requester?.first_name ?? ''} ${requester?.last_name ?? ''} <${email}>`.trim(), subject, html }); }
  catch (e) { return json({ ok: false, error: `Email failed: ${e instanceof Error ? e.message : String(e)}` }, 500); }
  return json({ ok: true, sentCount: 1 });
});
```

- [ ] **Step 2: Deploy** — `supabase functions deploy notify-sanction --project-ref wkyerxlgricfphopocoz`

- [ ] **Step 3: Commit**
```bash
git add supabase/functions/notify-sanction/index.ts
git commit -m "feat(email): add notify-sanction function"
```

### Task 14: Add invoker + wire Sanction.tsx (#6/#7/#8)

**Files:**
- Modify: `src/lib/supabase.ts` (after `requestManagerAccess`)
- Modify: `src/pages/Sanction.tsx` (submit ~334-336; approve ~873; reject ~890)

- [ ] **Step 1: Add the invoker**

```ts
/** Sanction lifecycle email (submitted → team; approved/rejected → host). */
export async function notifySanction(args: {
  requestId: string;
  event: 'submitted' | 'approved' | 'rejected';
}): Promise<{ ok: boolean; sentCount?: number; error?: string }> {
  if (!supabase) return { ok: false, error: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('notify-sanction', { body: args });
  if (error) return { ok: false, error: error.message };
  return data as { ok: boolean; sentCount?: number; error?: string };
}
```

- [ ] **Step 2: Import the invoker** — add `notifySanction` to the `from '../lib/supabase'` import in Sanction.tsx.

- [ ] **Step 3: Wire submit (#6)** — replace lines ~335-336:
```tsx
    // TODO: email sanctioning team
    toast('Sanction request submitted; the Sanctioning Team will vote within 7 days.');
```
with:
```tsx
    notifySanction({ requestId: req.id, event: 'submitted' });
    toast('Sanction request submitted; the Sanctioning Team will vote within 7 days.');
```
(Fire-and-forget: the request is persisted regardless of email outcome.)

- [ ] **Step 4: Wire approve (#7)** — replace line ~873:
```tsx
      // TODO: email host approval/links
      // TODO: reminder emails 3d/1d before deadline (needs scheduler)
```
with:
```tsx
      notifySanction({ requestId: req.id, event: 'approved' });
      // TODO: reminder emails 3d/1d before deadline (needs scheduler)
```

- [ ] **Step 5: Wire reject (#8)** — replace line ~890:
```tsx
      // TODO: email host rejection notification
```
with:
```tsx
      notifySanction({ requestId: req.id, event: 'rejected' });
```

- [ ] **Step 6: Build** — `npm run build` (green) + `npx eslint src/pages/Sanction.tsx src/lib/supabase.ts` (no new errors).

- [ ] **Step 7: Live smoke test** — submit a sanction request (team/admin inbox gets "new request"); from the vote page approve one and reject another (requester inbox gets the decision email).

- [ ] **Step 8: Commit**
```bash
git add src/lib/supabase.ts src/pages/Sanction.tsx
git commit -m "feat(email): sanction submit/approve/reject notifications"
```

---

## Phase 6 — Final verification

### Task 15: Full sweep + docs

- [ ] **Step 1: Build + pure tests** — `npm run build` (green; verify `dist/index.html` asset refs) and `npx vitest run` (scoring/capabilities suite still passes — unaffected, but confirm no accidental import breakage).

- [ ] **Step 2: Confirm no remaining false "sent" toasts** — `git grep -nE "toast\(.*(sent|queued|notified|emailed)" src/` and confirm every remaining hit is either (a) backed by a real send wired in this plan, or (b) a documented deferral (payment-confirmation toasts gated on Stripe).

- [ ] **Step 3: Update CLAUDE.md Email infra section** — change the "Gmail SMTP" description to Resend, list the new functions (`send-club-invite`, `request-manager-access`, `notify-sanction`), and note `RESEND_API_KEY` / `RESEND_FROM` secrets. Remove the "swap to Resend before real production sends" line.

- [ ] **Step 4: Commit**
```bash
git add CLAUDE.md
git commit -m "docs: update email infra notes for Resend"
```

---

## Self-review (spec coverage)

- Part A transport → Tasks 1–5 (helper, secrets, 3 swaps). ✓
- #1 account invite + Resend → Task 6. ✓
- #4 waiver modal → Task 7. ✓
- #2/#3 club invites → Tasks 8–10. ✓
- #5 manager access (email only) → Tasks 11–12. ✓
- #6/#7/#8 sanction → Tasks 13–14. ✓
- Deferred (reminders/scheduler, Stripe confirmations) → left as TODOs, verified in Task 15 Step 2. ✓
- Auth split (admin reuse vs new notify functions) → honored throughout. ✓
