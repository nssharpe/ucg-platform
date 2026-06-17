/**
 * Half-up rounding to a fixed number of decimal places, matching the reference
 * tool's `constants.round_score` (Python `Decimal(str(float(x))).quantize(...,
 * ROUND_HALF_UP)`). JavaScript's `Math.round` is half-up for positives but
 * `(x * 1000)` reintroduces binary float error — the exact thing the reference
 * avoids by rounding the *shortest decimal string*. We do the same: take
 * `String(x)` (V8 emits the shortest round-tripping decimal, like Python's repr)
 * and round that string. A 0.0005 difference flips placements, so this matters.
 */
export function roundScore(x: number, places = 3): number {
  if (!Number.isFinite(x)) return x;
  if (x === 0) return 0;
  const neg = x < 0;
  let s = Math.abs(x).toString();
  if (s.includes('e') || s.includes('E')) {
    // Scientific notation (very small/large) — expand with guard precision.
    s = Math.abs(x).toFixed(places + 3);
  }
  const [intPart, fracRaw = ''] = s.split('.');
  if (fracRaw.length <= places) {
    return x; // already at or below target precision; nothing to round
  }
  const keep = fracRaw.slice(0, places);
  const guard = fracRaw.charCodeAt(places) - 48; // first discarded digit
  // Half-up: round up iff the discarded fraction >= 0.5, i.e. guard digit >= 5
  // (any digits after a 5 only make it larger, so the first digit decides).
  let mant = BigInt(intPart + keep);
  if (guard >= 5) mant += 1n;
  const scaled = Number(mant) / 10 ** places;
  return neg ? -scaled : scaled;
}

/** Compare two scores at score precision (3dp). */
export function scoreEq(a: number, b: number): boolean {
  return Math.abs(roundScore(a) - roundScore(b)) < 1e-9;
}
