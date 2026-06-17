import { roundScore } from './round';
import { assignPlaces } from './placement';
import { WAG, MAG, TNT, type AthleteEntry, type QualFlag } from './types';

/** Join key for matching one athlete across disciplines. */
function joinKey(e: AthleteEntry): string {
  return `${e.first}|${e.last}|${e.email}|${e.club}`;
}

function allCompeted(e: AthleteEntry, events: string[]): boolean {
  return events.every((ev) => e.events[ev] && e.events[ev].status !== 'Scratched');
}

export interface DecathlonResult {
  first: string;
  last: string;
  email: string;
  club: string;
  level: string; // "<WAG level>/<MAG level>"
  overall: number;
  place: number | null;
  qual: QualFlag;
}

/**
 * Decathlon: athletes who competed both WAG and MAG. Overall = 2×WAG_AA + MAG_AA
 * (provided AA scores), placed within each "WAGlevel/MAGlevel" group, blue number
 * 3. Only athletes eligible in both all-arounds (nothing scratched) are placed.
 * Ports `decathlon.Decathlon`. Prelims only.
 */
export function computeDecathlon(wag: AthleteEntry[], mag: AthleteEntry[]): DecathlonResult[] {
  const magByKey = new Map(mag.map((e) => [joinKey(e), e]));
  const rows: (DecathlonResult & { eligible: boolean; score: number; id: string })[] = [];
  for (const w of wag) {
    const m = magByKey.get(joinKey(w));
    if (!m) continue;
    const overall = roundScore(2 * roundScore(w.aaScore ?? 0) + roundScore(m.aaScore ?? 0));
    const eligible = allCompeted(w, WAG.events) && allCompeted(m, MAG.events);
    rows.push({
      id: joinKey(w),
      first: w.first,
      last: w.last,
      email: w.email,
      club: w.club,
      level: `${w.level}/${m.level}`,
      overall,
      score: overall,
      eligible,
      place: null,
      qual: 'N',
    });
  }
  const places = assignPlaces(rows, (r) => r.eligible, (r) => r.level);
  const out: DecathlonResult[] = [];
  for (const r of rows) {
    const place = places.get(r.id) ?? null;
    if (place == null) continue; // reference keeps only placed (eligible) athletes
    out.push({
      first: r.first,
      last: r.last,
      email: r.email,
      club: r.club,
      level: r.level,
      overall: r.overall,
      place,
      qual: place <= 3 ? 'Y' : 'N',
    });
  }
  return out;
}

export interface OmnithonResult {
  first: string;
  last: string;
  email: string;
  club: string;
  /** Whether the athlete competed every event across WAG, MAG, and TNT. */
  eligible: boolean;
  qual: QualFlag;
}

/**
 * Omnithon: athletes present in WAG, MAG, and TNT. ⚠️ The reference tool does not
 * compute a real composite score — its "Overall Score"/"Overall Place" are the
 * place-eligibility boolean (competed everything). We reproduce that for parity;
 * the real Omnithon formula is undefined upstream (flag to rules@naigc.org).
 * Ports `omnithon.Omnithon`. Prelims only.
 */
export function computeOmnithon(wag: AthleteEntry[], mag: AthleteEntry[], tnt: AthleteEntry[]): OmnithonResult[] {
  const magByKey = new Map(mag.map((e) => [joinKey(e), e]));
  const tntByKey = new Map(tnt.map((e) => [joinKey(e), e]));
  const out: OmnithonResult[] = [];
  for (const w of wag) {
    const m = magByKey.get(joinKey(w));
    const t = tntByKey.get(joinKey(w));
    if (!m || !t) continue;
    const eligible =
      allCompeted(w, WAG.events) && allCompeted(m, MAG.events) && allCompeted(t, TNT.events);
    out.push({ first: w.first, last: w.last, email: w.email, club: w.club, eligible, qual: eligible ? 'Y' : 'N' });
  }
  return out;
}
