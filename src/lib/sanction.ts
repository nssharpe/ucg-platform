// Pure sanction-workflow logic — no React/store/Supabase imports. Unit-tested in
// tests/sanction.test.ts. See docs/specs/2026-06-18-event-management.md.

export type SanctionVoteValue = 'approve' | 'reject' | 'abstain';

export interface VoteTally {
  decided: boolean;
  outcome: 'approved' | 'rejected' | 'pending';
  approvals: number;
  rejections: number;
  abstains: number;
  cast: number;
}

/**
 * Resolve a sanction vote.
 *  - Early **approval** as soon as approvals reach ⌈2/3 · teamSize⌉.
 *  - At/after the deadline: approve iff a **strict majority of votes cast** approve
 *    (ties and no-votes → rejected).
 *  - Otherwise pending.
 */
export function tallyVotes(
  votes: { vote: SanctionVoteValue }[],
  teamSize: number,
  nowISO: string,
  deadlineISO: string,
): VoteTally {
  const approvals = votes.filter((v) => v.vote === 'approve').length;
  const rejections = votes.filter((v) => v.vote === 'reject').length;
  const abstains = votes.filter((v) => v.vote === 'abstain').length;
  const cast = approvals + rejections + abstains;

  const twoThirds = Math.ceil((2 / 3) * Math.max(0, teamSize));
  if (teamSize > 0 && approvals >= twoThirds) {
    return { decided: true, outcome: 'approved', approvals, rejections, abstains, cast };
  }

  const past = Date.parse(nowISO) >= Date.parse(deadlineISO);
  if (past) {
    const outcome = approvals > rejections ? 'approved' : 'rejected';
    return { decided: true, outcome, approvals, rejections, abstains, cast };
  }

  return { decided: false, outcome: 'pending', approvals, rejections, abstains, cast };
}

/** US state name → 2-letter postal code (for Sanction IDs). */
export const US_STATE_ABBR: Record<string, string> = {
  Alabama: 'AL', Alaska: 'AK', Arizona: 'AZ', Arkansas: 'AR', California: 'CA',
  Colorado: 'CO', Connecticut: 'CT', Delaware: 'DE', 'District of Columbia': 'DC',
  Florida: 'FL', Georgia: 'GA', Hawaii: 'HI', Idaho: 'ID', Illinois: 'IL',
  Indiana: 'IN', Iowa: 'IA', Kansas: 'KS', Kentucky: 'KY', Louisiana: 'LA',
  Maine: 'ME', Maryland: 'MD', Massachusetts: 'MA', Michigan: 'MI', Minnesota: 'MN',
  Mississippi: 'MS', Missouri: 'MO', Montana: 'MT', Nebraska: 'NE', Nevada: 'NV',
  'New Hampshire': 'NH', 'New Jersey': 'NJ', 'New Mexico': 'NM', 'New York': 'NY',
  'North Carolina': 'NC', 'North Dakota': 'ND', Ohio: 'OH', Oklahoma: 'OK',
  Oregon: 'OR', Pennsylvania: 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC',
  'South Dakota': 'SD', Tennessee: 'TN', Texas: 'TX', Utah: 'UT', Vermont: 'VT',
  Virginia: 'VA', Washington: 'WA', 'West Virginia': 'WV', Wisconsin: 'WI',
  Wyoming: 'WY',
};

/** 2-letter code for a state name (accepts an already-2-letter code as-is). */
export function stateCode(state: string): string {
  if (/^[A-Za-z]{2}$/.test(state)) return state.toUpperCase();
  return US_STATE_ABBR[state] ?? 'XX';
}

/**
 * Next Sanction ID `YYYY_ST_###` for an event in `year` (number) hosted in
 * `state`, given all existing sanction ids. Sequence is per state per year,
 * starting at 001.
 */
export function nextSanctionId(year: number, state: string, existingIds: string[]): string {
  const st = stateCode(state);
  const prefix = `${year}_${st}_`;
  const max = existingIds
    .filter((id) => id.startsWith(prefix))
    .map((id) => parseInt(id.slice(prefix.length), 10))
    .filter((n) => Number.isFinite(n))
    .reduce((m, n) => Math.max(m, n), 0);
  return `${prefix}${String(max + 1).padStart(3, '0')}`;
}
