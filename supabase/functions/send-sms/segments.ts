// SMS segment/encoding logic for the Deno Edge runtime.
//
// MIRROR of src/lib/sms-segments.ts — kept as a separate copy because Edge
// Functions can't import from the Vite `src/` tree (same reason capabilities are
// split into capabilities-core.ts). If you change the segment math here, change it
// there too; the unit tests in tests/sms-segments.test.ts cover the canonical copy.

const GSM7_BASIC = new Set(
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ' +
  'ÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§' +
  '¿abcdefghijklmnopqrstuvwxyzäöñüà'
);
const GSM7_EXTENDED = new Set('^{}\\[~]|€\f');

export type SmsEncoding = 'GSM-7' | 'UCS-2';

export interface SegmentInfo {
  encoding: SmsEncoding;
  length: number;
  segments: number;
  perSegment: number;
  remaining: number;
  isUnicode: boolean;
}

export function isGsm7(text: string): boolean {
  for (const ch of text) {
    if (!GSM7_BASIC.has(ch) && !GSM7_EXTENDED.has(ch)) return false;
  }
  return true;
}

function gsm7Length(text: string): number {
  let n = 0;
  for (const ch of text) n += GSM7_EXTENDED.has(ch) ? 2 : 1;
  return n;
}

export function analyzeMessage(text: string): SegmentInfo {
  const unicode = !isGsm7(text);
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
