import { describe, it, expect } from 'vitest';
import { constrainToAngle, isExactSnap } from '@/lib/geometry/ortho';

describe('angle lock', () => {
  const o = { x: 100, y: 100 };

  it('locks a nearly-horizontal move to horizontal', () => {
    const p = constrainToAngle(o, { x: 300, y: 108 });
    expect(p.y).toBeCloseTo(100);
    expect(p.x).toBeCloseTo(300);
    expect(p.angleDeg).toBe(0);
  });

  it('locks a nearly-vertical move to vertical', () => {
    const p = constrainToAngle(o, { x: 95, y: -50 });
    expect(p.x).toBeCloseTo(100);
    expect(p.y).toBeCloseTo(-50);
  });

  it('locks to the 45° diagonal and keeps the projected length', () => {
    const p = constrainToAngle(o, { x: 200, y: 190 });
    expect(p.x - o.x).toBeCloseTo(p.y - o.y);
    expect(Math.hypot(p.x - o.x, p.y - o.y)).toBeCloseTo((100 + 90) / Math.SQRT2);
    expect(p.angleDeg).toBe(45);
  });

  it('supports 90°-only steps', () => {
    const p = constrainToAngle(o, { x: 200, y: 190 }, 90);
    expect(p.y).toBeCloseTo(100);
  });

  it('leaves a zero-length move alone', () => {
    expect(constrainToAngle(o, o)).toMatchObject(o);
  });

  it('exact snaps beat the lock; on-line snaps do not', () => {
    expect(isExactSnap('endpoint', true)).toBe(true);
    expect(isExactSnap('line', true)).toBe(false);
    expect(isExactSnap('endpoint', false)).toBe(false);
  });
});
