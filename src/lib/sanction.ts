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
 *  - Early **approval** as soon as approvals reach ⌈2/3 · teamSize⌉ — ONLY when `teamSize` is
 *    a known number. Unanimity at small team sizes (e.g. ⌈2/3·2⌉ = 2) is intended, not a bug.
 *  - `teamSize: null` means the count is genuinely unavailable (e.g. the
 *    `sanctioning_team_size()` RPC failed) — early approval is disabled entirely in that case
 *    (never guess a number), but the at/after-deadline majority-of-votes-cast path is
 *    unaffected, since it doesn't need a team size at all.
 *  - At/after the deadline: approve iff a **strict majority of votes cast** approve
 *    (ties and no-votes → rejected).
 *  - Otherwise pending.
 */
export function tallyVotes(
  votes: { vote: SanctionVoteValue }[],
  teamSize: number | null,
  nowISO: string,
  deadlineISO: string,
): VoteTally {
  const approvals = votes.filter((v) => v.vote === 'approve').length;
  const rejections = votes.filter((v) => v.vote === 'reject').length;
  const abstains = votes.filter((v) => v.vote === 'abstain').length;
  const cast = approvals + rejections + abstains;

  if (teamSize !== null && teamSize > 0) {
    const twoThirds = Math.ceil((2 / 3) * teamSize);
    if (approvals >= twoThirds) {
      return { decided: true, outcome: 'approved', approvals, rejections, abstains, cast };
    }
  }

  const past = Date.parse(nowISO) >= Date.parse(deadlineISO);
  if (past) {
    const outcome = approvals > rejections ? 'approved' : 'rejected';
    return { decided: true, outcome, approvals, rejections, abstains, cast };
  }

  return { decided: false, outcome: 'pending', approvals, rejections, abstains, cast };
}

/**
 * Whether the voting-deadline editor should be interactive for this viewer
 * (owners' decision 2026-08-26, sanction-quorum fix scope addition). Only a
 * `'sanctioning'` voter may edit — matching `canVoteSanction`, NOT the
 * broader `isSanctioning` visibility capability, so an admin without the
 * sanctioning role sees the deadline read-only — and only while the request
 * is still `'voting'`; once decided it's read-only for everyone regardless
 * of role.
 */
export function deadlineEditable(status: string, canVoteSanction: boolean): boolean {
  return status === 'voting' && canVoteSanction;
}

/**
 * `sanction_requests.deadline_at` is a REAL UTC instant (`addDays(nowISO, 7)`,
 * stamped via `toISOString()` — a genuine `Z`-suffixed timestamp), unlike the
 * naive-local wall-clock convention `regOpens`/`finalsLineupDeadlineAt` use
 * elsewhere in the app (see `toDatetimeLocalValue`, `events-core.ts`). A
 * `datetime-local` input's value is always interpreted/entered in the
 * BROWSER's local zone with no offset, so editing a real instant needs an
 * actual zone conversion, not a truncation. Returns '' for an unparsable/
 * missing value (matches `toDatetimeLocalValue`'s behavior for the input).
 */
export function deadlineToLocalInputValue(deadlineISO: string | null | undefined): string {
  if (!deadlineISO) return '';
  const d = new Date(deadlineISO);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Inverse of `deadlineToLocalInputValue`: a `datetime-local` input's local
 * wall-clock value (e.g. `'2026-06-25T14:00'`, no zone) → a real UTC instant
 * ISO string for writing back to `deadline_at`. Returns null for an empty/
 * unparsable value — the caller should treat that as "don't save."
 */
export function localInputValueToDeadlineISO(value: string): string | null {
  if (!value) return null;
  const d = new Date(value); // no trailing 'Z' => parsed as browser-local
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
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
 * The sanction requests a given signed-in person should see under "Your
 * sanction requests" (UAT E-01-04): the ones they submitted, or that were
 * submitted for a club they manage. RLS (`sanction_requests_read`,
 * `20260826000000`) already scopes what a NON-privileged caller's
 * `db.sanctionRequests` read returns to exactly this set — but an admin or
 * Sanctioning Team member's read includes EVERY request (that policy's
 * admin/sanctioning branch), so this filter still has to run client-side or
 * an admin visiting the request form would see the entire league's queue
 * under "Your requests". Sorted newest-submitted-first (unsubmitted rows,
 * if any ever exist, sort last).
 */
export function ownSanctionRequestsOf<
  T extends { requesterPersonId: string | null; hostClubId: string; submittedAt?: string | null },
>(requests: T[], personId: string | null, managedClubIds: string[]): T[] {
  if (!personId) return [];
  return requests
    .filter((r) => r.requesterPersonId === personId || managedClubIds.includes(r.hostClubId))
    .sort((a, b) => (b.submittedAt ?? '').localeCompare(a.submittedAt ?? ''));
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
