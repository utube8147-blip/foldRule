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

const M = 0, L = 1, C = 2, CLOSE = 4, STROKE = 20;
const wall = { fn: 91, args: [STROKE, [M, 100, 100, L, 400, 100], null] };
const bezCircle = (cx: number, cy: number, r: number) => {
  const k = 0.5523 * r;
  return { fn: 91, args: [STROKE, [M, cx + r, cy,
    C, cx + r, cy + k, cx + k, cy + r, cx, cy + r,
    C, cx - k, cy + r, cx - r, cy + k, cx - r, cy,
    C, cx - r, cy - k, cx - k, cy - r, cx, cy - r,
    C, cx + k, cy - r, cx + r, cy - k, cx + r, cy, CLOSE], null] };
};
const bezArc = (cx: number, cy: number, r: number) => {           // quarter arc (door swing)
  const k = 0.5523 * r;
  return { fn: 91, args: [STROKE, [M, cx + r, cy, C, cx + r, cy + k, cx + k, cy + r, cx, cy + r], null] };
};
const segCircle = (cx: number, cy: number, r: number, n = 40) => {
  const p = Array.from({ length: n }, (_, i) => [cx + r * Math.cos((2 * Math.PI * i) / n), cy + r * Math.sin((2 * Math.PI * i) / n)]);
  return { fn: 91, args: [STROKE, [M, p[0][0], p[0][1], ...p.slice(1).flatMap(([x, y]) => [L, x, y]), CLOSE], null] };
};

describe('geometry is tagged line / arc / circle', () => {
  const out = runWorker([wall, bezCircle(600, 600, 60), bezArc(200, 700, 90), segCircle(800, 300, 50)]);

  it('walls are lines', () => {
    const wallLine = out.lines.find((l: any) => Math.abs(l.vertices[0].y - 100) < 0.01 && Math.abs(l.vertices[1].y - 100) < 0.01);
    expect(wallLine.shape).toBe('line');
  });

  it('curves of a full circle are circle; a door swing is an arc', () => {
    const shapes = out.curves.map((c: any) => c.shape);
    expect(shapes.filter((s: string) => s === 'circle')).toHaveLength(4);
    expect(shapes.filter((s: string) => s === 'arc')).toHaveLength(1);
  });

  it('segments of a circle drawn with straight lines are circle, not line', () => {
    const segs = out.lines.filter((l: any) => Math.hypot(l.vertices[0].x - 800, l.vertices[0].y - 300) < 55);
    expect(segs.length).toBeGreaterThan(30);
    expect(segs.every((l: any) => l.shape === 'circle')).toBe(true);
  });

  it('every snap point says which shape it belongs to', () => {
    expect(out.snapPoints.every((s: any) => ['line', 'arc', 'circle'].includes(s.shape))).toBe(true);
    const circleCentres = out.snapPoints.filter((s: any) => s.type === 'centroid' && s.shape === 'circle');
    const arcCentres    = out.snapPoints.filter((s: any) => s.type === 'centroid' && s.shape === 'arc');
    expect(circleCentres.length).toBeGreaterThanOrEqual(2);      // the curve circle + the segmented circle
    expect(arcCentres.length).toBeGreaterThanOrEqual(1);         // the door swing
    expect(out.snapPoints.some((s: any) => s.shape === 'line' && s.type === 'endpoint')).toBe(true);
  });

  it('a wall end and an arc end at the same spot both survive (for their own tools)', () => {
    const r = 90, k = 0.5523 * r;
    const o = runWorker([
      { fn: 91, args: [STROKE, [M, 290, 700, L, 500, 700], null] },            // wall ending at (290,700)
      { fn: 91, args: [STROKE, [M, 290, 700, C, 290, 700 + k, 200 + k, 790, 200, 790], null] }, // arc starting there
    ]);
    const at = o.snapPoints.filter((s: any) => Math.hypot(s.nx * 1000 - 290, s.ny * 1000 - 700) < 1);
    const shapes = new Set(at.map((s: any) => s.shape));
    expect(shapes.has('line')).toBe(true);
    expect(shapes.has('arc')).toBe(true);
  });
});

describe('drawn arcs for the arc tool', () => {
  const quarter = (cx: number, cy: number, r: number, from: number) => {
    // Quarter arc from angle `from` to `from + 90°` as one cubic Bézier.
    const k = 0.5523 * r, c = Math.cos, s = Math.sin, a = from, b = from + Math.PI / 2;
    return [C,
      cx + r * c(a) - k * s(a), cy + r * s(a) + k * c(a),
      cx + r * c(b) + k * s(b), cy + r * s(b) - k * c(b),
      cx + r * c(b), cy + r * s(b)];
  };

  it('a door swing is one 90° arc with the right centre and radius', () => {
    const r = 90;
    const o = runWorker([{ fn: 91, args: [STROKE, [M, 200 + r, 700, ...quarter(200, 700, r, 0)], null] }]);
    expect(o.arcs).toHaveLength(1);
    expect(o.arcs[0].nx * 1000).toBeCloseTo(200, 0);
    expect(o.arcs[0].r).toBeCloseTo(90, 0);
    expect((o.arcs[0].sweep * 180) / Math.PI).toBeCloseTo(90, 0);
  });

  it('two curves forming a half circle become one 180° arc', () => {
    const r = 60;
    const o = runWorker([{ fn: 91, args: [STROKE, [M, 500 + r, 500, ...quarter(500, 500, r, 0), ...quarter(500, 500, r, Math.PI / 2)], null] }]);
    expect(o.arcs).toHaveLength(1);
    expect((o.arcs[0].sweep * 180) / Math.PI).toBeCloseTo(180, 0);
  });

  it('an arc drawn as straight segments is found too', () => {
    const n = 12, r = 80, pts = Array.from({ length: n }, (_, i) => [300 + r * Math.cos((Math.PI / 2) * i / (n - 1)), 300 + r * Math.sin((Math.PI / 2) * i / (n - 1))]);
    const o = runWorker([{ fn: 91, args: [STROKE, [M, pts[0][0], pts[0][1], ...pts.slice(1).flatMap(([x, y]) => [L, x, y])], null] }]);
    expect(o.arcs).toHaveLength(1);
    expect((o.arcs[0].sweep * 180) / Math.PI).toBeGreaterThan(80);
  });

  it('full circles are not listed as arcs', () => {
    expect(runWorker([bezCircle(600, 600, 60)]).arcs).toHaveLength(0);
  });
});
