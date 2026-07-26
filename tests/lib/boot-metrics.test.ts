import { describe, it, expect } from 'vitest';
import {
  shouldReportBootMetrics, isQuotaExceededError,
  BOOT_PAYLOAD_BYTES_THRESHOLD, BOOT_HYDRATION_MS_THRESHOLD,
} from '../../src/lib/boot-metrics';

describe('shouldReportBootMetrics', () => {
  it('is false comfortably under both thresholds', () => {
    expect(shouldReportBootMetrics(1024, 500)).toBe(false);
  });

  it('is true once payload bytes cross the threshold', () => {
    expect(shouldReportBootMetrics(BOOT_PAYLOAD_BYTES_THRESHOLD + 1, 0)).toBe(true);
  });

  it('is false exactly at the payload threshold (strictly greater-than)', () => {
    expect(shouldReportBootMetrics(BOOT_PAYLOAD_BYTES_THRESHOLD, 0)).toBe(false);
  });

  it('is true once hydration duration crosses the threshold', () => {
    expect(shouldReportBootMetrics(0, BOOT_HYDRATION_MS_THRESHOLD + 1)).toBe(true);
  });

  it('is false exactly at the hydration threshold (strictly greater-than)', () => {
    expect(shouldReportBootMetrics(0, BOOT_HYDRATION_MS_THRESHOLD)).toBe(false);
  });

  it('is true when both thresholds are crossed', () => {
    expect(shouldReportBootMetrics(BOOT_PAYLOAD_BYTES_THRESHOLD * 2, BOOT_HYDRATION_MS_THRESHOLD * 2)).toBe(true);
  });
});

describe('isQuotaExceededError', () => {
  it('recognizes the modern standard name', () => {
    expect(isQuotaExceededError(new DOMException('nope', 'QuotaExceededError'))).toBe(true);
  });

  it('recognizes Firefox legacy name', () => {
    expect(isQuotaExceededError(new DOMException('nope', 'NS_ERROR_DOM_QUOTA_REACHED'))).toBe(true);
  });

  it('recognizes the legacy cross-browser code 22', () => {
    const err = new DOMException('nope', 'SomeOtherName');
    Object.defineProperty(err, 'code', { value: 22 });
    expect(isQuotaExceededError(err)).toBe(true);
  });

  it('recognizes the Firefox legacy code 1014', () => {
    const err = new DOMException('nope', 'SomeOtherName');
    Object.defineProperty(err, 'code', { value: 1014 });
    expect(isQuotaExceededError(err)).toBe(true);
  });

  it('rejects an unrelated DOMException', () => {
    expect(isQuotaExceededError(new DOMException('nope', 'NotFoundError'))).toBe(false);
  });

  it('rejects a plain Error', () => {
    expect(isQuotaExceededError(new Error('storage full'))).toBe(false);
  });

  it('rejects non-error values', () => {
    expect(isQuotaExceededError(undefined)).toBe(false);
    expect(isQuotaExceededError('QuotaExceededError')).toBe(false);
    expect(isQuotaExceededError(null)).toBe(false);
  });
});
