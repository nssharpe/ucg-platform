// SMS segment + encoding logic — pure, dependency-free, unit-tested.
//
// Every SMS is billed *per segment*, and the segment size depends on the
// encoding the carrier must use:
//   - GSM-7 (plain text): 160 chars single / 153 per part when concatenated.
//   - UCS-2 (any non-GSM char, e.g. emoji or a curly quote): 70 / 67.
// A single emoji therefore drops the limit from 160 → 70 and can 2–3× the cost
// of a blast — so the Communicate composer shows a live readout from this module,
// and send-sms enforces a max-segment cap server-side using the same logic.
//
// Lives apart from any React/runtime deps (like capabilities-core.ts) so it can
// be unit-tested in the node/vitest environment. See tests/sms-segments.test.ts.

// GSM 03.38 default alphabet — characters that encode as a single 7-bit septet.
const GSM7_BASIC = new Set(
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ' +
  'ÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§' +
  '¿abcdefghijklmnopqrstuvwxyzäöñüà'
);

// GSM 03.38 extension table — each of these encodes as TWO septets (an escape
// prefix + the char), so they count double toward the GSM-7 length.
const GSM7_EXTENDED = new Set('^{}\\[~]|€\f');

export type SmsEncoding = 'GSM-7' | 'UCS-2';

export interface SegmentInfo {
  encoding: SmsEncoding;
  /** Encoded length: GSM-7 septets (extension chars count 2) or UCS-2 16-bit units. */
  length: number;
  /** Number of billable segments (parts) this message will split into. */
  segments: number;
  /** Per-segment capacity at the current segment count (160/153 or 70/67). */
  perSegment: number;
  /** Characters left before the message rolls into another segment. */
  remaining: number;
  /** True when a non-GSM char forced UCS-2 (emoji, smart quote, etc.). */
  isUnicode: boolean;
}

/** True when every character is representable in GSM-7 (no UCS-2 fallback). */
export function isGsm7(text: string): boolean {
  for (const ch of text) {
    if (!GSM7_BASIC.has(ch) && !GSM7_EXTENDED.has(ch)) return false;
  }
  return true;
}

/** GSM-7 encoded length in septets (extension-table chars count as 2). */
function gsm7Length(text: string): number {
  let n = 0;
  for (const ch of text) n += GSM7_EXTENDED.has(ch) ? 2 : 1;
  return n;
}

/** Analyze a message body: encoding, encoded length, and billable segment count. */
export function analyzeMessage(text: string): SegmentInfo {
  const unicode = !isGsm7(text);
  // UCS-2 counts 16-bit code units — str.length already does (surrogates count 2).
  const length = unicode ? text.length : gsm7Length(text);

  const single = unicode ? 70 : 160;
  const multi = unicode ? 67 : 153;

  let segments: number;
  let perSegment: number;
  if (length <= single) {
    segments = length === 0 ? 0 : 1;
    perSegment = single;
  } else {
    segments = Math.ceil(length / multi);
    perSegment = multi;
  }

  const capacity = Math.max(segments, 1) * perSegment;
  return {
    encoding: unicode ? 'UCS-2' : 'GSM-7',
    length,
    segments,
    perSegment,
    remaining: capacity - length,
    isUnicode: unicode,
  };
}

// Common non-GSM characters that sneak in via copy-paste (smart quotes, dashes,
// ellipsis, non-breaking space) mapped to GSM-7-safe equivalents. Lets the UI
// offer a one-click "normalize" so a stray curly quote doesn't force UCS-2.
const NORMALIZE_MAP: Record<string, string> = {
  '‘': "'", '’': "'",            // ‘ ’ curly single quotes
  '“': '"', '”': '"',            // “ ” curly double quotes
  '–': '-', '—': '-',            // – — en/em dash
  '…': '...',                          // … ellipsis
  ' ': ' ',                            // non-breaking space
  '•': '*',                            // • bullet
  '´': "'", '`': "'",            // ´ ` accents-as-quotes
};

/** Replace common non-GSM punctuation with GSM-7-safe equivalents. */
export function normalizeToGsm7(text: string): string {
  let out = '';
  for (const ch of text) out += NORMALIZE_MAP[ch] ?? ch;
  return out;
}
