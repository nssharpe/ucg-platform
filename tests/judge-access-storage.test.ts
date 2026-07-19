import { describe, it, expect } from 'vitest';
import { parseJudgeAccessMap, serializeJudgeAccessMap, withJudgeAccess } from '../src/lib/judge-access-storage';

describe('parseJudgeAccessMap', () => {
  it('returns an empty map for null/undefined/empty input', () => {
    expect(parseJudgeAccessMap(null)).toEqual({});
    expect(parseJudgeAccessMap(undefined)).toEqual({});
    expect(parseJudgeAccessMap('')).toEqual({});
  });

  it('parses a valid eventId->token map', () => {
    const raw = JSON.stringify({ 'evt-1': 'tok-1', 'evt-2': 'tok-2' });
    expect(parseJudgeAccessMap(raw)).toEqual({ 'evt-1': 'tok-1', 'evt-2': 'tok-2' });
  });

  it('tolerates corrupt JSON without throwing', () => {
    expect(parseJudgeAccessMap('{not json')).toEqual({});
  });

  it('drops non-string values and rejects non-object shapes', () => {
    expect(parseJudgeAccessMap(JSON.stringify(['a', 'b']))).toEqual({});
    expect(parseJudgeAccessMap(JSON.stringify('just a string'))).toEqual({});
    expect(parseJudgeAccessMap(JSON.stringify({ 'evt-1': 42, 'evt-2': 'tok-2' }))).toEqual({ 'evt-2': 'tok-2' });
  });
});

describe('withJudgeAccess', () => {
  it('adds a new event without mutating the input map', () => {
    const before = { 'evt-1': 'tok-1' };
    const after = withJudgeAccess(before, 'evt-2', 'tok-2');
    expect(after).toEqual({ 'evt-1': 'tok-1', 'evt-2': 'tok-2' });
    expect(before).toEqual({ 'evt-1': 'tok-1' }); // unchanged
  });

  it('overwrites an existing event token', () => {
    const before = { 'evt-1': 'tok-old' };
    const after = withJudgeAccess(before, 'evt-1', 'tok-new');
    expect(after).toEqual({ 'evt-1': 'tok-new' });
  });
});

describe('serializeJudgeAccessMap / parseJudgeAccessMap round-trip', () => {
  it('round-trips a map', () => {
    const map = { 'evt-1': 'tok-1', 'evt-2': 'tok-2' };
    expect(parseJudgeAccessMap(serializeJudgeAccessMap(map))).toEqual(map);
  });
});
