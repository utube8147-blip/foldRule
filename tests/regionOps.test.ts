import { describe, it, expect } from 'vitest';
import { unionShapes, subtractShapes, intersectShapes, splitShape, shapeArea, pointInShape, type Shape } from '@/lib/geometry/regionOps';

const rect = (x: number, y: number, w: number, h: number): Shape => ({
  outer: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }], holes: [],
});
const near = (a: number, b: number) => expect(a).toBeCloseTo(b, 6);

describe('region operations', () => {
  it('joins overlapping and touching areas into one', () => {
    const u = unionShapes([rect(0.1, 0.1, 0.2, 0.2), rect(0.2, 0.1, 0.2, 0.2)]);
    expect(u).toHaveLength(1); near(shapeArea(u[0]), 0.06);
    const t = unionShapes([rect(0.1, 0.1, 0.1, 0.1), rect(0.2, 0.1, 0.1, 0.1)]);
    expect(t).toHaveLength(1); near(shapeArea(t[0]), 0.02);
    expect(t[0].outer).toHaveLength(4);            // shared edge is gone
  });
  it('keeps separate areas separate', () => {
    expect(unionShapes([rect(0.1, 0.1, 0.1, 0.1), rect(0.5, 0.5, 0.1, 0.1)])).toHaveLength(2);
  });
  it('cuts a hole when the cutter is inside', () => {
    const r = subtractShapes(rect(0.1, 0.1, 0.4, 0.4), [rect(0.2, 0.2, 0.1, 0.1)]);
    expect(r).toHaveLength(1); expect(r[0].holes).toHaveLength(1);
    near(shapeArea(r[0]), 0.16 - 0.01);
    expect(pointInShape({ x: 0.25, y: 0.25 }, r[0])).toBe(false);
    expect(pointInShape({ x: 0.15, y: 0.15 }, r[0])).toBe(true);
  });
  it('a second cut-out keeps the first', () => {
    const one = subtractShapes(rect(0.1, 0.1, 0.4, 0.4), [rect(0.2, 0.2, 0.05, 0.05)])[0];
    const two = subtractShapes(one, [rect(0.35, 0.35, 0.05, 0.05)]);
    expect(two[0].holes).toHaveLength(2); near(shapeArea(two[0]), 0.16 - 0.005);
  });
  it('subtracting across the middle gives two pieces', () => {
    expect(subtractShapes(rect(0.1, 0.1, 0.4, 0.2), [rect(0.25, 0, 0.1, 0.5)])).toHaveLength(2);
  });
  it('keeps only the overlap', () => {
    const r = intersectShapes([rect(0.1, 0.1, 0.2, 0.2), rect(0.2, 0.2, 0.2, 0.2)]);
    expect(r).toHaveLength(1); near(shapeArea(r[0]), 0.01);
    expect(intersectShapes([rect(0.1, 0.1, 0.1, 0.1), rect(0.5, 0.5, 0.1, 0.1)])).toHaveLength(0);
  });
  it('splits along a line, even one that stops short of the edges', () => {
    const s = splitShape(rect(0.1, 0.1, 0.4, 0.2), [{ x: 0.2, y: 0.15 }, { x: 0.2, y: 0.25 }]);
    expect(s).toHaveLength(2);
    near(shapeArea(s[0]), 0.06); near(shapeArea(s[1]), 0.02);
    near(shapeArea(s[0]) + shapeArea(s[1]), 0.08);   // nothing lost
  });
  it('a line that misses leaves the shape alone', () => {
    expect(splitShape(rect(0.1, 0.1, 0.1, 0.1), [{ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.9 }])).toHaveLength(1);
  });
});
