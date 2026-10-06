import { describe, it, expect } from 'vitest';
import { mergeRings, ringArea, type Ring } from '@/lib/geometry/ringUnion';

const rect = (x0: number, y0: number, x1: number, y1: number): Ring => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

describe('joining room outlines', () => {
  it('two pieces split by a thin line become one shape (the line is absorbed)', () => {
    // a 200 × 100 space cut by a 2-wide line at x = 100
    const out = mergeRings([rect(0, 0, 99, 100), rect(101, 0, 200, 100)], 3);
    expect(out).toHaveLength(1);
    expect(ringArea(out[0])).toBeCloseTo(200 * 100, 0);
    expect(out[0].length).toBeLessThanOrEqual(6);        // still a plain rectangle, no notch at the join
  });

  it('pieces separated by a real wall stay separate', () => {
    const out = mergeRings([rect(0, 0, 90, 100), rect(110, 0, 200, 100)], 3);   // 20-wide wall
    expect(out).toHaveLength(2);
    expect(ringArea(out[0])).toBeCloseTo(90 * 100, 0);
  });

  it('something standing on the joining line is swallowed, not left as a hole', () => {
    // left and right halves, each notched around a table (40–60 × 40–60) that straddles the line
    const left:  Ring = [[0, 0], [49, 0], [49, 39], [39, 39], [39, 61], [49, 61], [49, 100], [0, 100]];
    const right: Ring = [[51, 0], [100, 0], [100, 100], [51, 100], [51, 61], [61, 61], [61, 39], [51, 39]];
    const out = mergeRings([left, right], 3);
    expect(out).toHaveLength(1);                                   // no inner ring returned
    expect(ringArea(out[0])).toBeCloseTo(100 * 100, 0);
  });

  it('a single outline comes back essentially unchanged', () => {
    const l: Ring = [[0, 0], [100, 0], [100, 40], [40, 40], [40, 100], [0, 100]];
    const out = mergeRings([l], 3);
    expect(out).toHaveLength(1);
    expect(ringArea(out[0])).toBeCloseTo(ringArea(l), 0);
  });

  it('winding does not matter', () => {
    const a = rect(0, 0, 99, 100), b = rect(101, 0, 200, 100).reverse() as Ring;
    expect(mergeRings([a, b], 3)).toHaveLength(1);
  });
});
