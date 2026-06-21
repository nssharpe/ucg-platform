# Digital Waiver E-Signature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the stubbed waiver upload/sign flow with a legally-binding clickwrap e-signature system: versioned waiver text, a structured signature evidence record (no PDFs), server-stamped IP, and a verified-email guardian path for minors.

**Architecture:** Waiver text lives in `waiver_documents` (immutable versions + SHA-256 hash). Signatures are written by a `record-waiver-signature` Edge Function that stamps the real IP server-side into `waiver_signatures`. Minors route to a guardian via a tokenized link (`waiver_sign_requests` + a `request-guardian-waiver` Edge Function that emails the link); the membership sits in a new `pending-waiver` status until the guardian signs at a standalone `/waiver/sign/:token` page. Pure logic (hashing, version increment, minor test, token state, certificate text) is split into `src/lib/waivers-core.ts` and unit-tested under the existing node/vitest setup.

**Tech Stack:** React + TS + Vite (HashRouter), Supabase (Postgres + RLS + Deno Edge Functions, denomailer SMTP), Vitest (node env).

**Reference spec:** `docs/specs/2026-06-20-digital-waiver-esign-design.md`

**Repo gotchas (from CLAUDE.md):**
- Path has spaces and `&` — call binaries directly, not npm shims.
- Run tests with: `node node_modules/vitest/vitest.mjs run` (append a path to scope).
- New migrations: `supabase migration new <name>` (timestamped); apply with
  `supabase db push` with the sandbox disabled. Nate has standing authorization.
- Enum gotcha: `ALTER TYPE ... ADD VALUE` must be in its OWN migration, committed
  before any migration/code that uses the new value.
- Router is **HashRouter** — external links must use `#/…` (e.g.
  `${origin}/ucg-platform/#/waiver/sign/<token>`).

---

## File structure

**Create:**
- `supabase/migrations/<ts>_membership_status_pending_waiver.sql` — enum add (alone)
- `supabase/migrations/<ts>_waiver_esign.sql` — 3 tables + indexes + RLS
- `src/lib/waivers-core.ts` — pure logic (hash, version, minor, token, certificate)
- `tests/lib/waivers-core.test.ts` — unit tests for the above
- `supabase/functions/record-waiver-signature/index.ts` — server-side signing
- `supabase/functions/request-guardian-waiver/index.ts` — token + guardian email
- `src/pages/WaiverSign.tsx` — standalone guardian signing page

**Modify:**
- `src/lib/types.ts` — new types + `MembershipStatus` + `DB` fields
- `src/lib/supabase.ts` — row mappers, push/load helpers, EF invokers, loadAll
- `src/lib/seed.ts` — seed default published waiver documents
- `src/pages/Admin.tsx` — rewrite the `Waivers` component (text editor + real records)
- `src/pages/Membership.tsx` — real self-sign + guardian-request in the waiver step
- `src/App.tsx` — add `/waiver/sign/:token` route

---

## Task 1: Migration — add `pending-waiver` enum value (alone)

**Files:**
- Create: `supabase/migrations/<ts>_membership_status_pending_waiver.sql`

- [ ] **Step 1: Create the migration file**

Run: `supabase migration new membership_status_pending_waiver`

Put ONLY this in it (enum gotcha — must commit before any file uses the value):

```sql
-- Minors await a guardian e-signature before their membership activates.
alter type membership_status add value if not exists 'pending-waiver';
```

- [ ] **Step 2: Commit (do not push yet — pushed together in Task 13)**

```bash
git add supabase/migrations/*_membership_status_pending_waiver.sql
git commit -m "feat(db): add 'pending-waiver' membership_status enum value"
```

---

## Task 2: Migration — waiver tables + RLS

**Files:**
- Create: `supabase/migrations/<ts>_waiver_esign.sql`

- [ ] **Step 1: Create the migration file**

Run: `supabase migration new waiver_esign`

- [ ] **Step 2: Write the schema**

```sql
-- Versioned waiver text. A new row per edit; existing rows are immutable so
-- every signature stays bound to the exact text it agreed to.
create table waiver_documents (
  id            uuid primary key default gen_random_uuid(),
  season_id     text not null references seasons(id) on delete cascade,
  waiver_type   text not null,           -- 'Athlete' | 'Coach' | 'Judge' | 'Other Floor Access'
  version       int  not null,           -- per (season_id, waiver_type)
  body          text not null,
  content_hash  text not null,           -- sha-256 hex of body
  published     boolean not null default true,
  created_at    timestamptz not null default now(),
  created_by    uuid,                    -- auth.uid() of the editing admin
  unique (season_id, waiver_type, version)
);
create index on waiver_documents (season_id, waiver_type, published);

-- The legal artifact: one row per signing event.
create table waiver_signatures (
  id                  uuid primary key default gen_random_uuid(),
  person_id           text not null references people(id) on delete cascade,
  season_id           text not null references seasons(id) on delete cascade,
  waiver_type         text not null,
  waiver_document_id  uuid not null references waiver_documents(id),
  content_hash        text not null,     -- snapshot of the doc hash at signing
  signer_name         text not null,
  signer_email        text not null,
  signer_role         text not null,     -- 'self' | 'guardian'
  signer_relationship text,              -- e.g. 'parent' (guardian only)
  consent             boolean not null,
  signed_at           timestamptz not null default now(),
  ip                  text,
  user_agent          text,
  created_at          timestamptz not null default now()
);
create index on waiver_signatures (person_id, season_id, waiver_type);

-- Pending guardian signing tokens for minors.
create table waiver_sign_requests (
  id             uuid primary key default gen_random_uuid(),
  token          text not null unique,
  person_id      text not null references people(id) on delete cascade,
  season_id      text not null references seasons(id) on delete cascade,
  waiver_type    text not null,
  membership_type text not null,         -- 'athlete' | 'coach'
  guardian_email text not null,
  status         text not null default 'pending',  -- 'pending'|'completed'|'expired'
  created_at     timestamptz not null default now(),
  completed_at   timestamptz
);
create index on waiver_sign_requests (token);
```

- [ ] **Step 3: Write the RLS policies (same file)**

