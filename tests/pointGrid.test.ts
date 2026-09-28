import { describe, it, expect } from 'vitest';
import { buildPointGrid } from '@/lib/geometry/pointGrid';

describe('pin grid', () => {
  const pts = Array.from({ length: 5000 }, (_, i) => ({ x: (i % 100) * 10, y: Math.floor(i / 100) * 10, type: 'endpoint' }));
  const grid = buildPointGrid(pts);

  it('returns only points within the radius, nearest first', () => {
    const near = grid.near({ x: 500, y: 250 }, 15);
    expect(near.length).toBeGreaterThan(0);
    expect(near.every(p => Math.hypot(p.x - 500, p.y - 250) <= 15)).toBe(true);
    expect(near[0]).toMatchObject({ x: 500, y: 250 });
    // brute force agrees
    const brute = pts.filter(p => Math.hypot(p.x - 500, p.y - 250) <= 15);
    expect(near).toHaveLength(brute.length);
  });

  it('caps the number of pins drawn', () => {
    expect(grid.near({ x: 500, y: 250 }, 400, 150)).toHaveLength(150);
  });

  it('returns nothing far from any point', () => {
    expect(grid.near({ x: 5000, y: 5000 }, 50)).toHaveLength(0);
  });
});
