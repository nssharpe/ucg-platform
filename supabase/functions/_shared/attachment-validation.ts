// _shared/attachment-validation.ts — pure validation for the optional image
// `attachments` on "Report a problem" (event-report screenshots). NO Deno/
// Supabase imports — dual-importable under vitest node (tests/attachment-
// validation.test.ts) and by report-problem/index.ts at runtime, mirroring
// the camp-confirmation.ts pattern. Uses only global atob (present in both
// Deno and Node 18+) to inspect a payload's leading bytes WITHOUT decoding
// the whole (potentially multi-MB) base64 string.
//
// This module validates shape/size/magic-bytes ONLY. The caller still does
// auth + the actual send — a validation pass here is not itself a security
// boundary against, say, a malicious authenticated user, but it keeps
// mislabeled/oversized/non-image payloads out of the email Nate/Julia open.

export const MAX_ATTACHMENTS = 3;
export const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024; // 2MB, post-client-compression
// Combined-request budget across all attachments' base64 strings — a coarse
// guard against a request that lies about per-file size but sends a huge body.
export const MAX_TOTAL_BASE64_CHARS = 8_500_000;

const ALLOWED_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export interface AttachmentIn {
  name?: unknown;
  type?: unknown;
  dataBase64?: unknown;
}

export interface ValidatedAttachment {
  filename: string;
  type: string;
  dataBase64: string;
}

export interface ValidationResult {
  ok: boolean;
  error?: string;
  attachments: ValidatedAttachment[];
}

const BASE64_SHAPE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Decoded byte size from a base64 string's length + trailing padding —
 *  computed from the STRING LENGTH alone, never by decoding the payload.
 *  Safe to call on multi-MB strings. */
export function estimateDecodedBytes(base64: string): number {
  const len = base64.length;
  if (len === 0) return 0;
  let padding = 0;
  if (base64.endsWith('==')) padding = 2;
  else if (base64.endsWith('=')) padding = 1;
  return Math.max(0, Math.floor((len * 3) / 4) - padding);
}

/** Strip to a safe basename and force the extension implied by the
 *  DECLARED `type` — never trusts whatever extension the client sent. */
export function sanitizeFilename(name: string, type: string): string {
  const ext = ALLOWED_TYPES[type] ?? 'jpg';
  const base = name.split(/[/\\]/).pop() ?? 'screenshot';
  const cleaned = base.replace(/\.[^./\\]*$/, '').replace(/[^a-zA-Z0-9._ -]/g, '').trim().slice(0, 80) || 'screenshot';
  return `${cleaned}.${ext}`;
}

// Decodes only the leading slice of the base64 string (a small, fixed number
// of chars — NOT the full payload) to recover the first few raw bytes.
const MAGIC_PREFIX_BASE64_CHARS = 24; // multiple of 4; decodes to 18 bytes, enough for every signature below

function decodeBase64Prefix(base64: string, chars: number): Uint8Array {
  const slice = base64.slice(0, chars);
  const bin = atob(slice);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Confirms the payload's leading bytes match the declared MIME type's magic
 *  number, decoding only a small fixed-size prefix rather than the whole
 *  (potentially multi-MB) body. Catches a mislabeled/non-image file. */
export function hasValidMagicBytes(dataBase64: string, type: string): boolean {
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64Prefix(dataBase64, MAGIC_PREFIX_BASE64_CHARS);
  } catch {
    return false;
  }
  if (type === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === 'image/png') return bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (type === 'image/webp') {
    if (bytes.length < 12) return false;
    const riff = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    const webp = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    return riff === 'RIFF' && webp === 'WEBP';
  }
  return false;
}

/** Validates a whole `attachments` payload: count (<=3), per-item shape/
 *  type/size/magic-bytes, and the combined-request base64 budget. Returns
 *  the first failure (fail-fast, generic-enough error message) or the
 *  sanitized attachment list ready to hand to `sendOne`. `undefined`/`null`
 *  input is treated as "no attachments" (the field is optional). */
export function validateAttachments(input: unknown): ValidationResult {
  if (input === undefined || input === null) return { ok: true, attachments: [] };
  if (!Array.isArray(input)) return { ok: false, error: 'attachments must be an array.', attachments: [] };
  if (input.length > MAX_ATTACHMENTS) {
    return { ok: false, error: `You can attach at most ${MAX_ATTACHMENTS} screenshots.`, attachments: [] };
  }

  let totalBase64Chars = 0;
  const out: ValidatedAttachment[] = [];
  for (const raw of input as AttachmentIn[]) {
    const name = typeof raw?.name === 'string' ? raw.name : '';
    const type = typeof raw?.type === 'string' ? raw.type : '';
    const dataBase64 = typeof raw?.dataBase64 === 'string' ? raw.dataBase64 : '';

    if (!type || !(type in ALLOWED_TYPES)) {
      return { ok: false, error: 'Attachments must be JPEG, PNG, or WebP images.', attachments: [] };
    }
    if (!dataBase64 || dataBase64.length % 4 !== 0 || !BASE64_SHAPE.test(dataBase64)) {
      return { ok: false, error: 'One of the attachments was not valid image data.', attachments: [] };
    }

    totalBase64Chars += dataBase64.length;
    if (totalBase64Chars > MAX_TOTAL_BASE64_CHARS) {
      return { ok: false, error: 'Attachments are too large altogether — try fewer or smaller screenshots.', attachments: [] };
    }

    const decodedBytes = estimateDecodedBytes(dataBase64);
    if (decodedBytes > MAX_ATTACHMENT_BYTES) {
      return { ok: false, error: `${name || 'An attachment'} is too large (max 2MB).`, attachments: [] };
    }

    if (!hasValidMagicBytes(dataBase64, type)) {
      return { ok: false, error: 'One of the attachments did not look like a valid image file.', attachments: [] };
    }

    out.push({ filename: sanitizeFilename(name, type), type, dataBase64 });
  }

  return { ok: true, attachments: out };
}
