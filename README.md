# UCG Registration & Scoring Platform — MVP prototype

A working prototype of the **United Club Gymnastics** (formerly NAIGC) registration and
scoring platform, intended to replace ScoreFlippers. Built with React + TypeScript + Vite.

**Live demo:** https://nssharpe.github.io/ucg-platform/
**Access password:** `fortheloveofthesport`

## What this is

A clickable, data-driven prototype seeded with realistic demo data (8 clubs, ~70 members,
3 meets, live + completed scoring). All data lives in the browser (`localStorage`), seeded
deterministically — there is no backend yet. The data layer (`src/lib/store.ts`) is shaped
like an async API so a real backend can swap in with minimal churn.

## Roles

Switch roles from the **"Viewing as"** dropdown in the sidebar. No real login — each role
loads a demo persona:

- **League Admin** — dashboard with attention flags, members, clubs, league controls
  (seasons/fees/levels/regions/waivers), and the Communicate tool (filtered email/SMS).
- **Club Manager** — roster, the meet-registration grid (level dropdown + event checkboxes
  with live team totals), and the club cart + invoices.
- **Athlete** — membership purchase flow (confirm info → e-sign waiver → pay/club-cart),
  profile, and personal meet schedule.
- **Judge** — tablet-first score entry with SV-cap validation and a flash-score display
  that pushes live to results instantly.
- **Meet Host** — session + squad builder (default rotations, copy setup to other sessions,
  holding squad) and host dashboard.
- **Spectator** — public live results, no login.

## Features implemented (this pass)

Membership lifecycle with waivers & club-pay · searchable type-to-search dropdowns ·
club roster & meet-reg grid · club cart, coupons & invoices · meet sessions & squad builder ·
judge scoring with **the real NAIGC scoring calculators embedded** (MAG SV, WAG Open,
Masters) feeding D / E / Final straight into the live flash · live results (all-around,
event rankings, team scores with top-3-counting) · admin member/club management with
membership toggles · league controls (seasons, levels, regions, waivers) · bulk
communicate tool · CSV "export everything" · regions mapping · unique URLs per page ·
mobile/tablet responsive · password gate.

### Embedded calculators

The three existing NAIGC calculators are bundled verbatim under `public/calculators/`
and embedded in the judge score-entry flow via an iframe + `postMessage` bridge
(`public/calculators/bridge.js`), so their tested scoring logic is reused unchanged.
`src/lib/calculators.ts` maps each UCG level to its calculator and presets apparatus /
ruleset. MAG (Developmental / Intermediate / Advanced) computes a start value the judge
adds deductions to; WAG Open and Masters compute the full D / E / Final and post directly.
**Not yet covered:** other WAG levels (Xcel Silver/Platinum/Diamond, Level 9), T&T, and
WAG/Masters vault (table-value based) — those still use manual entry.

## Not yet built (future passes)

Real backend + auth + payments (Stripe) · the actual embedded SV calculators · PDF
certificates/score sheets · banquet tickets & add-ons checkout · under-18 guardian
e-sign delivery · API for external leagues · meet-creation wizard · finals rosters ·
nationals status dashboard. See `../Reg & Scoring Platform Specification.md`.

## Develop

```bash
npm install
npm run dev      # http://localhost:5173/ucg-platform/
npm run build    # production build to dist/
```

To change the access password, update `GATE_HASH` in `src/lib/store.ts` with the SHA-256
hex of the new password. Note: the gate is light obfuscation suitable for a private
prototype, not real security — the bundle is public on GitHub Pages.
