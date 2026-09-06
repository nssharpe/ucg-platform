// _shared/sanction-summary.ts — pure "what did I ask for?" rendering of a
// sanction-request payload as labelled rows. NO Deno/Supabase imports here —
// this module is unit-tested by vitest under node (tests/sanction-summary.test.ts)
// AND imported by both the client (Sanction.tsx "Details" dialog on Your
// Sanction Requests) and the notify-sanction Edge Function (the requester's
// "submitted" confirmation email), mirroring the event-comm.ts pattern.
//
// UAT E-01-03 (Julia, 2026-09-06): the submission email only named the event
// and dates, and the requester had no way to see the rest of what they
// submitted — the vote page that renders the full payload is Sanctioning-Team
// gated. Both surfaces now render the SAME rows from here.

export interface SanctionSummaryRow {
  section: string;
  label: string;
  value: string;
}

export interface SanctionSummaryOptions {
  /** Resolve a level id to its display name; unknown ids fall back to the id. */
  levelName?: (id: string) => string | undefined;
  hostClubName?: string | null;
}

const isBlank = (v: unknown) => v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

const yesNo = (v: unknown) => (v ? 'Yes' : 'No');

/** "2026-11-05T12:00" (datetime-local) → "2026-11-05 12:00"; plain dates pass through. */
const when = (v: unknown) => (typeof v === 'string' ? v.replace('T', ' ') : String(v));

const money = (v: unknown) => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : String(v);
};

const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** Rows describing `payload` (the sanction form's submitted answers), grouped
 *  by section in form order. Blank/absent answers are omitted so a minimal
 *  request doesn't render a wall of "—". Conditional groups (fees, awards,
 *  add-ons) only expand when their toggle is on, matching the form. */
export function sanctionSummaryRows(
  payload: Record<string, unknown>,
  opts: SanctionSummaryOptions = {},
): SanctionSummaryRow[] {
  const rows: SanctionSummaryRow[] = [];
  const add = (section: string, label: string, value: unknown) => {
    if (isBlank(value)) return;
    rows.push({ section, label, value: String(value) });
  };
  const levels = (ids: unknown) => (Array.isArray(ids)
    ? ids.map((id) => opts.levelName?.(String(id)) ?? String(id)).join(', ')
    : '');

  const S1 = 'Event';
  add(S1, 'Event name', payload.eventName);
  add(S1, 'Event kind', payload.eventKind === 'camp' ? 'Camp' : payload.eventKind === 'competition' ? 'Competition' : payload.eventKind);
  add(S1, 'Host club', opts.hostClubName);
  const alt = payload.altContact as { name?: string; email?: string; phone?: string } | null | undefined;
  if (alt && (alt.name || alt.email || alt.phone)) {
    add(S1, 'Alternate contact', [alt.name, alt.email, alt.phone].filter(Boolean).join(' · '));
  }
  add(S1, 'Accessible to all divisions', payload.accessible === undefined ? undefined : yesNo(payload.accessible));

  const S2 = 'Dates & location';
  if (!isBlank(payload.startDate) || !isBlank(payload.endDate)) {
    add(S2, 'Dates', payload.startDate === payload.endDate || isBlank(payload.endDate)
      ? when(payload.startDate)
      : `${when(payload.startDate)} to ${when(payload.endDate)}`);
  }
  add(S2, 'Registration opens', isBlank(payload.regOpens) ? undefined : when(payload.regOpens));
  add(S2, 'Registration closes', isBlank(payload.regCloses) ? undefined : when(payload.regCloses));
  add(S2, 'Late registration starts', isBlank(payload.lateRegStart) ? undefined : when(payload.lateRegStart));
  add(S2, 'Venue', payload.venue);
  add(S2, 'Address', [payload.street, payload.city, payload.state, payload.country].filter((x) => !isBlank(x)).join(', '));

  const S3 = 'Competition details';
  add(S3, 'Regional bid', payload.isRegionalBid === undefined ? undefined : yesNo(payload.isRegionalBid));
  if (payload.isRegionalBid) add(S3, 'Athletic trainer present', yesNo(payload.hasAthleticTrainer));
  add(S3, 'Insurance needed', payload.insuranceNeeded === undefined ? undefined : yesNo(payload.insuranceNeeded));
  add(S3, 'Estimated participants', payload.estimatedParticipants);
  add(S3, 'Maximum participants', payload.maxParticipants);

  const S4 = 'Levels';
  add(S4, 'WAG levels', levels(payload.wagLevels));
  add(S4, 'MAG levels', levels(payload.magLevels));
  add(S4, 'T&T levels', levels(payload.tntLevels));

  const S5 = 'Fees & awards';
  add(S5, 'UCG collects fees', payload.collectFees === undefined ? undefined : yesNo(payload.collectFees));
  if (payload.collectFees) {
    add(S5, 'Per-participant fee', isBlank(payload.perParticipantFee) ? undefined : money(payload.perParticipantFee));
    add(S5, 'Late fee', isBlank(payload.lateFee) ? undefined : money(payload.lateFee));
    add(S5, 'Payout method', payload.payoutMethod === 'paypal' ? 'PayPal' : payload.payoutMethod === 'check' ? 'Check' : payload.payoutMethod);
    add(S5, 'PayPal name', payload.paypalName);
    add(S5, 'Check payee', payload.checkPayee);
  }
  add(S5, 'UCG awards', payload.naigcAwards === undefined ? undefined : yesNo(payload.naigcAwards));
  if (payload.naigcAwards) {
    add(S5, 'Award places', payload.awardPlaces);
    add(S5, 'Award type', payload.awardType === 'sticker-backs' ? 'Sticker backs' : cap(String(payload.awardType ?? '')));
    add(S5, 'Ribbon ranking', Array.isArray(payload.ribbonRanking) ? payload.ribbonRanking.filter((x) => !isBlank(x)).join(', ') : undefined);
    add(S5, 'Awards ship to', payload.awardsAddress);
  }

  const S6 = 'Add-ons & other';
  add(S6, 'Club banner requested', payload.wantBanner === undefined ? undefined : yesNo(payload.wantBanner));
  add(S6, 'Hotel block', payload.hotelBlock === undefined ? undefined : yesNo(payload.hotelBlock));
  add(S6, 'Overnight details', payload.overnightDescription);
  const tshirt = payload.tshirtAddon as { price?: number; sizes?: string[] } | null | undefined;
  add(S6, 'T-shirt add-on', tshirt ? `${money(tshirt.price)}${tshirt.sizes?.length ? ` · sizes ${tshirt.sizes.join(', ')}` : ''}` : (payload.tshirtAddon === null ? 'No' : undefined));
  const leo = payload.leoAddon as { price?: number; sizes?: string[] } | null | undefined;
  add(S6, 'Leo add-on', leo ? `${money(leo.price)}${leo.sizes?.length ? ` · sizes ${leo.sizes.join(', ')}` : ''}` : (payload.leoAddon === null ? 'No' : undefined));
  add(S6, 'Years previously held', payload.yearsPreviouslyHeld);
  add(S6, 'Additional comments', payload.additionalComments);
  add(S6, 'Certified by', payload.certTypedName);

  return rows;
}

/** Group rows by section, preserving first-seen section order. */
export function groupSanctionSummary(rows: SanctionSummaryRow[]): { section: string; rows: SanctionSummaryRow[] }[] {
  const out: { section: string; rows: SanctionSummaryRow[] }[] = [];
  for (const r of rows) {
    let g = out.find((x) => x.section === r.section);
    if (!g) { g = { section: r.section, rows: [] }; out.push(g); }
    g.rows.push(r);
  }
  return out;
}
