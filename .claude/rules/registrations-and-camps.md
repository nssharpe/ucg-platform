---
paths:
  - "src/components/RegistrationEditor*.tsx"
  - "src/pages/MyRegistrations.tsx"
  - "src/pages/Club.tsx"
  - "src/pages/Events.tsx"
  - "src/pages/Event*.tsx"
  - "src/pages/Membership.tsx"
  - "src/lib/pricing.ts"
  - "src/lib/registration-status.ts"
  - "src/lib/reg-estimate.ts"
  - "src/lib/capabilities-core.ts"
  - "supabase/functions/_shared/camp-confirmation.ts"
  - "supabase/functions/manage-waitlist/**"
---

# Registration, membership, and camp rules

Naming: "Meet" → **Event** everywhere; gymnastics apparatus → **apparatus**. Preserved and NOT
renamed: `'meet-entry'` invoice_item_kind, `meet-host` app_role, `meet_kind` enum, the persisted
`NationalsConfig.cutoffs.event` jsonb key, opaque id-value prefixes (`meet-…` seed ids,
`scores.id` composite), DOM/realtime `event`s. Retired routes use slug-preserving
`<Navigate replace>` redirects (`/meets*` → `/events*`). Older docs predate the rename:
`docs/specs/2026-06-26-events-rename-and-registration-flow.md`.

**`/club/:id/cart` is NOT retired** (UAT round-1, Z-01-02, `2026-08-22`): it was a
`<Navigate to="/cart" replace>` redirect from unified-cart-b2 until this date, when it became a
real page (`ClubCart.tsx`) — a club's cart/receipts are no longer bundled onto the manager's
personal `/cart` page. `/club/:id/purchases` (`ClubPurchaseHistory.tsx`) is new alongside it.
Both use the "current club" idiom (`src/lib/current-club.ts`) rather than
`caps.managedClubIds[0]` — see `Layout.tsx`'s `navFor`.

## Club-membership gate is ON

A club needs an active `club_memberships` row for a season before its athletes can register or
it can host — enforced at every registration entry point via
`clubHasActiveMembership`/`seasonForDate` (`capabilities-core.ts`). **New registration paths
MUST apply this gate.**

## Registration paid-state

`Registration.paid` is the explicit entry-fee flag; new regs land `paid:false`
("Pending Purchase"). The link between a cart/invoice line and the reg(s) it pays is
**`refRegIds` — always match on it, never a heuristic**; webhook fulfillment flips exactly those
regs. `updatedPending` marks a paid reg edited back to pending by a change fee.

- **Host-club $0:** competing-for club == event host ⇒ fees $0
  (`registrationEntryFee`/`registrationChangeFee`, pure, unit-tested) and regs are created
  `paid:true` with NO cart line.
- **Cross-club lock:** `paidRegistrationClub` blocks registering an athlete already
  paid-registered under another club for the same event. Pending regs don't lock.
- **Change eligibility:** `changeIsEligible(before, after)` (`pricing.ts`) gates "Add change to
  cart" — add discipline / change level / change club / swap athlete, NOT apparatus tweaks
  within a discipline.
- **One live (non-refunded) row per (event, athlete, discipline) — UAT Z-02,
  `20260822010000`.** Client-minted reg ids (`reg-<ms>-<athlete>-<disc>`,
  `RegistrationEditor.tsx:585/618`) never collide, so two sessions registering the same
  athlete+event+discipline at once used to both succeed silently — enforced now by the DB
  partial unique index `registrations_live_slot_uniq`, with `create-checkout-session`/
  `_shared/fulfill.ts` catching a pre-existing duplicate (see money-invariants.md). Not scoped
  to `club_id` — a cross-club duplicate is the same bug the cross-club lock above already treats
  as a conflict.

## Independent athletes exist — never assume a club

Three separate UAT bugs (2026-08-27, one evening) came from code assuming every athlete has a
club: the club-membership gate blocked club-less registration (G-02), the `''` sentinel hit the
`club_id` FK (see data-layer.md), and MyRegistrations' Edit dialog null-guarded `currentClubId`
into a silent self-close. Invariants: `''` is the CLIENT sentinel for "independent" (NULL in the
DB, `registrationToRow` converts); pricing/gates accept `''`; UI never dead-ends on a missing
club — no `if (!clubId) return null` around member-facing flows. New registration surfaces must
be exercised at least once as a club-less athlete before shipping.

## Member self-edit divergence — CRITICAL

