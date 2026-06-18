# Auth & Email Setup — Supabase Dashboard Steps

**Date:** 2026-06-16  
**Context:** These are manual dashboard steps required to make email confirmation work
correctly and look on-brand. None of these can be done from code.

---

## 1. Fix the confirmation redirect (Site URL)

The default Supabase Site URL is `http://localhost:3000`, which causes the
confirmation link to land on a 404/error page for real users.

**Authentication → URL Configuration**

| Setting | Value |
|---|---|
| **Site URL** | `https://nssharpe.github.io/ucg-platform/` |
| **Redirect URLs** (add both) | `https://nssharpe.github.io/ucg-platform/` |
| | `http://localhost:5173/` |

Steps:
1. Supabase dashboard → your project → **Authentication** (left nav) → **URL Configuration**.
2. Set **Site URL** to `https://nssharpe.github.io/ucg-platform/`.
3. Under **Redirect URLs**, click **Add URL** and add each value in the table above.
4. Save.

The code already passes `emailRedirectTo: window.location.origin + BASE_URL` on
`signUp`, so once the redirect URL is whitelisted here, confirmation links will
return users to the app correctly.

---

## 2. Custom SMTP (UCG-branded sender)

By default confirmation emails come from `noreply@mail.supabase.io` with a
Supabase subject line. Set up a UCG sender so recipients trust the email.

**Authentication → Emails → SMTP Settings**

Recommended: use [Resend](https://resend.com) (free tier is sufficient for now).

1. Create a Resend account and verify `naigc.org` (or `ucg.naigc.org`) as a sending
   domain. Resend walks you through the DNS records (SPF, DKIM).
2. In Resend → API Keys, create a key with **Sending access** only.
3. In Supabase → **Authentication → Emails** (or **Project Settings → Auth**):
   - Enable **Custom SMTP**.
   - **Host:** `smtp.resend.com`
   - **Port:** `465` (SSL) or `587` (TLS)
   - **Username:** `resend`
   - **Password:** your Resend API key
   - **Sender name:** `United Club Gymnastics`
   - **Sender email:** `noreply@naigc.org` (must match verified Resend domain)
4. Save and use the **Send test email** button to verify delivery.

---

## 3. Email template customization

**Authentication → Emails → Email Templates**

Customize at minimum: **Confirm signup** and **Magic Link**.

### Suggested HTML for "Confirm signup"

Replace the default template body with:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Confirm your UCG account</title>
</head>
<body style="margin:0;padding:0;background:#f5f7f8;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f7f8;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">

          <!-- Header bar -->
          <tr>
            <td style="background:#1d2a38;padding:28px 40px;">
              <span style="font-size:28px;font-weight:800;color:#ffffff;letter-spacing:-0.5px;">
                UCG<span style="color:#f46949;">.</span>
              </span>
              <p style="margin:6px 0 0;color:rgba(219,235,237,0.7);font-size:12px;letter-spacing:0.08em;text-transform:uppercase;">
                United Club Gymnastics
              </p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:36px 40px 28px;">
              <h1 style="margin:0 0 12px;font-size:22px;color:#1d2a38;font-weight:700;">
                Confirm your account
              </h1>
              <p style="margin:0 0 24px;color:#4a5568;font-size:15px;line-height:1.6;">
                You're one step away from accessing the UCG Registration &amp;
                Scoring Platform. Click the button below to verify your email
                address and sign in.
              </p>
              <a href="{{ .ConfirmationURL }}"
                 style="display:inline-block;background:#f46949;color:#ffffff;text-decoration:none;
                        font-weight:700;font-size:15px;padding:14px 28px;border-radius:6px;
                        letter-spacing:0.02em;">
                Confirm my account →
              </a>
              <p style="margin:24px 0 0;color:#718096;font-size:12px;line-height:1.6;">
                If you didn't create an account, you can safely ignore this email.<br />
                This link expires in 24 hours.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#f5f7f8;padding:20px 40px;border-top:1px solid #e2e8f0;">
              <p style="margin:0;color:#a0aec0;font-size:11px;text-align:center;">
                United Club Gymnastics &nbsp;·&nbsp; For the love of the sport.<br />
                <a href="https://naigc.org" style="color:#a0aec0;">naigc.org</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
```

**Subject line:** `Confirm your UCG account`

### Suggested HTML for "Magic Link"

**Subject line:** `Your UCG sign-in link`

Replace the default template body with:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Sign in to UCG</title>
</head>
<body style="margin:0;padding:0;background:#f5f7f8;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f7f8;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">

          <!-- Header bar -->
          <tr>
            <td style="background:#1d2a38;padding:28px 40px;">
              <span style="font-size:28px;font-weight:800;color:#ffffff;letter-spacing:-0.5px;">
                UCG<span style="color:#f46949;">.</span>
              </span>
              <p style="margin:6px 0 0;color:rgba(219,235,237,0.7);font-size:12px;letter-spacing:0.08em;text-transform:uppercase;">
                United Club Gymnastics
              </p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:36px 40px 28px;">
              <h1 style="margin:0 0 12px;font-size:22px;color:#1d2a38;font-weight:700;">
                Your sign-in link
              </h1>
              <p style="margin:0 0 24px;color:#4a5568;font-size:15px;line-height:1.6;">
                Click the button below to sign in to the UCG Registration &amp;
                Scoring Platform. No password needed — this link signs you in directly.
              </p>
              <a href="{{ .ConfirmationURL }}"
                 style="display:inline-block;background:#f46949;color:#ffffff;text-decoration:none;
                        font-weight:700;font-size:15px;padding:14px 28px;border-radius:6px;
                        letter-spacing:0.02em;">
                Sign in to UCG →
              </a>
              <p style="margin:24px 0 0;color:#718096;font-size:12px;line-height:1.6;">
                If you didn't request this link, you can safely ignore this email.<br />
                This link expires in 1 hour and can only be used once.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#f5f7f8;padding:20px 40px;border-top:1px solid #e2e8f0;">
              <p style="margin:0;color:#a0aec0;font-size:11px;text-align:center;">
                United Club Gymnastics &nbsp;·&nbsp; For the love of the sport.<br />
                <a href="https://naigc.org" style="color:#a0aec0;">naigc.org</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
```

---

## 4. Duplicate-account risk note

`link_or_create_person` claims a person row by **verified email**. The flow is:

1. User signs up → Supabase creates an unconfirmed auth user.
2. User clicks the confirmation link → email is verified.
3. User signs in → `onAuthenticated` runs `link_or_create_person` → the RPC
   matches by `auth.email()` (verified) and either claims an existing person or
   creates a new one.

**If Site URL is wrong (Step 1 above):** the confirmation link goes to
`localhost:3000`, the user never confirms, the auth user stays unverified, and
if they retry they can end up with a second unverified auth row. The RPC may then
create a stray "orphan" person row (no memberships, no club) because the email
was never verified, so the claim-by-email path didn't fire.

**Fix:** completing Step 1 (correct Site URL) resolves this. Once confirmation
works end-to-end, `link_or_create_person` behaves correctly. Any existing stray
person rows from broken confirmation flows can be merged or deleted via the
Admin → Members UI.
