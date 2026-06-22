import { describe, it, expect } from 'vitest';
import { analyzeMessage, isGsm7, normalizeToGsm7 } from '../src/lib/sms-segments';

describe('isGsm7', () => {
  it('accepts plain ASCII and common GSM punctuation', () => {
    expect(isGsm7('UCG: Reg closes Friday! Pay at the portal.')).toBe(true);
    expect(isGsm7('Cost is £5 / €5 @ 50% off?')).toBe(true);
  });
  it('rejects emoji and smart punctuation', () => {
    expect(isGsm7('See you there 🎉')).toBe(false);
    expect(isGsm7('We’re ready')).toBe(false); // curly apostrophe
    expect(isGsm7('A — B')).toBe(false);       // em dash
  });
});

describe('analyzeMessage — GSM-7', () => {
  it('empty string is zero segments', () => {
    const r = analyzeMessage('');
    expect(r).toMatchObject({ encoding: 'GSM-7', length: 0, segments: 0 });
  });
  it('160 chars is exactly one segment', () => {
    const r = analyzeMessage('a'.repeat(160));
    expect(r).toMatchObject({ encoding: 'GSM-7', length: 160, segments: 1, remaining: 0 });
  });
  it('161 chars rolls into two segments at 153/part', () => {
    const r = analyzeMessage('a'.repeat(161));
    expect(r).toMatchObject({ encoding: 'GSM-7', segments: 2, perSegment: 153 });
    expect(r.remaining).toBe(153 * 2 - 161);
  });
  it('extension-table chars count as two septets', () => {
    // 159 'a' + one '€' (2 septets) = 161 septets -> 2 segments
    const r = analyzeMessage('a'.repeat(159) + '€');
    expect(r.length).toBe(161);
    expect(r.segments).toBe(2);
  });
});

describe('analyzeMessage — UCS-2', () => {
  it('a single emoji forces UCS-2 and the 70-char limit', () => {
    const r = analyzeMessage('hi 🎉');
    expect(r.encoding).toBe('UCS-2');
    expect(r.isUnicode).toBe(true);
    expect(r.perSegment).toBe(70);
    expect(r.segments).toBe(1);
  });
  it('70 BMP unicode chars is one segment, 71 is two at 67/part', () => {
    // 'ж' (Cyrillic) is not in GSM-7, so it forces UCS-2. ('é' actually *is* GSM-7.)
    expect(analyzeMessage('ж'.repeat(70)).segments).toBe(1);
    const r = analyzeMessage('ж'.repeat(71));
    expect(r).toMatchObject({ encoding: 'UCS-2', segments: 2, perSegment: 67 });
  });
  it('astral emoji counts as two UCS-2 units', () => {
    // 🎉 is a surrogate pair => length 2
    expect(analyzeMessage('🎉').length).toBe(2);
  });
});

describe('normalizeToGsm7', () => {
  it('converts smart quotes, dashes and ellipsis to GSM-7-safe chars', () => {
    const dirty = '“We’re ready” — sign up…';
    const clean = normalizeToGsm7(dirty);
    expect(clean).toBe('"We\'re ready" - sign up...');
    expect(isGsm7(clean)).toBe(true);
  });
  it('leaves emoji untouched (cannot be normalized)', () => {
    expect(isGsm7(normalizeToGsm7('party 🎉'))).toBe(false);
  });
});
