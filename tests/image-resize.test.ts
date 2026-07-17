import { describe, it, expect } from 'vitest';
import { computeTargetDimensions, MAX_ATTACHMENT_EDGE_PX } from '../src/lib/image-resize';

describe('computeTargetDimensions (pure resize math)', () => {
  it('leaves an already-small image untouched', () => {
    expect(computeTargetDimensions(800, 600)).toEqual({ width: 800, height: 600 });
  });

  it('is a no-op when the long edge exactly equals the cap', () => {
    expect(computeTargetDimensions(1600, 900, 1600)).toEqual({ width: 1600, height: 900 });
  });

  it('downscales a landscape image to the cap on the long (width) edge', () => {
    const { width, height } = computeTargetDimensions(3200, 1800, 1600);
    expect(width).toBe(1600);
    expect(height).toBe(900);
  });

  it('downscales a portrait image to the cap on the long (height) edge', () => {
    const { width, height } = computeTargetDimensions(1800, 3200, 1600);
    expect(height).toBe(1600);
    expect(width).toBe(900);
  });

  it('never upscales a smaller image', () => {
    expect(computeTargetDimensions(400, 300, MAX_ATTACHMENT_EDGE_PX)).toEqual({ width: 400, height: 300 });
  });

  it('handles a square image at the cap', () => {
    expect(computeTargetDimensions(4000, 4000, 1600)).toEqual({ width: 1600, height: 1600 });
  });

  it('returns zero dimensions for invalid (zero/negative) input rather than NaN', () => {
    expect(computeTargetDimensions(0, 600)).toEqual({ width: 0, height: 0 });
    expect(computeTargetDimensions(800, 0)).toEqual({ width: 0, height: 0 });
    expect(computeTargetDimensions(-10, 600)).toEqual({ width: 0, height: 0 });
  });

  it('rounds to whole pixels', () => {
    const { width, height } = computeTargetDimensions(3333, 2222, 1600);
    expect(Number.isInteger(width)).toBe(true);
    expect(Number.isInteger(height)).toBe(true);
  });
});
