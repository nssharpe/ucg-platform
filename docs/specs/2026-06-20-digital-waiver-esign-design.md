# Digital waiver e-signature (clickwrap) — design

Date: 2026-06-20
Status: Draft for review
Owner: Nate (PM); implementation: Claude

## Problem

The admin Waivers screen lets you "upload" a waiver PDF, but nothing is stored —
the file is in-memory only and the "View" link toasts "prototype — no real file
stored". The membership wizard has a waiver step, but it's also a stub: the text
is hardcoded placeholder, the promised guardian email link never sends, and the
only thing persisted is `waiver_signed_at` / `waiver_signed_by` on the membership
row. The hint even claims "IP recorded" — it isn't.

Rather than host signed PDFs, we want a **digital, legally binding e-signature**.

## Approach: built-in clickwrap (no PDFs, no third party)

US electronic signatures are governed by the federal **ESIGN Act** and **UETA**
(adopted by ~every state). A signature is binding when we can demonstrate:

1. **Intent to sign** — a deliberate affirmation (typed name + click).
2. **Consent to do business electronically** — an explicit checkbox.
3. **Attribution** — the signature ties to an identifiable person.
4. **Record integrity & retention** — we can prove *what* was agreed to and
   reproduce it on demand.

Legal validity comes from the **audit trail bound to an immutable version of the
waiver text**, not from a rendered PDF. So we store a structured signature
**record**, not a file. If a human-readable "document" is ever needed (dispute,
insurer), we regenerate it on demand from the record + the retained waiver text.

Rejected alternatives:
- **Third-party e-sign (DocuSign/Dropbox Sign):** overkill, recurring cost, and
  ironically stores signed PDFs. Reserve for notarization-grade needs we don't have.
- **Typed signature stamped onto a PDF template:** reintroduces the PDF storage we
  want to avoid, with no legal benefit over clickwrap.

### Decisions (locked with PM)

- Scope: clickwrap e-sign; waivers become editable **text**, not uploaded PDFs.
- Identity: **both** paths — members sign logged-in (role=self); guardians of
  minors sign via a **verified email link** (role=guardian).
- Consent: **explicit checkbox** in addition to typed full name.
- Guardian flow: **emailed link only** (no in-person guardian signing); the
  membership stays in a **pending-waiver** state until the guardian completes it.

## Components

### 1. Versioned waiver text (replaces PDF upload)

Admin "Waivers" tab becomes a **text editor** per `season + waiver type`
(`Athlete | Coach | Judge | Other Floor Access`). Saving creates an **immutable
version** with a SHA-256 content hash. Prior versions are retained forever so every
signature stays bound to the exact text it agreed to. Editing produces a new
version; it never mutates an existing one.

- New table `waiver_documents`: `id`, `season_id`, `waiver_type`, `version`
  (int, per season+type), `body` (text/markdown), `content_hash` (text),
  `published` (bool), `created_at`, `created_by`.
- The current "Upload file" / version-history UI is removed.
- Out of scope (deferrable add-on): attaching a reference PDF alongside the text.

### 2. Signature evidence record

New table `waiver_signatures` — **one row per signing event**, the legal artifact:

- `id`, `person_id`, `season_id`, `waiver_type`
- `waiver_document_id` + `content_hash` (snapshot of exactly what was agreed)
- `signer_name`, `signer_email`
- `signer_role` (`self | guardian`), `signer_relationship` (nullable; e.g. "parent")
- `consent` (bool — the checkbox state at submit time)
- `signed_at` (server timestamp), `ip` (text), `user_agent` (text)
- `created_at`

`memberships.waiver_signed_at` / `waiver_signed_by` remain as denormalized
convenience pointers; `waiver_signatures` is the source of truth.

### 3. Server-side recording (Edge Function)

A browser can't be trusted to report its own IP, so signatures are written through
a new Supabase Edge Function **`record-waiver-signature`** that:

- validates the request (waiver doc exists + is published; hash matches),
- stamps the real client **IP** and a server **timestamp**,
- inserts the `waiver_signatures` row,
- updates the relevant membership(s) to `active`/next state and sets the
  convenience pointers.

