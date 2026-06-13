# Hosting & pre-launch checklist

How this app is hosted today, where it goes for production, and what to harden
before taking real registrations and payments. Written 2026-06-13.

## The shape of the app (why hosting is easy)

The platform is **two independent halves**:

1. **Frontend** — a static bundle (the Vite build: HTML/JS/CSS). Any static host
   serves it. No server-side rendering, no Node runtime needed in production.
2. **Backend** — Supabase (Postgres + Auth + Edge Functions), already cloud-hosted
   and independent of where the frontend lives.

Because the frontend is just static files, moving hosts is "repoint a deploy +
a DNS record," not a rewrite. **None of the current work is host-specific.**

## Today (development)

- **Frontend:** GitHub Pages at https://nssharpe.github.io/ucg-platform/, deployed
  by GitHub Actions on push to `main` (`.github/workflows/deploy.yml`).
- **Backend:** Supabase project `ucg-platform` (ref `wkyerxlgricfphopocoz`), free tier.
- **Routing:** `HashRouter` (`#/meets`) — forced by GitHub Pages' lack of SPA
  rewrites and the `/ucg-platform/` base path.
- **Auth:** Supabase email/password. Real security is **Row-Level Security** in
  Postgres — that boundary is host-independent and already production-grade.

## Production target: `registration.unitedgymnastics.org`

**A subdomain is DNS, not hosting.** `registration.unitedgymnastics.org` is a single
DNS record that can point anywhere — it does **not** need to share infrastructure
with the main UCG marketing site. The recommended layout:

- The marketing site (`unitedgymnastics.org`) stays on whatever it runs on (WordPress,
  Squarespace, …), untouched.
- The registration app lives on its **own static host**; a CNAME points the
  `registration.` subdomain at it.
- The two are linked only by navigation + shared branding. This decoupling is a
  feature: a deploy/outage on one can't take down the other.

Avoid serving the app under a path on the main site (`/registration`) or rebuilding
it into the CMS — more fragile, more work, no benefit.

### Recommended production stack

| Concern | Dev (now) | Production |
|---|---|---|
| Static host | GitHub Pages | **Cloudflare Pages** (or Netlify/Vercel) — custom domain, private repo, security headers, free WAF/DDoS |
| Routing | `HashRouter` (`#/meets`) | `BrowserRouter` (`/meets`) — small code change once the host does SPA fallback |
| Database/Auth | Supabase **free** (pauses when idle, minimal backups) | Supabase **Pro** ($25/mo: daily backups + PITR, no pausing) |
| Auth emails | default Supabase sender (rate-limited, generic) | **custom SMTP** (Resend/Postmark/SES) from `@unitedgymnastics.org` for deliverability |

The migration is roughly a half-day and is not blocking feature work.

## Pre-launch hardening checklist

Already handled / by design:
- [x] **PCI** — Stripe hosted Checkout keeps card data off our site entirely
  (lightest tier, SAQ-A). True on any host. (See the Stripe work for sub-project B.)
- [x] **Data access** — RLS protects every table; the Supabase anon key is public by
  design (RLS is the gate, not the key).
- [x] **Secrets** — the Stripe secret key and Supabase service-role key live only in
  Edge Functions / GitHub Actions vars, never in the frontend bundle.
- [x] **Email confirmation ON** — required for the claim-by-email account model.

To do before a real launch:
- [ ] **Supabase Pro** — backups + point-in-time recovery + no idle-pausing. The one
  item to insist on before handling real registration/payment data.
- [ ] **RLS audit** — a deliberate pass over every policy: no table world-writable,
  enable leaked-password protection, confirm public read is scoped to the intended
  competition tables only.
- [ ] **Custom SMTP** for auth/notification emails (deliverability + branding).
- [ ] **Security headers** — CSP, HSTS, X-Frame-Options via the host's config
  (trivial on Cloudflare/Netlify/Vercel; awkward on GitHub Pages — part of why we move).
- [ ] **Cloudflare in front** — free DDoS protection + WAF if we use Cloudflare Pages.
- [ ] **Error monitoring** — Sentry (or similar) so failures surface before users report them.
- [ ] **Custom domain + HTTPS** on the registration subdomain (automatic on any real host).
- [ ] **Transactional email** for app notifications (new-club requests →
  `newclubinquiries@naigc.org`, membership receipts, etc.) — not yet built (see CLAUDE.md).

## Open question for later: shared login (SSO)

If users should eventually have one account across the marketing site and the
registration app, that's an SSO conversation (Supabase can be the identity provider,
or defer to one). It changes nothing today and is the main place the two systems
might genuinely couple. Decide when the main-site direction is settled — worth
knowing what `unitedgymnastics.org` is built on before then.
