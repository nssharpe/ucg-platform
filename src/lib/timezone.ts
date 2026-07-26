// Pure, zero-runtime-deps derivation of an event's IANA timezone from its
// location. Event timezones are no longer user-selected (2026-07-20) — they're
// derived from the event's US state. Split states map to the zone of the state
// capital (see docs/specs/2026-07-20-season-card-ucg-events-and-cleanups.md
// "Timezone derivation").
const DEFAULT_ZONE = 'America/New_York';

// Keyed by full lowercase state/territory name.
const STATE_TIMEZONES: Record<string, string> = {
  alabama: 'America/Chicago',
  alaska: 'America/Anchorage',
  arizona: 'America/Phoenix',
  arkansas: 'America/Chicago',
  california: 'America/Los_Angeles',
  colorado: 'America/Denver',
  connecticut: 'America/New_York',
  delaware: 'America/New_York',
  'district of columbia': 'America/New_York',
  florida: 'America/New_York',
  georgia: 'America/New_York',
  hawaii: 'Pacific/Honolulu',
  idaho: 'America/Boise',
  illinois: 'America/Chicago',
  indiana: 'America/New_York',
  iowa: 'America/Chicago',
  kansas: 'America/Chicago',
  kentucky: 'America/New_York',
  louisiana: 'America/Chicago',
  maine: 'America/New_York',
  maryland: 'America/New_York',
  massachusetts: 'America/New_York',
  michigan: 'America/New_York',
  minnesota: 'America/Chicago',
  mississippi: 'America/Chicago',
  missouri: 'America/Chicago',
  montana: 'America/Denver',
  nebraska: 'America/Chicago',
  nevada: 'America/Los_Angeles',
  'new hampshire': 'America/New_York',
  'new jersey': 'America/New_York',
  'new mexico': 'America/Denver',
  'new york': 'America/New_York',
  'north carolina': 'America/New_York',
  'north dakota': 'America/Chicago',
  ohio: 'America/New_York',
  oklahoma: 'America/Chicago',
  oregon: 'America/Los_Angeles',
  pennsylvania: 'America/New_York',
  'rhode island': 'America/New_York',
  'south carolina': 'America/New_York',
  'south dakota': 'America/Chicago',
  tennessee: 'America/Chicago',
  texas: 'America/Chicago',
  utah: 'America/Denver',
  vermont: 'America/New_York',
  virginia: 'America/New_York',
  washington: 'America/Los_Angeles',
  'west virginia': 'America/New_York',
  wisconsin: 'America/Chicago',
  wyoming: 'America/Denver',
  // Territories
  'puerto rico': 'America/Puerto_Rico',
  'virgin islands': 'America/Puerto_Rico',
  'us virgin islands': 'America/Puerto_Rico',
  guam: 'Pacific/Guam',
};

// Keyed by 2-letter code (state + DC + territories).
const CODE_TIMEZONES: Record<string, string> = {
  al: 'America/Chicago',
  ak: 'America/Anchorage',
  az: 'America/Phoenix',
  ar: 'America/Chicago',
  ca: 'America/Los_Angeles',
  co: 'America/Denver',
  ct: 'America/New_York',
  de: 'America/New_York',
  dc: 'America/New_York',
  fl: 'America/New_York',
  ga: 'America/New_York',
  hi: 'Pacific/Honolulu',
  id: 'America/Boise',
  il: 'America/Chicago',
  in: 'America/New_York',
  ia: 'America/Chicago',
  ks: 'America/Chicago',
  ky: 'America/New_York',
  la: 'America/Chicago',
  me: 'America/New_York',
  md: 'America/New_York',
  ma: 'America/New_York',
  mi: 'America/New_York',
  mn: 'America/Chicago',
  ms: 'America/Chicago',
  mo: 'America/Chicago',
  mt: 'America/Denver',
  ne: 'America/Chicago',
  nv: 'America/Los_Angeles',
  nh: 'America/New_York',
  nj: 'America/New_York',
  nm: 'America/Denver',
  ny: 'America/New_York',
  nc: 'America/New_York',
  nd: 'America/Chicago',
  oh: 'America/New_York',
  ok: 'America/Chicago',
  or: 'America/Los_Angeles',
  pa: 'America/New_York',
  ri: 'America/New_York',
  sc: 'America/New_York',
  sd: 'America/Chicago',
  tn: 'America/Chicago',
  tx: 'America/Chicago',
  ut: 'America/Denver',
  vt: 'America/New_York',
  va: 'America/New_York',
  wa: 'America/Los_Angeles',
  wv: 'America/New_York',
  wi: 'America/Chicago',
  wy: 'America/Denver',
  // Territories
  pr: 'America/Puerto_Rico',
  vi: 'America/Puerto_Rico',
  gu: 'Pacific/Guam',
};

const US_COUNTRY_NAMES = new Set([
  '', 'us', 'usa', 'u.s.', 'u.s.a.', 'united states', 'united states of america',
]);

function isUsCountry(country?: string | null): boolean {
  if (country == null) return true; // blank/omitted defaults to US
  const c = country.trim().toLowerCase();
  return US_COUNTRY_NAMES.has(c);
}

/** Derive the IANA timezone for an event from its US state (+ optional country). */
export function timezoneForState(state?: string | null, country?: string | null): string {
  if (!isUsCountry(country)) return DEFAULT_ZONE;
  if (!state) return DEFAULT_ZONE;
  const key = state.trim().toLowerCase();
  if (!key) return DEFAULT_ZONE;
  if (key.length === 2 && CODE_TIMEZONES[key]) return CODE_TIMEZONES[key];
  if (STATE_TIMEZONES[key]) return STATE_TIMEZONES[key];
  return DEFAULT_ZONE;
}

/** Short abbreviation ("EDT", "PST", …) for an IANA timezone, as of right
 *  now. Lifted out of src/pages/Events.tsx (2026-07-26, H2) so any page that
 *  needs to LABEL a date already shown in the event's own local wall-clock
 *  time (never to convert it — `regOpens`/`regCloses`/etc. are stored as
 *  naive local-time strings, not UTC instants) can reuse the same helper
 *  instead of redefining it. */
export function tzAbbrev(timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'short' })
      .formatToParts(new Date());
    return parts.find((p) => p.type === 'timeZoneName')?.value ?? timezone;
  } catch {
    return timezone;
  }
}
