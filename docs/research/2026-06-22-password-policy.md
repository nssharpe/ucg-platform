# Password policy best practice — recommendation

> Research note, 2026-06-22. Answers: "What's best practice for password enforcement
> in terms of length, composition, etc.?"

## TL;DR — modern guidance (NIST SP 800-63B)

Current best practice has moved **away** from forced complexity rules and frequent
rotation, toward **length + a breached-password check**:

- **Minimum length 8**, ideally encourage longer (passphrases). NIST allows up to 64+.
- **Do NOT mandate composition** (no "must contain 1 upper, 1 digit, 1 symbol"). Forced
  composition pushes users to predictable patterns (`Password1!`) and hurts usability
  without improving real security.
- **Do NOT force periodic rotation.** Only force a reset on evidence of compromise.
- **DO screen against known-breached passwords** (the single highest-value control) and
  against trivial/sequential values.
- **Allow paste** and password managers (we do — inputs use `autocomplete` correctly).
- **Allow all characters incl. spaces/Unicode.**

## What Supabase gives us out of the box

Supabase Auth has built-in password policy settings (Dashboard → Authentication →
Policies, or `config.toml` for local). We can set these centrally — no app code:

- **Minimum length** (default 6 → raise to **8** minimum, recommend 10–12).
- **Required character classes** — Supabase offers presets like
  `lower_upper_letters_digits_symbols`. Per NIST we'd normally skip this, but if the org
  wants a visible "strong password" signal, `lower_upper_letters_digits` (no symbol
  requirement) is a reasonable middle ground.
- **Leaked password protection** — Supabase integrates **HaveIBeenPwned** to reject
  known-breached passwords. **This is a Pro-plan feature.** It's the most valuable
  setting; if/when we're on Pro, turn it on.

## Recommendation for UCG

1. **Set Supabase minimum length to 10.** Cheap, no code, immediate.
2. **Turn on leaked-password protection** if we're on (or move to) the Pro plan — this
   is the one control that actually stops account takeover from credential stuffing.
3. **Do not require symbols.** Optionally require "letters + digits" only if the org
   wants a complexity signal; otherwise length-only is fine and more usable.
4. **Add a client-side strength meter + min-length hint** on the Gate sign-up form so
   users get feedback *before* submit (Supabase only rejects on submit). A small
   `zxcvbn`-style check or a simple length/variety hint is enough — purely advisory.
5. **No forced rotation.** Reset only via the existing email reset flow or on compromise.

### Concrete app changes (small)
- `src/pages/Gate.tsx` sign-up: show min-length requirement inline; disable submit until
  the new password meets the configured minimum; surface Supabase's policy-rejection
  message clearly (it returns a descriptive error today, swallowed into the generic
  error line — make sure it's shown).

## References
- NIST SP 800-63B (Digital Identity — Authenticators): https://pages.nist.gov/800-63-3/sp800-63b.html
- Supabase password security: https://supabase.com/docs/guides/auth/password-security
- HaveIBeenPwned Pwned Passwords: https://haveibeenpwned.com/Passwords
