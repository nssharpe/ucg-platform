# Stripe Integration Plan — payments, card-on-file, club cart (2026-06-18)

Plan for wiring real payments into UCG: membership/meet/banquet/add-on charges,
**saving a card on file**, the **club cart** payment path, and how the already-built
**Admin Payment Override ($0)** coexists. No code this push — this is the blueprint.

## Why this is deferred
The platform is a static GitHub Pages SPA with a Supabase backend. Charging cards
requires a **server-side secret** (Stripe secret key) that must never ship in the
browser bundle. That means **Supabase Edge Functions** (Deno) as the trusted
backend for all Stripe calls. Setting that up needs: a Stripe account, the Edge
Function deploy pipeline, and webhook wiring — out of scope for a frontend push.

## Architecture
```
Browser (SPA)  ──>  Supabase Edge Function  ──>  Stripe API
   │ Stripe.js / Elements (publishable key only)        │
   │                                                     │ webhooks
   └──< client_secret / SetupIntent <────────────────────┘
Supabase DB: customers, payment_methods, payments, invoices (source of truth)
```
- **Publishable key** in the SPA (safe). **Secret key** only in Edge Functions
  (Supabase secrets).
- Edge Functions to build: `create-payment-intent`, `create-setup-intent`,
  `list-payment-methods`, `charge-saved-method`, `stripe-webhook`. These live
  alongside the future `send-sms` and transactional-email functions.

## Card-on-file ("store the card for future use")
The UI already has a **disabled "Save this card" checkbox** (Membership flow). To
make it real:
1. Create a **Stripe Customer** per person on first payment; store
   `stripe_customer_id` on `people` (new column / migration).
2. To save a card without charging, use a **SetupIntent** + Stripe Elements; on
   success Stripe returns a `payment_method` id → store a **reference** (brand,
   last4, exp, `stripe_payment_method_id`) in a new `payment_methods` table. **Never
   store raw card data** — Stripe holds it (PCI scope stays minimal / SAQ-A).
3. Later charges use a **PaymentIntent with `customer` + `payment_method` +
   `off_session: true`** ("charge saved card"). Handle the `requires_action` case
   (3DS/SCA) by falling back to an on-session confirmation.
4. UI: a "Saved cards" section on the profile/billing page (list, set default,
   remove → detach PaymentMethod via Edge Function).

## Payment flows
- **Membership / meet entry / banquet / add-ons:** build the invoice (the app
  already creates `Invoice`/`InvoiceItem`), then a `create-payment-intent` for the
  invoice total; confirm with Elements or a saved card. On webhook
  `payment_intent.succeeded`, mark the invoice `paidAt` and activate membership /
  confirm registration (server-side, authoritative — don't trust the client).
- **Club cart:** the club's pending items already aggregate in `carts[clubId]`. A
  club manager pays the whole cart → one PaymentIntent for the cart total, then the
  webhook clears the cart, creates a paid club `Invoice`, and flips each pushed
  membership from `pending-club-payment` → `active`. (The in-app push-to-club-cart
  + manager notification is already built; this just adds the real charge.)
- **Sanctioned-event fee collection** (NAIGC collects & remits to host): charge the
  participant normally; track host payouts separately (Stripe Connect *or* manual
  PayPal/check per the Event Management spec — Connect is the clean long-term path
  but adds onboarding complexity; start manual).

## Admin Payment Override coexistence
The built **Admin Payment Override** completes an invoice at **$0** with
`paidVia: 'comp'`, `activatedByAdmin: true` — it never touches Stripe. Keep it as a
parallel path: if override is used, **skip the PaymentIntent entirely** and write the
paid/active state directly (server-side guard: only real admins may call the
override Edge path). This stays valid after Stripe lands.

## Fees & money math
- Stripe US card fee ≈ **2.9% + $0.30** per successful charge (verify current rate;
  non-profit discount may be available — apply for Stripe's nonprofit pricing).
- Decide whether to **absorb** or **pass through** the fee (a "processing fee" line
  item). For a ~$35 membership, fee ≈ $1.32.
- Refunds: the app already models `refunded`/`refundRequested`; wire a
  `refund-payment` Edge Function (Stripe Refund) for admin-approved refunds. Note
  the platform fee is **not** returned on refunds.

## Data model additions (future migration 0008-ish)
- `people.stripe_customer_id text`
- `payment_methods (id, person_id, stripe_pm_id, brand, last4, exp_month, exp_year,
  is_default, created_at)`
- `payments (id, invoice_id, stripe_payment_intent_id, amount, status, created_at)`
- webhook idempotency table (store processed Stripe event ids).

## Rollout order (when greenlit)
1. Stripe account + test keys; Supabase Edge Function scaffold + secrets.
2. `create-payment-intent` + Elements on the membership flow (test mode).
3. `stripe-webhook` → authoritative invoice/membership state.
4. SetupIntent + saved cards (flip the "Save card" checkbox on).
5. Club-cart payment + refunds.
6. Switch to live keys; PCI SAQ-A self-assessment; go live.

> Confirm current Stripe pricing, SCA/3DS requirements, and nonprofit eligibility on
> Stripe's site before implementing — these shift over time.