`MyRegistrations.tsx` embeds the shared `RegistrationEditor`, targets the member's OWN cart,
same paid/`updatedPending` semantics as `Club.tsx`. **But the member side NEVER deletes a
registration** — a fully deselected discipline is retained-but-blanked. Deletion stays a refund
action **through the editor's own save path** (`saveRegs`/`RegistrationEditor`) — this rule is
about *that* path only.

**Deliberate carve-out (owners' withdrawal spec 2026-08-23):** the new "Withdraw" button/dialog
(`WithdrawDialog.tsx`) is a SEPARATE, explicit self-serve delete path via its own edge function
(`withdraw-registration`) — confirm dialog, immediate, emails both sides — not a side effect of
an ordinary editor save. It deletes on-time (before `last_date_to_edit`) exactly like an on-time
refund approval, or keeps+scratches (stamping `withdrawn_at`, never `refunded`) after. Don't read
this as license to add deletion to the editor's own save flow — that rule stands unchanged.

`RegistrationEditor`'s optional `originalClubId` prop makes a club-only switch chargeable; other
callers omit it.

## Membership holds are INDEPENDENT

Waiver and club-payment holds can co-exist. Derive via `membershipHolds(m)`
(`capabilities-core.ts`): `waiverHold = !waiverSignedAt`,
`paymentHold = clubCartPending || status === 'pending-club-payment'`. **Render bubbles off
`membershipHolds`, never the raw enum.** `clubCartPending` is set on club-cart push and cleared
server-side by `stripe-webhook` fulfillment.

**`record-waiver-signature` splits on `club_cart_pending`, NEVER on `paid_via`** (fixed
2026-08-04; prod v13). `paid_via` says who was *going* to pay; `club_cart_pending` says whether a
payment is still *outstanding*. They come apart whenever a club pays before the guardian signs —
`fulfill.ts` writes that as `status:'pending-waiver', paid_via:'club', club_cart_pending:false`.
Keying on `paid_via` re-asserted a payment hold on an already-paid membership, and — because the
activate arm carried `.neq('paid_via','club')` — left that row unable to reach `active` at all.
Note `paid_via` is NULLABLE, so `<> 'club'` is NULL (not true) for an unset value: such a row
matched neither arm and stuck at `pending-waiver` permanently. `club_cart_pending` is
`not null default false` (verified on prod AND staging), so it has no such trap.
Decision logic: `_shared/membership-signing.ts` — **keep in lockstep with `membershipHolds`**.

## Camps are session-less, level-less, and discipline-less

Camp events (`eventType === 'camp'`) save `sessions: []` and `secondDisciplineFee: 0` (flat
fee), auto-set `lastDateToEdit = regCloses`, and keep `disciplines` only as "equipment
available" for display on the Event page — registration itself asks nothing discipline-related.

`RegistrationEditor` camp mode shows a single confirmation line (no checkboxes). A brand-new
camp registration always saves exactly **ONE** row: `discipline: event.disciplines[0]`
(fallback `'MAG'`), `levelId: ''`, `apparatus: []`, `sessionId: null`. The discipline value
exists only to satisfy the NOT NULL enum column — never shown, never asked about.

Editing a LEGACY multi-row camp registration (one row per discipline, from before 2026-07-23)
keeps every row as-is — no delete/re-add churn; only `clubId` refreshes, so a club-only switch
stays chargeable.

**Don't add code that assumes a reg has a level or apparatus without a camp branch.**

**Camps are individual self-registration ONLY** (spec §G; Julia confirmed "block it outright"
2026-08-19): `Club.tsx`'s `openEvents` picker filters `eventType === 'camp'`, so a club manager
cannot register athletes for a camp — or see camp registrations from the club page (athletes
edit their own via MyRegistrations; admins via admin surfaces). New manager-side registration
entry points must keep this filter.

Roster tools and "Competition setup" are removed entirely from the camp host dashboard; only the
registration-workbook export remains (it still carries the overnight-survey roster).

## Camp survey is a per-event question BUILDER

`campConfig.survey = { enabled, questions: [{ id, label, type: 'text'|'single'|'multi',
options?, required }] }`, resolved via `campSurveyQuestionsOf(campConfig)` (`pricing.ts` —
legacy `overnightSurvey`/`surveyMandatory` events derive the classic 4 questions).

Answers are `Registration.campSurvey: Record<questionId, string|string[]>`, validated by
`campSurveyAnswersValid`, and written **ONLY** via `pushCampSurvey` (a targeted UPDATE — see the
column-revoke × upsert trap in `supabase-migrations.md`).

Rendered generically in the wizard editor, reg flows, responses card, receipt email
(`_shared/camp-confirmation.ts` — **keep in lockstep**), and host export.
