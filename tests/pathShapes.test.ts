import { describe, it, expect } from 'vitest';
import { tessellateArc, pathToRing, regularPolygon, circleRing, ringArea, clampSides } from '@/lib/geometry/pathShapes';

describe('area shapes', () => {
  it('an arc goes through its middle point, whichever way it is drawn', () => {
    // upper half of the unit-100 circle, drawn left→right through the top (y up = negative)
    const up = tessellateArc({ x: -100, y: 0 }, { x: 0, y: -100 }, { x: 100, y: 0 }, 2);
    expect(Math.min(...up.map(p => p.y))).toBeCloseTo(-100, 1);
    expect(Math.max(...up.map(p => p.y))).toBeLessThanOrEqual(1e-6);
    // same ends through the bottom
    const down = tessellateArc({ x: -100, y: 0 }, { x: 0, y: 100 }, { x: 100, y: 0 }, 2);
    expect(Math.max(...down.map(p => p.y))).toBeCloseTo(100, 1);
    expect(Math.min(...down.map(p => p.y))).toBeGreaterThanOrEqual(-1e-6);
    // every point is on the circle; the ends are exact
    for (const p of up) expect(Math.hypot(p.x, p.y)).toBeCloseTo(100, 6);
    expect(up[0]).toEqual({ x: -100, y: 0 });
    expect(up[up.length - 1]).toEqual({ x: 100, y: 0 });
  });

  it('collinear "arc" points fall back to straight lines', () => {
    expect(tessellateArc({ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 })).toHaveLength(3);
  });

  it('a room with one curved wall: rectangle plus a half-disc', () => {
    // 200 × 100 rectangle with a semicircular bay (r = 50) bulging out of the right side
    const ring = pathToRing([
      { type: 'line', points: [{ x: 0, y: 100 }, { x: 0, y: 0 }, { x: 200, y: 0 }] },
      { type: 'arc',  points: [{ x: 200, y: 0 }, { x: 250, y: 50 }, { x: 200, y: 100 }] },
      { type: 'line', points: [{ x: 200, y: 100 }, { x: 0, y: 100 }] },
    ], 1);
    const expected = 200 * 100 + (Math.PI * 50 * 50) / 2;
    expect(ringArea(ring)).toBeGreaterThan(expected * 0.999);
    expect(ringArea(ring)).toBeLessThanOrEqual(expected);
    // joins are not duplicated and the closing point is dropped
    for (let i = 1; i < ring.length; i++) {
      expect(Math.hypot(ring[i].x - ring[i - 1].x, ring[i].y - ring[i - 1].y)).toBeGreaterThan(0);
    }
    expect(ring[ring.length - 1]).not.toEqual(ring[0]);
  });

  it('regular polygons: right corner count, first corner where you clicked, correct area', () => {
    const hex = regularPolygon({ x: 10, y: 10 }, { x: 110, y: 10 }, 6);
    expect(hex).toHaveLength(6);
    expect(hex[0].x).toBeCloseTo(110); expect(hex[0].y).toBeCloseTo(10);
    expect(ringArea(hex)).toBeCloseTo((3 * Math.sqrt(3) / 2) * 100 * 100, 4);
    expect(ringArea(regularPolygon({ x: 0, y: 0 }, { x: 0, y: 50 }, 4))).toBeCloseTo(2 * 50 * 50, 6);
  });

  it('sides are kept within sensible limits', () => {
    expect(clampSides(2)).toBe(3);
    expect(clampSides(100)).toBe(24);
    expect(clampSides(NaN)).toBe(6);
    expect(clampSides(7.6)).toBe(8);
  });

  it('circle ring is on the circle', () => {
    const ring = circleRing({ x: 0, y: 0 }, { x: 30, y: 40 });
    expect(ring).toHaveLength(72);
    for (const p of ring) expect(Math.hypot(p.x, p.y)).toBeCloseTo(50, 6);
  });
});
