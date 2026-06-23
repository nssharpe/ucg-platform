# Auth hardening: 2FA & passkeys — options and recommendation

> Research note, 2026-06-22. Answers the account-setup question: "We need to explore
> two-factor authentication and passkeys for better security for login. What are our
> options there?"

## Current state

Login is email + password via `supabase.auth.signInWithPassword` (`src/pages/Gate.tsx`).
No second factor. Email confirmation is on (sign-up sends a confirm link). We are on
Supabase Auth (GoTrue), which gives us MFA primitives for free — we do **not** need a
third-party identity provider.

## What Supabase Auth gives us

Supabase Auth supports **Multi-Factor Authentication (MFA)** with three factor types.
All are driven through the same enroll → challenge → verify API
(`supabase.auth.mfa.*`) and surfaced in the JWT via an **AAL** (Authenticator
Assurance Level): `aal1` = password only, `aal2` = password + a verified factor.

| Factor type | What the user does | Cost / tier | Notes |
|---|---|---|---|
| **TOTP** (`mfa.enroll({ factorType: 'totp' })`) | Scans a QR into Google Authenticator / Authy / 1Password, enters 6-digit code | Free, all plans | The standard "authenticator app" 2FA. No SMS cost, works offline. |
| **Phone / SMS** (`factorType: 'phone'`) | Receives a code by text | Needs an SMS provider; per-message cost | We already have Telnyx wired for Communicate SMS, so this is *possible*, but adds cost + SIM-swap risk. |
| **WebAuthn / Passkeys** (`factorType: 'webauthn'`) | Face ID / Touch ID / Windows Hello / security key | Free, all plans | Phishing-resistant. Newer in Supabase; verify the installed `@supabase/supabase-js` version exposes it before committing. |

### AAL enforcement
RLS policies and the client can require `aal2` for sensitive actions:
`auth.jwt()->>'aal' = 'aal2'`. The client reads
`supabase.auth.mfa.getAuthenticatorAssuranceLevel()` → `{ currentLevel, nextLevel }`.
If `nextLevel === 'aal2' && currentLevel === 'aal1'`, prompt for the second factor.

## Passkeys: two different things

"Passkeys" can mean either of two things — decide which we want:

1. **Passkey as a second factor (MFA `webauthn`)** — password first, then Face ID/Touch
   ID. Easiest to add on top of what we have; same enroll/challenge/verify flow as TOTP.
2. **Passkey as primary (passwordless) login** — no password at all, sign in with the
   device authenticator. Stronger UX and phishing-resistant, but a bigger change to the
   Gate flow and needs a recovery story (lost device → email magic link fallback).

## Recommendation (phased)

Given we're a volunteer-run org platform with a mix of non-technical users (parents,
athletes), optimize for "meaningfully better security without locking anyone out":

- **Phase A — TOTP MFA, opt-in.** Add an "Authenticator app (2FA)" section to the
  Profile page: enroll (show QR), verify, list/unenroll factors. Lowest cost, no new
  infra, works for everyone. This is the 80/20.
- **Phase B — Require aal2 for admins.** Once league admins have TOTP enrolled, gate
  `/admin/*` and destructive Edge Functions on `aal2`. Protects the highest-value
  accounts (league admins can edit any club/membership).
- **Phase C — Passkeys as an additional factor** (`webauthn`), opt-in, after confirming
  SDK support. Sell it as "skip codes — use Face ID / Touch ID."
- **Defer SMS MFA.** It costs per-message and is the weakest factor (SIM-swap). Only
  add if users specifically ask and can't use an authenticator app.
- **Skip passwordless-primary for now** — bigger rebuild + recovery complexity; revisit
  once passkeys are familiar to the user base.

### Account-recovery must-haves before turning on *required* MFA
- **Recovery codes** at enroll time (Supabase returns nothing built-in here — we'd show
  one-time backup notice and rely on admin reset).
- **Admin reset path:** a league-admin Edge Function to unenroll a locked-out user's
  factors (service role: `auth.admin` + delete factor). Build this *with* Phase B.

## Rough effort
- Phase A (TOTP opt-in): ~1–2 days (Profile UI + enroll/verify/unenroll flows + tests).
- Phase B (require aal2 for admin): ~1 day (client gate + RLS predicate + admin-reset fn).
- Phase C (passkeys): ~1 day once SDK support confirmed.

## References
- Supabase MFA (TOTP): https://supabase.com/docs/guides/auth/auth-mfa/totp
- Supabase MFA (Phone): https://supabase.com/docs/guides/auth/auth-mfa/phone
- Supabase WebAuthn/passkeys: https://supabase.com/docs/guides/auth/auth-mfa (factor types)
- AAL & enforcing MFA in RLS: https://supabase.com/docs/guides/auth/auth-mfa#enforce-mfa
