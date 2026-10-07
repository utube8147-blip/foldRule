import { describe, it, expect } from 'vitest';
import type { TakeoffRow } from '@/types';
import { checkBySnap, refineOffset, shiftGeometry, type PageGeometry, type Pt } from '@/lib/takeoff/snapRevision';

const W = 1000, H = 800;
const L = (x0: number, y0: number, x1: number, y1: number): [Pt, Pt] => [{ x: x0, y: y0 }, { x: x1, y: y1 }];
const geom = (lines: [Pt, Pt][]): PageGeometry => ({ points: lines.flatMap(l => [l[0], l[1]]), lines });
const n = (x: number, y: number) => ({ x: x / W, y: y / H });
const row = (o: Partial<TakeoffRow>): TakeoffRow => ({
  id: 'x', childIds: [], drawingId: 'd', description: '', type: 'Length', quantity: 0, unit: 'm', unitRate: 0,
  notes: '', points: [], isOverridden: false, color: '#fff', isVisible: true, ...o,
});

// A room 100..500 × 100..400 with a partition at x = 300 from the top wall to the bottom wall.
const box = [L(100, 100, 500, 100), L(500, 100, 500, 400), L(500, 400, 100, 400), L(100, 400, 100, 100)];
const oldG = geom([...box, L(300, 100, 300, 400)]);
const check = (rows: TakeoffRow[], newG: PageGeometry) =>
  Object.fromEntries(checkBySnap(rows, oldG, newG, { pageW: W, pageH: H }).map(c => [c.id, c]));

describe('revision check by snap', () => {
  const partition = row({ id: 'part', quantity: 3, points: [n(300, 100), n(300, 400)] });
  const top = row({ id: 'top', quantity: 4, points: [n(100, 100), n(500, 100)] });
  const leftRoom = row({ id: 'left', type: 'Polygon', unit: 'sq m', quantity: 6, points: [n(100, 100), n(300, 100), n(300, 400), n(100, 400)] });
  const freehand = row({ id: 'free', quantity: 1, points: [n(150, 250), n(250, 260)] });
  const pin = row({ id: 'pin', type: 'Count', points: [n(200, 200)] });
  const rows = [partition, top, leftRoom, freehand, pin];

  it('confirms everything when the linework is the same', () => {
    const c = check(rows, oldG);
    expect([c.part.verdict, c.top.verdict, c.left.verdict]).toEqual(['confirmed', 'confirmed', 'confirmed']);
    expect([c.free.verdict, c.pin.verdict]).toEqual(['unknown', 'unknown']);
  });

  it('a partition that moves sideways: the wall and the room follow, the outer wall is confirmed', () => {
    const c = check(rows, geom([...box, L(360, 100, 360, 400)]));
    expect(c.top.verdict).toBe('confirmed');
    expect(c.part.verdict).toBe('moved');
    expect(c.part.suggestion!.points.map(p => Math.round(p.x * W))).toEqual([360, 360]);
    expect(c.part.suggestion!.quantity).toBeCloseTo(3, 6);           // same length, new place
    expect(c.left.verdict).toBe('moved');
    expect(c.left.suggestion!.quantity).toBeCloseTo(6 * (260 / 200), 4);   // the room got wider
  });

  it('a wall that gets shorter: its end follows along its own line', () => {
    const c = check([partition], geom([...box, L(300, 100, 300, 280)]));
    expect(c.part.movedPoints).toBe(1);
    expect(Math.round(c.part.suggestion!.points[1].y * H)).toBe(280);
    expect(c.part.suggestion!.quantity).toBeCloseTo(3 * (180 / 300), 4);
  });

  it('a wall removed between corners that are still there is not confirmed', () => {
    const c = check([partition], geom(box));
    expect(c.part.verdict).toBe('moved');
    expect(c.part.suggestion).toBeUndefined();
  });

  it('no suggestion when a moved corner has nowhere near to go', () => {
    const far = geom([L(100, 100, 500, 100), L(900, 700, 950, 700)]);
    const c = check([partition], far);
    expect(c.part.verdict).toBe('moved');
    expect(c.part.suggestion).toBeUndefined();
  });

  it('finds the exact offset of a sheet exported slightly shifted', () => {
    const many = geom(Array.from({ length: 30 }, (_, i) => L(50 + i * 20, 60, 50 + i * 20, 300 + i * 7)));
    const moved = shiftGeometry(many, { x: -2.3, y: 1.1 });
    const off = refineOffset(many, moved, { x: 2, y: -1 })!;
    expect(off.x).toBeCloseTo(2.3, 6);
    expect(off.y).toBeCloseTo(-1.1, 6);
    expect(refineOffset(many, geom([L(0, 0, 5, 5)]))).toBeNull();
  });
});
