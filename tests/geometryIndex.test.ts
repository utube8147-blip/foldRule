import { describe, it, expect } from 'vitest';
import { buildGeometryIndex } from '@/lib/geometry/geometryIndex';

const line = (id: string, x1: number, y1: number, x2: number, y2: number) =>
  ({ id, vertices: [{ x: x1, y: y1 }, { x: x2, y: y2 }] as [{ x: number; y: number }, { x: number; y: number }] });

describe('geometry index', () => {
  const idx = buildGeometryIndex(
    [
      line('wall', 0, 100, 5000, 100),        // very long (many cells)
      line('short', 300, 300, 340, 300),
      line('near', 300, 310, 340, 310),
    ],
    [{ id: 'arc', bezier: { p0: { x: 600, y: 600 }, p1: { x: 600, y: 655 }, p2: { x: 645, y: 700 }, p3: { x: 700, y: 700 } } }],
  );

  it('finds the nearest line to the cursor', () => {
    expect(idx.nearest({ x: 320, y: 302 }, 10)?.id).toBe('short');
    expect(idx.nearest({ x: 320, y: 308 }, 10)?.id).toBe('near');
  });

  it('finds long lines anywhere along their length', () => {
    expect(idx.nearest({ x: 4200, y: 104 }, 10)?.id).toBe('wall');
  });

  it('finds curves by their actual shape', () => {
    // Near the curve midpoint B(0.5) ≈ (629.4, 670.6), well off the straight chord.
    const hit = idx.nearest({ x: 632, y: 668 }, 10);
    expect(hit?.id).toBe('arc');
  });

  it('returns nothing when the cursor is too far away', () => {
    expect(idx.nearest({ x: 2000, y: 2000 }, 10)).toBeNull();
  });

  it('is fast on a plan-sized page', () => {
    const many = Array.from({ length: 6000 }, (_, i) => line(`l${i}`, (i % 80) * 12, Math.floor(i / 80) * 12, (i % 80) * 12 + 10, Math.floor(i / 80) * 12));
    const big = buildGeometryIndex(many, []);
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) big.nearest({ x: (i * 7) % 900, y: (i * 13) % 900 }, 10);
    expect(performance.now() - t0).toBeLessThan(200);   // 1000 lookups (≈ 16 s of mouse moves at 60 fps)
  });
});

describe('snap onto the nearest line / curve', () => {
  const k = 0.5523 * 50;
  const idx = buildGeometryIndex(
    [{ id: 'wall', shape: 'line', vertices: [{ x: 0, y: 100 }, { x: 400, y: 100 }] }],
    [{ id: 'q', shape: 'circle', center: { x: 500, y: 500 }, radius: 50,
       bezier: { p0: { x: 550, y: 500 }, p1: { x: 550, y: 500 + k }, p2: { x: 500 + k, y: 550 }, p3: { x: 500, y: 550 } } }],
  );

  it('lands exactly on a line when clicking beside it', () => {
    const hit = idx.nearestPoint({ x: 137, y: 106 }, 12)!;
    expect(hit.point.x).toBeCloseTo(137, 6);
    expect(hit.point.y).toBeCloseTo(100, 6);
  });

  it('lands exactly on a circle edge (true radius, not the sampled curve)', () => {
    const hit = idx.nearestPoint({ x: 540, y: 540 }, 12)!;   // near the 45° point
    expect(Math.hypot(hit.point.x - 500, hit.point.y - 500)).toBeCloseTo(50, 6);
  });

  it('only considers the shapes the tool allows', () => {
    expect(idx.nearestPoint({ x: 137, y: 106 }, 12, new Set(['circle']))).toBeNull();
    expect(idx.nearestPoint({ x: 540, y: 540 }, 12, new Set(['line']))).toBeNull();
  });

  it('does nothing when the click is too far from any line', () => {
    expect(idx.nearestPoint({ x: 137, y: 140 }, 12)).toBeNull();
  });
});
