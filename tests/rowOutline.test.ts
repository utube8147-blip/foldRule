import { describe, it, expect } from 'vitest';
import type { TakeoffRow } from '@/types';
import { rowOutlinePx } from '@/lib/takeoff/rowOutline';

const row = (o: Partial<TakeoffRow>): TakeoffRow => ({
  id: 'x', childIds: [], drawingId: 'd', description: '', type: 'Length', quantity: 0, unit: 'm', unitRate: 0,
  notes: '', points: [], isOverridden: false, color: '#fff', isVisible: true, ...o,
});
const W = 1000, H = 1000;

describe('row outline', () => {
  it('follows a three-point arc instead of joining its points with straight lines', () => {
    // half circle of radius 100 about (500, 500): left, top, right
    const arc = row({ arcRadius: 1, sweepAngle: Math.PI, points: [{ x: 0.4, y: 0.5 }, { x: 0.5, y: 0.4 }, { x: 0.6, y: 0.5 }] });
    const { pts, closed } = rowOutlinePx(arc, W, H);
    expect(closed).toBe(false);
    expect(pts.length).toBeGreaterThan(20);
    for (const p of pts) expect(Math.hypot(p.x - 500, p.y - 500)).toBeCloseTo(100, 3);
    expect(pts[0]).toEqual({ x: 400, y: 500 });
    expect(pts[pts.length - 1]).toEqual({ x: 600, y: 500 });
  });

  it('draws a circle round its centre', () => {
    const c = row({ arcRadius: 1, sweepAngle: 2 * Math.PI, points: [{ x: 0.5, y: 0.5 }, { x: 0.6, y: 0.5 }] });
    const { pts, closed } = rowOutlinePx(c, W, H);
    expect(closed).toBe(true);
    for (const p of pts) expect(Math.hypot(p.x - 500, p.y - 500)).toBeCloseTo(100, 6);
  });

  it('leaves straight shapes alone and squares up a two-point rectangle', () => {
    expect(rowOutlinePx(row({ points: [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.1 }] }), W, H).pts).toEqual([{ x: 100, y: 100 }, { x: 200, y: 100 }]);
    const r = rowOutlinePx(row({ type: 'Rectangle', points: [{ x: 0.1, y: 0.1 }, { x: 0.3, y: 0.2 }] }), W, H);
    expect(r.pts).toHaveLength(4);
    expect(r.closed).toBe(true);
  });
});
