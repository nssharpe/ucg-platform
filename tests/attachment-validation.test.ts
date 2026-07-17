import { describe, it, expect } from 'vitest';
import {
  estimateDecodedBytes,
  sanitizeFilename,
  hasValidMagicBytes,
  validateAttachments,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
} from '../supabase/functions/_shared/attachment-validation';

function b64(bytes: number[]): string {
  return Buffer.from(Uint8Array.from(bytes)).toString('base64');
}

const JPEG_HEADER = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46];
const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const WEBP_HEADER = [0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50];

function fakeImageBase64(header: number[], totalBytes = 1000): string {
  const bytes = header.concat(new Array(Math.max(0, totalBytes - header.length)).fill(0x00));
  return b64(bytes);
}

describe('estimateDecodedBytes', () => {
  it('matches the real decoded length for unpadded base64', () => {
    const raw = b64([1, 2, 3, 4, 5, 6]); // 6 bytes, no padding
    expect(estimateDecodedBytes(raw)).toBe(6);
  });

  it('accounts for one and two padding characters', () => {
    const oneByteOff = b64([1, 2, 3, 4, 5]); // 5 bytes -> 1 padding char
    expect(estimateDecodedBytes(oneByteOff)).toBe(5);
    const twoOff = b64([1, 2, 3, 4]); // 4 bytes -> 2 padding chars
    expect(estimateDecodedBytes(twoOff)).toBe(4);
  });

  it('scales correctly for a large (~2MB) payload without decoding it', () => {
    const size = MAX_ATTACHMENT_BYTES;
    const bytes = new Array(size).fill(0);
    const base64 = b64(bytes);
    expect(estimateDecodedBytes(base64)).toBe(size);
  });

  it('returns 0 for an empty string', () => {
    expect(estimateDecodedBytes('')).toBe(0);
  });
});

describe('sanitizeFilename', () => {
  it('forces the extension implied by the declared type', () => {
    expect(sanitizeFilename('photo.png', 'image/jpeg')).toBe('photo.jpg');
    expect(sanitizeFilename('screenshot', 'image/png')).toBe('screenshot.png');
  });

  it('strips a path and keeps only the basename', () => {
    expect(sanitizeFilename('C:\\Users\\nate\\Desktop\\evil.jpg', 'image/jpeg')).toBe('evil.jpg');
  });

  it('strips dangerous characters', () => {
    const name = sanitizeFilename('../../etc/passwd<script>.png', 'image/webp');
    expect(name).not.toMatch(/[/\\<>]/);
    expect(name.endsWith('.webp')).toBe(true);
  });

  it('falls back to "screenshot" for an empty/unusable name', () => {
    expect(sanitizeFilename('', 'image/jpeg')).toBe('screenshot.jpg');
    expect(sanitizeFilename('***', 'image/png')).toBe('screenshot.png');
  });
});

describe('hasValidMagicBytes', () => {
  it('accepts a correctly-signed JPEG', () => {
    expect(hasValidMagicBytes(fakeImageBase64(JPEG_HEADER), 'image/jpeg')).toBe(true);
  });

  it('accepts a correctly-signed PNG', () => {
    expect(hasValidMagicBytes(fakeImageBase64(PNG_HEADER), 'image/png')).toBe(true);
  });

  it('accepts a correctly-signed WebP (RIFF....WEBP)', () => {
    expect(hasValidMagicBytes(fakeImageBase64(WEBP_HEADER), 'image/webp')).toBe(true);
  });

  it('rejects a mismatched signature (declared PNG, actually JPEG bytes)', () => {
    expect(hasValidMagicBytes(fakeImageBase64(JPEG_HEADER), 'image/png')).toBe(false);
  });

  it('rejects a non-image payload (e.g. a text/script file) for any declared type', () => {
    const textBytes = Array.from('#!/bin/sh\necho hi\n').map((c) => c.charCodeAt(0));
    const base64 = b64(textBytes);
    expect(hasValidMagicBytes(base64, 'image/jpeg')).toBe(false);
    expect(hasValidMagicBytes(base64, 'image/png')).toBe(false);
    expect(hasValidMagicBytes(base64, 'image/webp')).toBe(false);
  });

  it('rejects an unknown declared type', () => {
    expect(hasValidMagicBytes(fakeImageBase64(PNG_HEADER), 'image/gif')).toBe(false);
  });
});

describe('validateAttachments', () => {
  it('treats undefined/null as "no attachments" (optional field)', () => {
    expect(validateAttachments(undefined)).toEqual({ ok: true, attachments: [] });
    expect(validateAttachments(null)).toEqual({ ok: true, attachments: [] });
  });

  it('rejects a non-array payload', () => {
    const result = validateAttachments({ not: 'an array' });
    expect(result.ok).toBe(false);
  });

  it('rejects more than MAX_ATTACHMENTS items', () => {
    const one = { name: 'a.jpg', type: 'image/jpeg', dataBase64: fakeImageBase64(JPEG_HEADER) };
    const result = validateAttachments(new Array(MAX_ATTACHMENTS + 1).fill(one));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/at most/i);
  });

  it('accepts up to MAX_ATTACHMENTS valid images and sanitizes filenames', () => {
    const items = [
      { name: 'first.png', type: 'image/jpeg', dataBase64: fakeImageBase64(JPEG_HEADER) },
      { name: 'second', type: 'image/png', dataBase64: fakeImageBase64(PNG_HEADER) },
      { name: 'third.gif', type: 'image/webp', dataBase64: fakeImageBase64(WEBP_HEADER) },
    ];
    const result = validateAttachments(items);
    expect(result.ok).toBe(true);
    expect(result.attachments.map((a) => a.filename)).toEqual(['first.jpg', 'second.png', 'third.webp']);
  });

  it('rejects a disallowed MIME type', () => {
    const result = validateAttachments([{ name: 'a.svg', type: 'image/svg+xml', dataBase64: fakeImageBase64(PNG_HEADER) }]);
    expect(result.ok).toBe(false);
  });

  it('rejects malformed base64 (bad shape / wrong padding length)', () => {
    const result = validateAttachments([{ name: 'a.jpg', type: 'image/jpeg', dataBase64: 'not-base64!!!' }]);
    expect(result.ok).toBe(false);
  });

  it('rejects an oversized attachment (over 2MB decoded) without needing a huge fixture', () => {
    // A base64 string whose LENGTH alone implies >2MB decoded — the size check
    // must trip from length math, not from actually decoding this string.
    const targetBytes = MAX_ATTACHMENT_BYTES + 4096;
    const oversizedLength = Math.ceil((targetBytes * 4) / 3 / 4) * 4; // round up to a multiple of 4
    const dataBase64 = 'A'.repeat(oversizedLength);
    const result = validateAttachments([{ name: 'huge.jpg', type: 'image/jpeg', dataBase64 }]);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/too large/i);
  });

  it('rejects a payload whose magic bytes do not match the declared type', () => {
    const result = validateAttachments([{ name: 'fake.png', type: 'image/png', dataBase64: fakeImageBase64(JPEG_HEADER) }]);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/valid image file/i);
  });
});
