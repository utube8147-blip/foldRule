import { describe, it, expect } from 'vitest';
import { snapOutline, polygonArea, type P } from '@/lib/geometry/snapOutline';
import { buildGeometryIndex } from '@/lib/geometry/geometryIndex';

const L = (id: string, x1: number, y1: number, x2: number, y2: number) =>
  ({ id, shape: 'line' as const, vertices: [{ x: x1, y: y1 }, { x: x2, y: y2 }] as [{ x: number; y: number }, { x: number; y: number }] });

/** A traced outline: 1.5 inside the walls, rounded corners, slight wobble. */
function traced(x0: number, y0: number, x1: number, y1: number): P[] {
  const i = 1.5, r = 3, pts: P[] = [];
  const edge = (ax: number, ay: number, bx: number, by: number, n: number) => {
    for (let k = 0; k < n; k++) {
      const t = k / n, w = (k % 3 - 1) * 0.3;
      pts.push([ax + (bx - ax) * t + (ay === by ? 0 : w), ay + (by - ay) * t + (ay === by ? w : 0)]);
    }
  };
  edge(x0 + i + r, y0 + i, x1 - i - r, y0 + i, 20); pts.push([x1 - i - 1, y0 + i + 1]);
  edge(x1 - i, y0 + i + r, x1 - i, y1 - i - r, 20); pts.push([x1 - i - 1, y1 - i - 1]);
  edge(x1 - i - r, y1 - i, x0 + i + r, y1 - i, 20); pts.push([x0 + i + 1, y1 - i - 1]);
  edge(x0 + i, y1 - i - r, x0 + i, y0 + i + r, 20); pts.push([x0 + i + 1, y0 + i + 1]);
  return pts;
}

describe('snapping fill outlines onto the drawing', () => {
  const walls = [L('top', 50, 100, 250, 100), L('right', 200, 50, 200, 250), L('bottom', 50, 200, 250, 200), L('left', 100, 50, 100, 250)];
  const idx = buildGeometryIndex(walls, []);
  const opts = {
    nearest: (x: number, y: number, tol: number) => idx.nearestPoint({ x, y }, tol) as never,
    edgeTol: 4, cornerTol: 4,
  };

  it('a traced room becomes the exact rectangle of its walls (sharp corners)', () => {
    const out = snapOutline(traced(100, 100, 200, 200), opts);
    expect(out).toHaveLength(4);
    expect(polygonArea(out)).toBeCloseTo(100 * 100, 6);
    const corners = out.map(([x, y]) => `${Math.round(x)},${Math.round(y)}`).sort();
    expect(corners).toEqual(['100,100', '100,200', '200,100', '200,200']);
  });

  it('points on an arc stay on the arc (curves stay curved)', () => {
    const r = 50, k = 0.5523 * r;                                  // quarter arc centred (300,300)
    const arcIdx = buildGeometryIndex([L('base', 300, 300, 350, 300), L('side', 300, 300, 300, 350)],
      [{ id: 'arc', shape: 'arc', center: { x: 300, y: 300 }, radius: r,
         bezier: { p0: { x: 350, y: 300 }, p1: { x: 350, y: 300 + k }, p2: { x: 300 + k, y: 350 }, p3: { x: 300, y: 350 } } }]);
    const quarter: P[] = [[300.5, 300.5], [348, 300.5]];
    for (let a = 5; a < 90; a += 10) quarter.push([300 + 48.5 * Math.cos((a * Math.PI) / 180), 300 + 48.5 * Math.sin((a * Math.PI) / 180)]);
    quarter.push([300.5, 348]);
    const out = snapOutline(quarter, { nearest: (x, y, t) => arcIdx.nearestPoint({ x, y }, t) as never, edgeTol: 4, cornerTol: 4 });
    const onArc = out.filter(([x, y]) => Math.abs(Math.hypot(x - 300, y - 300) - 50) < 1e-6);
    expect(onArc.length).toBeGreaterThan(5);
  });

  it('leaves the outline alone where there is nothing to snap to', () => {
    const empty = buildGeometryIndex([], []);
    const poly = traced(100, 100, 200, 200);
    expect(snapOutline(poly, { nearest: (x, y, t) => empty.nearestPoint({ x, y }, t) as never, edgeTol: 4, cornerTol: 4 })).toBe(poly);
  });
});
