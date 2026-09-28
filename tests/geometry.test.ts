import { describe, it, expect } from 'vitest';
import { shoelaceArea, linearLength } from '@/hooks/measurements/useMeasurements/useMeasurementCommit';

// Page 1000×500 pt shown at zoom 2 → canvas 2000×1000 px.
const W = 2000, H = 1000, ZOOM = 2;

describe('quantity maths', () => {
  it('linear length is zoom-independent and applies the scale factor', () => {
    const pts = [{ x: 0, y: 0 }, { x: 0.5, y: 0 }]; // half the page width = 500 pt
    expect(linearLength(pts, W, H, ZOOM, 1)).toBeCloseTo(500);
    expect(linearLength(pts, W, H, ZOOM, 0.01)).toBeCloseTo(5);
    // Same shape at a different zoom gives the same real length
    expect(linearLength(pts, W * 3, H * 3, ZOOM * 3, 0.01)).toBeCloseTo(5);
  });

  it('area scales by the square of the scale factor', () => {
    const square = [{ x: 0, y: 0 }, { x: 0.1, y: 0 }, { x: 0.1, y: 0.2 }, { x: 0, y: 0.2 }]; // 100×100 pt
    expect(shoelaceArea(square, W, H, ZOOM, 1)).toBeCloseTo(10_000);
    expect(shoelaceArea(square, W, H, ZOOM, 0.01)).toBeCloseTo(1);
  });

  it('polygon winding does not change the area', () => {
    const cw  = [{ x: 0, y: 0 }, { x: 0, y: 0.2 }, { x: 0.1, y: 0.2 }, { x: 0.1, y: 0 }];
    const ccw = [...cw].reverse();
    expect(shoelaceArea(cw, W, H, ZOOM, 1)).toBeCloseTo(shoelaceArea(ccw, W, H, ZOOM, 1));
  });

  it('mixing a live zoom with committed dimensions would be wrong (regression guard)', () => {
    const pts = [{ x: 0, y: 0 }, { x: 0.5, y: 0 }];
    // dims at zoom 2, but divided by a live zoom of 2.5 → 20% error. The viewer
    // now always passes the zoom the dims were computed at (dimsScaleRef).
    expect(linearLength(pts, W, H, 2.5, 1)).not.toBeCloseTo(500);
  });
});