This mirrors the existing `send-email` function pattern.

### 4. Two signing paths

**Member (logged in)** — in the membership wizard's waiver step:
1. Render the published waiver text for that season+type.
2. Require: consent checkbox **and** typed full legal name (matches name on file).
3. On submit → call `record-waiver-signature` with `signer_role=self`.

**Minor → guardian (verified email)** — DOB < 18 at signing time:
1. Wizard collects guardian name + email and sends a tokenized signing link via
   the existing `send-email` function. A new `waiver_sign_requests` table holds the
   token (`id`, `token`, `person_id`, `season_id`, `waiver_type`, `guardian_email`,
   `status` = `pending|completed|expired`, `created_at`, `completed_at`).
2. The athlete's membership is created in **`pending-waiver`** status.
3. Guardian opens the standalone signing page (`/waiver/sign/:token`), reads the
   same versioned text, checks consent, types their name + relationship, submits.
4. On submit → `record-waiver-signature` with `signer_role=guardian`; the token is
   marked completed and the membership transitions out of `pending-waiver`.

### 5. Admin visibility

The "Signed waivers" list shows real `waiver_signatures` records. Each row expands
to a regenerated, human-readable certificate, e.g.:

> Jane Doe's guardian, John Doe (parent), agreed to **Athlete Waiver v3**
> (hash `abc123…`) on 2026-06-20 14:02 UTC from IP `x.x.x.x` (consent: yes).

No file is stored; the certificate is rendered from the record + retained text.

## Data flow

```
Admin edits waiver text ─► waiver_documents (new immutable version + hash)

Member signs (logged in)
  wizard ─► record-waiver-signature (EF) ─► waiver_signatures + membership=active

Minor signs (guardian)
  wizard ─► waiver_sign_requests (token) ─► send-email (EF) ─► guardian email
  membership = pending-waiver
  guardian ─► /waiver/sign/:token ─► record-waiver-signature (EF)
           ─► waiver_signatures + token=completed + membership active
```

## Migrations

Per the CLAUDE.md enum gotcha, `membership_status` is a Postgres enum, so adding
`pending-waiver` must commit in its **own** migration before anything references it:

1. `…_membership_status_pending_waiver.sql` — `ALTER TYPE membership_status ADD
   VALUE 'pending-waiver';` (alone).
2. `…_waiver_esign.sql` — `waiver_documents`, `waiver_signatures`,
   `waiver_sign_requests` tables, indexes, and RLS policies.

RLS sketch:
- `waiver_documents`: read = anyone (published rows are public so unauthenticated
  guardians can render text via token); write = admin only.
- `waiver_signatures`: insert/select via the Edge Function (service role); admins
  can read all; a person can read their own.
- `waiver_sign_requests`: managed by Edge Functions; token lookup is unauthenticated
  but scoped to a single pending row.

## Error handling

- Expired/used/invalid guardian token → friendly "this link is no longer valid;
  ask the athlete to resend" page.
- Signing against a stale waiver version (admin republished mid-flow) → re-render
  the current version and require re-affirmation; never record against a hash that
  doesn't match the current published doc.
- Edge Function failure → the wizard surfaces the error and does **not** mark the
  membership signed (no silent partial state).
- Name mismatch (self path) → block submit, as today.

## Testing

- Unit (vitest, node env): content-hash stability, version increment per
  season+type, minor/age determination at a given signing date, token
  state-machine transitions (pending→completed/expired). These are pure functions
  split out from React, matching the existing `capabilities-core` pattern.
- Edge Function logic (IP stamping, hash validation, membership transition) covered
  by pure helpers where possible; manual verification for the HTTP surface.
- No DOM/component tests yet (consistent with current repo state).

## Human-only / out of scope

- **NAIGC counsel must bless the actual waiver wording.** The signing *mechanism*
  is standard ESIGN/UETA; the *content* needs a human sign-off.
- Reference-PDF attachment alongside text — deferrable add-on.
- Real email deliverability already depends on the existing `send-email` function.
