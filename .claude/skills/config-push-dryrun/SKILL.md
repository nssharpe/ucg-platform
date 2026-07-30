---
name: config-push-dryrun
description: Safely dry-run and apply `supabase config push` for UCG, including the prompt-eating trap that pushed unintended auth defaults to prod. Use before ANY config push, or when changing supabase/config.toml or auth email templates.
---

# `supabase config push` — dry run first

This command has broken prod auth once. Treat every invocation as dangerous.

## Two independent traps

**1. It pushes DEFAULTS for undeclared `[auth]` keys.** Any `[auth]` setting not explicitly
declared in `config.toml` is pushed as the CLI's default, overwriting whatever the dashboard has.
Keep every key in `config.toml` deliberate — that's why `[auth.passkey]`, `[auth.webauthn]`, and
`[auth.mfa.web_authn]` are all declared explicitly even where the value matches the default.

**2. It AUTO-CONFIRMS under agent detection**, and closed stdin also defaults the prompt to Yes.
So a "dry run" can apply for real.

## The dry run

```bash
echo n | supabase config push --agent no
```

Read the diff before doing anything else.

### ⚠⚠ `echo n` feeds exactly ONE line

If an EXTRA prompt appears first, it eats the `n` and the real push prompt EOF-defaults to **YES**.

This bit us live 2026-07-18: enabling `[auth.mfa.web_authn]` triggered a paid-add-on cost
confirmation *before* the push prompt, which consumed the `n` — and the push went through,
sending `min-password-length 6` and `secure_password_change false` to prod during what was
supposed to be a dry run. Repaired the same session.

**Mitigation:** pipe one `n` per expected prompt, or count prompts from a prior run first.

```bash
printf 'n\nn\n' | supabase config push --agent no
```

## Environment

**Prod only.** Staging is free-tier and 400s template pushes.

## Auth email templates

Templates are repo-managed and render from the shared email layout:

```bash
npx tsx scripts/render-auth-email-templates.mts
```

→ writes `supabase/templates/*.html` → then `config push`.

Full runbook and trap list: `supabase/README.md` → "Auth email templates".

## After pushing

Confirm the settings that matter actually landed — read them back from the dashboard side rather
than trusting the command's output. The 2026-07-18 incident was only caught by reading back.
