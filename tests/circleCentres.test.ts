import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function runWorker(operators: { fn: number; args: unknown[] }[]) {
  const src = readFileSync(join(process.cwd(), 'workers/pdfGeometry.worker.js'), 'utf8');
  let out: any = null;
  const self: any = { postMessage: (m: unknown) => { out = m; } };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('self', 'console', src)(self, { log() {}, warn() {}, error() {} });
  self.onmessage({ data: { type: 'PARSE', operators, dims: { w: 1000, h: 1000 }, viewportTransform: [1, 0, 0, 1, 0, 0] } });
  return out;
}

const M = 0, L = 1, CLOSE = 4, STROKE = 20;
/** A stroked path made of straight segments through the given points. */
const poly = (pts: [number, number][], close = false) => ({
  fn: 91,
  args: [STROKE, [M, pts[0][0], pts[0][1], ...pts.slice(1).flatMap(([x, y]) => [L, x, y]), ...(close ? [CLOSE] : [])], null],
});
const ring = (cx: number, cy: number, r: number, n: number, from = 0, to = 2 * Math.PI) =>
  Array.from({ length: n }, (_, i) => {
    const a = from + ((to - from) * i) / (n - (to - from >= 2 * Math.PI ? 0 : 1));
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as [number, number];
  });
const centres = (out: any) => out.snapPoints.filter((s: any) => s.type === 'centroid');
const near = (s: any, x: number, y: number) => Math.hypot(s.nx * 1000 - x, s.ny * 1000 - y) < 1;

describe('circle centre snaps', () => {
  it('finds the centre of a circle drawn as 36 straight segments', () => {
    const out = runWorker([poly(ring(400, 300, 80, 36), true)]);
    expect(centres(out).some((s: any) => near(s, 400, 300))).toBe(true);
  });

  it('finds the centre of a quarter arc (e.g. a door swing) drawn as segments', () => {
    const out = runWorker([poly(ring(200, 700, 90, 12, 0, Math.PI / 2))]);
    expect(centres(out).some((s: any) => near(s, 200, 700))).toBe(true);
  });

  it('does not invent a centre for a rectangle with extra vertices', () => {
    const rect: [number, number][] = [[100,100],[150,100],[200,100],[250,100],[250,150],[250,200],[200,200],[150,200],[100,200],[100,150]];
    expect(centres(runWorker([poly(rect, true)]))).toHaveLength(0);
  });

  it('does not invent a centre for a wavy / irregular line', () => {
    const wobble = Array.from({ length: 20 }, (_, i) => [100 + i * 20, 500 + (i % 2 ? 15 : -15)] as [number, number]);
    expect(centres(runWorker([poly(wobble)]))).toHaveLength(0);
  });

  it('still finds centres of circles drawn as true curves', () => {
    // A circle from 4 cubic Béziers (k ≈ 0.5523).
    const cx = 600, cy = 600, r = 50, k = 0.5523 * r, C = 2;
    const buf = [M, cx + r, cy,
      C, cx + r, cy + k, cx + k, cy + r, cx, cy + r,
      C, cx - k, cy + r, cx - r, cy + k, cx - r, cy,
      C, cx - r, cy - k, cx - k, cy - r, cx, cy - r,
      C, cx + k, cy - r, cx + r, cy - k, cx + r, cy, CLOSE];
    const out = runWorker([{ fn: 91, args: [STROKE, buf, null] }]);
    expect(centres(out).some((s: any) => near(s, cx, cy))).toBe(true);
  });
});

describe('non-circular curves', () => {
  it('get no fake centre snap', () => {
    const M = 0, C = 2, STROKE = 20;
    // An S-shaped Bézier: not a circular arc.
    const out = runWorker([{ fn: 91, args: [STROKE, [M, 100, 100, C, 300, 0, 100, 400, 300, 300], null] }]);
    expect(out.snapPoints.filter((s: any) => s.type === 'centroid')).toHaveLength(0);
  });
});

describe('full circles for one-click measuring', () => {
  const M = 0, L = 1, C = 2, CLOSE = 4, STROKE = 20;
  const bezCircle = (cx: number, cy: number, r: number) => {
    const k = 0.5523 * r;
    return { fn: 91, args: [STROKE, [M, cx + r, cy,
      C, cx + r, cy + k, cx + k, cy + r, cx, cy + r,
      C, cx - k, cy + r, cx - r, cy + k, cx - r, cy,
      C, cx - r, cy - k, cx - k, cy - r, cx, cy - r,
      C, cx + k, cy - r, cx + r, cy - k, cx + r, cy, CLOSE], null] };
  };
  const segCircle = (cx: number, cy: number, r: number, n = 48) => {
    const pts = Array.from({ length: n }, (_, i) => [cx + r * Math.cos((2 * Math.PI * i) / n), cy + r * Math.sin((2 * Math.PI * i) / n)]);
    return { fn: 91, args: [STROKE, [M, pts[0][0], pts[0][1], ...pts.slice(1).flatMap(([x, y]) => [L, x, y]), CLOSE], null] };
  };

  it('a circle made of 4 curves is one circle with the right radius', () => {
    const out = runWorker([bezCircle(500, 400, 60)]);
    expect(out.circles).toHaveLength(1);
    expect(out.circles[0].nx * 1000).toBeCloseTo(500, 0);
    expect(out.circles[0].ny * 1000).toBeCloseTo(400, 0);
    expect(out.circles[0].r).toBeCloseTo(60, 0);
  });

  it('a segmented circle is found too', () => {
    const out = runWorker([segCircle(300, 300, 45)]);
    expect(out.circles).toHaveLength(1);
    expect(out.circles[0].r).toBeCloseTo(45, 0);
  });

  it('concentric rings stay separate circles with the same centre', () => {
    const out = runWorker([bezCircle(500, 500, 80), bezCircle(500, 500, 30)]);
    expect(out.circles).toHaveLength(2);
    expect(out.circles.map((c: any) => Math.round(c.r)).sort()).toEqual([30, 80]);
  });

  it('a quarter arc (door swing) is not offered as a full circle', () => {
    const r = 90, k = 0.5523 * r;
    const out = runWorker([{ fn: 91, args: [STROKE, [M, 200 + r, 700, C, 200 + r, 700 + k, 200 + k, 700 + r, 200, 700 + r], null] }]);
    expect(out.circles).toHaveLength(0);
  });
});