```sql
alter table waiver_documents     enable row level security;
alter table waiver_signatures    enable row level security;
alter table waiver_sign_requests enable row level security;

-- Waiver text: published rows are world-readable (guardians render via token,
-- no login). Admins manage. (is_admin() defined in 0002_rls.sql.)
create policy waiver_docs_read   on waiver_documents for select using (published or is_admin());
create policy waiver_docs_write  on waiver_documents for all    using (is_admin()) with check (is_admin());

-- Signatures: inserts/updates happen via the service-role Edge Function (RLS
-- bypassed). Through the API, admins read all; a person reads their own.
create policy waiver_sigs_read   on waiver_signatures for select
  using (is_admin() or person_id = my_person_id()::text);

-- Sign requests: token-based lookup is unauthenticated (a single pending row is
-- not sensitive); writes go through the service-role Edge Functions.
create policy waiver_reqs_read   on waiver_sign_requests for select using (true);
```

> Note: `my_person_id()` returns uuid in 0002; `people.id` is text since 0004, so
> cast both sides to text as shown. Verify the cast compiles during `db push`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/*_waiver_esign.sql
git commit -m "feat(db): waiver_documents, waiver_signatures, waiver_sign_requests + RLS"
```

---

## Task 3: TypeScript types

**Files:**
- Modify: `src/lib/types.ts` (MembershipStatus ~line 94; add interfaces near AccountInvite ~line 371; DB interface ~line 380)

- [ ] **Step 1: Extend `MembershipStatus`**

Replace line 94:

```ts
export type MembershipStatus = 'active' | 'pending-club-payment' | 'pending-waiver' | 'none';
```

- [ ] **Step 2: Add waiver interfaces (after the `AccountInvite` interface)**

```ts
export type WaiverType = 'Athlete' | 'Coach' | 'Judge' | 'Other Floor Access';
export const WAIVER_TYPES: WaiverType[] = ['Athlete', 'Coach', 'Judge', 'Other Floor Access'];

export interface WaiverDocument {
  id: string;
  seasonId: string;
  waiverType: WaiverType;
  version: number;
  body: string;
  contentHash: string;
  published: boolean;
  createdAt: string;
}

export interface WaiverSignature {
  id: string;
  personId: string;
  seasonId: string;
  waiverType: WaiverType;
  waiverDocumentId: string;
  contentHash: string;
  signerName: string;
  signerEmail: string;
  signerRole: 'self' | 'guardian';
  signerRelationship?: string | null;
  consent: boolean;
  signedAt: string;
  ip?: string | null;
  userAgent?: string | null;
}
```

- [ ] **Step 3: Add to the `DB` interface (before the closing brace)**

```ts
  /** Versioned waiver text (all versions retained). */
  waiverDocuments?: WaiverDocument[];
  /** Recorded e-signatures (the legal evidence records). */
  waiverSignatures?: WaiverSignature[];
```

- [ ] **Step 4: Typecheck + commit**

Run: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`
Expected: no new errors in `types.ts` (pre-existing errors elsewhere are tolerated; do not introduce new ones in files you touch).

```bash
git add src/lib/types.ts
git commit -m "feat(types): waiver document + signature types, pending-waiver status"
```

---

## Task 4: Pure waiver logic + tests (TDD)

**Files:**
- Create: `src/lib/waivers-core.ts`
- Test: `tests/lib/waivers-core.test.ts`

This module imports zero runtime deps (mirrors `capabilities-core.ts`) so it runs
under the node vitest env. `sha256Hex` uses the Web Crypto API (`globalThis.crypto.subtle`),
available in Node 20+ and the browser.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import {
  sha256Hex, nextVersion, isMinorAt, advanceRequest, certificateText,
} from '../../src/lib/waivers-core';
import type { WaiverSignature } from '../../src/lib/types';

