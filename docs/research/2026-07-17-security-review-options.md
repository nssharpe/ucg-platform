# Third-party security review — options & recommendation

> Research note, 2026-07-17. Answers the open decision "security-review budget
> before live keys" (production-readiness §2 / whats-next **§1.6** — renumbered
> 2026-07-31; §1.7 is now the separate `security-guidance` plugin decision).
> Decision is Nate's; this brief lays out the market, what we actually need, and a
> recommendation.
>
> **Addendum 2026-07-31:** two cheaper first passes worth weighing before paying for a
> human audit — Anthropic's **Claude Security plugin** (multi-agent whole-repo scan with
> independently reviewed findings) and one `/code-review ultra` run against the money paths
> during the planned Max month. See
> [`../specs/2026-07-31-review-and-cleanup-findings.md`](../specs/2026-07-31-review-and-cleanup-findings.md) §7.

## What we're buying and why

We're a volunteer-run nonprofit about to take **real money** (Stripe live keys)
and we hold **minors' PII**. We've already done serious internal work — the
2026-07-02 adversarial money-path review + hardening Phases 1–2, MFA/aal2
(2026-07-17), fail-closed RLS patterns — but every finding so far came from the
same "author" (Claude + Nate). The value of a third-party review is an
**independent set of eyes with a different toolbox**, focused on:

1. **RLS / authorization** — the single real security boundary (PostgREST is
   directly reachable; every table's policies are the product's access control).
2. **The payment path** — `create-checkout-session` server pricing,
   `stripe-webhook` fulfillment, refunds (`process-refund`), coupon handling.
3. **Auth flows** — sign-up/invite/magic-link/recovery (HashRouter quirks),
   MFA step-up, the no-login token links (waiver signing, manager-access).
4. **Abuse surfaces** — the public email-sending functions, rate limiting
   (currently absent — a known open item; a reviewer will flag it, which is
   fine, it's already on the list).

What we do NOT need to pay for: network/infra pentesting (GitHub Pages +
Supabase = no servers of ours), phishing/social engineering, compliance
audits (SOC 2 etc. — not required for our counterparties today).

## The market (2026 pricing)

| Option | Typical cost | What you get | Fit |
|---|---|---|---|
| **Traditional firm, SMB scope** | $8–12k | 1–2 assets, manual testing, report + retest | Solid but priced for orgs bigger than us |
| **Startup-scoped manual pentest** (boutique / regional firm) | **$4–8k** (5–7 tester-days) | One web app, a few roles, API endpoints — exactly our shape | **Best fit** |
| **PTaaS platforms** (Cobalt etc.) | ~$15k+/yr commitments (credits + platform fee) | Continuous testing platform | Overkill; annual commitment for a one-off need |
| **Supabase-specialist auditors** (SecurifyAI, Precursor, AuditYourApp, ModernPentest) | low-$k to mid-$k | RLS-focused config/policy review, some offer CREST-accredited manual testing | Strong stack fit; newer/smaller shops — check references |
| **Independent consultant** (day-rate) | $850–2,500/day → ~$3–8k for 3–5 days | Depends entirely on the individual | Great value IF vetted (ask for RLS/Postgres + payments experience) |
| **Automated scanners only** | $0–3k | OWASP ZAP/Burp scans; Supabase-specific: **Supabomb**, SecurifyAI's open-source RLS scanner | Not a substitute — but free ones are worth running regardless |
| **Bug bounty / VDP** | $0 platform-light or self-run | Crowd finds bugs post-launch | Premature pre-launch; consider a simple security.txt + disclosure policy instead |

Rule of thumb from every pricing guide: **a "web-app pentest" under ~$3k is an
automated scan with a report template** — fine as a layer, not as the
independent review.

## Recommendation (two layers + one freebie)

1. **Now ($0, 🤖):** run the open-source Supabase-specific scanners (Supabomb,
   SecurifyAI's RLS scanner) against **staging**, triage findings. Also add
   `npm audit`/Dependabot (already on the quality-pass list). This catches the
   embarrassing stuff before anyone is paid to find it.
2. **Before live keys ($4–8k, 👤 budget + 🤖 prep):** a **scoped 3–5 day manual
   engagement** — either a Supabase-specialist shop (ask Precursor/SecurifyAI
   for a scoped quote; verify CREST/OSCP-type credentials and references) or a
   vetted independent with Postgres-RLS + payments experience. Scope letter:
   the 4 focus areas above, staging environment + seeded accounts provided,
   source access offered (white-box is more value per day than black-box at
   this budget). Deliverable: findings w/ severity + retest of fixes.
3. **Skip for now:** PTaaS subscriptions, bug bounty, compliance audits.

Budget line to plan around: **$5k ± $2k**, timed after rate-limiting lands
(item 2.2) so the report isn't 30% "add rate limiting."

### Prep checklist when Nate green-lights (🤖 can do all of it)
- Freeze a scope doc: URLs, project refs, the 4 focus areas, out-of-scope list.
- Provision reviewer accounts on staging (athlete / manager / admin / finance).
- Export the RLS policy set + edge-function inventory as a review packet.
- Run the free scanners first and attach their triaged results.

## Sources
- [Blaze InfoSec — pentest pricing guide 2026](https://www.blazeinfosec.com/post/how-much-does-penetration-testing-cost/)
- [Autonoma — what engineering leaders pay (2026)](https://getautonoma.com/blog/penetration-testing-cost)
- [SecureLeap — startup pentest pricing](https://www.secureleap.tech/blog/penetration-testing-cost-startup-pricing)
- [BSG — pentest cost ranges](https://bsg.tech/blog/what-can-you-expect-to-pay-for-penetration-testing/)
- [Cobalt pricing](https://www.cobalt.io/pricing) · [Cobalt credit-model breakdown](https://pentestingcost.com/vendors/cobalt-pricing/)
- [Precursor Security — testing Supabase RLS](https://www.precursorsecurity.com/blog/row-level-recklessness-testing-supabase-security)
- [ModernPentest — Supabomb (open-source Supabase pentest CLI)](https://modernpentest.com/blog/introducing-supabomb)
- [SecurifyAI — open-source Supabase RLS scanner](https://securifyai.co/supabase-rls-scanner-open-source-supabase-security-audit-tool/)
- [AuditYourApp — Supabase/Firebase scanner](https://www.audityour.app/)