describe('sha256Hex', () => {
  it('is stable and matches the known SHA-256 of "abc"', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('differs when text differs', async () => {
    expect(await sha256Hex('a')).not.toBe(await sha256Hex('b'));
  });
});

describe('nextVersion', () => {
  it('starts at 1 with no prior versions', () => {
    expect(nextVersion([])).toBe(1);
  });
  it('returns max+1', () => {
    expect(nextVersion([{ version: 1 }, { version: 3 }, { version: 2 }])).toBe(4);
  });
});

describe('isMinorAt', () => {
  it('true when under 18 at the given date', () => {
    expect(isMinorAt('2010-06-20', new Date('2026-06-20T00:00:00Z'))).toBe(true);
  });
  it('false on the 18th birthday', () => {
    expect(isMinorAt('2008-06-20', new Date('2026-06-20T00:00:00Z'))).toBe(false);
  });
  it('false when dob missing', () => {
    expect(isMinorAt('', new Date('2026-06-20T00:00:00Z'))).toBe(false);
  });
});

describe('advanceRequest', () => {
  it('pending -> completed', () => {
    expect(advanceRequest('pending', 'complete')).toBe('completed');
  });
  it('pending -> expired', () => {
    expect(advanceRequest('pending', 'expire')).toBe('expired');
  });
  it('completed is terminal', () => {
    expect(advanceRequest('completed', 'complete')).toBe('completed');
    expect(advanceRequest('completed', 'expire')).toBe('completed');
  });
});

describe('certificateText', () => {
  const sig: WaiverSignature = {
    id: 's1', personId: 'p1', seasonId: '2026', waiverType: 'Athlete',
    waiverDocumentId: 'd1', contentHash: 'abc123', signerName: 'John Doe',
    signerEmail: 'john@example.com', signerRole: 'guardian', signerRelationship: 'parent',
    consent: true, signedAt: '2026-06-20T14:02:00Z', ip: '1.2.3.4', userAgent: 'UA',
  };
  it('renders a guardian certificate with version, hash, ip, consent', () => {
    const txt = certificateText(sig, 3, 'Jane Doe');
    expect(txt).toContain('Jane Doe');
    expect(txt).toContain('guardian John Doe (parent)');
    expect(txt).toContain('Athlete Waiver v3');
    expect(txt).toContain('abc123');
    expect(txt).toContain('1.2.3.4');
    expect(txt).toContain('consent: yes');
  });
  it('renders a self certificate without the guardian clause', () => {
    const self = { ...sig, signerRole: 'self' as const, signerRelationship: null };
    const txt = certificateText(self, 1, 'John Doe');
    expect(txt).toContain('John Doe agreed to');
    expect(txt).not.toContain('guardian');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node node_modules/vitest/vitest.mjs run tests/lib/waivers-core.test.ts`
Expected: FAIL (module not found / exports undefined).

- [ ] **Step 3: Implement `src/lib/waivers-core.ts`**

```ts
// Pure waiver logic — zero runtime deps so it runs under node/vitest.
import type { WaiverSignature } from './types';

/** SHA-256 hex digest of a string (Web Crypto; Node 20+ and browsers). */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Next per-(season,type) version number given existing versions. */
export function nextVersion(existing: { version: number }[]): number {
  return existing.reduce((max, v) => Math.max(max, v.version), 0) + 1;
}

/** True when the person is under 18 at `on` (false if dob missing). */
export function isMinorAt(dob: string, on: Date): boolean {
  if (!dob?.trim()) return false;
  const birth = new Date(dob);
  if (Number.isNaN(birth.getTime())) return false;
  let age = on.getFullYear() - birth.getFullYear();
  const m = on.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && on.getDate() < birth.getDate())) age--;
  return age < 18;
}

export type RequestStatus = 'pending' | 'completed' | 'expired';

/** Token state machine. 'pending' is the only non-terminal state. */
export function advanceRequest(
  status: RequestStatus, action: 'complete' | 'expire',
): RequestStatus {
  if (status !== 'pending') return status;
  return action === 'complete' ? 'completed' : 'expired';
}

/** Human-readable, regenerated-on-demand signing certificate.
 *  `athleteName` is the membership holder; for guardian signatures the signer
 *  differs from the holder. */
export function certificateText(
  sig: WaiverSignature, version: number, athleteName: string,
): string {
  const when = new Date(sig.signedAt).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const who = sig.signerRole === 'guardian'
    ? `${athleteName}'s guardian ${sig.signerName}` +
      (sig.signerRelationship ? ` (${sig.signerRelationship})` : '')
    : `${sig.signerName}`;
  const verb = sig.signerRole === 'guardian' ? 'agreed to' : 'agreed to';
  return `${who} ${verb} ${sig.waiverType} Waiver v${version} ` +
    `(hash ${sig.contentHash}) on ${when} from IP ${sig.ip ?? 'unknown'} ` +
    `(consent: ${sig.consent ? 'yes' : 'no'}).`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `node node_modules/vitest/vitest.mjs run tests/lib/waivers-core.test.ts`
Expected: PASS (all cases green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/waivers-core.ts tests/lib/waivers-core.test.ts
git commit -m "feat: pure waiver logic (hash, version, minor, token, certificate) + tests"
```

---

## Task 5: Supabase mappers, helpers, loaders, EF invokers

**Files:**
- Modify: `src/lib/supabase.ts`

- [ ] **Step 1: Add row mappers (after the `rowToClubRequest` block, ~line 253)**

```ts
const rowToWaiverDocument = (r: any): WaiverDocument => ({
  id: r.id, seasonId: r.season_id, waiverType: r.waiver_type, version: r.version,
  body: r.body, contentHash: r.content_hash, published: r.published, createdAt: r.created_at,
});
const rowToWaiverSignature = (r: any): WaiverSignature => ({
  id: r.id, personId: r.person_id, seasonId: r.season_id, waiverType: r.waiver_type,
  waiverDocumentId: r.waiver_document_id, contentHash: r.content_hash,
  signerName: r.signer_name, signerEmail: r.signer_email, signerRole: r.signer_role,
  signerRelationship: r.signer_relationship, consent: r.consent, signedAt: r.signed_at,
  ip: r.ip, userAgent: r.user_agent,
});
```

Add `WaiverDocument, WaiverSignature` to the type import at the top of the file.

- [ ] **Step 2: Add an admin push for waiver documents (after `pushClubRequest`)**

```ts
/** Insert a new immutable waiver document version (admin only via RLS). */
export function pushWaiverDocument(d: WaiverDocument) {
  remoteUpsert('waiver_documents', [{
    id: d.id, season_id: d.seasonId, waiver_type: d.waiverType, version: d.version,
    body: d.body, content_hash: d.contentHash, published: d.published, created_at: d.createdAt,
  }]);
}
```

- [ ] **Step 3: Add Edge Function invokers (near `sendEmail`, ~line 446)**

```ts
export interface RecordSignatureArgs {
  personId: string; seasonId: string; waiverType: string; membershipType: string;
  waiverDocumentId: string; contentHash: string;
  signerName: string; signerEmail: string;
  signerRole: 'self' | 'guardian'; signerRelationship?: string;
  consent: boolean; token?: string;        // present for guardian path
}

/** Record a signature server-side (stamps real IP) + activate membership.
 *  Returns { ok } or { ok:false, error }. */
export async function recordWaiverSignature(
  args: RecordSignatureArgs,
): Promise<{ ok: boolean; error?: string }> {
  if (!supabase) return { ok: false, error: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('record-waiver-signature', { body: args });
  if (error) return { ok: false, error: error.message };
  return data as { ok: boolean; error?: string };
}

/** Create a guardian signing token and email the link. */
export async function requestGuardianWaiver(args: {
  personId: string; seasonId: string; waiverType: string; membershipType: string;
  guardianName: string; guardianEmail: string;
}): Promise<{ ok: boolean; error?: string }> {
  if (!supabase) return { ok: false, error: 'Supabase is not configured.' };
  const { data, error } = await supabase.functions.invoke('request-guardian-waiver', { body: args });
  if (error) return { ok: false, error: error.message };
  return data as { ok: boolean; error?: string };
}

/** Public token lookup for the guardian signing page (RLS: select=true). */
export async function fetchSignRequest(token: string) {
  if (!supabase) return null;
  const { data, error } = await supabase.from('waiver_sign_requests')
    .select('*').eq('token', token).maybeSingle();
  if (error) { console.error('[supabase] fetchSignRequest failed:', error); return null; }
  return data;
}

/** The published waiver doc for a season+type (latest published version). */
export async function fetchPublishedWaiver(seasonId: string, waiverType: string) {
  if (!supabase) return null;
  const { data, error } = await supabase.from('waiver_documents')
    .select('*').eq('season_id', seasonId).eq('waiver_type', waiverType)
    .eq('published', true).order('version', { ascending: false }).limit(1).maybeSingle();
  if (error) { console.error('[supabase] fetchPublishedWaiver failed:', error); return null; }
  return data ? rowToWaiverDocument(data) : null;
}
```

- [ ] **Step 4: Load waiver tables in `loadAll`**

In the `Promise.all([...])` add two more reads (tolerated if absent, like 0007/0008):

```ts
      supabase.from('waiver_documents').select('*'),   // tolerated if absent
      supabase.from('waiver_signatures').select('*'),  // tolerated if absent
```

Destructure them as `waiverDocsR, waiverSigsR` at the end of the array. Do NOT add
them to the hard `errors` list. Then before the final `return`:

```ts
    const waiverDocuments: WaiverDocument[] = (waiverDocsR.error ? [] : waiverDocsR.data ?? [])
      .map(rowToWaiverDocument);
    const waiverSignatures: WaiverSignature[] = (waiverSigsR.error ? [] : waiverSigsR.data ?? [])
      .map(rowToWaiverSignature);
```

And in the returned object literal:

```ts
      ...(waiverDocuments.length ? { waiverDocuments } : {}),
      ...(waiverSignatures.length ? { waiverSignatures } : {}),
```

- [ ] **Step 5: Typecheck + commit**

Run: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`
Expected: no new errors in `supabase.ts`.

```bash
git add src/lib/supabase.ts
git commit -m "feat(supabase): waiver mappers, push/load, EF invokers"
```

---

## Task 6: Edge Function — record-waiver-signature

**Files:**
- Create: `supabase/functions/record-waiver-signature/index.ts`

Runs as service role (RLS bypassed). `verify_jwt` is left ON by default; the
guardian path passes the anon apikey only, so set this function to **no JWT
verification** in config (see Step 2) and authorize by the token instead.

- [ ] **Step 1: Write the function**

```ts
// record-waiver-signature — writes the legal signature record, stamping the
// real client IP server-side, then activates the membership.
//
// Two callers:
//  - self  (signed-in member): validated by Authorization Bearer JWT.
//  - guardian (anon): validated by a pending waiver_sign_requests token.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return req.headers.get('x-real-ip') ?? 'unknown';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

  const url = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const db = createClient(url, serviceKey, { auth: { persistSession: false } });

  let a: any;
  try { a = await req.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }, 400); }

  // --- Authorize ---
  if (a.signerRole === 'guardian') {
    if (!a.token) return json({ ok: false, error: 'Missing token' }, 401);
    const { data: reqRow } = await db.from('waiver_sign_requests')
      .select('*').eq('token', a.token).maybeSingle();
    if (!reqRow || reqRow.status !== 'pending') {
      return json({ ok: false, error: 'This signing link is no longer valid.' }, 410);
    }
    a.personId = reqRow.person_id; a.seasonId = reqRow.season_id;
    a.waiverType = reqRow.waiver_type; a.membershipType = reqRow.membership_type;
  } else {
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const { data: u, error } = await db.auth.getUser(token);
    if (error || !u.user) return json({ ok: false, error: 'Invalid session' }, 401);
    // Ensure the caller owns the person row they claim to sign for.
    const { data: person } = await db.from('people').select('id')
      .eq('id', a.personId).eq('auth_user_id', u.user.id).maybeSingle();
    if (!person) return json({ ok: false, error: 'Not your record' }, 403);
  }

  // --- Validate the doc + hash (never record against a stale version) ---
  const { data: doc } = await db.from('waiver_documents')
    .select('*').eq('id', a.waiverDocumentId).eq('published', true).maybeSingle();
  if (!doc) return json({ ok: false, error: 'Waiver document not found.' }, 404);
  if (doc.content_hash !== a.contentHash) {
    return json({ ok: false, error: 'The waiver was updated. Please re-read and sign again.' }, 409);
  }
  if (!a.consent) return json({ ok: false, error: 'Consent is required.' }, 400);

  // --- Insert the signature record ---
  const { error: insErr } = await db.from('waiver_signatures').insert({
    person_id: a.personId, season_id: a.seasonId, waiver_type: a.waiverType,
    waiver_document_id: a.waiverDocumentId, content_hash: a.contentHash,
    signer_name: a.signerName, signer_email: a.signerEmail, signer_role: a.signerRole,
    signer_relationship: a.signerRelationship ?? null, consent: true,
    ip: clientIp(req), user_agent: req.headers.get('user-agent') ?? null,
  });
  if (insErr) return json({ ok: false, error: insErr.message }, 500);

  // --- Activate the membership + set convenience pointers ---
  const { error: upErr } = await db.from('memberships')
    .update({ status: 'active', waiver_signed_at: new Date().toISOString(), waiver_signed_by: a.signerName })
    .eq('person_id', a.personId).eq('season_id', a.seasonId).eq('type', a.membershipType);
  if (upErr) return json({ ok: false, error: upErr.message }, 500);

  if (a.signerRole === 'guardian') {
    await db.from('waiver_sign_requests')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('token', a.token);
  }
  return json({ ok: true });
});
```

> **Membership status nuance (from spec review):** the update above forces
> `active`. If the athlete chose **club-pay**, the row should go to
> `pending-club-payment` instead of `active` once the waiver is in. Handle by
> reading the current row first: if `paid_via = 'club'` and not yet paid, set
> `pending-club-payment`; else `active`. Implement this read-then-set in Step 1's
> membership update (one extra `select` before the `update`).

- [ ] **Step 2: Disable JWT verification for this function**

Create/append `supabase/config.toml` (if absent, `supabase init` already made one;
otherwise add the block):

```toml
[functions.record-waiver-signature]
verify_jwt = false
```

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/record-waiver-signature/index.ts supabase/config.toml
git commit -m "feat(edge): record-waiver-signature (server-stamped IP, membership activation)"
```

---

## Task 7: Edge Function — request-guardian-waiver

**Files:**
- Create: `supabase/functions/request-guardian-waiver/index.ts`

Signed-in member triggers this for their minor's membership: it creates the token
row and emails the guardian a `#/waiver/sign/<token>` link. Reuses denomailer
SMTP like `send-email` (no admin gate — any signed-in member may request for their
own record).

- [ ] **Step 1: Write the function**

```ts
// request-guardian-waiver — create a pending signing token + email the guardian.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SMTPClient } from 'https://deno.land/x/denomailer@1.6.0/mod.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405);

  const url = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const gmailUser = Deno.env.get('GMAIL_USER');
  const gmailPass = Deno.env.get('GMAIL_APP_PASSWORD');
  const fromName = Deno.env.get('GMAIL_FROM_NAME') ?? 'United Club Gymnastics';
  const appUrl = Deno.env.get('APP_PUBLIC_URL') ?? 'https://nssharpe.github.io/ucg-platform';
  if (!gmailUser || !gmailPass) return json({ ok: false, error: 'Email not configured.' }, 500);

  const db = createClient(url, serviceKey, { auth: { persistSession: false } });
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: u, error: uErr } = await db.auth.getUser(token);
  if (uErr || !u.user) return json({ ok: false, error: 'Invalid session' }, 401);

  let a: any;
  try { a = await req.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }, 400); }
  if (!EMAIL_RE.test((a.guardianEmail ?? '').trim())) return json({ ok: false, error: 'Invalid guardian email.' }, 400);

  // Caller must own the athlete record.
  const { data: person } = await db.from('people').select('id, first_name, last_name')
    .eq('id', a.personId).eq('auth_user_id', u.user.id).maybeSingle();
  if (!person) return json({ ok: false, error: 'Not your record' }, 403);

  const signToken = crypto.randomUUID().replace(/-/g, '');
  const { error: insErr } = await db.from('waiver_sign_requests').insert({
    token: signToken, person_id: a.personId, season_id: a.seasonId,
    waiver_type: a.waiverType, membership_type: a.membershipType,
    guardian_email: a.guardianEmail.trim(), status: 'pending',
  });
  if (insErr) return json({ ok: false, error: insErr.message }, 500);

  const link = `${appUrl}/#/waiver/sign/${signToken}`;
  const athlete = `${person.first_name} ${person.last_name}`;
  const html = `<p>Hello ${a.guardianName ?? ''},</p>
    <p>${athlete} has requested that you, as parent/guardian, sign the
    ${a.waiverType} waiver for United Club Gymnastics.</p>
    <p><a href="${link}">Click here to review and sign the waiver</a>.</p>
    <p>This is an electronic signature with timestamp and IP recorded.</p>`;

  const smtp = new SMTPClient({ connection: { hostname: 'smtp.gmail.com', port: 465, tls: true,
    auth: { username: gmailUser, password: gmailPass } } });
  try {
    await smtp.send({ from: `${fromName} <${gmailUser}>`, to: a.guardianEmail.trim(),
      subject: `Sign the ${a.waiverType} waiver for ${athlete}`, html });
    await smtp.close();
  } catch (e) {
    return json({ ok: false, error: `Email failed: ${e instanceof Error ? e.message : String(e)}` }, 500);
  }
  return json({ ok: true });
});
```

- [ ] **Step 2: Commit**

```bash
git add supabase/functions/request-guardian-waiver/index.ts
git commit -m "feat(edge): request-guardian-waiver (token + guardian email)"
```

---

## Task 8: Admin Waivers — text editor + real records

**Files:**
- Modify: `src/pages/Admin.tsx` (replace the `Waivers` component, ~lines 1011–1230, and remove the in-memory `WaiverVersion`/`WaiverHistory`/`WAIVER_TYPES` block)

- [ ] **Step 1: Remove the prototype state**

Delete `type WaiverVersion`, `type WaiverHistory`, the local `const WAIVER_TYPES`
(now imported from types), and the in-memory `history`/`handleUpload`/upload UI.

- [ ] **Step 2: Rewrite the `Waivers` component**

Replace the component with a text editor per type plus a real signed-records list.
Key behavior: load published doc + history per season+type from `db.waiverDocuments`;
"Save new version" computes `sha256Hex(body)`, calls `pushWaiverDocument` with
`version = nextVersion(existing)`, and `mutate`s the local store. Signed list reads
`db.waiverSignatures` filtered to the season; each row expands to
`certificateText(sig, version, athleteName)`.

```tsx
import { WAIVER_TYPES, type WaiverType, type WaiverDocument } from '../lib/types';
import { sha256Hex, nextVersion, certificateText } from '../lib/waivers-core';
import { pushWaiverDocument } from '../lib/supabase';

function Waivers() {
  const db = useDB();
  const toast = useToast();
  const currentSeason = db.seasons.find((s) => s.current) ?? db.seasons[0];
  const [selectedSeasonId, setSelectedSeasonId] = useState(currentSeason?.id ?? '');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [signedQ, setSignedQ] = useState('');
  const selectedSeason = db.seasons.find((s) => s.id === selectedSeasonId) ?? currentSeason;

  const docsFor = (t: WaiverType): WaiverDocument[] =>
    (db.waiverDocuments ?? [])
      .filter((d) => d.seasonId === selectedSeasonId && d.waiverType === t)
      .sort((a, b) => a.version - b.version);
  const publishedFor = (t: WaiverType) => {
    const pubs = docsFor(t).filter((d) => d.published);
    return pubs[pubs.length - 1];
  };

  const saveVersion = async (t: WaiverType) => {
    const key = `${selectedSeasonId}:${t}`;
    const body = (drafts[key] ?? publishedFor(t)?.body ?? '').trim();
    if (body.length < 20) { toast('Waiver text is too short to publish.'); return; }
    const existing = docsFor(t);
    const doc: WaiverDocument = {
      id: crypto.randomUUID(), seasonId: selectedSeasonId, waiverType: t,
      version: nextVersion(existing), body, contentHash: await sha256Hex(body),
      published: true, createdAt: new Date().toISOString(),
    };
    mutate((d) => { (d.waiverDocuments ??= []).push(doc); });
    pushWaiverDocument(doc);
    setDrafts((p) => ({ ...p, [key]: doc.body }));
    toast(`${t} waiver v${doc.version} published.`);
  };

  const signed = useMemo(() => {
    const lq = signedQ.toLowerCase();
    return (db.waiverSignatures ?? [])
      .filter((s) => s.seasonId === selectedSeasonId)
      .map((s) => {
        const p = db.people.find((x) => x.id === s.personId);
        const name = p ? `${p.firstName} ${p.lastName}` : s.personId;
        const v = (db.waiverDocuments ?? []).find((d) => d.id === s.waiverDocumentId)?.version ?? 0;
        return { sig: s, name, version: v };
      })
      .filter((r) => !lq || r.name.toLowerCase().includes(lq))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [db.waiverSignatures, db.waiverDocuments, db.people, selectedSeasonId, signedQ]);

  return (
    <div>
      {/* Season selector — unchanged markup from the old component */}
      <div className="grid cols-2" style={{ marginBottom: 24 }}>
        {WAIVER_TYPES.map((t) => {
          const key = `${selectedSeasonId}:${t}`;
          const pub = publishedFor(t);
          const value = drafts[key] ?? pub?.body ?? '';
          return (
            <div className="card card-pad" key={t}>
              <h3 className="card-title">{t} waiver — {selectedSeason?.name ?? '—'}</h3>
              <p style={{ fontSize: 13.5, color: 'var(--ink-soft)', marginTop: 0 }}>
                {pub ? `Published v${pub.version}` : 'Not published yet'} · e-signed with timestamp, IP & consent recorded.
              </p>
              <textarea className="input" rows={8} value={value}
                onChange={(e) => setDrafts((p) => ({ ...p, [key]: e.target.value }))}
                placeholder="Enter the waiver text members will agree to…" />
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button className="btn small primary" onClick={() => saveVersion(t)}>Save new version</button>
                {docsFor(t).length > 1 && (
                  <details><summary style={{ fontSize: 12.5, color: 'var(--ink-soft)', cursor: 'pointer' }}>
                    History ({docsFor(t).length})</summary>
                    <ul style={{ margin: '4px 0 0 16px', fontSize: 12.5, color: 'var(--ink-soft)' }}>
                      {[...docsFor(t)].reverse().map((d) => (
                        <li key={d.id}>v{d.version} — {new Date(d.createdAt).toLocaleString()} (hash {d.contentHash.slice(0, 8)}…)</li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="card card-pad">
        <h3 className="card-title">Signed waivers — {selectedSeason?.name ?? '—'}</h3>
        <input className="input" style={{ maxWidth: 280, marginBottom: 12 }} placeholder="Search by name"
          value={signedQ} onChange={(e) => setSignedQ(e.target.value)} />
        {signed.length === 0 ? (
          <p style={{ fontSize: 13.5, color: 'var(--ink-soft)' }}>No signatures recorded for this season.</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {signed.slice(0, 300).map(({ sig, name, version }) => (
              <li key={sig.id} style={{ borderBottom: '1px solid var(--line)', padding: '8px 0' }}>
                <strong>{name}</strong> — {sig.waiverType} ({sig.signerRole})
                <details>
                  <summary style={{ fontSize: 12.5, color: 'var(--accent)', cursor: 'pointer' }}>Certificate</summary>
                  <p style={{ fontSize: 12.5, color: 'var(--ink-soft)', margin: '4px 0 0' }}>
                    {certificateText(sig, version, name)}
                  </p>
                </details>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
```

> Ensure `mutate` is imported in Admin.tsx (it already uses the store elsewhere —
> reuse the existing import; if only `useDB` is imported, add `mutate` from
> `../lib/store`).

- [ ] **Step 3: Verify build + commit**

Run: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`
Expected: no new errors in `Admin.tsx`.

```bash
git add src/pages/Admin.tsx
git commit -m "feat(admin): waiver text editor (versioned) + real signature records"
```

---

## Task 9: Membership wizard — real self-sign

**Files:**
- Modify: `src/pages/Membership.tsx` (waiver step ~lines 421–460; signing logic ~lines 92–177)

- [ ] **Step 1: Load the published waiver + add consent state**

Near the other `useState` in the wizard component:

```tsx
const [consent, setConsent] = useState(false);
const [waiverDoc, setWaiverDoc] = useState<WaiverDocument | null>(null);
const [signing, setSigning] = useState(false);
useEffect(() => {
  // The first selected type maps to a waiver type; athlete→Athlete, coach→Coach.
  const wt = selectedTypes.includes('coach') ? 'Coach' : 'Athlete';
  void fetchPublishedWaiver(season.id, wt).then(setWaiverDoc);
}, [season.id, selectedTypes]);
```

Imports: `useEffect` from react; `fetchPublishedWaiver, recordWaiverSignature, requestGuardianWaiver` from `../lib/supabase`; `WaiverDocument` from `../lib/types`; `isMinorAt` from `../lib/waivers-core`.

- [ ] **Step 2: Replace `isMinor` to use the shared helper**

```tsx
const isMinor = isMinorAt(me.dob ?? '', new Date());
```

- [ ] **Step 3: Render real text + consent checkbox (self path)**

Replace the hardcoded placeholder `<div>` body with `waiverDoc?.body` and add the
checkbox; `waiverValid` now also requires `consent` and a loaded doc:

```tsx
const sigMatchesName = normalise(waiverSig) === normalise(expectedSig);
const waiverValid = !!waiverDoc && consent && (isMinor ? false : sigMatchesName);
```

(For minors the "Sign & continue" button is replaced by a "Send guardian link"
action — Task 10 — so `waiverValid` gates only the self path.)

JSX for the text + self affirmation:

```tsx
<div style={{ background: 'var(--ice-100)', border: '1px solid var(--line)', borderRadius: 8,
  padding: 14, fontSize: 13, maxHeight: 200, overflowY: 'auto', marginBottom: 14, whiteSpace: 'pre-wrap' }}>
  {waiverDoc ? waiverDoc.body : 'Loading the current waiver…'}
</div>
{!isMinor && (
  <>
    <Field label="Type your full legal name to sign"
      hint="This is a legal electronic signature; timestamp and IP are recorded.">
      <input type="text" value={waiverSig} onChange={(e) => setWaiverSig(e.target.value)} placeholder={expectedSig} />
    </Field>
    {waiverSig.trim().length > 0 && !sigMatchesName && (
      <p style={{ color: 'var(--coral-600)', fontSize: 13, marginTop: -8, marginBottom: 10 }}>
        Your signature must match your name on file: <strong>{expectedSig}</strong>.
      </p>
    )}
    <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13.5, marginBottom: 12 }}>
      <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
      <span>I have read the waiver above and agree to sign it electronically.</span>
    </label>
  </>
)}
```

- [ ] **Step 4: Wire the self submit to the Edge Function**

Replace the `setStep('pay')` on the self "Sign & continue" button with an async
handler that records the signature first (membership rows are created later at the
pay step exactly as today; the EF activates them, so signing must precede creating
the membership rows — simplest: record signature here, then proceed to pay, and at
the pay step the membership is created with `status` per payment path and the
convenience pointers set from the signature). Concretely:

```tsx
const signSelf = async () => {
  if (!waiverDoc) return;
  setSigning(true);
  const res = await recordWaiverSignature({
    personId: me.id, seasonId: season.id, waiverType: waiverDoc.waiverType,
    membershipType: selectedTypes.includes('coach') ? 'coach' : 'athlete',
    waiverDocumentId: waiverDoc.id, contentHash: waiverDoc.contentHash,
    signerName: waiverSig.trim(), signerEmail: me.email, signerRole: 'self', consent,
  });
  setSigning(false);
  if (!res.ok) { toast(res.error ?? 'Could not record signature.'); return; }
  setStep('pay');
};
```

Button: `<button className="btn primary" disabled={!waiverValid || signing} onClick={signSelf}>{signing ? 'Signing…' : 'Sign & continue →'}</button>`

> Note: the EF updates membership rows by `(person_id, season_id, type)`. Today the
> membership row is created at the pay step (`Membership.tsx:167`). To keep the EF's
> update target present, create the membership row (status `pending-waiver`) BEFORE
> calling the EF, or have the pay step skip overwriting `waiver_signed_*`. Simplest
> within the existing flow: at the pay step, set the membership `status` by payment
> path as today but DO NOT overwrite `waiverSignedAt/By` (the EF already set them).
> Verify the final membership row shows `active` + signed pointers after a full run.

- [ ] **Step 5: Verify build + commit**

Run: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`

```bash
git add src/pages/Membership.tsx
git commit -m "feat(membership): real self e-signature (published text, consent, IP via EF)"
```

---

## Task 10: Membership wizard — guardian request for minors

**Files:**
- Modify: `src/pages/Membership.tsx` (minor branch of the waiver step)

- [ ] **Step 1: Add guardian fields + handler**

```tsx
const [guardianName, setGuardianName] = useState('');
const [guardianEmail, setGuardianEmail] = useState('');
const [sentGuardian, setSentGuardian] = useState(false);

const sendGuardian = async () => {
  if (!waiverDoc) return;
  if (guardianName.trim().length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(guardianEmail)) {
    toast('Enter the guardian name and a valid email.'); return;
  }
  setSigning(true);
  const res = await requestGuardianWaiver({
    personId: me.id, seasonId: season.id, waiverType: waiverDoc.waiverType,
    membershipType: selectedTypes.includes('coach') ? 'coach' : 'athlete',
    guardianName: guardianName.trim(), guardianEmail: guardianEmail.trim(),
  });
  setSigning(false);
  if (!res.ok) { toast(res.error ?? 'Could not send the guardian link.'); return; }
  setSentGuardian(true);
  toast('Signing link sent to the guardian.');
};
```

- [ ] **Step 2: Render the minor branch**

```tsx
{isMinor && (
  <>
    <Badge tone="warn">Under 18</Badge>
    <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13.5, margin: '8px 0 12px' }}>
      <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
      <span>I confirm a parent/guardian will sign this waiver electronically on the athlete's behalf.</span>
    </label>
    {sentGuardian ? (
      <p style={{ fontSize: 14 }}>✓ Link sent to {guardianEmail}. The membership activates once the guardian signs.</p>
    ) : (
      <>
        <Field label="Guardian name"><input type="text" value={guardianName} onChange={(e) => setGuardianName(e.target.value)} /></Field>
        <Field label="Guardian email"><input type="email" placeholder="guardian@example.com" value={guardianEmail} onChange={(e) => setGuardianEmail(e.target.value)} /></Field>
        <button className="btn primary" disabled={!waiverDoc || !consent || signing} onClick={sendGuardian}>
          {signing ? 'Sending…' : 'Email guardian a signing link'}
        </button>
      </>
    )}
  </>
)}
```

- [ ] **Step 3: Create the membership as `pending-waiver` for minors**

Where the membership is created at the pay step, when `isMinor` the status must be
`'pending-waiver'` (the guardian EF flips it to active on signing). Adjust the
status expression at `Membership.tsx:170` to prefer `pending-waiver` for minors who
haven't completed guardian signing.

- [ ] **Step 4: Verify build + commit**

Run: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`

```bash
git add src/pages/Membership.tsx
git commit -m "feat(membership): guardian email signing for minors (pending-waiver)"
```

---

## Task 11: Guardian signing page + route

**Files:**
- Create: `src/pages/WaiverSign.tsx`
- Modify: `src/App.tsx` (import + route)

- [ ] **Step 1: Write the page**

```tsx
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { fetchSignRequest, fetchPublishedWaiver, recordWaiverSignature } from '../lib/supabase';
import type { WaiverDocument } from '../lib/types';

export default function WaiverSign() {
  const { token = '' } = useParams();
  const [state, setState] = useState<'loading' | 'ready' | 'invalid' | 'done'>('loading');
  const [req, setReq] = useState<any>(null);
  const [doc, setDoc] = useState<WaiverDocument | null>(null);
  const [name, setName] = useState('');
  const [relationship, setRelationship] = useState('parent');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    (async () => {
      const r = await fetchSignRequest(token);
      if (!r || r.status !== 'pending') { setState('invalid'); return; }
      const d = await fetchPublishedWaiver(r.season_id, r.waiver_type);
      if (!d) { setState('invalid'); return; }
      setReq(r); setDoc(d); setState('ready');
    })();
  }, [token]);

  const submit = async () => {
    if (!doc) return;
    setBusy(true); setErr('');
    const res = await recordWaiverSignature({
      personId: req.person_id, seasonId: req.season_id, waiverType: req.waiver_type,
      membershipType: req.membership_type, waiverDocumentId: doc.id, contentHash: doc.contentHash,
      signerName: name.trim(), signerEmail: req.guardian_email, signerRole: 'guardian',
      signerRelationship: relationship, consent, token,
    });
    setBusy(false);
    if (!res.ok) { setErr(res.error ?? 'Could not record signature.'); return; }
    setState('done');
  };

  if (state === 'loading') return <div className="card card-pad" style={{ maxWidth: 640, margin: '40px auto' }}>Loading…</div>;
  if (state === 'invalid') return <div className="card card-pad" style={{ maxWidth: 640, margin: '40px auto' }}>
    <h2>This signing link is no longer valid.</h2>
    <p style={{ color: 'var(--ink-soft)' }}>Ask the athlete to resend the guardian link from their membership page.</p></div>;
  if (state === 'done') return <div className="card card-pad" style={{ maxWidth: 640, margin: '40px auto' }}>
    <h2>✓ Thank you — the waiver is signed.</h2>
    <p style={{ color: 'var(--ink-soft)' }}>The athlete's membership is now active.</p></div>;

  return (
    <div className="card card-pad" style={{ maxWidth: 640, margin: '40px auto' }}>
      <h2>{req.waiver_type} waiver — guardian signature</h2>
      <div style={{ background: 'var(--ice-100)', border: '1px solid var(--line)', borderRadius: 8,
        padding: 14, fontSize: 13, maxHeight: 240, overflowY: 'auto', margin: '12px 0', whiteSpace: 'pre-wrap' }}>
        {doc?.body}
      </div>
      <label style={{ display: 'block', marginBottom: 8 }}>Your full legal name
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label style={{ display: 'block', marginBottom: 8 }}>Relationship to athlete
        <input className="input" value={relationship} onChange={(e) => setRelationship(e.target.value)} /></label>
      <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13.5, margin: '8px 0 12px' }}>
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        <span>I am the parent/guardian and agree to sign this waiver electronically. Timestamp and IP are recorded.</span>
      </label>
      {err && <p style={{ color: 'var(--coral-600)', fontSize: 13 }}>{err}</p>}
      <button className="btn primary" disabled={busy || consent === false || name.trim().length < 2} onClick={submit}>
        {busy ? 'Signing…' : 'Sign waiver'}
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Add the route (public — no `RequireAccount`)**

In `src/App.tsx`, add the import alongside the other page imports and a route
inside `<Routes>` (before the `*` catch-all):

```tsx
import WaiverSign from './pages/WaiverSign';
// …
<Route path="/waiver/sign/:token" element={<WaiverSign />} />
```

- [ ] **Step 3: Verify build + commit**

Run: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`

```bash
git add src/pages/WaiverSign.tsx src/App.tsx
git commit -m "feat: standalone guardian waiver signing page + route"
```

---

## Task 12: Seed default waiver documents

**Files:**
- Modify: `src/lib/seed.ts`

The seed runs synchronously, but `sha256Hex` is async. Use a fixed placeholder
hash for seeded docs (they're demo-only; real docs are admin-created) — OR compute
hashes in an async post-seed step. Simplest: seed with a deterministic placeholder
body and a literal hash string `'seed'`; the Edge Function only enforces hash
equality for docs it serves, and seeded demo docs are replaced once an admin saves
a real version.

- [ ] **Step 1: Add seeded docs**

In `buildSeed()`, for the current season add one published `WaiverDocument` per
`WAIVER_TYPES` entry:

```ts
import { WAIVER_TYPES } from './types';
// … inside buildSeed, after seasons are built:
const waiverDocuments = WAIVER_TYPES.map((t, i) => ({
  id: `seed-waiver-${i}`,
  seasonId: currentSeasonId,
  waiverType: t,
  version: 1,
  body: `UCG ${t.toUpperCase()} ASSUMPTION OF RISK, WAIVER & RELEASE.\n\n` +
    `I acknowledge that gymnastics carries inherent risk of serious injury. ` +
    `In consideration of being permitted to participate in United Club Gymnastics ` +
    `events, I release UCG, host clubs, venues, and their officers from liability ` +
    `to the fullest extent permitted by law. (Placeholder text — replace in Admin → Waivers.)`,
  contentHash: 'seed',
  published: true,
  createdAt: new Date().toISOString(),
}));
// include `waiverDocuments` (and `waiverSignatures: []`) in the returned DB object.
```

> Bump `SEED_VERSION` in `src/lib/store.ts` from 3 to 4 so existing localStorage
> snapshots reseed and pick up the new field.

- [ ] **Step 2: Verify build + tests + commit**

Run: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`
Run: `node node_modules/vitest/vitest.mjs run`
Expected: all tests pass.

```bash
git add src/lib/seed.ts src/lib/store.ts
git commit -m "feat(seed): default placeholder waiver documents; bump SEED_VERSION"
```

---

## Task 13: Deploy — migrations + Edge Functions

**Files:** none (deployment)

- [ ] **Step 1: Show what will apply, then push migrations**

Run (sandbox disabled): `supabase db push --dry-run` then `supabase db push`
Expected: the two new migrations apply cleanly; the enum migration applies before
the tables migration.

- [ ] **Step 2: Set the guardian-link base URL secret**

Run: `supabase secrets set APP_PUBLIC_URL=https://nssharpe.github.io/ucg-platform`

- [ ] **Step 3: Deploy the Edge Functions**

Run: `supabase functions deploy record-waiver-signature`
Run: `supabase functions deploy request-guardian-waiver`
Expected: both deploy; `record-waiver-signature` shows `verify_jwt = false` from config.

- [ ] **Step 4: Smoke test (manual)**

1. Admin → Waivers → edit the Athlete text → Save new version → confirm v2 appears.
2. As an adult member, run membership → waiver step shows the saved text → check
   consent + type name → Sign → confirm `waiver_signatures` row has a real IP and
   the membership is `active`.
3. As a minor (DOB < 18), send guardian link → open the emailed `#/waiver/sign/…`
   link in a private window → sign → confirm membership flips out of
   `pending-waiver` and a `signer_role='guardian'` row exists.
4. Admin → Waivers → Signed list → expand a Certificate → confirm version, hash,
   IP, consent render.

- [ ] **Step 5: Commit any config touched + push branch**

```bash
git add -A && git commit -m "chore: waiver e-sign deploy config" --allow-empty
git push
```

---

## Self-review notes (addressed)

- **Spec coverage:** versioned text (T2/T3/T8), evidence record (T2/T6), server IP
  (T6), self path (T9), guardian email path (T7/T10/T11), admin certificate (T8),
  pending-waiver status (T1/T10), counsel sign-off is human-only (out of scope).
- **Status interplay (club-pay + minor):** flagged in T6 Step 1 note and T10 Step 3
  — resolve by reading the membership/payment path before setting status; default
  active, `pending-club-payment` when club-pay unpaid, `pending-waiver` until
  guardian signs. Confirm during T13 smoke test.
- **Hash on seed:** seeded docs use a literal `'seed'` hash (demo-only); real
  admin-saved docs always compute `sha256Hex`. EF hash check protects real docs.
- **Type consistency:** `recordWaiverSignature` args match the EF body keys; EF
  reads `waiver_sign_requests` to fill server-trusted fields on the guardian path.
